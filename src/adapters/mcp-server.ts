import crypto from "node:crypto";
import { z } from "zod";
import type { Config } from "../config.js";
import { GatewayError } from "../observability/redaction.js";
import type { Principal } from "../types.js";
import { MessageCommandService } from "../application/message-command-service.js";
import { StatusService } from "../application/status-service.js";
import { TargetRegistry } from "../application/target-registry.js";

export const MCP_PROTOCOL_VERSION = "2026-07-28";
// The published SDK 1.30 transport still models initialize/session semantics.
// The design baseline is modern request-scoped MCP, so this boundary keeps the
// JSON-RPC dispatch stateless and leaves SDK adoption to a future compatible release.
type RpcRequest = { jsonrpc: "2.0"; id?: string | number | null; method: string; params?: Record<string, unknown> };
type RpcResponse = { jsonrpc: "2.0"; id: string | number | null; result?: unknown; error?: { code: number; message: string; data?: unknown } };

const sendInput = z.object({ target: z.string(), text: z.string(), idempotencyKey: z.string() }).strict();

function resultContent(value: unknown, isError = false): { content: Array<{ type: "text"; text: string }>; structuredContent: unknown; isError?: true } {
  return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value, ...(isError ? { isError: true } : {}) };
}
function ok(id: RpcRequest["id"], result: unknown): RpcResponse { return { jsonrpc: "2.0", id: id ?? null, result }; }
function error(id: RpcRequest["id"], code: number, message: string, data?: unknown): RpcResponse { return { jsonrpc: "2.0", id: id ?? null, error: { code, message, ...(data === undefined ? {} : { data }) } }; }

export class McpServerAdapter {
  constructor(private readonly options: { config: Config; status: StatusService; targets: TargetRegistry; commands: MessageCommandService }) {}

  async handle(input: unknown, principal: Principal, requestId: string = crypto.randomUUID(), headerVersion?: string): Promise<RpcResponse> {
    if (!input || typeof input !== "object") return error(null, -32600, "Invalid Request");
    const parsed = input as Partial<RpcRequest>;
    if (parsed.jsonrpc !== "2.0" || typeof parsed.method !== "string") return error(parsed.id, -32600, "Invalid Request");
    if (parsed.method === "server/discover") return ok(parsed.id, this.discover());
    try {
      this.validateMetadata(parsed.params, headerVersion);
      switch (parsed.method) {
        case "ping": return ok(parsed.id, {});
        case "tools/list": return ok(parsed.id, this.listTools(principal, parsed.params));
        case "tools/call": return ok(parsed.id, await this.callTool(principal, parsed.params ?? {}, requestId));
        case "resources/list": return ok(parsed.id, this.listResources(principal));
        case "resources/read": return ok(parsed.id, this.readResource(principal, parsed.params ?? {}));
        case "initialize": return error(parsed.id, -32601, "initialize is not supported in modern mode");
        default: return error(parsed.id, -32601, `Method not found: ${parsed.method}`);
      }
    } catch (cause) {
      if (cause instanceof GatewayError) return error(parsed.id, cause.httpStatus === 403 ? -32003 : -32602, cause.message, { code: cause.code });
      return error(parsed.id, -32602, cause instanceof Error ? cause.message : "Invalid parameters");
    }
  }

  private validateMetadata(params: Record<string, unknown> | undefined, headerVersion?: string): void {
    const meta = params?._meta;
    const bodyVersion: string | undefined = meta && typeof meta === "object" && typeof (meta as Record<string, unknown>).protocolVersion === "string" ? String((meta as Record<string, unknown>).protocolVersion) : undefined;
    const version = bodyVersion ?? headerVersion;
    if (!version || !this.options.config.mcpProtocolVersions.includes(version) || version !== MCP_PROTOCOL_VERSION) throw new GatewayError("UNSUPPORTED_PROTOCOL_VERSION", `supported MCP protocol version is ${MCP_PROTOCOL_VERSION}`, 400);
    if (headerVersion && bodyVersion && headerVersion !== bodyVersion) throw new GatewayError("PROTOCOL_VERSION_MISMATCH", "MCP protocol version header and body do not match", 400);
  }

  private discover(): unknown { return { protocolVersions: this.options.config.mcpProtocolVersions, serverInfo: { name: "wechat-personal-gateway", version: "0.1.0" }, capabilities: { tools: {}, resources: { subscribe: false, listChanged: false } } }; }

