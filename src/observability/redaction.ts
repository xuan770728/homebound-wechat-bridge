const SENSITIVE_KEYS = /token|authorization|context|user.?id|password|secret|body|text|content/i;

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, SENSITIVE_KEYS.test(key) ? "[REDACTED]" : redact(item)]));
  }
  return value;
}

export function safeErrorCode(error: unknown): string {
  if (error instanceof GatewayError) return error.code;
  if (error instanceof Error && error.name === "AbortError") return "UPSTREAM_TIMEOUT";
  return "UPSTREAM_NETWORK_ERROR";
}

export class GatewayError extends Error {
  constructor(public readonly code: string, message: string, public readonly httpStatus = 400) { super(message); this.name = "GatewayError"; }
}
