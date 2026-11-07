import type { ContinuityMemoryBodyV1 } from "../../contracts/types.js";
import { WorkflowContractError } from "../../contracts/types.js";
import { canonicalJson, convergenceDigest } from "./convergence-logic.js";
import { msg } from "./i18n.js";

export const CURRENT_MEMORY_MAX_BYTES = 2000;

function exactObject(value: unknown, keys: string[]): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

function boundedString(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && Array.from(value).length <= maximum;
}

/** Pure validation also covers migration inputs without importing Ajv into lifecycle hooks. */
function validBody(memory: ContinuityMemoryBodyV1): boolean {
  const lists = ["completionCriteria", "constraints", "decisions", "progress", "blockers", "nextActions"];
  if (!exactObject(memory, ["status", "core", "evidenceRefs"]) || !["active", "paused", "completed"].includes(memory.status)
    || !exactObject(memory.core, ["objective", ...lists]) || !boundedString(memory.core.objective, 4000)) return false;
  const core = memory.core as unknown as Record<string, unknown>;
  if (!lists.every(key => {
    const values = core[key];
    return Array.isArray(values) && values.length <= 64 && values.every(value => boundedString(value, 2000));
  })) return false;
  return Array.isArray(memory.evidenceRefs) && memory.evidenceRefs.length <= 128 && memory.evidenceRefs.every(ref =>
    exactObject(ref, ["artifactId", "locator", "digest", "verified"]) && boundedString(ref.artifactId, 256)
      && boundedString(ref.locator, 2000) && typeof ref.digest === "string" && /^sha256:[a-f0-9]{64}$/u.test(ref.digest)
      && typeof ref.verified === "boolean");
}

/** The stored body, including JSON keys and evidence references, is the byte boundary. */
export function serializeContinuityMemory(memory: ContinuityMemoryBodyV1): { json: string; digest: `sha256:${string}`; bytes: number } {
  if (!validBody(memory)) {
    throw new WorkflowContractError("INVALID_INPUT", msg("workflow.schema.contractMismatch", {name: "continuityMemory"}));
  }
  const json = canonicalJson(memory);
  const bytes = Buffer.byteLength(json, "utf8");
  if (bytes > CURRENT_MEMORY_MAX_BYTES) {
    throw new WorkflowContractError("INVALID_INPUT", msg("continuity.checkpoint.tooLarge", {bytes, limit: CURRENT_MEMORY_MAX_BYTES}), {
      reasonCode: "CONTINUITY_MEMORY_TOO_LARGE", actualBytes: bytes, maxBytes: CURRENT_MEMORY_MAX_BYTES,
    });
  }
  return { json, digest: convergenceDigest(memory), bytes };
}
