import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { WorkflowContractError } from "../../contracts/types.js";
import { convergenceDigest } from "./convergence-logic.js";
import { actorAccess, type ActorObservation, type InputObservation } from "./input-observation.js";
import type { WorkflowStore } from "./workflow-store.js";

export const SESSION_PROOF_FIELD = "_sessionProof";
const KEY = "governance-root-call-key-v3";
const PREFIX = "ags-root-v3";
const TTL_MS = 5 * 60_000;

export interface VerifiedSessionActor {
  host: string;
  sessionId: string;
  actor: ActorObservation;
}
export interface SessionActorProofVerifier {
  verify(tool: string, args: Record<string, unknown>): VerifiedSessionActor;
}
interface RootCallProof extends VerifiedSessionActor {
  version: 3;
  tool: string;
  inputDigest: string;
  call: string;
  issuedAt: number;
  expiresAt: number;
}
export function withoutSessionProof(args: Record<string, unknown>): Record<string, unknown> {
  const input = { ...args };
  delete input[SESSION_PROOF_FIELD];
  return input;
}
function invalid(reasonCode: string): never {
  throw new WorkflowContractError("BINDING_INVALID", "The current root hook proof is invalid.", { reasonCode });
}

/** Per-call proof only. Reuses workflow secrets and the atomic one-use observation claim;
 * no identity registry, polling, process inference or host-specific rule lives here.
 * A same-user process can read the key: this is a hook contract, not OS isolation. */
export class SessionActorProofs implements SessionActorProofVerifier {
  constructor(private readonly store: WorkflowStore, private readonly now: () => number = Date.now) {}

  private key(): Buffer {
    const key = Buffer.from(this.store.getOrCreateSecret(KEY, () => randomBytes(32).toString("base64url")), "base64url");
    if (key.length !== 32) return invalid("ROOT_PROOF_KEY_INVALID");
    return key;
  }

  issue(observation: InputObservation, tool: string, args: Record<string, unknown>): string {
    const access = actorAccess(observation.actor);
    if (!access.allowed) return invalid(access.reasonCode);
    if (!observation.host || !observation.sessionId || !observation.callId) return invalid("ROOT_CALL_ID_MISSING");
    if (Object.hasOwn(args, "_sessionBinding")) return invalid("CALLER_SESSION_BINDING_REJECTED");
    const issuedAt = this.now();
    const proof: RootCallProof = {
      version: 3, host: observation.host, sessionId: observation.sessionId, actor: { ...observation.actor },
      tool, inputDigest: convergenceDigest(withoutSessionProof(args)),
      call: createHash("sha256").update(JSON.stringify([observation.host, observation.sessionId, observation.callId])).digest("hex"),
      issuedAt, expiresAt: issuedAt + TTL_MS,
    };
    const body = `${PREFIX}.${Buffer.from(JSON.stringify(proof)).toString("base64url")}`;
    return `${body}.${createHmac("sha256", this.key()).update(body).digest("base64url")}`;
  }

  verify(tool: string, args: Record<string, unknown>): VerifiedSessionActor {
    if (Object.hasOwn(args, "_sessionBinding")) return invalid("CALLER_SESSION_BINDING_REJECTED");
    const token = args[SESSION_PROOF_FIELD];
    if (typeof token !== "string" || !token) {
      throw new WorkflowContractError("BINDING_REQUIRED", "A current root hook proof is required.", { reasonCode: "ROOT_HOOK_PROOF_REQUIRED" });
    }
    if (token.length > 8192) return invalid("ROOT_PROOF_TOO_LARGE");
    const [prefix, encoded, signature, extra] = token.split(".");
    if (prefix !== PREFIX || !encoded || !signature || extra !== undefined) return invalid("ROOT_PROOF_FORMAT_INVALID");
    const expected = createHmac("sha256", this.key()).update(`${prefix}.${encoded}`).digest();
    const actual = Buffer.from(signature, "base64url");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return invalid("ROOT_PROOF_SIGNATURE_INVALID");
    let proof: RootCallProof;
    try { proof = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as RootCallProof; }
    catch { return invalid("ROOT_PROOF_PAYLOAD_INVALID"); }
    const now = this.now();
    if (!proof || proof.version !== 3 || typeof proof.host !== "string" || !proof.host
      || typeof proof.sessionId !== "string" || !proof.sessionId || !proof.actor
      || !actorAccess(proof.actor).allowed || typeof proof.call !== "string" || !/^[a-f0-9]{64}$/u.test(proof.call)
      || !Number.isFinite(proof.issuedAt) || !Number.isFinite(proof.expiresAt)
      || proof.issuedAt > now || proof.expiresAt <= now || proof.expiresAt - proof.issuedAt !== TTL_MS
      || proof.tool !== tool || proof.inputDigest !== convergenceDigest(withoutSessionProof(args))) {
      return invalid("ROOT_PROOF_SCOPE_OR_TIME_INVALID");
    }
    if (!this.store.claimExecutionObservation(`${PREFIX}:${proof.call}`, new Date(proof.expiresAt).toISOString(), new Date(now).toISOString())) {
      return invalid("ROOT_PROOF_ALREADY_CONSUMED");
    }
    return { host: proof.host, sessionId: proof.sessionId, actor: { ...proof.actor } };
  }
}