  private listTools(principal: Principal, params?: Record<string, unknown>): unknown {
    if (!principal.scopes.has("mcp:read")) return { tools: [], nextCursor: null };
    const tools: unknown[] = [
      { name: "weixin_get_status", description: "Read the current gateway and WeChat account status.", inputSchema: { type: "object", properties: {}, additionalProperties: false }, outputSchema: { type: "object" }, annotations: { readOnlyHint: true, destructiveHint: false } },
      { name: "weixin_list_targets", description: "List configured, redacted WeChat target aliases.", inputSchema: { type: "object", properties: {}, additionalProperties: false }, outputSchema: { type: "object" }, annotations: { readOnlyHint: true, destructiveHint: false } },
    ];
    if (principal.scopes.has("mcp:send")) tools.push({ name: "weixin_send_text", description: "Send text to a configured WeChat target after user confirmation.", inputSchema: { type: "object", additionalProperties: false, properties: { target: { type: "string" }, text: { type: "string", minLength: 1, maxLength: 4000 }, idempotencyKey: { type: "string", minLength: 8, maxLength: 128 } }, required: ["target", "text", "idempotencyKey"] }, outputSchema: { type: "object", additionalProperties: false, properties: { requestId: { type: "string" }, target: { type: "string" }, status: { type: "string", enum: ["SENT", "IN_PROGRESS", "UNKNOWN"] }, messageId: { type: "string" } }, required: ["requestId", "target", "status"] }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } });
    tools.sort((a, b) => String((a as { name: string }).name).localeCompare(String((b as { name: string }).name)));
    const cursor = typeof params?.cursor === "string" ? Number.parseInt(Buffer.from(params.cursor, "base64url").toString("utf8"), 10) : 0;
    const page = Number.isInteger(cursor) && cursor >= 0 ? tools.slice(cursor, cursor + 50) : tools;
    return { tools: page, ...(cursor + page.length < tools.length ? { nextCursor: Buffer.from(String(cursor + page.length)).toString("base64url") } : {}) };
  }

  private async callTool(principal: Principal, params: Record<string, unknown>, requestId: string): Promise<unknown> {
    const name = typeof params.name === "string" ? params.name : "";
    const args = params.arguments && typeof params.arguments === "object" ? params.arguments : {};
    try {
      if (name === "weixin_get_status") {
        if (!principal.scopes.has("mcp:read")) throw new GatewayError("FORBIDDEN", "mcp:read scope is required", 403);
        return resultContent(this.options.status.snapshot());
      }
      if (name === "weixin_list_targets") {
        if (!principal.scopes.has("mcp:read")) throw new GatewayError("FORBIDDEN", "mcp:read scope is required", 403);
        return resultContent({ targets: this.options.targets.list().filter((target) => principal.targets.has("*") || principal.targets.has(target.target)) });
      }
      if (name === "weixin_send_text") {
        const parsed = sendInput.parse(args);
        const result = await this.options.commands.sendText(principal, requestId, parsed);
        return resultContent(result, result.status === "FAILED" || result.status === "UNKNOWN");
      }
      return resultContent({ code: "UNKNOWN_TOOL", message: "unknown tool" }, true);
    } catch (cause) {
      if (cause instanceof GatewayError) return resultContent({ code: cause.code, message: cause.message }, true);
      if (cause instanceof z.ZodError) return resultContent({ code: "INVALID_TOOL_INPUT", message: "tool input does not match schema" }, true);
      return resultContent({ code: "TOOL_EXECUTION_FAILED", message: "tool execution failed" }, true);
    }
  }

  private listResources(principal: Principal): unknown {
    if (!principal.scopes.has("mcp:read")) return { resources: [] };
    return { resources: [{ uri: "weixin://status", name: "WeChat gateway status", mimeType: "application/json" }, { uri: "weixin://targets", name: "Configured WeChat targets", mimeType: "application/json" }] };
  }
  private readResource(principal: Principal, params: Record<string, unknown>): unknown {
    if (!principal.scopes.has("mcp:read")) throw new GatewayError("FORBIDDEN", "mcp:read scope is required", 403);
    const uri = typeof params.uri === "string" ? params.uri : "";
    const value = uri === "weixin://status" ? this.options.status.snapshot() : uri === "weixin://targets" ? { targets: this.options.targets.list().filter((target) => principal.targets.has("*") || principal.targets.has(target.target)) } : undefined;
    if (!value) throw new GatewayError("RESOURCE_NOT_FOUND", "resource not found", 404);
    return { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(value) }] };
  }
}
