import { createHash } from "node:crypto";

import type { ArtifactNamespaceV1, CheckpointDeltaV1 } from "../../../contracts/types.js";
import { ARTIFACT_NAMESPACE, WorkflowContractError } from "../../../contracts/types.js";
import { ContractValidator, verifyArtifactRefContent } from "../schema-validator.js";

const validator = new ContractValidator();

export interface TransportReadback {
  /** The caller must obtain this through an authorized object/file reference read. */
  ref: unknown;
  bytes: unknown;
  /** Trusted caller scope, never copied from the supplied reference. */
  expectedNamespace: ArtifactNamespaceV1;
  encoding: "identity" | "gzip";
  /** Required for gzip; supplied by a trusted manifest, not inferred from decoded content. */
  raw?: { size: number; digest: string };
}

export interface TransportCodec<T> {
  decode(bytes: Uint8Array): T;
  /** Required for gzip. Must return bytes, not text or an object. */
  decompress?(bytes: Uint8Array): Uint8Array;
}

/** Verify the exact transported bytes before any interpretation or decompression. */
export function verifyTransportReadback<T>(input: TransportReadback, codec: TransportCodec<T>): T {
  if (!ARTIFACT_NAMESPACE.includes(input.expectedNamespace)) {
    throw new WorkflowContractError("INVALID_INPUT", "Unknown expected artifact namespace.");
  }
  const ref = validator.artifactRef(input.ref);
  if (ref.namespace !== input.expectedNamespace || ref.hashDomain !== "raw-bytes") {
    throw new WorkflowContractError("GATE_FAILED", "Artifact namespace or hash domain differs from the readback contract.");
  }
  if (!(input.bytes instanceof Uint8Array)) {
    throw new WorkflowContractError("INVALID_INPUT", "Readback must contain bytes, not text or chunks.");
  }
  // Copy once so the bytes passed to codecs are exactly the bytes whose digest was checked.
  const bytes = Buffer.from(input.bytes);
  verifyArtifactRefContent(validator, ref, bytes);
  if (input.encoding === "identity") return codec.decode(bytes);
  if (input.encoding !== "gzip" || !codec.decompress || !input.raw
    || !Number.isSafeInteger(input.raw.size) || input.raw.size < 0
    || !/^sha256:[a-f0-9]{64}$/u.test(input.raw.digest)) {
    throw new WorkflowContractError("INVALID_INPUT", "Unsupported or missing transport decompressor.");
  }
  const uncompressed = codec.decompress(bytes);
  if (!(uncompressed instanceof Uint8Array)) {
    throw new WorkflowContractError("INVALID_INPUT", "Transport decompressor must return bytes.");
  }
  const raw = Buffer.from(uncompressed);
  const digest = `sha256:${createHash("sha256").update(raw).digest("hex")}`;
  if (raw.byteLength !== input.raw.size || digest !== input.raw.digest) {
    throw new WorkflowContractError("INTEGRITY_FAILED", "Uncompressed content does not match its declared size and digest.");
  }
  return codec.decode(raw);
}

/** Small checkpoint deltas alone may be inline; strings and text chunks are never reassembled. */
export function verifyInlineCheckpointDelta(value: unknown): CheckpointDeltaV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new WorkflowContractError("INVALID_INPUT", "Inline delta must be one structured value, not text or chunks.");
  }
  return validator.checkpointDelta(value);
}
