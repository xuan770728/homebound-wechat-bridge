import { EncryptedFileStore } from "./encrypted-file-store.js";

export class CursorStore {
  private readonly store: EncryptedFileStore;
  constructor(dataDir: string, encryptionKey?: string) { this.store = new EncryptedFileStore(dataDir, encryptionKey); }
  read(accountId = "default"): string { return this.store.readJson<string>(`accounts/${accountId}/cursor.enc`) ?? ""; }
  write(accountId: string, cursor: string): void { this.store.writeJson(`accounts/${accountId}/cursor.enc`, cursor); }
}
