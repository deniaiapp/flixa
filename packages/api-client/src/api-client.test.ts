import { describe, expect, it, vi } from "vitest";
import {
  assertSecureBaseUrl,
  createClientFetch,
  createClientHeaders,
  describeDeviceAuthKeyProblem,
  fetchDeniUsage,
  fetchFlixaModels,
  findFlixaErrorCode,
  findUsageLimitExceeded,
  FlixaApiError,
  getBillingUrl,
  getDeviceAuthVerificationUrl,
  getRemainingPercent,
  getUsageSummary,
  initiateDeviceAuth,
  parseDeniUsageInfo,
  parseRetryAfterMs,
  pollDeviceAuth,
  readFlixaApiError,
  resolveDeniAiBaseUrl,
  resolveFlixaApiRoot,
  resolveFlixaBaseUrl,
  usageUnitsToUsd,
  waitForDeviceAuth,
  type DeviceAuthPollResult,
} from "./index";

type FetchInput = Parameters<typeof fetch>[0];

interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(body === undefined ? "" : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function mockFetch(...responses: Array<Response | Error>) {
  const requests: RecordedRequest[] = [];
  const queue = [...responses];
  const fetchMock = vi.fn(async (input: FetchInput, init?: RequestInit) => {
    requests.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: { ...(init?.headers as Record<string, string>) },
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    const next = queue.shift();
    if (!next) {
      throw new Error("Unexpected request");
    }
    if (next instanceof Error) {
      throw next;
    }
    return next;
  });
  return { fetch: fetchMock as unknown as typeof fetch, requests };
}

const noSleep = async () => {};

describe("urls", () => {
  it("uses the production URLs by default", () => {
    expect(resolveFlixaBaseUrl(undefined, {})).toBe("https://flixa-api.deniai.app/v1/agent");
    expect(resolveFlixaApiRoot(undefined, {})).toBe("https://flixa-api.deniai.app/v1");
    expect(resolveDeniAiBaseUrl(undefined, {})).toBe("https://deniai.app");
  });

  it("honours FLIXA_BASE_URL and DENI_AI_BASE_URL", () => {
    const env = {
      FLIXA_BASE_URL: "https://staging.example.com/v1/agent/",
      DENI_AI_BASE_URL: "https://staging.deniai.example/",
    };
    expect(resolveFlixaBaseUrl(undefined, env)).toBe("https://staging.example.com/v1/agent");
    expect(resolveFlixaApiRoot(undefined, env)).toBe("https://staging.example.com/v1");
    expect(resolveDeniAiBaseUrl(undefined, env)).toBe("https://staging.deniai.example");
    expect(resolveFlixaBaseUrl("https://override.example/v1/agent", env)).toBe(
      "https://override.example/v1/agent",
    );
  });

  it("enforces https except for loopback or an explicit opt-out", () => {
    expect(() => assertSecureBaseUrl("http://api.example.com", {})).toThrow(/Refusing/);
    expect(assertSecureBaseUrl("http://localhost:8787/v1", {})).toBe("http://localhost:8787/v1");
    expect(
      assertSecureBaseUrl("http://api.example.com", { FLIXA_ALLOW_INSECURE_BASE_URL: "1" }),
    ).toBe("http://api.example.com");
    expect(() =>
      resolveDeniAiBaseUrl(undefined, { DENI_AI_BASE_URL: "http://evil.test" }),
    ).toThrow();
  });

  it("builds the verification and billing URLs", () => {
    expect(getDeviceAuthVerificationUrl("AB CD", "https://deniai.app")).toBe(
      "https://deniai.app/flixa/authorize?code=AB%20CD",
    );
    expect(getBillingUrl("https://deniai.app")).toBe("https://deniai.app/settings/billing");
  });
});

describe("client headers", () => {
  it("matches the CLI headers", () => {
    expect(
      createClientHeaders({ kind: "cli", version: "0.4.1", platform: "linux", arch: "x64" }),
    ).toEqual({
      "User-Agent": "flixa-cli/0.4.1 (linux-x64)",
      "x-client": "flixa-cli",
      "x-flixa-client": "cli/0.4.1",
      originator: "flixa-cli",
    });
  });

  it("matches the VS Code headers", () => {
    expect(createClientHeaders({ kind: "vscode", version: "0.9.5", platform: "win32" })).toEqual({
      "User-Agent": "flixa-vscode/0.9.5",
      "x-flixa-client": "vscode/0.9.5 (win32)",
      "x-client": "flixa-vscode",
    });
  });

  it("matches the Zed headers", () => {
    expect(createClientHeaders({ kind: "zed", version: "0.8.2" })).toEqual({
      "User-Agent": "flixa-zed/0.8.2",
      "x-flixa-client": "zed/0.8.2",
      "x-client": "flixa-zed",
    });
  });

  it("re-applies client headers last in the fetch wrapper", async () => {
    const { fetch, requests } = mockFetch(jsonResponse(200, {}));
    const clientFetch = createClientFetch({ "User-Agent": "flixa-zed/1" }, fetch);
    await clientFetch("https://example.com", {
      headers: new Headers({ "User-Agent": "ai/1", "X-Other": "1" }),
    });
    expect(requests[0]?.headers).toEqual({
      "user-agent": "ai/1",
      "x-other": "1",
      "User-Agent": "flixa-zed/1",
    });
  });
});

describe("errors", () => {
  it("parses the OpenAI-style envelope", async () => {
    const error = await readFlixaApiError(
      jsonResponse(403, {
        error: {
          message: "Update required",
          type: "invalid_request_error",
          param: null,
          code: "client_update_required",
        },
      }),
    );
    expect(error).toBeInstanceOf(FlixaApiError);
    expect(error.status).toBe(403);
    expect(error.code).toBe("client_update_required");
    expect(error.type).toBe("invalid_request_error");
    expect(error.message).toBe("Update required");
  });

  it("exposes USAGE_LIMIT_EXCEEDED details", async () => {
    const error = await readFlixaApiError(
      jsonResponse(429, {
        error: {
          message: "Monthly usage limit reached",
          type: "quota_exceeded",
          param: null,
          code: "USAGE_LIMIT_EXCEEDED",
          category: "basic",
          tier: "go",
          canVerifyForBoost: false,
          canUpgrade: true,
          upgradeUrl: "https://deniai.app/settings/billing",
        },
      }),
    );
    expect(error.usageLimit).toEqual({
      message: "Monthly usage limit reached",
      type: "quota_exceeded",
      code: "USAGE_LIMIT_EXCEEDED",
      category: "basic",
      tier: "go",
      canVerifyForBoost: false,
      canUpgrade: true,
      verifyUrl: undefined,
      upgradeUrl: "https://deniai.app/settings/billing",
    });
  });

  it("falls back to the raw text and status", async () => {
    const error = await readFlixaApiError(
      new Response("Bad gateway", { status: 502, statusText: "Bad Gateway" }),
    );
    expect(error.code).toBeNull();
    expect(error.message).toBe("Bad gateway");
  });

  it("finds codes in AI SDK style errors and cause chains", () => {
    const apiCallError = Object.assign(new Error("Forbidden"), {
      responseBody: JSON.stringify({ error: { code: "service_unavailable", message: "x" } }),
    });
    expect(findFlixaErrorCode(new Error("wrapped", { cause: apiCallError }))).toBe(
      "service_unavailable",
    );
    expect(
      findUsageLimitExceeded(
        new Error(JSON.stringify({ error: { code: "USAGE_LIMIT_EXCEEDED", message: "limit" } })),
      )?.message,
    ).toBe("limit");
  });

  it("parses Retry-After", () => {
    expect(parseRetryAfterMs("12")).toBe(12_000);
    expect(parseRetryAfterMs(new Date(10_000).toUTCString(), 4_000)).toBe(6_000);
    expect(parseRetryAfterMs(null)).toBeNull();
  });
});

describe("device auth", () => {
  it("initiates and builds the verification URL", async () => {
    const { fetch, requests } = mockFetch(
      jsonResponse(200, { userCode: "ABCD-1234", deviceCode: "dev-1", expiresIn: 900 }),
    );
    const session = await initiateDeviceAuth({ fetch, deniAiBaseUrl: "https://deniai.app" });
    expect(session).toEqual({
      userCode: "ABCD-1234",
      deviceCode: "dev-1",
      expiresIn: 900,
      verificationUrl: "https://deniai.app/flixa/authorize?code=ABCD-1234",
    });
    expect(requests[0]).toMatchObject({
      url: "https://deniai.app/api/device-auth",
      method: "POST",
      body: { action: "initiate" },
    });
  });

  it.each<[Response, DeviceAuthPollResult]>([
    [jsonResponse(200, { approved: false }), { status: "pending" }],
    [
      jsonResponse(200, { approved: true, apiKey: "sk-1", apiKeyId: "key_1" }),
      { status: "approved", apiKey: "sk-1", apiKeyId: "key_1" },
    ],
    [
      jsonResponse(200, { approved: true, apiKeyUnavailable: true }),
      { status: "api_key_unavailable" },
    ],
    [jsonResponse(404, { error: "Invalid device code" }), { status: "invalid_code" }],
    [jsonResponse(410, { error: "Expired" }), { status: "expired" }],
    [
      jsonResponse(429, { error: "Slow down" }, { "Retry-After": "7" }),
      { status: "rate_limited", retryAfterMs: 7_000 },
    ],
    [
      jsonResponse(403, {
        code: "API_KEY_LIMIT_REACHED",
        error: "You have reached the maximum number of API keys.",
        apiKeys: [
          {
            id: "k1",
            name: "Laptop",
            keyPrefix: "sk-abc",
            lastUsedAt: "2026-10-01T00:00:00Z",
            createdAt: "2026-01-01T00:00:00Z",
          },
        ],
      }),
      {
        status: "api_key_limit_reached",
        message: "You have reached the maximum number of API keys.",
        apiKeys: [
          {
            id: "k1",
            name: "Laptop",
            keyPrefix: "sk-abc",
            lastUsedAt: "2026-10-01T00:00:00Z",
            createdAt: "2026-01-01T00:00:00Z",
          },
        ],
      },
    ],
  ])("maps poll responses", async (response, expected) => {
    const { fetch, requests } = mockFetch(response);
    await expect(
      pollDeviceAuth("dev-1", { fetch, deniAiBaseUrl: "https://deniai.app" }),
    ).resolves.toEqual(expected);
    expect(requests[0]?.body).toEqual({ action: "poll", deviceCode: "dev-1" });
  });

  it("throws for other server errors", async () => {
    const { fetch } = mockFetch(jsonResponse(500, { error: { message: "boom" } }));
    await expect(pollDeviceAuth("dev-1", { fetch })).rejects.toBeInstanceOf(FlixaApiError);
  });

  it("polls until approved, respecting Retry-After", async () => {
    const { fetch } = mockFetch(
      jsonResponse(200, { approved: false }),
      jsonResponse(429, {}, { "Retry-After": "30" }),
      new Error("network down"),
      jsonResponse(200, { approved: true, apiKey: "sk-1", apiKeyId: "key_1" }),
    );
    const sleeps: number[] = [];
    const onPollError = vi.fn();
    const outcome = await waitForDeviceAuth(
      { deviceCode: "dev-1", expiresIn: 900 },
      { fetch, sleep: async (ms) => void sleeps.push(ms), onPollError },
    );
    expect(outcome).toEqual({ status: "approved", apiKey: "sk-1", apiKeyId: "key_1" });
    expect(sleeps).toEqual([5_000, 5_000, 30_000, 5_000]);
    expect(onPollError).toHaveBeenCalledTimes(1);
  });

  it("returns the typed key outcomes", async () => {
    const unavailable = await waitForDeviceAuth(
      { deviceCode: "d", expiresIn: 900 },
      {
        fetch: mockFetch(jsonResponse(200, { approved: true, apiKeyUnavailable: true })).fetch,
        sleep: noSleep,
      },
    );
    expect(unavailable).toEqual({ status: "api_key_unavailable" });
    if (unavailable.status !== "api_key_unavailable") throw new Error("unreachable");
    expect(describeDeviceAuthKeyProblem(unavailable, "https://deniai.app")).toContain(
      "Revoke an unused API key at https://deniai.app",
    );

    const limit = await waitForDeviceAuth(
      { deviceCode: "d", expiresIn: 900 },
      {
        fetch: mockFetch(
          jsonResponse(403, {
            code: "API_KEY_LIMIT_REACHED",
            error: "Too many keys.",
            apiKeys: [
              { id: "k1", name: "Laptop", keyPrefix: "sk-abc", lastUsedAt: null, createdAt: null },
            ],
          }),
        ).fetch,
        sleep: noSleep,
      },
    );
    expect(limit.status).toBe("api_key_limit_reached");
    if (limit.status !== "api_key_limit_reached") throw new Error("unreachable");
    const message = describeDeviceAuthKeyProblem(limit, "https://deniai.app");
    expect(message).toContain("Too many keys. Revoke an API key at https://deniai.app");
    expect(message).toContain("- Laptop (sk-abc…)");
  });

  it("gives up after repeated failures, on timeout, and on cancel", async () => {
    const failing = await waitForDeviceAuth(
      { deviceCode: "d", expiresIn: 900 },
      {
        fetch: mockFetch(new Error("a"), new Error("b")).fetch,
        sleep: noSleep,
        maxConsecutiveFailures: 2,
      },
    );
    expect(failing.status).toBe("error");

    let clock = 0;
    const timedOut = await waitForDeviceAuth(
      { deviceCode: "d", expiresIn: 10 },
      {
        fetch: mockFetch(
          jsonResponse(200, { approved: false }),
          jsonResponse(200, { approved: false }),
        ).fetch,
        sleep: async (ms) => {
          clock += ms;
        },
        now: () => clock,
      },
    );
    expect(timedOut).toEqual({ status: "timed_out" });

    const controller = new AbortController();
    controller.abort();
    const cancelled = await waitForDeviceAuth(
      { deviceCode: "d", expiresIn: 900 },
      { fetch: mockFetch().fetch, signal: controller.signal },
    );
    expect(cancelled).toEqual({ status: "cancelled" });
  });
});

describe("usage", () => {
  const payload = {
    tier: "go",
    planId: "go_monthly",
    status: "active",
    hasVerifiedPaymentMethod: true,
    cardVerifiedAt: "2026-10-01T00:00:00Z",
    verifyUrl: null,
    upgradeUrl: "https://deniai.app/settings/billing",
    isTeam: false,
    periodEnd: "2026-12-01T00:00:00Z",
    maxModeEnabled: false,
    maxModeEligible: true,
    pool: {
      limit: 10_000_000,
      used: 2_500_000,
      remaining: 7_500_000,
      periodEnd: "2026-12-01T00:00:00Z",
    },
    usage: [
      {
        category: "basic",
        unit: "units",
        limit: 4_000_000,
        used: 1_000_000,
        remaining: 3_000_000,
        periodStart: "2026-11-01T00:00:00Z",
        periodEnd: "2026-12-01T00:00:00Z",
      },
    ],
  };

  it("fetches /v1/deni/usage with bearer auth and client headers", async () => {
    const { fetch, requests } = mockFetch(jsonResponse(200, payload));
    const usage = await fetchDeniUsage({
      apiKey: "sk-1",
      fetch,
      baseUrl: "https://flixa-api.deniai.app/v1/agent",
      headers: { "x-client": "flixa-cli" },
    });
    expect(requests[0]).toMatchObject({
      url: "https://flixa-api.deniai.app/v1/deni/usage",
      method: "GET",
      headers: { Authorization: "Bearer sk-1", "x-client": "flixa-cli" },
    });
    expect(usage).toEqual(payload);
  });

  it("falls back to billing-status only on 404", async () => {
    const { fetch, requests } = mockFetch(jsonResponse(404, {}), jsonResponse(200, payload));
    await fetchDeniUsage({
      apiKey: "sk-1",
      fetch,
      baseUrl: "https://flixa-api.deniai.app/v1/agent",
    });
    expect(requests.map((request) => request.url)).toEqual([
      "https://flixa-api.deniai.app/v1/deni/usage",
      "https://flixa-api.deniai.app/v1/deni/billing-status",
    ]);

    const failing = mockFetch(
      jsonResponse(401, { error: { code: "invalid_key", message: "bad key" } }),
    );
    await expect(
      fetchDeniUsage({
        apiKey: "sk-1",
        fetch: failing.fetch,
        baseUrl: "https://flixa-api.deniai.app/v1/agent",
      }),
    ).rejects.toMatchObject({ status: 401, code: "invalid_key" });
    expect(failing.requests).toHaveLength(1);
  });

  it("prefers the pool and falls back to the basic usage item", () => {
    const withPool = parseDeniUsageInfo(payload);
    expect(getUsageSummary(withPool)).toEqual(payload.pool);
    expect(getRemainingPercent(getUsageSummary(withPool)!)).toBe(75);

    const withoutPool = parseDeniUsageInfo({ ...payload, pool: undefined });
    expect(withoutPool.pool).toBeUndefined();
    expect(getUsageSummary(withoutPool)).toEqual({
      limit: 4_000_000,
      used: 1_000_000,
      remaining: 3_000_000,
      periodEnd: "2026-12-01T00:00:00Z",
    });
  });

  it("fills defaults for older payloads", () => {
    const usage = parseDeniUsageInfo({
      tier: "plus",
      usage: [
        { category: "basic", limit: null, used: 5, periodStart: "x" },
        { category: "other", used: 1 },
      ],
    });
    expect(usage).toMatchObject({
      tier: "plus",
      planId: null,
      isTeam: false,
      maxModeEnabled: false,
    });
    expect(usage.usage).toEqual([
      {
        category: "basic",
        unit: "units",
        limit: null,
        used: 5,
        remaining: null,
        periodStart: "x",
        periodEnd: null,
      },
    ]);
    expect(getRemainingPercent(getUsageSummary(usage)!)).toBeNull();
  });

  it("converts units to dollars", () => {
    expect(usageUnitsToUsd(2_000_000)).toBe(1);
  });
});

describe("models", () => {
  it("fetches /v1/models and normalizes entries", async () => {
    const { fetch, requests } = mockFetch(
      jsonResponse(200, [
        {
          id: "openai/gpt-6-luna",
          label: "GPT-6 Luna",
          description: "Flagship",
          tags: ["coding"],
          efforts: ["low", "medium", "high"],
          contextWindow: 400_000,
          usageTier: 2,
          tier: "free",
          premium: false,
          tokenUsageMultiplier: 1.5,
          default: true,
        },
        { id: "anthropic/claude-opus", label: "Opus", efforts: false, tier: "pro", premium: true },
      ]),
    );
    const models = await fetchFlixaModels({
      apiKey: "sk-1",
      fetch,
      baseUrl: "https://flixa-api.deniai.app/v1/agent",
    });
    expect(requests[0]?.url).toBe("https://flixa-api.deniai.app/v1/models");
    expect(requests[0]?.headers["Authorization"]).toBe("Bearer sk-1");
    expect(models[0]).toEqual({
      id: "openai/gpt-6-luna",
      label: "GPT-6 Luna",
      description: "Flagship",
      tags: ["coding"],
      efforts: ["low", "medium", "high"],
      contextWindow: 400_000,
      usageTier: 2,
      tier: "free",
      premium: false,
      tokenUsageMultiplier: 1.5,
      default: true,
    });
    expect(models[1]).toMatchObject({
      id: "anthropic/claude-opus",
      efforts: false,
      tier: "pro",
      premium: true,
      usageTier: null,
      default: false,
    });
  });

  it("sends no Authorization header without an API key and only calls /v1/models", async () => {
    const { fetch, requests } = mockFetch(jsonResponse(404, { error: { message: "nope" } }));
    await expect(
      fetchFlixaModels({ fetch, baseUrl: "https://flixa-api.deniai.app/v1/agent" }),
    ).rejects.toBeInstanceOf(FlixaApiError);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.headers["Authorization"]).toBeUndefined();
  });
});
