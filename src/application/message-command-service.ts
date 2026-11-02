import crypto from "node:crypto";
import type { AppLogger } from "../observability/logger.js";
import { GatewayError, safeErrorCode } from "../observability/redaction.js";
import { IdempotencyStore, hashIdempotencyKey } from "../persistence/idempotency-store.js";
import type { Principal, SendResult } from "../types.js";
import { buildTextMessage } from "../weixin/message-builder.js";
import { mapUpstreamError, ProtocolClient, UpstreamError } from "../weixin/protocol-client.js";
import { TargetRegistry } from "./target-registry.js";
import { SendQueue, QueueFullError } from "./send-queue.js";
import { StatusService } from "./status-service.js";
import type { Config } from "../config.js";
import type { SlidingWindowRateLimiter } from "../security/rate-limit.js";

export class MessageCommandService {
  private readonly locks = new Map<string, Promise<unknown>>();
  constructor(private readonly options: { config: Config; client: ProtocolClient; targets: TargetRegistry; idempotency: IdempotencyStore; queue: SendQueue; status: StatusService; logger: AppLogger; getCredential: () => { baseUrl: string; botToken: string } | undefined; sendLimiter?: SlidingWindowRateLimiter }) {}

  async sendText(principal: Principal, requestId: string, input: { target: string; text: string; idempotencyKey: string }): Promise<SendResult> {
    this.validateInput(principal, input);
    const keyHash = hashIdempotencyKey(principal.id, input.target, input.idempotencyKey);
    const existing = this.options.idempotency.get(keyHash);
    if (existing) return { requestId: existing.requestId, target: existing.target, status: existing.status, ...(existing.messageId ? { messageId: existing.messageId } : {}), ...(existing.errorCode ? { errorCode: existing.errorCode } : {}) };
    this.options.sendLimiter?.consume(`${principal.id}\0${input.target}`);
    const locked = this.locks.get(keyHash);
    if (locked) return { requestId, target: input.target, status: "IN_PROGRESS" };
    const run = this.execute(principal, requestId, input, keyHash);
    this.locks.set(keyHash, run);
    try { return await run; } finally { this.locks.delete(keyHash); }
  }

  async showTyping(targetAlias: string): Promise<boolean> {
    let target: ReturnType<TargetRegistry["resolve"]>;
    try { target = this.options.targets.resolve(targetAlias); } catch { return false; }
    const credential = this.options.getCredential();
    if (!credential) return false;
    return this.options.client.showTyping({
      baseUrl: credential.baseUrl,
      token: credential.botToken,
      toUserId: target.userId,
      contextToken: target.contextToken,
      timeoutMs: 5000,
    });
  }

  private validateInput(principal: Principal, input: { target: string; text: string; idempotencyKey: string }): void {
    if (!principal.scopes.has("mcp:send")) throw new GatewayError("FORBIDDEN", "mcp:send scope is required", 403);
    if (!principal.targets.has("*") && !principal.targets.has(input.target)) throw new GatewayError("TARGET_NOT_ALLOWED", "target is not authorized", 403);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(input.target)) throw new GatewayError("INVALID_TARGET", "invalid target alias", 400);
    if (input.text.length < 1 || input.text.length > 4000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(input.text)) throw new GatewayError("INVALID_TEXT", "text must be 1-4000 characters without control characters", 400);
    if (input.idempotencyKey.length < 8 || input.idempotencyKey.length > 128) throw new GatewayError("INVALID_IDEMPOTENCY_KEY", "invalid idempotency key", 400);
  }

  private async execute(principal: Principal, requestId: string, input: { target: string; text: string; idempotencyKey: string }, keyHash: string): Promise<SendResult> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.options.config.idempotencyTtlMs).toISOString();
    const recordBase = { principalId: principal.id, keyHash, target: input.target, requestId, expiresAt, createdAt: now.toISOString(), updatedAt: now.toISOString() };
    let target: ReturnType<TargetRegistry["resolve"]>;
    try { target = this.options.targets.resolve(input.target); } catch (error) {
      const code = error instanceof Error ? error.message : "TARGET_CONTEXT_UNAVAILABLE";
      throw new GatewayError(code, code === "TARGET_NOT_ALLOWED" ? "target is not configured" : "target context is unavailable", 409);
    }
    const credential = this.options.getCredential();
    if (!credential) throw new GatewayError("AUTH_EXPIRED", "WeChat account is not online", 503);
    try {
      this.options.idempotency.put({ ...recordBase, status: "IN_PROGRESS" });
      const messageId = `wechat-personal-gateway-${crypto.randomUUID()}`;
      const receipt = await this.options.queue.enqueue(async () => this.options.client.sendText({ baseUrl: credential.baseUrl, token: credential.botToken, message: buildTextMessage({ toUserId: target.userId, text: input.text, contextToken: target.contextToken, clientId: messageId }), timeoutMs: this.options.config.sendTimeoutMs }));
      if (!receipt.confirmed) {
        const errorCode = "DELIVERY_UNCONFIRMED";
        this.options.idempotency.put({ ...recordBase, status: "UNKNOWN", errorCode, updatedAt: new Date().toISOString() });
        this.options.logger.warn({ requestId, principalId: principal.id, target: input.target, result: "UNKNOWN", errorCode }, "message accepted without delivery receipt");
        return { requestId, target: input.target, status: "UNKNOWN", errorCode };
      }
      const confirmedMessageId = receipt.messageId ?? messageId;
      this.options.idempotency.put({ ...recordBase, status: "SENT", messageId: confirmedMessageId, updatedAt: new Date().toISOString() });
      this.options.status.outbound();
      this.options.logger.info({ requestId, principalId: principal.id, target: input.target, result: "SENT" }, "message sent");
      return { requestId, target: input.target, status: "SENT", messageId: confirmedMessageId };
    } catch (error) {
      const unknown = error instanceof UpstreamError && (error.kind === "timeout" || error.kind === "network");
      const status = unknown ? "UNKNOWN" : "FAILED";
      const errorCode = error instanceof QueueFullError ? "SEND_QUEUE_FULL" : error instanceof UpstreamError && error.ret === -14 ? "AUTH_EXPIRED" : error instanceof UpstreamError ? "UPSTREAM_REJECTED" : safeErrorCode(error);
      this.options.idempotency.put({ ...recordBase, status, errorCode, updatedAt: new Date().toISOString() });
      if (error instanceof QueueFullError) throw new GatewayError(errorCode, "send queue is full", 429);
      if (unknown) return { requestId, target: input.target, status: "UNKNOWN", errorCode };
      throw mapUpstreamError(error);
    }
  }
}
