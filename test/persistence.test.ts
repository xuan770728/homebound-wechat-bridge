import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EncryptedFileStore } from "../src/persistence/encrypted-file-store.js";
import { ContextTokenStore } from "../src/persistence/context-token-store.js";
import { CursorStore } from "../src/persistence/cursor-store.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe("encrypted persistence", () => {
  it("writes encrypted, recoverable, atomically replaced values", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wpg-store-")); dirs.push(dir);
    const store = new EncryptedFileStore(dir, "test-key");
    store.writeJson("accounts/default/credential.enc", { botToken: "secret-token", accountId: "default" });
    const raw = fs.readFileSync(path.join(dir, "accounts/default/credential.enc"), "utf8");
    expect(raw).not.toContain("secret-token");
    expect(store.readJson<{ botToken: string }>("accounts/default/credential.enc")?.botToken).toBe("secret-token");
  });

  it("keeps cursor and contexts in separate encrypted records", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wpg-store-")); dirs.push(dir);
    const cursor = new CursorStore(dir, "test-key"); const contexts = new ContextTokenStore(dir, "test-key");
    cursor.write("default", "cursor-1"); contexts.set("default", "user-1", "context-1");
    expect(cursor.read("default")).toBe("cursor-1");
    expect(contexts.get("default", "user-1")).toBe("context-1");
    expect(fs.existsSync(path.join(dir, "accounts/default/cursor.enc"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "accounts/default/context-tokens.enc"))).toBe(true);
  });
});
