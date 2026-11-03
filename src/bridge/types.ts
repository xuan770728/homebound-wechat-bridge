export type BridgeEvent = {
  id: string;
  correlationId: string;
  kind: "message";
  source: "wechat.dm";
  stream: "conversation";
  replyRoute: "wechat.dm" | "voice.call";
  replyPolicy: "required";
  createdAt: string;
  visibleText: string;
  modelContext: string;
  target: string;
};

export type EventStatus = "pending" | "reserved" | "delivered";

export type ReplyDeliveryState = {
  fingerprint: string;
  sentCount: number;
  completed: boolean;
  inFlight: boolean;
  completedAt?: string;
};

export type StoredBridgeEvent = {
  event: BridgeEvent;
  status: EventStatus;
  reply?: ReplyDeliveryState;
};
