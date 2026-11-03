import path from "node:path";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HTTP_PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  HTTP_HOST: z.string().default("127.0.0.1"),
  DATA_DIR: z.string().default("./data"),
  WEIXIN_BASE_URL: z.string().url().default("https://ilinkai.weixin.qq.com"),
  WEIXIN_BOT_TYPE: z.string().default("3"),
  BOT_AGENT: z.string().default("WeChatPersonalGateway/0.1.0"),
  LOG_LEVEL: z.string().default("info"),
  MCP_ENABLED: z.enum(["true", "false"]).default("true").transform((v) => v === "true"),
  MCP_PATH: z.string().default("/mcp"),
  MCP_EVENTS_PATH_TOKEN: z.string().default("local-events-token-change-me"),
  SETUP_PATH_TOKEN: z.string().default("local-setup-token-change-me"),
  MCP_PROTOCOL_VERSIONS: z.string().default("2026-07-28"),
  MCP_MAX_BODY_BYTES: z.coerce.number().int().positive().default(262144),
  MCP_TOOL_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  MCP_SEND_RATE_LIMIT: z.string().default("30/1m"),
  MCP_ALLOWED_TARGETS: z.string().default("my-wechat"),
  WEIXIN_TARGETS_JSON: z.string().default(""),
  MCP_AUTH_MODE: z.enum(["none", "token"]).default("none"),
  MCP_DEV_API_KEY: z.string().default(""),
  MCP_ACCESS_TOKENS: z.string().default(""),
  BOOTSTRAP_ENABLED: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
  WEIXIN_ENCRYPTION_KEY: z.string().default(""),
  WEIXIN_LONG_POLL_TIMEOUT_MS: z.coerce.number().int().positive().default(35000),
  WEIXIN_SEND_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),
  WEIXIN_QUEUE_SIZE: z.coerce.number().int().positive().default(32),
  IDEMPOTENCY_TTL_MS: z.coerce.number().int().positive().default(86400000),
  PHONE_BRIDGE_TOKEN: z.string().default(""),
  PHONE_REPLY_TIMEOUT_MS: z.coerce.number().int().min(5000).max(120000).default(45000),
  SUBSCRIPTION_STORE_URL: z.string().url().optional(),
  TRUSTED_HOSTS: z.string().default("127.0.0.1,localhost"),
});

export type Config = {
  nodeEnv: "development" | "test" | "production";
  httpPort: number;
  httpHost: string;
  dataDir: string;
  weixinBaseUrl: string;
  weixinBotType: string;
  botAgent: string;
  logLevel: string;
  mcpEnabled: boolean;
  mcpPath: string;
  mcpEventsPath: string;
  setupPath: string;
  mcpProtocolVersions: string[];
  mcpMaxBodyBytes: number;
  mcpToolTimeoutMs: number;
  mcpSendRateLimit: string;
  allowedTargets: string[];
  targets: Array<{ target: string; displayName: string; fromUserId?: string; enabled?: boolean }>;
  authMode: "none" | "token";
  bootstrapEnabled: boolean;
  devApiKey?: string;
  accessTokens: Record<string, { id: string; scopes: string[]; targets: string[] }>;
  encryptionKey?: string;
  longPollTimeoutMs: number;
  sendTimeoutMs: number;
  queueSize: number;
  idempotencyTtlMs: number;
  phoneBridgeToken?: string;
  phoneReplyTimeoutMs: number;
  subscriptionStoreUrl?: string;
  trustedHosts: string[];
};

