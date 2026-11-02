import type { AppLogger } from "./logger.js";

export function audit(logger: AppLogger, event: { requestId: string; principalId: string; action: string; target?: string; outcome: string; durationMs: number }): void {
  logger.info({ audit: true, ...event }, "gateway audit event");
}
