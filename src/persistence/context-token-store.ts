import { EncryptedFileStore } from "./encrypted-file-store.js";

export class ContextTokenStore {
  private readonly store: EncryptedFileStore;
  private readonly cache = new Map<string, Map<string, string>>();
  constructor(dataDir: string, encryptionKey?: string) { this.store = new EncryptedFileStore(dataDir, encryptionKey); }

  private load(accountId: string): Map<string, string> {
    const existing = this.cache.get(accountId);
    if (existing) return existing;
    const raw = this.store.readJson<Record<string, string>>(`accounts/${accountId}/context-tokens.enc`) ?? {};
    const map = new Map(Object.entries(raw).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0));
    this.cache.set(accountId, map);
    return map;
  }

  get(accountId: string, userId: string): string | undefined { return this.load(accountId).get(userId); }
  set(accountId: string, userId: string, token: string): void {
    const map = this.load(accountId);
    if (!userId || !token || map.get(userId) === token) return;
    map.set(userId, token);
    this.store.writeJson(`accounts/${accountId}/context-tokens.enc`, Object.fromEntries(map));
  }
  has(accountId: string, userId: string): boolean { return this.load(accountId).has(userId); }
}
