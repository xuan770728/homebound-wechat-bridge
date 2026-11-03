import crypto from "node:crypto";

export type VoiceTurn = {
  id: string;
  callId: string;
  delegationId: string;
  latestUserText: string;
  userTranscript: string;
  assistantTranscript: string;
  startedAt?: string;
  createdAt: string;
};

type Slot = {
  turn: VoiceTurn;
  reply?: string;
  waiters: Set<(reply: string) => void>;
  expiresAt: number;
};

export class VoiceTurnService {
  private readonly slots = new Map<string, Slot>();

  enqueue(input: Omit<VoiceTurn, "id" | "createdAt">): { turn: VoiceTurn; created: boolean } {
    this.sweep();
    const id = `voice_${crypto.createHash("sha256").update(`${input.callId}\0${input.delegationId}`).digest("hex").slice(0, 32)}`;
    const existing = this.slots.get(id);
    if (existing) return { turn: existing.turn, created: false };
    const turn: VoiceTurn = { ...input, id, createdAt: new Date().toISOString() };
    this.slots.set(id, { turn, waiters: new Set(), expiresAt: Date.now() + 5 * 60_000 });
    return { turn, created: true };
  }

  read(id: string) {
    this.sweep();
    const slot = this.slots.get(id);
    if (!slot) return { found: false, completed: false } as const;
    return { found: true, completed: Boolean(slot.reply), turn: slot.turn } as const;
  }

  reply(id: string, reply: string) {
    this.sweep();
    const slot = this.slots.get(id);
    if (!slot) throw new Error("The referenced voice turn is not available.");
    const normalized = reply.trim();
    if (!normalized) throw new Error("Voice reply must not be empty.");
    if (!slot.reply) {
      slot.reply = normalized;
      slot.expiresAt = Date.now() + 2 * 60_000;
      for (const resolve of slot.waiters) resolve(normalized);
      slot.waiters.clear();
    }
    return { ok: true, eventId: id, completed: true, deduplicated: slot.reply !== normalized, reply: slot.reply };
  }

  async waitForReply(id: string, timeoutMs: number): Promise<string> {
    const slot = this.slots.get(id);
    if (!slot) throw new Error("VOICE_TURN_NOT_FOUND");
    if (slot.reply) return slot.reply;
    return await new Promise<string>((resolve, reject) => {
      const finish = (reply: string) => { clearTimeout(timer); slot.waiters.delete(finish); resolve(reply); };
      const timer = setTimeout(() => { slot.waiters.delete(finish); reject(new Error("VOICE_REPLY_TIMEOUT")); }, timeoutMs);
      slot.waiters.add(finish);
    });
  }

  status() {
    this.sweep();
    return { pending: [...this.slots.values()].filter((slot) => !slot.reply).length };
  }

  private sweep() {
    const now = Date.now();
    for (const [id, slot] of this.slots) if (slot.expiresAt <= now && slot.waiters.size === 0) this.slots.delete(id);
  }
}
