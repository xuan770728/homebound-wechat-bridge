import { loadConfig } from "./config.js";
import { createLogger } from "./observability/logger.js";
import { IdempotencyStore } from "./persistence/idempotency-store.js";
import { AccountRuntime } from "./weixin/account-runtime.js";
import { QrLoginService } from "./weixin/qr-login-service.js";
import { MessageCommandService } from "./application/message-command-service.js";
import { SendQueue } from "./application/send-queue.js";
import { McpServerAdapter } from "./adapters/mcp-server.js";
import { buildHttpServer } from "./adapters/http-server.js";
import { parseRateLimit, SlidingWindowRateLimiter } from "./security/rate-limit.js";
import { BootstrapDiscovery } from "./application/bootstrap-discovery.js";
import { WechatBridgeService } from "./bridge/service.js";
import { McpEventsAdapter } from "./bridge/mcp-events-adapter.js";

const config = loadConfig();
const logger = createLogger(config);
const bootstrap = new BootstrapDiscovery();
let bridge: WechatBridgeService | undefined;
const runtime = new AccountRuntime(config, logger, async (message) => {
  const { fromUserId, contextToken } = message;
  bootstrap.observeInbound(fromUserId, contextToken);
  await bridge?.onInbound(message);
});
const idempotency = new IdempotencyStore(config.dataDir, config.encryptionKey);
const queue = new SendQueue(config.queueSize);
const sendRate = parseRateLimit(config.mcpSendRateLimit);
const commands = new MessageCommandService({ config, client: runtime.client, targets: runtime.targets, idempotency, queue, status: runtime.status, logger, sendLimiter: new SlidingWindowRateLimiter(sendRate.max, sendRate.windowMs), getCredential: () => { const credential = runtime.currentCredential(); return credential ? { baseUrl: credential.baseUrl, botToken: credential.botToken } : undefined; } });
const qr = new QrLoginService(config, runtime.client, (credential) => runtime.applyCredential(credential));
const mcp = new McpServerAdapter({ config, status: runtime.status, targets: runtime.targets, commands });
bridge = new WechatBridgeService({ config, commands, targets: runtime.targets, logger });
const eventsMcp = new McpEventsAdapter(bridge);
const app = buildHttpServer({ config, logger, runtime, commands, mcp, qr, bootstrap, bridge, eventsMcp });

await runtime.start();
await app.listen({ port: config.httpPort, host: config.httpHost });
logger.info({ host: config.httpHost, port: config.httpPort }, "homebound WeChat bridge started");

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, "gateway shutting down");
  try { bridge?.stop(); queue.stopAccepting(); await app.close(); await runtime.stopPoller(); await queue.drain(); await runtime.notifyStop(); runtime.finishStop(); } finally { process.exitCode = 0; }
}
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
