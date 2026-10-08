import { createHash } from "node:crypto";
import { z } from "zod";
import type { ConfirmedContext, SkillClassificationRequestV1, SkillInventory, SkillMetadata } from "./types.js";
import {digestClassificationValue} from "./digest.js";
export {digestClassificationValue} from "./digest.js";

const list = z.array(z.string());
const contextSchema = z.object({
  taskRevision: z.string().nullable(), objective: z.string().nullable(), actions: list.nullable(), targets: list.nullable(),
  constraints: list.nullable(), prohibitedActions: list.nullable(), background: z.string().nullable(),
}).strict();
const sourceSchema = z.array(z.object({ field: z.enum(["taskRevision", "objective", "actions", "targets", "constraints", "prohibitedActions", "background"]), reference: z.string().min(1) }).strict());
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const metadataSchema = z.object({
  skillId: z.string().min(1), version: z.string().min(1), description: z.string().min(1), enabled: z.boolean(), installed: z.boolean(), hostSupported: z.boolean(),
  capabilities: list.min(1), actions: list, targets: list, constraints: list, applicability: list.min(1), exclusions: list.min(1), dependencies: list,
  phases: z.array(z.object({ capability: z.string(), phase: z.string(), phaseOrder: z.number().int(), requiredInputArtifacts: list, producedArtifacts: list, gate: z.record(z.string(), z.unknown()).optional(), inputBindings: z.array(z.object({ targetArtifact: z.string(), sources: list, operation: z.string() }).passthrough()).optional() }).strict()),
  sourceRefs: z.array(z.object({ path: z.string(), digest }).strict()),
  sourceMap: z.array(z.object({ field: z.string(), path: z.string(), startLine: z.number().int().positive().optional(), endLine: z.number().int().positive().optional(), digest }).strict()).optional(),
}).strict();

export const classificationRequestSchema = z.object({
  schemaVersion: z.literal("1.0.0"), requestId: z.string().min(1), operationId: z.string().min(1),
  originalPrompt: z.string(), promptDigest: digest, confirmedContext: contextSchema, contextSources: sourceSchema,
  skills: z.array(metadataSchema), inventoryDigest: digest, taxonomyRevision: z.string().min(1),
  classificationCriteriaRef: z.string().min(1), requestDigest: digest,
}).strict();
const inputSchema = z.object({
  requestId: z.string().min(1), operationId: z.string().min(1), originalPrompt: z.string(),
  classificationCriteriaRef: z.string().min(1), confirmedContext: contextSchema.partial().optional(), contextSources: sourceSchema.optional(),
  inventory: z.object({
    skills: z.array(metadataSchema), inventoryDigest: digest, taxonomyRevision: z.string().min(1),
    issues: z.array(z.object({ skillId: z.string().nullable(), code: z.string(), field: z.string() }).strict()),
  }).strict(),
}).strict();

export interface ClassificationRequestInput {
  requestId: string;
  operationId: string;
  originalPrompt: string;
  confirmedContext?: Partial<ConfirmedContext>;
  contextSources?: SkillClassificationRequestV1["contextSources"];
  inventory: SkillInventory;
  classificationCriteriaRef: string;
}

export function createClassificationRequest(input: ClassificationRequestInput): SkillClassificationRequestV1 {
  inputSchema.parse(input);
  const confirmedContext = contextSchema.parse({ taskRevision: null, objective: null, actions: null, targets: null, constraints: null, prohibitedActions: null, background: null, ...input.confirmedContext });
  const contextSources = sourceSchema.parse(input.contextSources ?? []);
  z.array(metadataSchema).parse(input.inventory.skills);
  for (const [field, value] of Object.entries(confirmedContext)) {
    if (value !== null && !contextSources.some((source) => source.field === field)) throw new Error("CONTEXT_SOURCE_MISSING");
  }
  const request = {
    schemaVersion: "1.0.0" as const, requestId: input.requestId, operationId: input.operationId,
    originalPrompt: input.originalPrompt, promptDigest: `sha256:${createHash("sha256").update(input.originalPrompt, "utf8").digest("hex")}`,
    confirmedContext, contextSources, skills: structuredClone(input.inventory.skills),
    inventoryDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/).parse(input.inventory.inventoryDigest),
    taxonomyRevision: z.string().min(1).parse(input.inventory.taxonomyRevision), classificationCriteriaRef: input.classificationCriteriaRef,
  };
  const finalized = { ...request, requestDigest: digestClassificationValue(request) };
  validateClassificationRequest(finalized);
  return finalized;
}

export function validateClassificationRequest(request: SkillClassificationRequestV1): void {
  classificationRequestSchema.parse(request);
  const { requestDigest, ...body } = request;
  if (request.schemaVersion !== "1.0.0" || typeof request.originalPrompt !== "string" || request.promptDigest !== `sha256:${createHash("sha256").update(request.originalPrompt, "utf8").digest("hex")}` || requestDigest !== digestClassificationValue(body)) throw new Error("REQUEST_INTEGRITY_FAILED");
  contextSchema.parse(request.confirmedContext);
  sourceSchema.parse(request.contextSources);
  z.array(metadataSchema).parse(request.skills);
  for (const [field, value] of Object.entries(request.confirmedContext)) if (value !== null && !request.contextSources.some((source) => source.field === field)) throw new Error("CONTEXT_SOURCE_MISSING");
  if (new Set(request.skills.map((skill) => skill.skillId)).size !== request.skills.length) throw new Error("DUPLICATE_SKILL_ID");
}

/** Drop only local binding/trace data. Unknown null and confirmed empty arrays survive. */
export function projectClassificationRequest(request: SkillClassificationRequestV1, maximumInputBytes?: number) {
  validateClassificationRequest(request);
  const payload = {
    originalPrompt: request.originalPrompt, confirmedContext: structuredClone(request.confirmedContext),
    taxonomyRevision: request.taxonomyRevision, classificationCriteriaRef: request.classificationCriteriaRef,
    skills: request.skills.map((skill) => {
      const semantic = structuredClone(skill);
      Reflect.deleteProperty(semantic, "sourceRefs");
      Reflect.deleteProperty(semantic, "sourceMap");
      return semantic as Omit<SkillMetadata, "sourceRefs" | "sourceMap">;
    }),
  };
  const payloadBytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
  if (maximumInputBytes !== undefined && (!Number.isSafeInteger(maximumInputBytes) || maximumInputBytes < 1)) throw new Error("INVALID_INPUT_LIMIT");
  if (maximumInputBytes !== undefined && payloadBytes > maximumInputBytes) throw Object.assign(new Error("INPUT_TOO_LONG"), { payloadBytes, maximumInputBytes, omittedRanges: [] });
  return {
    payload, projectionRevision: "1.0.0", payloadBytes,
    preservedFields: ["originalPrompt", "confirmedContext", "taxonomyRevision", "classificationCriteriaRef", "skills.* except sourceRefs/sourceMap"],
    omittedFields: ["schemaVersion", "requestId", "operationId", "promptDigest", "contextSources", "inventoryDigest", "requestDigest", "skills.*.sourceRefs", "skills.*.sourceMap"],
  };
}
