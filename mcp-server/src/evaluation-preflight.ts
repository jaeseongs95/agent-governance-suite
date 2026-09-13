import { createHash } from "node:crypto";
import { access } from "node:fs/promises";

export type EvaluationPreflightCode =
  | "ARTIFACT_BINDING_MISMATCH"
  | "ACTOR_BINDING_MISMATCH"
  | "ACTOR_REUSE"
  | "DIGEST_MISMATCH"
  | "DUPLICATE_ID"
  | "EMPTY_ARTIFACT"
  | "EMPTY_REQUIRED_FIELD"
  | "FORBIDDEN_VISIBLE_FIELD"
  | "ID_SEQUENCE_MISMATCH"
  | "INVALID_JSONL"
  | "OUTPUT_EXISTS"
  | "RUN_OUT_OF_BUDGET";

export class EvaluationPreflightError extends Error {
  constructor(
    readonly code: EvaluationPreflightCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(`${code}: ${message}`);
    this.name = "EvaluationPreflightError";
  }
}

export interface EvaluationActorSpec {
  role: string;
  actorId: string;
  declaredActorId?: string;
}

export interface EvaluationArtifactSpec {
  name: string;
  text: string;
  canonicalIds?: boolean;
  idField?: string;
  requiredFields?: string[];
  nonEmptyStringFields?: string[];
  actorRole?: string;
  actorField?: string;
  forbiddenVisibleFields?: string[];
}

export interface EvaluationDigestBinding {
  name: string;
  value: string | Buffer;
  expectedSha256?: string;
}

export interface EvaluationRecordBinding {
  sourceArtifact: string;
  targetArtifact: string;
  fields: string[];
}

export interface EvaluationPreflightRequest {
  runOrdinal: number;
  approvedRunCount: number;
  expectedRecordCount: number;
  outputPaths: string[];
  actors: EvaluationActorSpec[];
  artifacts: EvaluationArtifactSpec[];
  digestBindings: EvaluationDigestBinding[];
  recordBindings?: EvaluationRecordBinding[];
}

export interface EvaluationPreflightResult {
  ids: string[];
  digests: Record<string, string>;
}

const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;

export async function assertEvaluationPreflight(
  request: EvaluationPreflightRequest,
): Promise<EvaluationPreflightResult> {
  if (
    !Number.isInteger(request.runOrdinal)
    || request.runOrdinal < 1
    || !Number.isInteger(request.approvedRunCount)
    || request.approvedRunCount < 1
    || request.runOrdinal > request.approvedRunCount
  ) {
    throw new EvaluationPreflightError("RUN_OUT_OF_BUDGET", "run ordinal is outside the approved evaluation count", {
      runOrdinal: request.runOrdinal,
      approvedRunCount: request.approvedRunCount,
    });
  }

  for (const outputPath of request.outputPaths) {
    if (await pathExists(outputPath)) {
      throw new EvaluationPreflightError("OUTPUT_EXISTS", "evaluation output would be overwritten", { outputPath });
    }
  }

  const actorsByRole = new Map<string, string>();
  const actorIds = new Set<string>();
  for (const actor of request.actors) {
    if (!actor.role || !actor.actorId || (actor.declaredActorId !== undefined && actor.declaredActorId !== actor.actorId)) {
      throw new EvaluationPreflightError("ACTOR_BINDING_MISMATCH", "declared and observed actors must match", {
        role: actor.role,
        actorId: actor.actorId,
        declaredActorId: actor.declaredActorId ?? null,
      });
    }
    if (actorsByRole.has(actor.role)) {
      throw new EvaluationPreflightError("ACTOR_BINDING_MISMATCH", "actor roles must be unique", { role: actor.role });
    }
    if (actorIds.has(actor.actorId)) {
      throw new EvaluationPreflightError("ACTOR_REUSE", "evaluation roles must use distinct actors", {
        role: actor.role,
        actorId: actor.actorId,
      });
    }
    actorsByRole.set(actor.role, actor.actorId);
    actorIds.add(actor.actorId);
  }

  const digests: Record<string, string> = {};
  for (const binding of request.digestBindings) {
    const actual = sha256(binding.value);
    digests[binding.name] = actual;
    if (
      binding.expectedSha256 !== undefined
      && (!DIGEST_PATTERN.test(binding.expectedSha256) || actual !== binding.expectedSha256)
    ) {
      throw new EvaluationPreflightError("DIGEST_MISMATCH", "artifact does not match its frozen digest", {
        name: binding.name,
        expectedSha256: binding.expectedSha256,
        actualSha256: actual,
      });
    }
  }

  const parsedArtifacts = request.artifacts.map((artifact) => ({
    artifact,
    records: parseJsonl(artifact.name, artifact.text),
  }));
  const canonicalArtifacts = parsedArtifacts.filter(({ artifact }) => artifact.canonicalIds === true);
  if (canonicalArtifacts.length !== 1) {
    throw new EvaluationPreflightError("ID_SEQUENCE_MISMATCH", "exactly one artifact must define the canonical ID sequence", {
      canonicalArtifactCount: canonicalArtifacts.length,
    });
  }

  const canonical = canonicalArtifacts[0]!;
  const canonicalIds = readIds(canonical.artifact, canonical.records);
  if (canonicalIds.length !== request.expectedRecordCount) {
    throw new EvaluationPreflightError("ID_SEQUENCE_MISMATCH", "canonical artifact count does not match the frozen case count", {
      artifact: canonical.artifact.name,
      expectedRecordCount: request.expectedRecordCount,
      actualRecordCount: canonicalIds.length,
    });
  }

  for (const { artifact, records } of parsedArtifacts) {
    validateRequiredFields(artifact, records);
    validateForbiddenVisibleFields(artifact, records);
    if (artifact.idField) {
      const ids = readIds(artifact, records);
      if (ids.length !== canonicalIds.length || ids.some((id, index) => id !== canonicalIds[index])) {
        throw new EvaluationPreflightError("ID_SEQUENCE_MISMATCH", "artifact IDs do not match the canonical sequence", {
          artifact: artifact.name,
          expectedCount: canonicalIds.length,
          actualCount: ids.length,
        });
      }
    }
    if (artifact.actorRole) {
      const expectedActorId = actorsByRole.get(artifact.actorRole);
      if (!expectedActorId) {
        throw new EvaluationPreflightError("ACTOR_BINDING_MISMATCH", "artifact references an undeclared actor role", {
          artifact: artifact.name,
          role: artifact.actorRole,
        });
      }
      const actorField = artifact.actorField ?? "actorId";
      if (records.some((record) => record[actorField] !== expectedActorId)) {
        throw new EvaluationPreflightError("ACTOR_BINDING_MISMATCH", "artifact records do not match the declared actor", {
          artifact: artifact.name,
          role: artifact.actorRole,
          actorField,
        });
      }
    }
    digests[artifact.name] = sha256(artifact.text);
  }

  const artifactsByName = new Map(parsedArtifacts.map((item) => [item.artifact.name, item.records]));
  for (const binding of request.recordBindings ?? []) {
    const source = artifactsByName.get(binding.sourceArtifact);
    const target = artifactsByName.get(binding.targetArtifact);
    if (!source || !target || source.length !== target.length || binding.fields.length === 0) {
      throw new EvaluationPreflightError("ARTIFACT_BINDING_MISMATCH", "record binding references incompatible artifacts", {
        sourceArtifact: binding.sourceArtifact,
        targetArtifact: binding.targetArtifact,
      });
    }
    for (const [index, sourceRecord] of source.entries()) {
      const targetRecord = target[index]!;
      for (const field of binding.fields) {
        if (!Object.hasOwn(sourceRecord, field) || sourceRecord[field] !== targetRecord[field]) {
          throw new EvaluationPreflightError("ARTIFACT_BINDING_MISMATCH", "bound evaluation fields differ", {
            sourceArtifact: binding.sourceArtifact,
            targetArtifact: binding.targetArtifact,
            field,
            record: index + 1,
          });
        }
      }
    }
  }

  return { ids: canonicalIds, digests };
}

