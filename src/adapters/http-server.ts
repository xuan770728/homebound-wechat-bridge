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

function requestId(request: { headers: Record<string, string | string[] | undefined> }): string { return typeof request.headers["x-request-id"] === "string" ? request.headers["x-request-id"] : crypto.randomUUID(); }

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
