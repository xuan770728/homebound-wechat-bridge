import { GatewayError } from "../observability/redaction.js";

export class SlidingWindowRateLimiter {
  private readonly hits = new Map<string, number[]>();
  constructor(private readonly max: number, private readonly windowMs: number) {}
  consume(key: string): void {
    const now = Date.now();
    const current = (this.hits.get(key) ?? []).filter((timestamp) => timestamp > now - this.windowMs);
    if (current.length >= this.max) throw new GatewayError("RATE_LIMITED", "send rate limit exceeded", 429);
    current.push(now);
    this.hits.set(key, current);
  }
}

export function parseRateLimit(value: string): { max: number; windowMs: number } {
  const match = /^(\d+)\/(\d+)(s|m|h)$/.exec(value.trim());
  if (!match) throw new Error(`invalid rate limit: ${value}`);
  const unit = match[3] === "s" ? 1000 : match[3] === "m" ? 60_000 : 3_600_000;
  return { max: Number(match[1]), windowMs: Number(match[2]) * unit };
}