function parseJsonl(name: string, text: string): Array<Record<string, unknown>> {
  const lines = text.split(/\r?\n/u).filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    throw new EvaluationPreflightError("EMPTY_ARTIFACT", "required evaluation artifact is empty", { artifact: name });
  }
  return lines.map((line, index) => {
    try {
      const value = JSON.parse(line) as unknown;
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("record is not an object");
      return value as Record<string, unknown>;
    } catch (error) {
      throw new EvaluationPreflightError("INVALID_JSONL", "evaluation artifact contains invalid JSONL", {
        artifact: name,
        line: index + 1,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

function readIds(artifact: EvaluationArtifactSpec, records: Array<Record<string, unknown>>): string[] {
  const idField = artifact.idField ?? "id";
  const ids = records.map((record, index) => {
    const value = record[idField];
    if (typeof value !== "string" || value.length === 0) {
      throw new EvaluationPreflightError("EMPTY_REQUIRED_FIELD", "record ID must be a non-empty string", {
        artifact: artifact.name,
        field: idField,
        record: index + 1,
      });
    }
    return value;
  });
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) {
      throw new EvaluationPreflightError("DUPLICATE_ID", "evaluation artifact contains a duplicate ID", {
        artifact: artifact.name,
        id,
      });
    }
    seen.add(id);
  }
  return ids;
}

function validateRequiredFields(
  artifact: EvaluationArtifactSpec,
  records: Array<Record<string, unknown>>,
): void {
  for (const [index, record] of records.entries()) {
    for (const field of artifact.requiredFields ?? []) {
      if (!Object.hasOwn(record, field) || record[field] === null || record[field] === undefined) {
        throw new EvaluationPreflightError("EMPTY_REQUIRED_FIELD", "required evaluation field is missing", {
          artifact: artifact.name,
          field,
          record: index + 1,
        });
      }
    }
    for (const field of artifact.nonEmptyStringFields ?? []) {
      if (typeof record[field] !== "string" || String(record[field]).trim().length === 0) {
        throw new EvaluationPreflightError("EMPTY_REQUIRED_FIELD", "required evaluation text field is empty", {
          artifact: artifact.name,
          field,
          record: index + 1,
        });
      }
    }
  }
}

function validateForbiddenVisibleFields(
  artifact: EvaluationArtifactSpec,
  records: Array<Record<string, unknown>>,
): void {
  const forbidden = new Set(artifact.forbiddenVisibleFields ?? []);
  if (forbidden.size === 0) return;
  for (const [index, record] of records.entries()) {
    const found = findForbiddenField(record, forbidden);
    if (found) {
      throw new EvaluationPreflightError("FORBIDDEN_VISIBLE_FIELD", "hidden evaluation data is visible to a role", {
        artifact: artifact.name,
        field: found,
        record: index + 1,
      });
    }
  }
}

function findForbiddenField(value: unknown, forbidden: Set<string>): string | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findForbiddenField(item, forbidden);
      if (found) return found;
    }
    return null;
  }
  if (!value || typeof value !== "object") return null;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (forbidden.has(key)) return key;
    const found = findForbiddenField(nested, forbidden);
    if (found) return found;
  }
  return null;
}

async function pathExists(filePath: string): Promise<boolean> {
  return access(filePath).then(
    () => true,
    () => false,
  );
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
