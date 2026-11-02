import crypto from "node:crypto";
import QRCode from "qrcode";
import type { Config } from "../config.js";
import type { Credential } from "../types.js";
import { ProtocolClient } from "./protocol-client.js";

type Session = { id: string; qrcode: string; image: string; status: string; startedAt: number; baseUrl: string; verifyCode?: string };

export class QrLoginService {
  private readonly sessions = new Map<string, Session>();
  constructor(private readonly config: Config, private readonly client: ProtocolClient, private readonly onConfirmed: (credential: Credential) => Promise<void>) {}
  async start(): Promise<{ sessionId: string; qrcode: string; image: string; expiresAt: string }> {
    const qr = await this.client.getQrCode();
    // qrcode_img_content is the WeChat Lite App login URL that must be encoded
    // in the visible QR. The separate qrcode value is only the opaque token
    // used by get_qrcode_status while polling the login session.
    const image = await QRCode.toDataURL(qr.qrcode_img_content, { errorCorrectionLevel: "M", margin: 2, width: 320 });
    const id = crypto.randomUUID();
    this.sessions.set(id, { id, qrcode: qr.qrcode, image, status: "wait", startedAt: Date.now(), baseUrl: this.config.weixinBaseUrl });
    return { sessionId: id, qrcode: qr.qrcode, image, expiresAt: new Date(Date.now() + 5 * 60_000).toISOString() };
  }
  async poll(sessionId: string, verifyCode?: string): Promise<{ sessionId: string; status: string; credentialSaved: boolean }> {
    const session = this.sessions.get(sessionId);
    if (!session || Date.now() - session.startedAt > 5 * 60_000) throw new Error("QR_SESSION_EXPIRED");
    const response = await this.client.getQrStatus(session.qrcode, verifyCode ?? session.verifyCode);
    session.status = response.status;
    if (response.status === "scaned_but_redirect" && response.redirect_host) session.baseUrl = `https://${response.redirect_host}`;
    if (response.status === "confirmed") {
      if (!response.bot_token || !response.ilink_bot_id) throw new Error("LOGIN_RESPONSE_INCOMPLETE");
      const credential: Credential = { accountId: "default", botToken: response.bot_token, baseUrl: response.baseurl ?? session.baseUrl, ...(response.ilink_user_id ? { userId: response.ilink_user_id } : {}), updatedAt: new Date().toISOString() };
      await this.onConfirmed(credential);
      this.sessions.delete(sessionId);
      return { sessionId, status: response.status, credentialSaved: true };
    }
    return { sessionId, status: response.status, credentialSaved: false };
  }
}
