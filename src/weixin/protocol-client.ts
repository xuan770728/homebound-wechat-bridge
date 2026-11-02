import crypto from "node:crypto";
import type { Config } from "../config.js";
import { GatewayError } from "../observability/redaction.js";
import type { BaseInfo, GetUpdatesResponse, QrCodeResponse, QrStatusResponse, WeixinMessage } from "./protocol-types.js";

export class UpstreamError extends Error {
  constructor(public readonly kind: "timeout" | "network" | "http" | "protocol", message: string, public readonly ret?: number) { super(message); this.name = "UpstreamError"; }
}

export type ProtocolClientOptions = { baseUrl?: string; token?: string; abortSignal?: AbortSignal };
export type SendReceipt = { confirmed: boolean; messageId?: string };

export class ProtocolClient {
  constructor(private readonly config: Config) {}

  private baseInfo(): BaseInfo { return { channel_version: "0.1.0", bot_agent: this.config.botAgent }; }
  private commonHeaders(): Record<string, string> {
    return { "iLink-App-Id": "bot", "iLink-App-ClientVersion": "65547" };
  }
  private headers(token?: string): Record<string, string> {
    const uin = crypto.randomBytes(4).readUInt32BE(0).toString(10);
    return {
      "Content-Type": "application/json",
      AuthorizationType: "ilink_bot_token",
      "X-WECHAT-UIN": Buffer.from(uin).toString("base64"),
      ...this.commonHeaders(),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
  }

  async post<T>(endpoint: string, body: unknown, options: ProtocolClientOptions & { timeoutMs?: number } = {}): Promise<T> {
    const baseUrl = options.baseUrl ?? this.config.weixinBaseUrl;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? this.config.sendTimeoutMs);
    const onAbort = () => controller.abort();
    options.abortSignal?.addEventListener("abort", onAbort, { once: true });
    try {
      let response: Response;
      try {
        response = await fetch(new URL(endpoint, `${baseUrl.replace(/\/$/, "")}/`), { method: "POST", headers: this.headers(options.token), body: JSON.stringify(body), signal: controller.signal });
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") throw new UpstreamError("timeout", "upstream request timed out");
        throw new UpstreamError("network", "upstream network request failed");
      }
      const raw = await response.text();
      if (!response.ok) throw new UpstreamError("http", `upstream HTTP ${response.status}`);
      try { return JSON.parse(raw) as T; } catch { throw new UpstreamError("protocol", "upstream returned invalid JSON"); }
    } finally {
      clearTimeout(timeout);
      options.abortSignal?.removeEventListener("abort", onAbort);
    }
  }