function parseJson<T>(value: string, fallback: T, name: string): T {
  if (!value.trim()) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    throw new Error(`${name} must be valid JSON: ${String(error)}`);
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.parse(env);
  const targets = parseJson<Config["targets"]>(parsed.WEIXIN_TARGETS_JSON, [], "WEIXIN_TARGETS_JSON");
  const accessTokens = parseJson<Config["accessTokens"]>(parsed.MCP_ACCESS_TOKENS, {}, "MCP_ACCESS_TOKENS");
  const encryptionKey = parsed.WEIXIN_ENCRYPTION_KEY.trim() || undefined;
  const devApiKey = parsed.MCP_DEV_API_KEY.trim() || undefined;
  const phoneBridgeToken = parsed.PHONE_BRIDGE_TOKEN.trim() || undefined;
  const config: Config = {
    nodeEnv: parsed.NODE_ENV,
    httpPort: parsed.HTTP_PORT,
    httpHost: parsed.HTTP_HOST,
    dataDir: path.resolve(parsed.DATA_DIR),
    weixinBaseUrl: parsed.WEIXIN_BASE_URL.replace(/\/$/, ""),
    weixinBotType: parsed.WEIXIN_BOT_TYPE,
    botAgent: parsed.BOT_AGENT,
    logLevel: parsed.LOG_LEVEL,
    mcpEnabled: parsed.MCP_ENABLED,
    mcpPath: parsed.MCP_PATH.startsWith("/") ? parsed.MCP_PATH : `/${parsed.MCP_PATH}`,
    mcpEventsPath: `/mcp/events/${parsed.MCP_EVENTS_PATH_TOKEN}`,
    setupPath: `/setup/${parsed.SETUP_PATH_TOKEN}`,
    mcpProtocolVersions: parsed.MCP_PROTOCOL_VERSIONS.split(",").map((v) => v.trim()).filter(Boolean),
    mcpMaxBodyBytes: parsed.MCP_MAX_BODY_BYTES,
    mcpToolTimeoutMs: parsed.MCP_TOOL_TIMEOUT_MS,
    mcpSendRateLimit: parsed.MCP_SEND_RATE_LIMIT,
    allowedTargets: parsed.MCP_ALLOWED_TARGETS.split(",").map((v) => v.trim()).filter(Boolean),
    targets,
    authMode: parsed.MCP_AUTH_MODE,
    bootstrapEnabled: parsed.BOOTSTRAP_ENABLED,
    ...(devApiKey ? { devApiKey } : {}),
    accessTokens,
    ...(encryptionKey ? { encryptionKey } : {}),
    longPollTimeoutMs: parsed.WEIXIN_LONG_POLL_TIMEOUT_MS,
    sendTimeoutMs: parsed.WEIXIN_SEND_TIMEOUT_MS,
    queueSize: parsed.WEIXIN_QUEUE_SIZE,
    idempotencyTtlMs: parsed.IDEMPOTENCY_TTL_MS,
    ...(phoneBridgeToken ? { phoneBridgeToken } : {}),
    phoneReplyTimeoutMs: parsed.PHONE_REPLY_TIMEOUT_MS,
    ...(parsed.SUBSCRIPTION_STORE_URL ? { subscriptionStoreUrl: parsed.SUBSCRIPTION_STORE_URL } : {}),
    trustedHosts: parsed.TRUSTED_HOSTS.split(",").map((v) => v.trim()).filter(Boolean),
  };
  validateConfig(config);
  return config;
}

export function validateConfig(config: Config): void {
  if (config.mcpProtocolVersions.length === 0) throw new Error("MCP_PROTOCOL_VERSIONS must not be empty");
  if (config.allowedTargets.length === 0) throw new Error("MCP_ALLOWED_TARGETS must not be empty");
  if (config.nodeEnv === "production" && config.authMode === "none") {
    throw new Error("MCP_AUTH_MODE=none is only allowed outside production");
  }
  if (config.nodeEnv === "production" && !config.encryptionKey) {
    throw new Error("WEIXIN_ENCRYPTION_KEY is required in production");
  }
  const privatePaths: Array<[string, string]> = [["MCP_EVENTS_PATH_TOKEN", config.mcpEventsPath.split("/").at(-1)!], ["SETUP_PATH_TOKEN", config.setupPath.split("/").at(-1)!]];
  for (const [name, token] of privatePaths) {
    if (!/^[A-Za-z0-9._~-]{20,}$/.test(token)) throw new Error(`${name} must be at least 20 URL-safe characters`);
  }
  for (const target of config.targets) {
    if (!config.allowedTargets.includes(target.target)) continue;
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(target.target)) {
      throw new Error(`invalid target alias: ${target.target}`);
    }
  }
  if (config.phoneBridgeToken && config.phoneBridgeToken.length < 32) {
    throw new Error("PHONE_BRIDGE_TOKEN must be at least 32 characters");
  }
  if (config.subscriptionStoreUrl && !config.phoneBridgeToken) {
    throw new Error("SUBSCRIPTION_STORE_URL requires PHONE_BRIDGE_TOKEN");
  }
}
