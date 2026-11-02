import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { ProtocolClient } from "../src/weixin/protocol-client.js";

describe("iLink protocol client", () => {
  it("sends required headers and checks JSON ret", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ret: 0 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new ProtocolClient(loadConfig({ NODE_ENV: "test", WEIXIN_BASE_URL: "https://example.test" }));
    await client.sendText({ baseUrl: "https://example.test", token: "token", message: { to_user_id: "u", context_token: "c" } });
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer token");
    expect(headers.AuthorizationType).toBe("ilink_bot_token");
    expect(headers["X-WECHAT-UIN"]).toBeTruthy();
    vi.unstubAllGlobals();
  });

  it("rejects a non-zero JSON ret even with HTTP 200", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ ret: -14, errmsg: "expired" }), { status: 200 })));
    const client = new ProtocolClient(loadConfig({ NODE_ENV: "test" }));
    await expect(client.sendText({ baseUrl: "https://example.test", token: "token", message: {} })).rejects.toMatchObject({ name: "UpstreamError", ret: -14 });
    vi.unstubAllGlobals();
  });
});
