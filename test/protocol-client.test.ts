import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { ProtocolClient } from "../src/weixin/protocol-client.js";

describe("iLink protocol client", () => {
  it("sends required headers and returns a confirmed receipt", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ret: 0, message_id: "wechat-123" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new ProtocolClient(loadConfig({ NODE_ENV: "test", WEIXIN_BASE_URL: "https://example.test" }));
    await expect(client.sendText({ baseUrl: "https://example.test", token: "token", message: { to_user_id: "u", context_token: "c" } })).resolves.toEqual({ confirmed: true, messageId: "wechat-123" });
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer token");
    expect(headers.AuthorizationType).toBe("ilink_bot_token");
    expect(headers["X-WECHAT-UIN"]).toBeTruthy();
    vi.unstubAllGlobals();
  });

  it("marks a bare successful response as unconfirmed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ ret: 0 }), { status: 200 })));
    const client = new ProtocolClient(loadConfig({ NODE_ENV: "test" }));
    await expect(client.sendText({ baseUrl: "https://example.test", token: "token", message: {} })).resolves.toEqual({ confirmed: false });
    vi.unstubAllGlobals();
  });

  it("shows a best-effort typing indicator", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ret: 0, typing_ticket: "ticket-1" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ret: 0 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new ProtocolClient(loadConfig({ NODE_ENV: "test" }));
    await expect(client.showTyping({ baseUrl: "https://example.test", token: "token", toUserId: "u", contextToken: "c" })).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("ilink/bot/getconfig");
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("ilink/bot/sendtyping");
    vi.unstubAllGlobals();
  });

  it("rejects a non-zero JSON ret even with HTTP 200", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ ret: -14, errmsg: "expired" }), { status: 200 })));
    const client = new ProtocolClient(loadConfig({ NODE_ENV: "test" }));
    await expect(client.sendText({ baseUrl: "https://example.test", token: "token", message: {} })).rejects.toMatchObject({ name: "UpstreamError", ret: -14 });
    vi.unstubAllGlobals();
  });
});
