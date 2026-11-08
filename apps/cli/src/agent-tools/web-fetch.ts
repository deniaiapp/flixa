import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";

const MAX_REDIRECTS = 5;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 20_000;
const USER_AGENT = "flixa-cli-webfetch";

export interface WebFetchResult {
  url: string;
  status: number;
  contentType: string;
  text: string;
  truncated: boolean;
}

/**
 * Fetches a public http(s) page and returns readable text. Every hop, including
 * redirects, is checked against private/loopback/link-local ranges both before the
 * request and again inside the socket's DNS lookup, so a model-supplied URL cannot
 * be used to reach internal services.
 */
export async function fetchWebPage(urlText: string, maxChars: number): Promise<WebFetchResult> {
  let current = parseHttpUrl(urlText);

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    await assertPublicHost(current.hostname);
    const response = await requestOnce(current);
    const status = response.status;

    if (status >= 300 && status < 400 && response.location) {
      current = parseHttpUrl(new URL(response.location, current).toString());
      continue;
    }

    if (status < 200 || status >= 300) {
      throw new Error(`Request failed with HTTP ${status}.`);
    }

    const contentType = response.contentType;
    if (!isTextualContentType(contentType)) {
      throw new Error(`Unsupported content type: ${contentType || "unknown"}.`);
    }

    const raw = decodeBody(response.body, response.contentEncoding).toString("utf-8");
    const text = contentType.includes("html") ? htmlToText(raw) : raw.trim();
    const truncated = text.length > maxChars;
    return {
      url: current.toString(),
      status,
      contentType,
      text: truncated ? `${text.slice(0, maxChars)}\n...truncated...` : text,
      truncated,
    };
  }

  throw new Error(`Too many redirects (more than ${MAX_REDIRECTS}).`);
}

function parseHttpUrl(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Invalid URL: ${value}`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Only http and https URLs are supported: ${parsed.protocol}`);
  }
  if (parsed.username || parsed.password) {
    throw new Error("URLs with embedded credentials are not allowed.");
  }

  return parsed;
}

async function assertPublicHost(hostname: string): Promise<void> {
  const host = hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) {
    assertPublicAddress(host);
    return;
  }

  const addresses = await dnsLookup(host, { all: true });
  if (addresses.length === 0) {
    throw new Error(`Could not resolve host: ${hostname}`);
  }
  for (const address of addresses) {
    assertPublicAddress(address.address);
  }
}

function assertPublicAddress(address: string): void {
  if (isPrivateAddress(address)) {
    throw new Error(`Refusing to fetch a private or local address: ${address}`);
  }
}

// Runs at connect time so a DNS answer that changes after the pre-check is rejected too.
const guardedLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { all: true }).then(
    (addresses) => {
      const blocked = addresses.find((entry) => isPrivateAddress(entry.address));
      if (blocked || addresses.length === 0) {
        callback(
          new Error(`Refusing to connect to a private or local address for ${hostname}`),
          "",
          4,
        );
        return;
      }

      const first = addresses[0]!;
      if (options.all) {
        (callback as unknown as (error: null, result: typeof addresses) => void)(null, addresses);
        return;
      }
      callback(null, first.address, first.family);
    },
    (error: Error) => callback(error, "", 4),
  );
};

type RawResponse = {
  status: number;
  location?: string;
  contentType: string;
  contentEncoding: string;
  body: Buffer;
};

