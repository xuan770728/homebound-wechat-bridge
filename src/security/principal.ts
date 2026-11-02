import type { Config } from "../config.js";
import type { Principal } from "../types.js";
import { GatewayError } from "../observability/redaction.js";

type HeaderRequest = { headers: Record<string, string | string[] | undefined> };

function header(request: HeaderRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function bearer(request: HeaderRequest): string | undefined {
  const value = header(request, "authorization");
  return value?.startsWith("Bearer ") ? value.slice(7).trim() : undefined;
}

export function authenticate(request: HeaderRequest, config: Config): Principal {
  const token = bearer(request);
  if (config.authMode === "none") {
    if (config.nodeEnv === "production") throw new GatewayError("AUTH_REQUIRED", "authentication is required", 401);
    if (config.devApiKey && token !== config.devApiKey) throw new GatewayError("AUTH_REQUIRED", "development API key is required", 401);
    return { id: "local-development", scopes: new Set(["mcp:read", "mcp:send"]), targets: new Set(config.allowedTargets), authType: "none" };
  }
  if (!token) throw new GatewayError("AUTH_REQUIRED", "Bearer token is required", 401);
  const mapped = config.accessTokens[token];
  if (!mapped) throw new GatewayError("INVALID_TOKEN", "invalid access token", 401);
  return { id: mapped.id, scopes: new Set(mapped.scopes), targets: new Set(mapped.targets), authType: "bearer" };
}

export function requireScope(principal: Principal, scope: string): void {
  if (!principal.scopes.has(scope)) throw new GatewayError("FORBIDDEN", `scope ${scope} is required`, 403);
}

export function canTarget(principal: Principal, target: string): boolean {
  return principal.targets.has("*") || principal.targets.has(target);
}

export function validateOriginAndHost(request: HeaderRequest, config: Config): void {
  const host = header(request, "host")?.split(":")[0] ?? "";
  const trustAll = config.trustedHosts.includes("*");
  if (host && !trustAll && !config.trustedHosts.includes(host)) throw new GatewayError("INVALID_HOST", "untrusted Host", 400);
  const origin = header(request, "origin");
  if (origin) {
    try {
      const originHost = new URL(origin).hostname;
      if (!trustAll && !config.trustedHosts.includes(originHost)) throw new GatewayError("INVALID_ORIGIN", "untrusted Origin", 403);
    } catch (error) {
      if (error instanceof GatewayError) throw error;
      throw new GatewayError("INVALID_ORIGIN", "invalid Origin", 403);
    }
  }
}
