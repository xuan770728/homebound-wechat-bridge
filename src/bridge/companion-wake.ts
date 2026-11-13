import { randomUUID } from "node:crypto";
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { EventsService } from "./events/events.js";

type Wake = { id: string; at: string; note: string };

/** One-shot wakes. A model can explicitly arrange its next turn after waking. */
export class CompanionWake {
  private pending: Wake | null = null;
  private busy = false;
  private timer?: NodeJS.Timeout;
  private chain: Promise<unknown> = Promise.resolve();
  constructor(private file: string, private events: EventsService) {}

  async start() {
    try {
      const value = JSON.parse(await readFile(this.file, "utf8")) as Wake | null;
      if (value && typeof value.id === "string" && Number.isFinite(Date.parse(value.at)) && typeof value.note === "string") this.pending = value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    this.timer = setInterval(() => void this.tick().catch(() => undefined), 15_000);
    this.timer.unref();
  }
  stop() { if (this.timer) clearInterval(this.timer); }
  status() { return { pending: this.pending, activeSubscribers: this.events.activeSubscriptionCount("homebound.wake", "companion.wake") }; }
  schedule(minutes: number, note: string) {
    return this.serialize(async () => {
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440 || !note.trim() || note.length > 2000) throw new Error("Use 1–1440 minutes and a note of 1–2000 characters.");
      if (!this.events.activeSubscriptionCount("homebound.wake", "companion.wake")) throw new Error("Subscribe this Work chat to homebound.wake before scheduling.");
      this.pending = { id: randomUUID(), at: new Date(Date.now() + minutes * 60_000).toISOString(), note };
      await this.save();
      return this.status();
    });
  }
  cancel() { return this.serialize(async () => { this.pending = null; await this.save(); return this.status(); }); }
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.chain.then(operation, operation);
    this.chain = result.catch(() => undefined);
    return result;
  }
  private async save() {
    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(`${this.file}.tmp`, JSON.stringify(this.pending), { mode: 0o600 });
    await rename(`${this.file}.tmp`, this.file);
  }
  private async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.serialize(async () => {
        const wake = this.pending;
        if (!wake || Date.parse(wake.at) > Date.now()) return;
        const result = await this.events.emitCompanionWake(wake.id, wake.note);
        if (result.deliveries.some(delivery => delivery.accepted)) { this.pending = null; await this.save(); }
      });
    } finally { this.busy = false; }
  }
}
