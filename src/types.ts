export const ACCOUNT_STATES = [
  "NEED_LOGIN",
  "QR_WAITING",
  "QR_SCANNED",
  "VERIFY_CODE",
  "REDIRECTING",
  "ONLINE",
  "DEGRADED",
  "AUTH_EXPIRED",
  "STOPPING",
  "STOPPED",
] as const;
export type AccountStatus = (typeof ACCOUNT_STATES)[number];

export type PollerStatus = "STOPPED" | "STARTING" | "RUNNING" | "DEGRADED" | "STOPPING";
export type SendStatus = "SENT" | "FAILED" | "IN_PROGRESS" | "UNKNOWN";

export type Credential = {
  accountId: string;
  botToken: string;
  baseUrl: string;
  userId?: string;
  updatedAt: string;
};

export type TargetConfig = {
  target: string;
  displayName: string;
  fromUserId?: string;
  enabled: boolean;
};

export type TargetView = {
  target: string;
  displayName: string;
  available: boolean;
  contextReady: boolean;
};

export type GatewayStatus = {
  accountStatus: AccountStatus;
  pollerStatus: PollerStatus;
  lastPollAt: string | null;
  lastInboundAt: string | null;
  lastOutboundAt: string | null;
  authExpired: boolean;
  degradedReason: string | null;
  version: string;
};

export type Principal = {
  id: string;
  scopes: ReadonlySet<string>;
  targets: ReadonlySet<string>;
  authType: "none" | "bearer" | "mtls";
};

export type IdempotencyRecord = {
  principalId: string;
  keyHash: string;
  target: string;
  requestId: string;
  status: "IN_PROGRESS" | "SENT" | "FAILED" | "UNKNOWN";
  messageId?: string;
  errorCode?: string;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
};

export type SendResult = {
  requestId: string;
  target: string;
  status: SendStatus;
  messageId?: string;
  errorCode?: string;
};

export type InboundMessageHandler = (message: {
  fromUserId: string;
  contextToken: string;
  text: string;
  receivedAt: string;
}) => Promise<void>;
