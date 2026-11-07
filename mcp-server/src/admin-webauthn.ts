import { createHash, createPublicKey, verify, type KeyObject } from "node:crypto";

/**
 * WebAuthn assertion checks for the local admin page (AGS3-T-0024). Only node:crypto: the page sends the SPKI public key
 * the browser exposes (getPublicKey) at registration, so no CBOR or attestation parsing is needed. The relying party is
 * always `localhost` (WebAuthn does not accept an IP address as an RP ID); the page origin is http://localhost[:port].
 */
export const ADMIN_RP_ID = "localhost";

export const ADMIN_ERROR_CODES = [
  "ADMIN_KEY_NOT_REGISTERED", "ADMIN_ALREADY_BOOTSTRAPPED", "ADMIN_KEY_UNKNOWN", "ADMIN_KEY_REVOKED", "ADMIN_LAST_KEY_REVOKE_REFUSED",
  "ADMIN_ALGORITHM_UNSUPPORTED", "WEBAUTHN_PUBLIC_KEY_UNAVAILABLE", "ADMIN_SIGNATURE_INVALID", "ADMIN_CHALLENGE_MISMATCH",
  "ADMIN_ORIGIN_REJECTED", "ADMIN_RPID_MISMATCH", "ADMIN_USER_VERIFICATION_MISSING", "ADMIN_INTENT_NONCANONICAL", "ADMIN_INTENT_EXPIRED",
  "ADMIN_TARGET_STALE", "ADMIN_LOG_REGRESSED", "ADMIN_PROPOSAL_NOT_FOUND", "ADMIN_CHANGE_INVALID", "ADMIN_RECORD_ALTERED",
] as const;
export type AdminErrorCode = (typeof ADMIN_ERROR_CODES)[number];

export class AdminError extends Error {
  constructor(readonly code: AdminErrorCode, readonly details: Record<string, unknown> = {}) {
    super(code);
    this.name = "AdminError";
  }
}

/** COSE algorithm identifiers the page accepts: ES256, RS256, EdDSA (Ed25519). */
const ALGORITHMS: Record<number, { keyType: string; hash: string | null }> = {
  [-7]: { keyType: "ec", hash: "sha256" },
  [-257]: { keyType: "rsa", hash: "sha256" },
  [-8]: { keyType: "ed25519", hash: null },
};

export interface AdminPublicKey {
  credentialId: string;
  /** base64url DER SubjectPublicKeyInfo, as PublicKeyCredential.response.getPublicKey() returns it. */
  publicKey: string;
  alg: number;
}

export interface AdminAssertion {
  credentialId: string;
  /** base64url of the raw bytes the authenticator returned. */
  authenticatorData: string;
  clientDataJSON: string;
  signature: string;
}

export function sha256(data: Buffer | string): Buffer {
  return createHash("sha256").update(data).digest();
}

export function base64url(data: Buffer): string {
  return data.toString("base64url");
}

function bytes(value: string, field: string): Buffer {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]*$/.test(value)) throw new AdminError("ADMIN_SIGNATURE_INVALID", { field });
  return Buffer.from(value, "base64url");
}

/** The challenge the authenticator signs for an intent: SHA-256 of the canonical intent string. */
export function intentChallenge(intent: string): string {
  return base64url(sha256(Buffer.from(intent, "utf8")));
}

/** A short fingerprint the page shows next to a key, so a key planted by someone else stands out. */
export function keyFingerprint(publicKey: string): string {
  const hex = sha256(Buffer.from(publicKey, "base64url")).toString("hex").slice(0, 16).toUpperCase();
  return hex.match(/.{4}/g)!.join("-");
}

