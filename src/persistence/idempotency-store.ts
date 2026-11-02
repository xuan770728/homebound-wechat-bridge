import crypto from "node:crypto";
import fs from "node:fs";
import type { IdempotencyRecord } from "../types.js";
import { EncryptedFileStore } from "./encrypted-file-store.js";

export function hashIdempotencyKey(principalId: string, target: string, key: string): string {
  return crypto.createHash("sha256").update(`${principalId}\0${target}\0${key}`).digest("hex");
}

export class IdempotencyStore {
  private readonly store: EncryptedFileStore;
  constructor(private readonly dataDir: string, encryptionKey?: string) { this.store = new EncryptedFileStore(dataDir, encryptionKey); }

  get(hash: string): IdempotencyRecord | undefined {
    const relative = `accounts/default/idempotency/${hash}.json`;
    try {
      const record = this.store.readJson<IdempotencyRecord>(relative);
      if (record && Date.parse(record.expiresAt) <= Date.now()) {
        try { fs.unlinkSync(this.store.filePath(relative)); } catch { /* best effort expiry cleanup */ }
        return undefined;
      }
      return record;
    } catch (error) {
      throw new Error(`idempotency record is corrupt: ${String(error)}`);
    }
  }
  put(record: IdempotencyRecord): void { this.store.writeJson(`accounts/default/idempotency/${record.keyHash}.json`, record); }
}