  async get<T>(endpoint: string, options: ProtocolClientOptions & { timeoutMs?: number } = {}): Promise<T> {
    const baseUrl = options.baseUrl ?? this.config.weixinBaseUrl;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? this.config.sendTimeoutMs);
    const onAbort = () => controller.abort();
    options.abortSignal?.addEventListener("abort", onAbort, { once: true });
    try {
      let response: Response;
      try { response = await fetch(new URL(endpoint, `${baseUrl.replace(/\/$/, "")}/`), { method: "GET", headers: this.commonHeaders(), signal: controller.signal }); }
      catch (error) { if (error instanceof Error && error.name === "AbortError") throw new UpstreamError("timeout", "upstream request timed out"); throw new UpstreamError("network", "upstream network request failed"); }
      const raw = await response.text();
      if (!response.ok) throw new UpstreamError("http", `upstream HTTP ${response.status}`);
      try { return JSON.parse(raw) as T; } catch { throw new UpstreamError("protocol", "upstream returned invalid JSON"); }
    } finally { clearTimeout(timeout); options.abortSignal?.removeEventListener("abort", onAbort); }
  }

  async getQrCode(): Promise<QrCodeResponse> {
    return this.post<QrCodeResponse>(`ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(this.config.weixinBotType)}`, { local_token_list: [] }, { timeoutMs: 15000 });
  }

  async getQrStatus(qrcode: string, verifyCode?: string): Promise<QrStatusResponse> {
    const query = new URLSearchParams({ qrcode, ...(verifyCode ? { verify_code: verifyCode } : {}) });
    try { return await this.get<QrStatusResponse>(`ilink/bot/get_qrcode_status?${query.toString()}`, { timeoutMs: 35000 }); }
    catch (error) { if (error instanceof UpstreamError && error.kind === "timeout") return { status: "wait" }; throw error; }
  }

  async getUpdates(options: { baseUrl: string; token: string; cursor: string; abortSignal: AbortSignal; timeoutMs?: number }): Promise<GetUpdatesResponse> {
    try {
      return await this.post<GetUpdatesResponse>("ilink/bot/getupdates", { get_updates_buf: options.cursor, base_info: this.baseInfo() }, { ...options, timeoutMs: options.timeoutMs ?? this.config.longPollTimeoutMs });
    } catch (error) {
      if (error instanceof UpstreamError && error.kind === "timeout" && !options.abortSignal.aborted) return { ret: 0, msgs: [], get_updates_buf: options.cursor };
      throw error;
    }
  }

  async sendText(options: { baseUrl: string; token: string; message: WeixinMessage; timeoutMs?: number }): Promise<SendReceipt> {
    const response = await this.post<{ ret?: number; errcode?: number; errmsg?: string; message_id?: unknown; msg_id?: unknown; msg?: { message_id?: unknown } }>("ilink/bot/sendmessage", { msg: options.message, base_info: this.baseInfo() }, options);
    const code = response.ret ?? response.errcode;
    if (code !== undefined && code !== 0) throw new UpstreamError("protocol", "upstream rejected message", code);
    const rawMessageId = response.message_id ?? response.msg_id ?? response.msg?.message_id;
    const messageId = typeof rawMessageId === "string" || typeof rawMessageId === "number" ? String(rawMessageId) : undefined;
    return { confirmed: Boolean(messageId), ...(messageId ? { messageId } : {}) };
  }

  async showTyping(options: { baseUrl: string; token: string; toUserId: string; contextToken: string; timeoutMs?: number }): Promise<boolean> {
    try {
      const config = await this.post<{ ret?: number; errcode?: number; typing_ticket?: string }>("ilink/bot/getconfig", {
        to_user_id: options.toUserId,
        context_token: options.contextToken,
        base_info: this.baseInfo(),
      }, options);
      if ((config.ret !== undefined && config.ret !== 0) || (config.errcode !== undefined && config.errcode !== 0) || !config.typing_ticket) return false;
      const response = await this.post<{ ret?: number; errcode?: number }>("ilink/bot/sendtyping", {
        to_user_id: options.toUserId,
        typing_ticket: config.typing_ticket,
        context_token: options.contextToken,
        base_info: this.baseInfo(),
      }, options);
      return (response.ret === undefined || response.ret === 0) && (response.errcode === undefined || response.errcode === 0);
    } catch {
      return false;
    }
  }

  async notifyStart(options: { baseUrl: string; token: string }): Promise<void> {
    const response = await this.post<{ ret?: number }>("ilink/bot/msg/notifystart", { base_info: this.baseInfo() }, options);
    if (response.ret !== undefined && response.ret !== 0) throw new UpstreamError("protocol", "upstream rejected notifyStart", response.ret);
  }
  async notifyStop(options: { baseUrl: string; token: string }): Promise<void> {
    const response = await this.post<{ ret?: number }>("ilink/bot/msg/notifystop", { base_info: this.baseInfo() }, options);
    if (response.ret !== undefined && response.ret !== 0) throw new UpstreamError("protocol", "upstream rejected notifyStop", response.ret);
  }
}

export function mapUpstreamError(error: unknown): GatewayError {
  if (error instanceof UpstreamError) {
    if (error.ret === -14) return new GatewayError("AUTH_EXPIRED", "WeChat authentication expired", 503);
    if (error.kind === "timeout") return new GatewayError("UPSTREAM_TIMEOUT", "WeChat response timed out", 504);
    if (error.kind === "network") return new GatewayError("UPSTREAM_NETWORK_ERROR", "WeChat network request failed", 503);
    return new GatewayError("UPSTREAM_REJECTED", "WeChat rejected the request", 502);
  }
  return new GatewayError("UPSTREAM_NETWORK_ERROR", "WeChat request failed", 503);
}