/** Imports a registered key; an unknown algorithm or a key of another type is refused, never guessed. */
export function importAdminKey(key: AdminPublicKey): KeyObject {
  const algorithm = ALGORITHMS[key.alg];
  if (!algorithm) throw new AdminError("ADMIN_ALGORITHM_UNSUPPORTED", { alg: key.alg });
  let imported: KeyObject;
  try {
    imported = createPublicKey({ key: bytes(key.publicKey, "publicKey"), format: "der", type: "spki" });
  } catch {
    throw new AdminError("WEBAUTHN_PUBLIC_KEY_UNAVAILABLE");
  }
  if (imported.asymmetricKeyType !== algorithm.keyType) throw new AdminError("ADMIN_ALGORITHM_UNSUPPORTED", { alg: key.alg, keyType: imported.asymmetricKeyType });
  if (algorithm.keyType === "ec" && imported.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
    throw new AdminError("ADMIN_ALGORITHM_UNSUPPORTED", { alg: key.alg, curve: imported.asymmetricKeyDetails?.namedCurve });
  }
  return imported;
}

/** http://localhost or http://localhost:<port>; the relying party ID binds the rest. */
export function isAdminOrigin(origin: unknown): boolean {
  return typeof origin === "string" && /^http:\/\/localhost(?::\d{1,5})?$/.test(origin);
}

/** The origin the browser wrote into an assertion's client data, or null when it cannot be read. */
export function assertionOrigin(assertion: Pick<AdminAssertion, "clientDataJSON">): string | null {
  try {
    const origin = (JSON.parse(bytes(assertion.clientDataJSON, "clientDataJSON").toString("utf8")) as { origin?: unknown }).origin;
    return typeof origin === "string" ? origin : null;
  } catch {
    return null;
  }
}

/**
 * Checks one assertion over an intent: client data type, challenge, origin, RP ID hash, user presence and user
 * verification, then the signature. The sign counter is returned for the record and never decides anything (synced
 * passkeys report zero).
 */
export function verifyAdminAssertion(intent: string, assertion: AdminAssertion, key: AdminPublicKey): { signCount: number } {
  const clientDataBytes = bytes(assertion.clientDataJSON, "clientDataJSON");
  let clientData: { type?: unknown; challenge?: unknown; origin?: unknown };
  try { clientData = JSON.parse(clientDataBytes.toString("utf8")) as typeof clientData; } catch { throw new AdminError("ADMIN_SIGNATURE_INVALID", { field: "clientDataJSON" }); }
  if (clientData.type !== "webauthn.get") throw new AdminError("ADMIN_SIGNATURE_INVALID", { field: "type" });
  if (clientData.challenge !== intentChallenge(intent)) throw new AdminError("ADMIN_CHALLENGE_MISMATCH");
  if (!isAdminOrigin(clientData.origin)) throw new AdminError("ADMIN_ORIGIN_REJECTED", { origin: typeof clientData.origin === "string" ? clientData.origin.slice(0, 100) : null });
  const authenticatorData = bytes(assertion.authenticatorData, "authenticatorData");
  if (authenticatorData.length < 37) throw new AdminError("ADMIN_SIGNATURE_INVALID", { field: "authenticatorData" });
  if (!authenticatorData.subarray(0, 32).equals(sha256(ADMIN_RP_ID))) throw new AdminError("ADMIN_RPID_MISMATCH");
  const flags = authenticatorData[32]!;
  if ((flags & 0x01) === 0 || (flags & 0x04) === 0) throw new AdminError("ADMIN_USER_VERIFICATION_MISSING", { userPresent: (flags & 0x01) !== 0, userVerified: (flags & 0x04) !== 0 });
  const publicKey = importAdminKey(key);
  const signed = Buffer.concat([authenticatorData, sha256(clientDataBytes)]);
  let valid: boolean;
  try { valid = verify(ALGORITHMS[key.alg]!.hash, signed, publicKey, bytes(assertion.signature, "signature")); } catch { valid = false; }
  if (!valid) throw new AdminError("ADMIN_SIGNATURE_INVALID", { field: "signature" });
  return { signCount: authenticatorData.readUInt32BE(33) };
}
