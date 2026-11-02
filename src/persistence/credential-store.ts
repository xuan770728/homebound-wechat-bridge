import fs from "node:fs";
import type { Credential } from "../types.js";
import { EncryptedFileStore } from "./encrypted-file-store.js";

export class CredentialStore {
  private readonly store: EncryptedFileStore;
  constructor(dataDir: string, encryptionKey?: string) { this.store = new EncryptedFileStore(dataDir, encryptionKey); }
  read(accountId = "default"): Credential | undefined { return this.store.readJson<Credential>(`accounts/${accountId}/credential.enc`); }
  write(value: Credential): void { this.store.writeJson(`accounts/${value.accountId}/credential.enc`, value); }
  clear(accountId = "default"): void { const filePath = this.store.filePath(`accounts/${accountId}/credential.enc`); if (fs.existsSync(filePath)) fs.unlinkSync(filePath); }
}
