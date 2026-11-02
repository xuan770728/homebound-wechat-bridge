import type { Config } from "../config.js";
import type { AccountStatus, GatewayStatus, PollerStatus } from "../types.js";

export class StatusService {
  private accountStatus: AccountStatus = "NEED_LOGIN";
  private pollerStatus: PollerStatus = "STOPPED";
  private lastPollAt: string | null = null;
  private lastInboundAt: string | null = null;
  private lastOutboundAt: string | null = null;
  private degradedReason: string | null = null;
  constructor(private readonly config: Config) {}
  setAccountStatus(status: AccountStatus): void { this.accountStatus = status; }
  setPollerStatus(status: PollerStatus, reason?: string): void { this.pollerStatus = status; this.degradedReason = reason ?? (status === "DEGRADED" ? this.degradedReason : null); }
  poll(): void { this.lastPollAt = new Date().toISOString(); if (this.pollerStatus === "STARTING" || this.pollerStatus === "DEGRADED") this.pollerStatus = "RUNNING"; }
  inbound(): void { this.lastInboundAt = new Date().toISOString(); }
  outbound(): void { this.lastOutboundAt = new Date().toISOString(); }
  snapshot(): GatewayStatus { return { accountStatus: this.accountStatus, pollerStatus: this.pollerStatus, lastPollAt: this.lastPollAt, lastInboundAt: this.lastInboundAt, lastOutboundAt: this.lastOutboundAt, authExpired: this.accountStatus === "AUTH_EXPIRED", degradedReason: this.degradedReason, version: "0.1.0" }; }
  ready(): boolean { return Boolean(this.config.dataDir && this.config.mcpPath); }
}