function requestOnce(url: URL): Promise<RawResponse> {
  const send = url.protocol === "https:" ? httpsRequest : httpRequest;

  return new Promise<RawResponse>((resolvePromise, reject) => {
    const request = send(
      url,
      {
        method: "GET",
        lookup: guardedLookup,
        headers: {
          "user-agent": USER_AGENT,
          accept: "text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5",
          "accept-encoding": "gzip, deflate, br",
        },
      },
      (response: IncomingMessage) => {
        const status = response.statusCode ?? 0;
        const chunks: Buffer[] = [];
        let total = 0;

        response.on("data", (chunk: Buffer) => {
          total += chunk.length;
          if (total > MAX_BODY_BYTES) {
            request.destroy(new Error(`Response is larger than ${MAX_BODY_BYTES} bytes.`));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          resolvePromise({
            status,
            location: headerValue(response.headers.location),
            contentType: (headerValue(response.headers["content-type"]) ?? "").toLowerCase(),
            contentEncoding: (
              headerValue(response.headers["content-encoding"]) ?? ""
            ).toLowerCase(),
            body: Buffer.concat(chunks),
          });
        });
        response.on("error", reject);
      },
    );

    request.setTimeout(REQUEST_TIMEOUT_MS, () => {
      request.destroy(new Error(`Request timed out after ${REQUEST_TIMEOUT_MS}ms.`));
    });
    request.on("error", reject);
    request.end();
  });
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function decodeBody(body: Buffer, encoding: string): Buffer {
  // Compressed bodies are capped on the wire only, so cap the expanded size too (zip bombs).
  const limit = { maxOutputLength: MAX_BODY_BYTES * 4 };
  switch (encoding) {
    case "gzip":
    case "x-gzip":
      return gunzipSync(body, limit);
    case "deflate":
      return inflateSync(body, limit);
    case "br":
      return brotliDecompressSync(body, limit);
    default:
      return body;
  }
}

function isTextualContentType(contentType: string): boolean {
  if (!contentType) {
    return true;
  }
  return (
    contentType.startsWith("text/") ||
    contentType.includes("json") ||
    contentType.includes("xml") ||
    contentType.includes("javascript") ||
    contentType.includes("yaml")
  );
}

export function htmlToText(html: string): string {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  const body = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|header|footer|li|tr|h[1-6]|pre|blockquote)>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, " ");

  const text = decodeEntities(body)
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const cleanTitle = title ? decodeEntities(title).replace(/\s+/g, " ").trim() : "";
  return cleanTitle ? `${cleanTitle}\n\n${text}` : text;
}

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_m, code: string) => safeCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, code: string) => safeCodePoint(Number.parseInt(code, 16)))
    .replace(/&amp;/gi, "&");
}

function safeCodePoint(code: number): string {
  try {
    return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : "";
  } catch {
    return "";
  }
}

export function isPrivateAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    return isPrivateIpv4(address.split(".").map(Number));
  }
  if (version === 6) {
    return isPrivateIpv6(address);
  }
  return true;
}

function isPrivateIpv4(octets: number[]): boolean {
  const [a = 0, b = 0, c = 0] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isPrivateIpv6(address: string): boolean {
  const groups = expandIpv6(address);
  if (!groups) {
    return true;
  }

  const embeddedV4 = (high: number, low: number): number[] => [
    high >> 8,
    high & 0xff,
    low >> 8,
    low & 0xff,
  ];

  if (groups.slice(0, 5).every((group) => group === 0)) {
    // ::ffff:a.b.c.d is IPv4-mapped; ::, ::1 and IPv4-compatible forms are always blocked.
    return groups[5] === 0xffff ? isPrivateIpv4(embeddedV4(groups[6]!, groups[7]!)) : true;
  }

  // ::ffff:0:a.b.c.d (IPv4-translated, RFC 2765) also embeds an IPv4 address.
  if (groups.slice(0, 4).every((group) => group === 0) && groups[4] === 0xffff && groups[5] === 0) {
    return isPrivateIpv4(embeddedV4(groups[6]!, groups[7]!));
  }

  // 64:ff9b::/96 (NAT64) embeds an IPv4 address in the last 32 bits.
  if (
    groups[0] === 0x64 &&
    groups[1] === 0xff9b &&
    groups.slice(2, 6).every((group) => group === 0)
  ) {
    return isPrivateIpv4(embeddedV4(groups[6]!, groups[7]!));
  }

  const first = groups[0]!;
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00;
}

function expandIpv6(address: string): number[] | null {
  let text = address.split("%")[0]!.toLowerCase();

  const v4Tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(text)?.[1];
  if (v4Tail) {
    const octets = v4Tail.split(".").map(Number);
    const high = ((octets[0]! << 8) | octets[1]!).toString(16);
    const low = ((octets[2]! << 8) | octets[3]!).toString(16);
    text = `${text.slice(0, -v4Tail.length)}${high}:${low}`;
  }

  const halves = text.split("::");
  if (halves.length > 2) {
    return null;
  }

  const parse = (part: string): number[] =>
    part ? part.split(":").map((group) => Number.parseInt(group || "0", 16)) : [];
  const head = parse(halves[0]!);
  const tail = halves.length === 2 ? parse(halves[1]!) : [];
  const fill = 8 - head.length - tail.length;
  if ((halves.length === 1 && head.length !== 8) || fill < 0) {
    return null;
  }

  const zeros = Array.from({ length: halves.length === 2 ? fill : 0 }, () => 0);
  const groups = [...head, ...zeros, ...tail];
  return groups.length === 8 && groups.every((group) => Number.isFinite(group)) ? groups : null;
}
