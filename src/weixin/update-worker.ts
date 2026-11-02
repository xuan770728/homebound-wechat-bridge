import type { AppLogger } from "../observability/logger.js";
import type { ContextTokenStore } from "../persistence/context-token-store.js";
import type { CursorStore } from "../persistence/cursor-store.js";
import type { AccountStatus, InboundMessageHandler } from "../types.js";
import { ProtocolClient } from "./protocol-client.js";
import type { WeixinMessage } from "./protocol-types.js";
import { TargetRegistry } from "../application/target-registry.js";
import { StatusService } from "../application/status-service.js";

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("aborted")); }, { once: true });
  });
}

function messageText(message: WeixinMessage): string {
  return message.item_list?.find((item) => item.type === 1)?.text_item?.text ?? "";
}

export class UpdateWorker {
  private readonly abortController = new AbortController();
  private running = false;
  private completion?: Promise<void>;
  constructor(private readonly options: {
    client: ProtocolClient; cursorStore: CursorStore; contexts: ContextTokenStore; targets: TargetRegistry; status: StatusService; logger: AppLogger; baseUrl: string; token: string; accountId: string; longPollTimeoutMs: number; onInbound?: InboundMessageHandler;
  }) {}

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.options.status.setPollerStatus("STARTING");
    this.completion = this.loop();
  }
  async stop(): Promise<void> { if (!this.running && !this.completion) return; this.abortController.abort(); this.running = false; this.options.status.setPollerStatus("STOPPING"); await this.completion; this.completion = undefined; }

  private async loop(): Promise<void> {
    let cursor = this.options.cursorStore.read(this.options.accountId);
    let timeoutMs = this.options.longPollTimeoutMs;
    let failures = 0;
    while (!this.abortController.signal.aborted) {
      try {
        const response = await this.options.client.getUpdates({ baseUrl: this.options.baseUrl, token: this.options.token, cursor, abortSignal: this.abortController.signal, timeoutMs });
        if (response.longpolling_timeout_ms && response.longpolling_timeout_ms > 0) timeoutMs = response.longpolling_timeout_ms;
        if ((response.ret !== undefined && response.ret !== 0) || (response.errcode !== undefined && response.errcode !== 0)) {
          if (response.ret === -14 || response.errcode === -14) {
            this.options.status.setAccountStatus("AUTH_EXPIRED");
            this.options.status.setPollerStatus("DEGRADED", "AUTH_EXPIRED");
            return;
          }
          throw new Error(`getupdates rejected: ${response.ret ?? response.errcode}`);
        }
        failures = 0;
        this.options.status.poll();
        for (const message of response.msgs ?? []) {
          if (message.from_user_id && message.context_token) {
            this.options.contexts.set(this.options.accountId, message.from_user_id, message.context_token);
            this.options.targets.observeInbound(message.from_user_id, message.context_token);
            this.options.status.inbound();
            if (this.options.onInbound) await this.options.onInbound({ fromUserId: message.from_user_id, contextToken: message.context_token, text: messageText(message), receivedAt: new Date().toISOString() });
          }
        }
        if (response.get_updates_buf) {
          this.options.cursorStore.write(this.options.accountId, response.get_updates_buf);
          cursor = response.get_updates_buf;
        }
      } catch (error) {
        if (this.abortController.signal.aborted) break;
        failures += 1;
        this.options.status.setPollerStatus("DEGRADED", error instanceof Error ? error.message : "poll failed");
        const backoff = failures === 1 ? 2000 : failures === 2 ? 5000 : 15000;
        try { await delay(backoff, this.abortController.signal); } catch { break; }
      }
    }
    this.options.status.setPollerStatus("STOPPED");
  }
}
