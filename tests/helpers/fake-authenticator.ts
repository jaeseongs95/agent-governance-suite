import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign, type KeyObject } from "node:crypto";

import type { AdminAssertion } from "../../mcp-server/src/admin-webauthn.js";
import { intentChallenge } from "../../mcp-server/src/admin-webauthn.js";
import type { AdminChange } from "../../mcp-server/src/admin-log.js";
import type { ContextLayerService } from "../../mcp-server/src/context-layer-service.js";

/**
 * A software authenticator for tests: a node:crypto key pair that builds the same authenticatorData and clientDataJSON
 * a browser passkey returns for navigator.credentials.get(). Every field can be bent to produce one failure at a time.
 */
export type FakeAlgorithm = -7 | -257 | -8;

export interface AssertionOptions {
  origin?: string;
  type?: string;
  rpId?: string;
  /** Authenticator flags byte; 0x05 = user present + user verified. */
  flags?: number;
  /** Signs this challenge instead of the intent's. */
  challenge?: string;
  /** Flips one signature byte after signing. */
  corruptSignature?: boolean;
}

export interface FakeAuthenticator {
  credentialId: string;
  publicKey: string;
  alg: FakeAlgorithm;
  label: string;
  addChange(label?: string): AdminChange & { op: "key.add" };
  assert(intent: string, options?: AssertionOptions): AdminAssertion;
}

const sha256 = (data: Buffer | string) => createHash("sha256").update(data).digest();

export function fakeAuthenticator(alg: FakeAlgorithm = -7, label = `test key ${alg}`): FakeAuthenticator {
  const pair = alg === -7 ? generateKeyPairSync("ec", { namedCurve: "prime256v1" })
    : alg === -257 ? generateKeyPairSync("rsa", { modulusLength: 2048 })
      : generateKeyPairSync("ed25519");
  const privateKey: KeyObject = pair.privateKey;
  const credentialId = randomBytes(16).toString("base64url");
  const publicKey = pair.publicKey.export({ format: "der", type: "spki" }).toString("base64url");
  let counter = 0;
  return {
    credentialId, publicKey, alg, label,
    addChange: (name = label) => ({ op: "key.add", credentialId, publicKey, alg, label: name }),
    assert(intent, options = {}) {
      const clientData = Buffer.from(JSON.stringify({ type: options.type ?? "webauthn.get", challenge: options.challenge ?? intentChallenge(intent),
        origin: options.origin ?? "http://localhost:47615", crossOrigin: false }), "utf8");
      const signCount = Buffer.alloc(4);
      signCount.writeUInt32BE(++counter);
      const authenticatorData = Buffer.concat([sha256(options.rpId ?? "localhost"), Buffer.from([options.flags ?? 0x05]), signCount]);
      const signed = Buffer.concat([authenticatorData, sha256(clientData)]);
      const signature = sign(alg === -8 ? null : "sha256", signed, privateKey);
      if (options.corruptSignature) signature[signature.length - 1]! ^= 0x01;
      return { credentialId, authenticatorData: authenticatorData.toString("base64url"), clientDataJSON: clientData.toString("base64url"),
        signature: signature.toString("base64url") };
    },
  };
}

/** The page's flow: prepare the intent, sign it, commit it under a fresh request ID. */
export function signAndCommit(service: ContextLayerService, signer: FakeAuthenticator, change: unknown,
  options: { bootstrap?: boolean; proposalId?: string | null; assertion?: AssertionOptions; requestId?: string } = {}) {
  const prepared = service.prepareIntent(change, options.bootstrap ?? false);
  return service.commit({ intent: prepared.intent, assertion: signer.assert(prepared.intent, options.assertion), requestId: options.requestId ?? randomUUID(),
    proposalId: options.proposalId ?? null });
}

/** Registers `signer` as the first key when the log has none. */
export function ensureBootstrapped(service: ContextLayerService, signer: FakeAuthenticator): void {
  if (service.adminState().keys.length === 0) signAndCommit(service, signer, signer.addChange(), { bootstrap: true });
}
