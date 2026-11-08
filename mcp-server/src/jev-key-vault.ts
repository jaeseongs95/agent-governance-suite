import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Encrypted JEV keys (AGS3-T-0024). AES-256-GCM from node:crypto with a random 96-bit IV per value. The additional data
 * binds a ciphertext to its key name and the fingerprint the user signed, so a stored value cannot be moved to another
 * name or swapped for another key without the reader noticing. The 256-bit data key is a file beside the shared state
 * (owner-only permissions where the platform has them).
 *
 * What it protects: the shared state file copied or read on its own (a backup, a support bundle, an agent reading the
 * SQLite file) does not reveal a key. What it does not: a program running as the same OS user can read the data key
 * file too and decrypt (docs/user/admin-page.md, what this cannot stop).
 */
const FORMAT = "v1";
const DATA_KEY_BYTES = 32;

export class JevKeyVaultError extends Error {
  constructor(readonly code: "JEV_KEY_VAULT_UNAVAILABLE" | "JEV_KEY_UNREADABLE") {
    super(code);
    this.name = "JevKeyVaultError";
  }
}

/** sha256:<hex> of the UTF-8 value; the page computes the same with SubtleCrypto before signing. */
export function jevKeyFingerprint(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function additionalData(name: string, fingerprint: string): Buffer {
  return Buffer.from(`ags.jev-key\u0000${FORMAT}\u0000${name}\u0000${fingerprint}`, "utf8");
}

export class JevKeyVault {
  constructor(private readonly dataKeyPath: string) {}

  /**
   * The data key, created on first use. Two processes may race to create it: the key is written to a private temporary
   * file and linked into place, so a reader never sees a partial file and exactly one key wins.
   */
  private dataKey(create: boolean): Buffer {
    const read = (): Buffer | null => {
      try {
        const bytes = readFileSync(this.dataKeyPath);
        if (bytes.length !== DATA_KEY_BYTES) throw new JevKeyVaultError("JEV_KEY_VAULT_UNAVAILABLE");
        return bytes;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        if (error instanceof JevKeyVaultError) throw error;
        throw new JevKeyVaultError("JEV_KEY_VAULT_UNAVAILABLE");
      }
    };
    const existing = read();
    if (existing || !create) {
      if (!existing) throw new JevKeyVaultError("JEV_KEY_UNREADABLE");
      return existing;
    }
    mkdirSync(path.dirname(this.dataKeyPath), { recursive: true, mode: 0o700 });
    const temporary = `${this.dataKeyPath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      writeFileSync(temporary, randomBytes(DATA_KEY_BYTES), { mode: 0o600, flag: "wx" });
      try { linkSync(temporary, this.dataKeyPath); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new JevKeyVaultError("JEV_KEY_VAULT_UNAVAILABLE");
      }
    } catch (error) {
      if (error instanceof JevKeyVaultError) throw error;
      throw new JevKeyVaultError("JEV_KEY_VAULT_UNAVAILABLE");
    } finally {
      rmSync(temporary, { force: true });
    }
    const created = read();
    if (!created) throw new JevKeyVaultError("JEV_KEY_VAULT_UNAVAILABLE");
    return created;
  }

  seal(name: string, fingerprint: string, value: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.dataKey(true), iv);
    cipher.setAAD(additionalData(name, fingerprint));
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return [FORMAT, iv.toString("base64url"), ciphertext.toString("base64url"), cipher.getAuthTag().toString("base64url")].join(".");
  }

  /** The value, only when it decrypts under this name and fingerprint and hashes to that fingerprint. */
  open(name: string, fingerprint: string, sealed: string): string {
    const parts = sealed.split(".");
    if (parts.length !== 4 || parts[0] !== FORMAT) throw new JevKeyVaultError("JEV_KEY_UNREADABLE");
    let value: string;
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.dataKey(false), Buffer.from(parts[1]!, "base64url"), { authTagLength: 16 });
      decipher.setAAD(additionalData(name, fingerprint));
      decipher.setAuthTag(Buffer.from(parts[3]!, "base64url"));
      value = Buffer.concat([decipher.update(Buffer.from(parts[2]!, "base64url")), decipher.final()]).toString("utf8");
    } catch {
      throw new JevKeyVaultError("JEV_KEY_UNREADABLE");
    }
    if (jevKeyFingerprint(value) !== fingerprint) throw new JevKeyVaultError("JEV_KEY_UNREADABLE");
    return value;
  }
}
