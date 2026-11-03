import crypto from "node:crypto";
import Fastify, { type FastifyRequest } from "fastify";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import type { Config } from "../config.js";
import type { AppLogger } from "../observability/logger.js";
import { audit } from "../observability/audit.js";
import { GatewayError } from "../observability/redaction.js";
import { authenticate, canTarget, requireScope, validateOriginAndHost } from "../security/principal.js";
import { McpServerAdapter } from "./mcp-server.js";
import { AccountRuntime } from "../weixin/account-runtime.js";
import { QrLoginService } from "../weixin/qr-login-service.js";
import { MessageCommandService } from "../application/message-command-service.js";
import { BootstrapDiscovery } from "../application/bootstrap-discovery.js";
import { WechatBridgeService } from "../bridge/service.js";
import { McpEventsAdapter } from "../bridge/mcp-events-adapter.js";
import { setupPage } from "./setup-page.js";
import type { Principal } from "../types.js";

function requestId(request: { headers: Record<string, string | string[] | undefined> }): string { return typeof request.headers["x-request-id"] === "string" ? request.headers["x-request-id"] : crypto.randomUUID(); }

function phoneAuthorized(request: FastifyRequest, config: Config): boolean {
  const expected = config.phoneBridgeToken;
  const authorization = request.headers.authorization;
  if (!expected || typeof authorization !== "string" || !authorization.startsWith("Bearer ")) return false;
  const actual = authorization.slice(7);
  const left = Buffer.from(expected);
  const right = Buffer.from(actual);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function callDuration(seconds: number): string {
  const safe = Math.max(0, Math.min(7200, Math.floor(seconds)));
  return `${Math.floor(safe / 60).toString().padStart(2, "0")}:${(safe % 60).toString().padStart(2, "0")}`;
}

export function buildHttpServer(options: { config: Config; logger: AppLogger; runtime: AccountRuntime; commands: MessageCommandService; mcp: McpServerAdapter; qr: QrLoginService; bootstrap: BootstrapDiscovery; bridge: WechatBridgeService; eventsMcp: McpEventsAdapter }) {
  const { config, logger, runtime, commands, mcp, qr, bootstrap, bridge, eventsMcp } = options;
  const app = Fastify({ logger: false, bodyLimit: config.mcpMaxBodyBytes, requestIdHeader: "x-request-id" });
  void app.register(helmet, { contentSecurityPolicy: false });
  void app.register(rateLimit, { max: 120, timeWindow: "1 minute" });

  app.addHook("onRequest", async (request) => {
    validateOriginAndHost(request, config);
  });
  app.setErrorHandler((error, request, reply) => {
    const id = requestId(request);
    if (error instanceof GatewayError) return reply.code(error.httpStatus).send({ error: error.code, message: error.message, requestId: id });
    logger.error({ requestId: id, error: error instanceof Error ? error.message : String(error) }, "request failed");
    return reply.code(500).send({ error: "INTERNAL_ERROR", message: "internal server error", requestId: id });
  });

  app.get("/health/live", async () => ({ status: "ok" }));
  app.get("/health/ready", async (_request, reply) => {
    const ready = runtime.status.ready();
    return reply.code(ready ? 200 : 503).send({ status: ready ? "ready" : "not_ready", mcp: config.mcpEnabled, version: "0.1.0" });
  });

  app.post<{ Body: {
    type?: string; callId?: string; delegationId?: string; latestUserText?: string;
    userTranscript?: string; assistantTranscript?: string; startedAt?: string;
  } }>("/phone/v1/turn", async (request, reply) => {
    if (!config.phoneBridgeToken) return reply.code(503).send({ error: "PHONE_BRIDGE_DISABLED" });
    if (!phoneAuthorized(request, config)) return reply.code(401).send({ error: "UNAUTHORIZED" });
    const body = request.body ?? {};
    const callId = typeof body.callId === "string" ? body.callId.trim() : "";
    const delegationId = typeof body.delegationId === "string" ? body.delegationId.trim() : "";
    const latestUserText = typeof body.latestUserText === "string" ? body.latestUserText.trim() : "";
    if (!callId || !delegationId || !latestUserText || latestUserText.length > 5000) return reply.code(400).send({ error: "INVALID_VOICE_TURN" });
    try {
      const result = await bridge.requestVoiceTurn({
        callId,
        delegationId,
        latestUserText,
        userTranscript: typeof body.userTranscript === "string" ? body.userTranscript.slice(-5000) : "",
        assistantTranscript: typeof body.assistantTranscript === "string" ? body.assistantTranscript.slice(-5000) : "",
        ...(typeof body.startedAt === "string" ? { startedAt: body.startedAt } : {}),
      });
      return reply.header("cache-control", "private, no-store").send({ reply: result.reply, eventId: result.eventId });
    } catch (error) {
      if (error instanceof Error && error.message === "VOICE_REPLY_TIMEOUT") return reply.code(504).send({ error: "WORK_REPLY_TIMEOUT" });
      throw error;
    }
  });

  app.post<{ Body: { callId?: string; seconds?: number; startedAt?: string; endedAt?: string } }>("/phone/v1/complete", async (request, reply) => {
    if (!config.phoneBridgeToken) return reply.code(503).send({ error: "PHONE_BRIDGE_DISABLED" });
    if (!phoneAuthorized(request, config)) return reply.code(401).send({ error: "UNAUTHORIZED" });
    const body = request.body ?? {};
    const callId = typeof body.callId === "string" ? body.callId.trim() : "";
    if (!callId) return reply.code(400).send({ error: "INVALID_CALL" });
    const target = config.allowedTargets[0]!;
    const note = `☏ 与爸爸通话 ${callDuration(Number(body.seconds) || 0)}`;
    const principal: Principal = { id: "homebound-phone-bridge", scopes: new Set(["mcp:send"]), targets: new Set([target]), authType: "bearer" };
    const idempotencyKey = `phone-${crypto.createHash("sha256").update(callId).digest("hex").slice(0, 32)}`;
    const result = await commands.sendText(principal, requestId(request), { target, text: note, idempotencyKey });
    return reply.send({ synced: result.status === "SENT", note: result.status === "SENT" ? `微信已显示：${note}` : `${note} · 微信同步待确认` });
  });

  app.post(config.mcpPath, async (request, reply) => {
    if (!config.mcpEnabled) throw new GatewayError("MCP_DISABLED", "MCP is disabled", 404);
    const id = requestId(request);
    const started = Date.now();
    const principal = authenticate(request, config);
    const response = await mcp.handle(request.body, principal, id, typeof request.headers["mcp-protocol-version"] === "string" ? request.headers["mcp-protocol-version"] : undefined);
    audit(logger, { requestId: id, principalId: principal.id, action: "mcp", outcome: response.error ? "ERROR" : "OK", durationMs: Date.now() - started });
    return reply.type("application/json").send(response);
  });

  app.post(config.mcpEventsPath, async (request, reply) => {
    await bridge.ready;
    const response = await eventsMcp.handle(request.body, request.headers);
    if (!response.body) return reply.code(response.status).send();
    return reply.code(response.status).type("application/json").send(response.body);
  });

  const setupApi = `${config.setupPath}/api`;
  app.get(config.setupPath, async (request, reply) => {
    const forwarded = request.headers["x-forwarded-proto"];
    const protocol = typeof forwarded === "string" ? forwarded.split(",")[0]!.trim() : "https";
    const host = request.headers.host ?? "localhost";
    const origin = `${protocol}://${host}`;
    return reply.type("text/html; charset=utf-8").send(setupPage({ basePath: config.setupPath, mcpUrl: `${origin}${config.mcpEventsPath}`, target: config.allowedTargets[0]! }));
  });
  app.get(`${setupApi}/status`, async () => ({ ...runtime.status.snapshot(), bridge: bridge.status(), targets: runtime.targets.list() }));
  app.post(`${setupApi}/qr/start`, async () => qr.start());
  app.post<{ Params: { sessionId: string }; Body: { verifyCode?: string } }>(`${setupApi}/qr/:sessionId/poll`, async (request) => qr.poll(request.params.sessionId, request.body?.verifyCode));
  app.post(`${setupApi}/bind/start`, async () => bootstrap.start());
  app.get<{ Params: { sessionId: string } }>(`${setupApi}/bind/:sessionId`, async (request) => ({ sessionId: request.params.sessionId, candidates: bootstrap.list(request.params.sessionId) }));
  app.post<{ Params: { sessionId: string }; Body: { fromUserId?: string } }>(`${setupApi}/bind/:sessionId`, async (request) => {
    const fromUserId = request.body?.fromUserId;
    if (typeof fromUserId !== "string" || !fromUserId) throw new GatewayError("INVALID_BOOTSTRAP_BINDING", "fromUserId is required", 400);
    const candidate = bootstrap.candidate(request.params.sessionId, fromUserId);
    const target = config.allowedTargets[0]!;
    runtime.targets.bind(target, candidate.fromUserId, candidate.contextToken);
    bootstrap.complete(request.params.sessionId, fromUserId);
    return { target, bound: true };
  });

  app.get("/api/v1/status", async (request) => {
    authenticate(request, config);
    return runtime.status.snapshot();
  });
  app.post("/api/v1/auth/qr", async (request) => {
    authenticate(request, config);
    return qr.start();
  });
  app.post<{ Params: { sessionId: string }; Body: { verifyCode?: string } }>("/api/v1/auth/qr/:sessionId/poll", async (request) => {
    authenticate(request, config);
    return qr.poll(request.params.sessionId, request.body?.verifyCode);
  });
  app.post<{ Body: { target: string; text: string; idempotencyKey: string } }>("/api/v1/send/text", async (request) => {
    const principal = authenticate(request, config);
    const id = requestId(request);
    const result = await commands.sendText(principal, id, request.body);
    return result;
  });

  function requireBootstrap(principal: ReturnType<typeof authenticate>): void {
    if (!config.bootstrapEnabled) throw new GatewayError("BOOTSTRAP_DISABLED", "bootstrap is disabled", 404);
    requireScope(principal, "mcp:send");
  }

  app.post("/api/v1/bootstrap/targets", async (request) => {
    const principal = authenticate(request, config);
    requireBootstrap(principal);
    return bootstrap.start();
  });
  app.get<{ Params: { sessionId: string } }>("/api/v1/bootstrap/targets/:sessionId", async (request) => {
    const principal = authenticate(request, config);
    requireBootstrap(principal);
    try {
      return { sessionId: request.params.sessionId, candidates: bootstrap.list(request.params.sessionId) };
    } catch (error) {
      if (error instanceof Error && error.message === "BOOTSTRAP_SESSION_NOT_FOUND") throw new GatewayError(error.message, "bootstrap session is unavailable", 404);
      throw error;
    }
  });
  app.post<{ Params: { sessionId: string }; Body: { target?: string; fromUserId?: string } }>("/api/v1/bootstrap/targets/:sessionId/bind", async (request) => {
    const principal = authenticate(request, config);
    requireBootstrap(principal);
    const target = request.body?.target;
    const fromUserId = request.body?.fromUserId;
    if (typeof target !== "string" || typeof fromUserId !== "string" || !target || !fromUserId) throw new GatewayError("INVALID_BOOTSTRAP_BINDING", "target and fromUserId are required", 400);
    if (!canTarget(principal, target)) throw new GatewayError("TARGET_NOT_ALLOWED", "target is not authorized", 403);
    try {
      const candidate = bootstrap.candidate(request.params.sessionId, fromUserId);
      runtime.targets.bind(target, candidate.fromUserId, candidate.contextToken);
      bootstrap.complete(request.params.sessionId, fromUserId);
      return { target, bound: true };
    } catch (error) {
      if (error instanceof Error && ["BOOTSTRAP_SESSION_NOT_FOUND", "BOOTSTRAP_CANDIDATE_NOT_FOUND", "TARGET_NOT_ALLOWED", "TARGET_ALREADY_BOUND"].includes(error.message)) {
        throw new GatewayError(error.message, error.message === "TARGET_ALREADY_BOUND" ? "fromUserId is already bound to another target" : "bootstrap target binding is unavailable", 409);
      }
      throw error;
    }
  });

  return app;
}
