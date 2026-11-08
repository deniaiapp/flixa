export const MAX_TOOL_OUTPUT_CHARS = 16_000;
export const MAX_READ_CHARS = 24_000;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Parse a function_call `arguments` string; anything that is not a JSON object becomes `{}`. */
export function parseToolArguments(argumentsText: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(argumentsText) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function getRequiredString(
  args: Record<string, unknown>,
  key: string,
  allowEmpty = false,
): string {
  const value = args[key];
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    throw new Error(`Missing required string: ${key}`);
  }
  return value;
}

export function getOptionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function getOptionalInteger(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

export function truncate(value: string, maxLength = MAX_TOOL_OUTPUT_CHARS): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength)}\n...truncated...`;
}

export function shorten(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value;
}

export function toJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) {
    return 0;
  }
  let count = 0;
  let index = 0;
  while (true) {
    const found = haystack.indexOf(needle, index);
    if (found === -1) {
      return count;
    }
    count += 1;
    index = found + needle.length;
  }
}

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

export function createAbortError(message = "Aborted"): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Convert a glob (`*`, `**`, `?`) to an anchored, case-insensitive RegExp over `/` paths. */
export function globToRegExp(pattern: string): RegExp {
  const normalized = pattern.replace(/\\/g, "/");
  const anchored =
    normalized.includes("/") || normalized.includes("**") ? normalized : `**/${normalized}`;
  let expression = "^";
  for (let index = 0; index < anchored.length; index += 1) {
    const character = anchored[index] as string;
    if (character === "*" && anchored[index + 1] === "*") {
      index += 2;
      if (anchored[index] === "/") {
        expression += "(?:.*/)?";
      } else {
        expression += ".*";
        index -= 1;
      }
    } else if (character === "*") {
      expression += "[^/]*";
    } else if (character === "?") {
      expression += "[^/]";
    } else if (character === "{") {
      const close = anchored.indexOf("}", index);
      if (close > index) {
        const alternatives = anchored
          .slice(index + 1, close)
          .split(",")
          .map((part) => part.replace(/[.+^$()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*"));
        expression += `(?:${alternatives.join("|")})`;
        index = close;
      } else {
        expression += "\\{";
      }
    } else {
      expression += character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`${expression}$`, "i");
}
