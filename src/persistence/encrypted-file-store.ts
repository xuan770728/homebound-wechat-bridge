import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const MAGIC = "WPG1";

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
}

function atomicWrite(filePath: string, data: string): void {
  ensureDir(path.dirname(filePath));
  const tempPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const fd = fs.openSync(tempPath, "w", 0o600);
  try {
    fs.writeFileSync(fd, data, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.chmodSync(tempPath, 0o600);
  fs.renameSync(tempPath, filePath);
  try {
    const dirFd = fs.openSync(path.dirname(filePath), "r");
    try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
  } catch { /* Some filesystems do not allow fsync on directories. */ }
}

export class EncryptedFileStore {
  private readonly key: Buffer;

  constructor(private readonly dataDir: string, encryptionKey?: string) {
    if (!encryptionKey) {
      if (process.env.NODE_ENV === "production") throw new Error("Encryption key is required in production");
      this.key = crypto.createHash("sha256").update("development-only-wechat-personal-gateway").digest();
    } else {
      const decoded = Buffer.from(encryptionKey, "base64");
      this.key = decoded.length === 32 ? decoded : crypto.createHash("sha256").update(encryptionKey).digest();
    }
  }

  filePath(relativePath: string): string {
    const resolved = path.resolve(this.dataDir, relativePath);
    if (!resolved.startsWith(`${path.resolve(this.dataDir)}${path.sep}`)) throw new Error("invalid persistence path");
    return resolved;
  }

  writeJson<T>(relativePath: string, value: T): void {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.key, iv);
    const plaintext = Buffer.from(JSON.stringify(value), "utf8");
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    const payload = [MAGIC, iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(".");
    atomicWrite(this.filePath(relativePath), payload);
  }

  readJson<T>(relativePath: string): T | undefined {
    const filePath = this.filePath(relativePath);
    if (!fs.existsSync(filePath)) return undefined;
    const parts = fs.readFileSync(filePath, "utf8").trim().split(".");
    if (parts.length !== 4 || parts[0] !== MAGIC) throw new Error(`corrupt encrypted file: ${relativePath}`);
    try {
      const decipher = crypto.createDecipheriv("aes-256-gcm", this.key, Buffer.from(parts[1]!, "base64url"));
      decipher.setAuthTag(Buffer.from(parts[2]!, "base64url"));
      const plaintext = Buffer.concat([decipher.update(Buffer.from(parts[3]!, "base64url")), decipher.final()]);
      return JSON.parse(plaintext.toString("utf8")) as T;
    } catch (error) {
      throw new Error(`cannot decrypt ${relativePath}: ${String(error)}`);
    }
  }

  exists(relativePath: string): boolean { return fs.existsSync(this.filePath(relativePath)); }
}
