import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type Subscription = {
  id: string;
  owner: string;
  name: "homebound.weixin.message" | "homebound.voice.turn" | "homebound.wake";
  arguments: { source: "wechat.dm" | "voice.call" | "companion.wake" };
  url: string;
  secret: string;
  previousSecret?: string;
  rotationExpiresAt?: string;
  refreshBefore: string;
  active: boolean;
};

export class EventsStore {
  private subscriptions = new Map<string, Subscription>();

  constructor(
    private readonly file: string,
    private readonly remote?: { url: string; token: string; accessToken?: string },
  ) {}

  async load(): Promise<void> {
    if (this.remote) {
      try {
        const response = await fetch(this.remote.url, {
          headers: {
            authorization: `Bearer ${this.remote.token}`,
            accept: "application/json",
            ...(this.remote.accessToken ? { "OAI-Sites-Authorization": `Bearer ${this.remote.accessToken}` } : {}),
          },
        });
        if (!response.ok) throw new Error(`subscription store returned ${response.status}`);
        const body = await response.json() as { subscriptions?: unknown };
        if (Array.isArray(body.subscriptions)) {
          this.loadValues(body.subscriptions as Subscription[]);
          return;
        }
      } catch {
        // Fall back to the local copy so a temporary storage outage does not
        // prevent the bridge from starting.
      }
    }
    try {
      this.loadValues(JSON.parse(await readFile(this.file, "utf8")) as Subscription[]);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private loadValues(values: Subscription[]): void {
    const now = new Date().toISOString();
    for (const value of values) {
      if (["homebound.weixin.message", "homebound.voice.turn", "homebound.wake"].includes(value.name) && value.refreshBefore > now) {
        this.subscriptions.set(value.id, value);
      }
    }
  }

  get(id: string): Subscription | undefined { return this.subscriptions.get(id); }
  all(): Subscription[] { return [...this.subscriptions.values()]; }

  async put(value: Subscription): Promise<void> {
    this.subscriptions.set(value.id, value);
    await this.save();
  }

  async remove(id: string): Promise<void> {
    this.subscriptions.delete(id);
    await this.save();
  }

  private async save(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.tmp`;
    await writeFile(temporary, JSON.stringify(this.all(), null, 2), { mode: 0o600 });
    await rename(temporary, this.file);
    if (this.remote) {
      const response = await fetch(this.remote.url, {
        method: "PUT",
        headers: {
          authorization: `Bearer ${this.remote.token}`,
          "content-type": "application/json",
          ...(this.remote.accessToken ? { "OAI-Sites-Authorization": `Bearer ${this.remote.accessToken}` } : {}),
        },
        body: JSON.stringify({ subscriptions: this.all() }),
      });
      if (!response.ok) throw new Error(`subscription store returned ${response.status}`);
    }
  }
}
