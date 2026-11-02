import type { Config } from "../config.js";
import type { ContextTokenStore } from "../persistence/context-token-store.js";
import type { TargetConfig, TargetView } from "../types.js";
import { EncryptedFileStore } from "../persistence/encrypted-file-store.js";

export class TargetRegistry {
  private readonly targets: TargetConfig[];
  private readonly files: EncryptedFileStore;
  constructor(config: Config, private readonly contexts: ContextTokenStore) {
    this.files = new EncryptedFileStore(config.dataDir, config.encryptionKey);
    const persisted = this.files.readJson<TargetConfig[]>("accounts/default/targets.enc");
    const configured = new Map((persisted ?? config.targets).map((target) => [target.target, { ...target, enabled: target.enabled ?? true }]));
    this.targets = config.allowedTargets.map((alias) => configured.get(alias) ?? { target: alias, displayName: alias, enabled: true });
    this.files.writeJson("accounts/default/targets.enc", this.targets);
  }
  list(): TargetView[] {
    return this.targets.map((target) => ({ target: target.target, displayName: target.displayName, available: target.enabled && Boolean(target.fromUserId), contextReady: target.enabled && Boolean(target.fromUserId && this.contexts.get("default", target.fromUserId)) }));
  }
  aliasForUserId(fromUserId: string): string | undefined {
    return this.targets.find((target) => target.enabled && target.fromUserId === fromUserId)?.target;
  }
  resolve(target: string): TargetConfig & { userId: string; contextToken: string } {
    const item = this.targets.find((candidate) => candidate.target === target);
    if (!item || !item.enabled) throw new Error("TARGET_NOT_ALLOWED");
    if (!item.fromUserId) throw new Error("TARGET_CONTEXT_UNAVAILABLE");
    const contextToken = this.contexts.get("default", item.fromUserId);
    if (!contextToken) throw new Error("TARGET_CONTEXT_UNAVAILABLE");
    return { ...item, userId: item.fromUserId, contextToken };
  }
  observeInbound(fromUserId: string, contextToken: string): void {
    // Explicit target bindings are authoritative; unknown senders are never exposed as targets.
    if (this.targets.some((target) => target.fromUserId === fromUserId)) this.contexts.set("default", fromUserId, contextToken);
  }

  bind(target: string, fromUserId: string, contextToken: string): void {
    const item = this.targets.find((candidate) => candidate.target === target);
    if (!item || !item.enabled) throw new Error("TARGET_NOT_ALLOWED");
    const duplicate = this.targets.find((candidate) => candidate.target !== target && candidate.fromUserId === fromUserId);
    if (duplicate) throw new Error("TARGET_ALREADY_BOUND");
    item.fromUserId = fromUserId;
    this.contexts.set("default", fromUserId, contextToken);
    this.files.writeJson("accounts/default/targets.enc", this.targets);
  }
}
