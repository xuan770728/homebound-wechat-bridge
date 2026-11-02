import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { McpServerAdapter } from "../src/adapters/mcp-server.js";
import { StatusService } from "../src/application/status-service.js";
import { TargetRegistry } from "../src/application/target-registry.js";
import { ContextTokenStore } from "../src/persistence/context-token-store.js";
import type { Principal } from "../src/types.js";

function config(dataDir: string) {
  return loadConfig({ NODE_ENV: "test", DATA_DIR: dataDir, WEIXIN_TARGETS_JSON: JSON.stringify([{ target: "my-wechat", displayName: "Personal WeChat", fromUserId: "u1" }]), MCP_ALLOWED_TARGETS: "my-wechat" });
}

describe("modern MCP adapter", () => {
  it("discovers the modern version without initialize", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wpg-mcp-"));
    const cfg = config(dir); const status = new StatusService(cfg); const targets = new TargetRegistry(cfg, new ContextTokenStore(dir, "test-key"));
    const commands = {} as never;
    const adapter = new McpServerAdapter({ config: cfg, status, targets, commands });
    const response = await adapter.handle({ jsonrpc: "2.0", id: 1, method: "server/discover" }, principal());
    expect(response.result).toMatchObject({ protocolVersions: ["2026-07-28"] });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("filters send tool by scope and rejects old initialize", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wpg-mcp-"));
    const cfg = config(dir); const status = new StatusService(cfg); const targets = new TargetRegistry(cfg, new ContextTokenStore(dir, "test-key"));
    const adapter = new McpServerAdapter({ config: cfg, status, targets, commands: {} as never });
    const readOnly: Principal = { id: "read", scopes: new Set(["mcp:read"]), targets: new Set(["my-wechat"]), authType: "none" };
    const listed = await adapter.handle({ jsonrpc: "2.0", id: 2, method: "tools/list", params: { _meta: { protocolVersion: "2026-07-28" } } }, readOnly);
    expect(JSON.stringify(listed)).not.toContain("weixin_send_text");
    const old = await adapter.handle({ jsonrpc: "2.0", id: 3, method: "initialize", params: { _meta: { protocolVersion: "2026-07-28" } } }, readOnly);
    expect(old.error?.code).toBe(-32601);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

function principal(): Principal { return { id: "local", scopes: new Set(["mcp:read", "mcp:send"]), targets: new Set(["*"]), authType: "none" }; }
