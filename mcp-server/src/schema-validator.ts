import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import addFormatsModule, { type FormatsPlugin } from "ajv-formats";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import {
  type AttemptLeaseV1,
  type AttemptOutcomeV1,
  type AttemptProposalV1,
  type ConvergenceFrameV1,
  type ConvergenceRootHandleV1,
  type ConvergenceRootV1,
  type ConvergenceStatusSummaryV1,
  type ConvergenceStatusV1,
  type CheckpointContextRequestV1,
  type GuardedWorkflowStartRequestV1,
  type OpenConvergenceRootRequestV1,
  type PlanWorkflowRequestV1,
  type InspectContextRequestV1,
  type InputSourceReceiptV1,
  type ValidateCollaborationDecisionRequestV1,
  type KoreanProseGlossaryLookupRequestV1,
  type KoreanProseGlossaryLookupResultV1,
  type ExecuteStateCleanupRequestV1,
  type LoadContextRequestV1,
  type PurgeDirectContextRequestV1,
  type UpdateSessionStatusRequestV1,
  type ListSessionStatusRequestV1,
  type SendSessionMessageRequestV1,
  type AcknowledgeSessionMessagesRequestV1,
  type GetSessionMessageStatusRequestV1,
  type PrepareStateCleanupRequestV1,
  type SuppressContextRestoreRequestV1,
  type PluginUpdateNoticeV1,
  type ProviderResultV1,
  type PluginUpdateStatusV1,
  type ResolveConvergenceGateRequestV1,
  type SchemaReferenceV1,
  type SkillDescriptorV2,
  type StageResultV1,
  type StateCleanupPlanV1,
  type StateCleanupReceiptV1,
  type WorkflowPlanV1,
  type WorkflowReceiptV1,
  type WorkflowStatusSummaryV1,
  type HostModelCapabilitiesV1,
  type ModelApplicationRecordV2,
  type ModelApplicationRequestV2,
  type ModelCatalogV1,
  type ModelEvaluationRecordV1,
  type ModelRoutingDecisionV2,
  type ModelRoutingPolicyV1,
  type ModelSelectionRequestV2,
  type SemanticDecisionQuestionV1,
  type SemanticDecisionRequestV1,
  type SemanticDecisionAdviceV1,
  type SemanticDecisionPolicyV1,
  type SemanticModelAssignmentRequestV1,
  type ModelRoutingDecisionV3,
  type ModelApplicationRequestV3,
  type ModelApplicationRecordV3,
  WorkflowContractError,
} from "../../contracts/types.js";

import {
  assertSemanticJson,
  assertSemanticRequestIntegrity,
  assertSemanticAdviceIntegrity,
  assertSemanticAdviceBinding,
  assertSemanticPolicyConsistency,
  assertSemanticAssignmentBinding,
  assertSemanticDecisionIntegrity,
  assertSemanticDecisionBinding,
  assertSemanticApplicationBinding,
  assertSemanticRecordIntegrity,
  assertSemanticRecordBinding,
} from "./semantic-contract-invariants.js";

type JsonSchema = Record<string, unknown>;
const addFormats = addFormatsModule as unknown as FormatsPlugin;

function loadSchema(fileName: string): JsonSchema {
  const path = new URL(`../../contracts/${fileName}`, import.meta.url);
  return JSON.parse(readFileSync(path, "utf8")) as JsonSchema;
}

/** The wire schemas are loaded from contracts/ so MCP and direct callers share one definition. */
export const contractSchemas = {
  apiResult: loadSchema("api-result.v1.schema.json"),
  pluginUpdateStatus: loadSchema("plugin-update-status.v1.schema.json"),
  pluginUpdateNotice: loadSchema("plugin-update-notice.v1.schema.json"),
  executionContext: loadSchema("execution-context.v1.schema.json"),
  executionRequirement: loadSchema("execution-requirement.v1.schema.json"),
  taskEnvelope: loadSchema("task-envelope.v1.schema.json"),
  inputSourceReceipt: loadSchema("input-source-receipt.v1.schema.json"),
  validateCollaborationDecisionRequest: loadSchema("validate-collaboration-decision-request.v1.schema.json"),
  planWorkflowRequest: loadSchema("plan-workflow-request.v1.schema.json"),
  skillDescriptor: loadSchema("skill-descriptor.v1.schema.json"),
  skillDescriptorV2: loadSchema("skill-descriptor.v2.schema.json"),
  workflowPlan: loadSchema("workflow-plan.v1.schema.json"),
  stageResult: loadSchema("stage-result.v1.schema.json"),
  workflowReceipt: loadSchema("workflow-receipt.v1.schema.json"),
  workflowStatusSummary: loadSchema("workflow-status-summary.v1.schema.json"),
  convergenceFrame: loadSchema("convergence-frame.v1.schema.json"),
  convergenceRoot: loadSchema("convergence-root.v1.schema.json"),
  convergenceRootHandle: loadSchema("convergence-root-handle.v1.schema.json"),
  openConvergenceRootRequest: loadSchema("open-convergence-root-request.v1.schema.json"),
  attemptProposal: loadSchema("attempt-proposal.v1.schema.json"),
  attemptLease: loadSchema("attempt-lease.v1.schema.json"),
  guardedWorkflowStartRequest: loadSchema("guarded-workflow-start-request.v1.schema.json"),
  attemptOutcome: loadSchema("attempt-outcome.v1.schema.json"),
  convergenceReview: loadSchema("convergence-review.v1.schema.json"),
  resolveConvergenceGateRequest: loadSchema("resolve-convergence-gate-request.v1.schema.json"),
  convergenceStatus: loadSchema("convergence-status.v1.schema.json"),
  convergenceStatusSummary: loadSchema("convergence-status-summary.v1.schema.json"),
  responseMode: loadSchema("response-mode.v1.schema.json"),
  checkpointContextRequest: loadSchema("checkpoint-context-request.v1.schema.json"),
  inspectContextRequest: loadSchema("inspect-context-request.v1.schema.json"),
  loadContextRequest: loadSchema("load-context-request.v1.schema.json"),
  suppressContextRestoreRequest: loadSchema("suppress-context-restore-request.v1.schema.json"),
  purgeDirectContextRequest: loadSchema("purge-direct-context-request.v1.schema.json"),
  updateSessionStatusRequest: loadSchema("update-session-status-request.v1.schema.json"),
  listSessionStatusRequest: loadSchema("list-session-status-request.v1.schema.json"),
  sendSessionMessageRequest: loadSchema("send-session-message-request.v1.schema.json"),
  acknowledgeSessionMessagesRequest: loadSchema("acknowledge-session-messages-request.v1.schema.json"),
  getSessionMessageStatusRequest: loadSchema("get-session-message-status-request.v1.schema.json"),
  prepareStateCleanupRequest: loadSchema("prepare-state-cleanup-request.v1.schema.json"),
  executeStateCleanupRequest: loadSchema("execute-state-cleanup-request.v1.schema.json"),
  stateCleanupPlan: loadSchema("state-cleanup-plan.v1.schema.json"),
  stateCleanupReceipt: loadSchema("state-cleanup-receipt.v1.schema.json"),
  koreanProseGlossaryLookupRequest: loadSchema("korean-prose-glossary-lookup-request.v1.schema.json"),
  koreanProseGlossaryLookupResult: loadSchema("korean-prose-glossary-lookup-result.v1.schema.json"),
  modelCatalogV1: loadSchema("model-catalog.v1.schema.json"),
  modelRoutingPolicyV1: loadSchema("model-routing-policy.v1.schema.json"),
  hostModelCapabilitiesV1: loadSchema("host-model-capabilities.v1.schema.json"),
  modelSelectionRequestV2: loadSchema("model-selection-request.v2.schema.json"),
  modelRoutingDecisionV2: loadSchema("model-routing-decision.v2.schema.json"),
  modelApplicationRequestV2: loadSchema("model-application-request.v2.schema.json"),
  modelApplicationRecordV2: loadSchema("model-application-record.v2.schema.json"),
  modelEvaluationRecordV1: loadSchema("model-evaluation-record.v1.schema.json"),
  semanticDecisionQuestionV1: loadSchema("semantic-decision-question.v1.schema.json"),
  semanticDecisionRequestV1: loadSchema("semantic-decision-request.v1.schema.json"),
  semanticDecisionAdviceV1: loadSchema("semantic-decision-advice.v1.schema.json"),
  semanticDecisionPolicyV1: loadSchema("semantic-decision-policy.v1.schema.json"),
  semanticModelAssignmentRequestV1: loadSchema("semantic-model-assignment-request.v1.schema.json"),
  modelRoutingDecisionV3: loadSchema("model-routing-decision.v3.schema.json"),
  modelApplicationRequestV3: loadSchema("model-application-request.v3.schema.json"),
  modelApplicationRecordV3: loadSchema("model-application-record.v3.schema.json"),
};

// Providers declare artifact digests either bare or sha256:-prefixed. A SHA-256 digest that misses the
// declared pattern only by that prefix is validated in the declared form; the caller's value is stored.
function artifactDigestView(declared: JsonSchema): (artifact: unknown) => unknown {
  let items = (declared.properties as { artifacts?: { items?: JsonSchema } } | undefined)?.artifacts?.items;
  if (typeof items?.$ref === "string" && items.$ref.startsWith("#/")) {
    items = items.$ref.slice(2).split("/").reduce<JsonSchema | undefined>((node, key) => node?.[key] as JsonSchema | undefined, declared);
  }
  const properties = items?.properties as Record<string, { pattern?: unknown }> | undefined;
  return (artifact) => {
    if (!properties || !artifact || typeof artifact !== "object" || Array.isArray(artifact)) return artifact;
    const view: Record<string, unknown> = { ...artifact };
    for (const key of ["digest", "targetDigest"]) {
      const current = view[key];
      const pattern = properties[key]?.pattern;
      if (typeof current !== "string" || typeof pattern !== "string" || !/^(?:sha256:)?[a-f0-9]{64}$/u.test(current)) continue;
      const declaredForm = new RegExp(pattern, "u");
      const alternate = current.startsWith("sha256:") ? current.slice(7) : `sha256:${current}`;
      if (!declaredForm.test(current) && declaredForm.test(alternate)) view[key] = alternate;
    }
    return view;
  };
}

function errorText(errors: ErrorObject[] | null | undefined): string {
  return (errors ?? [])
    .map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`)
    .join("; ");
}

export class ContractValidator {
  private readonly validators: Record<string, ValidateFunction>;

  constructor() {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(ajv);
    for (const schema of Object.values(contractSchemas)) {
      ajv.addSchema(schema);
    }
    // Every contract schema's $id is https://skill-suite.local/contracts/<file name>.
    this.validators = Object.fromEntries(
      Object.entries(contractSchemas).map(([name, schema]) => [name, ajv.getSchema(schema.$id as string)!]),
    );
  }

  private assert<T>(name: keyof ContractValidator["validators"], value: unknown): T {
    const validate = this.validators[name];
    if (!validate) {
      throw new WorkflowContractError("INVALID_INPUT", `Validator '${name}' is not registered.`);
    }
    if (!validate(value)) {
      throw new WorkflowContractError("INVALID_INPUT", `${name} does not match its v1 contract.`, {
        validationErrors: errorText(validate.errors),
      });
    }
    return value as T;
  }

  planWorkflowRequest(value: unknown): PlanWorkflowRequestV1 {
    return this.assert<PlanWorkflowRequestV1>("planWorkflowRequest", value);
  }

  inputSourceReceipt(value: unknown): InputSourceReceiptV1 {
    return this.assert<InputSourceReceiptV1>("inputSourceReceipt", value);
  }

  validateCollaborationDecisionRequest(value: unknown): ValidateCollaborationDecisionRequestV1 {
    return this.assert<ValidateCollaborationDecisionRequestV1>("validateCollaborationDecisionRequest", value);
  }

  skillDescriptorV2(value: unknown): SkillDescriptorV2 {
    return this.assert<SkillDescriptorV2>("skillDescriptorV2", value);
  }

  stageResult(value: unknown): StageResultV1 {
    return this.assert<StageResultV1>("stageResult", value);
  }

  workflowPlan(value: unknown): WorkflowPlanV1 {
    return this.assert<WorkflowPlanV1>("workflowPlan", value);
  }

  workflowReceipt(value: unknown): WorkflowReceiptV1 {
    return this.assert<WorkflowReceiptV1>("workflowReceipt", value);
  }

  workflowStatusSummary(value: unknown): WorkflowStatusSummaryV1 {
    return this.assert<WorkflowStatusSummaryV1>("workflowStatusSummary", value);
  }

  convergenceFrame(value: unknown): ConvergenceFrameV1 {
    return this.assert<ConvergenceFrameV1>("convergenceFrame", value);
  }

  convergenceRoot(value: unknown): ConvergenceRootV1 {
    return this.assert<ConvergenceRootV1>("convergenceRoot", value);
  }

  convergenceRootHandle(value: unknown): ConvergenceRootHandleV1 {
    return this.assert<ConvergenceRootHandleV1>("convergenceRootHandle", value);
  }

  openConvergenceRootRequest(value: unknown): OpenConvergenceRootRequestV1 {
    return this.assert<OpenConvergenceRootRequestV1>("openConvergenceRootRequest", value);
  }

  attemptProposal(value: unknown): AttemptProposalV1 {
    return this.assert<AttemptProposalV1>("attemptProposal", value);
  }

  attemptLease(value: unknown): AttemptLeaseV1 {
    return this.assert<AttemptLeaseV1>("attemptLease", value);
  }

  guardedWorkflowStartRequest(value: unknown): GuardedWorkflowStartRequestV1 {
    return this.assert<GuardedWorkflowStartRequestV1>("guardedWorkflowStartRequest", value);
  }

  attemptOutcome(value: unknown): AttemptOutcomeV1 {
    return this.assert<AttemptOutcomeV1>("attemptOutcome", value);
  }

  resolveConvergenceGateRequest(value: unknown): ResolveConvergenceGateRequestV1 {
    return this.assert<ResolveConvergenceGateRequestV1>("resolveConvergenceGateRequest", value);
  }

  convergenceStatus(value: unknown): ConvergenceStatusV1 {
    return this.assert<ConvergenceStatusV1>("convergenceStatus", value);
  }

  convergenceStatusSummary(value: unknown): ConvergenceStatusSummaryV1 {
    return this.assert<ConvergenceStatusSummaryV1>("convergenceStatusSummary", value);
  }

  checkpointContextRequest(value: unknown): CheckpointContextRequestV1 {
    return this.assert<CheckpointContextRequestV1>("checkpointContextRequest", value);
  }

  inspectContextRequest(value: unknown): InspectContextRequestV1 {
    return this.assert<InspectContextRequestV1>("inspectContextRequest", value);
  }

  loadContextRequest(value: unknown): LoadContextRequestV1 {
    return this.assert<LoadContextRequestV1>("loadContextRequest", value);
  }

  suppressContextRestoreRequest(value: unknown): SuppressContextRestoreRequestV1 {
    return this.assert<SuppressContextRestoreRequestV1>("suppressContextRestoreRequest", value);
  }

  purgeDirectContextRequest(value: unknown): PurgeDirectContextRequestV1 {
    return this.assert<PurgeDirectContextRequestV1>("purgeDirectContextRequest", value);
  }

  updateSessionStatusRequest(value: unknown): UpdateSessionStatusRequestV1 {
    return this.assert<UpdateSessionStatusRequestV1>("updateSessionStatusRequest", value);
  }

  listSessionStatusRequest(value: unknown): ListSessionStatusRequestV1 {
    return this.assert<ListSessionStatusRequestV1>("listSessionStatusRequest", value);
  }

  sendSessionMessageRequest(value: unknown): SendSessionMessageRequestV1 {
    return this.assert<SendSessionMessageRequestV1>("sendSessionMessageRequest", value);
  }

  acknowledgeSessionMessagesRequest(value: unknown): AcknowledgeSessionMessagesRequestV1 {
    return this.assert<AcknowledgeSessionMessagesRequestV1>("acknowledgeSessionMessagesRequest", value);
  }

  getSessionMessageStatusRequest(value: unknown): GetSessionMessageStatusRequestV1 {
    return this.assert<GetSessionMessageStatusRequestV1>("getSessionMessageStatusRequest", value);
  }

  prepareStateCleanupRequest(value: unknown): PrepareStateCleanupRequestV1 {
    return this.assert<PrepareStateCleanupRequestV1>("prepareStateCleanupRequest", value);
  }

  executeStateCleanupRequest(value: unknown): ExecuteStateCleanupRequestV1 {
    return this.assert<ExecuteStateCleanupRequestV1>("executeStateCleanupRequest", value);
  }

  stateCleanupPlan(value: unknown): StateCleanupPlanV1 {
    return this.assert<StateCleanupPlanV1>("stateCleanupPlan", value);
  }

  stateCleanupReceipt(value: unknown): StateCleanupReceiptV1 {
    return this.assert<StateCleanupReceiptV1>("stateCleanupReceipt", value);
  }

  koreanProseGlossaryLookupRequest(value: unknown): KoreanProseGlossaryLookupRequestV1 {
    return this.assert<KoreanProseGlossaryLookupRequestV1>("koreanProseGlossaryLookupRequest", value);
  }

  koreanProseGlossaryLookupResult(value: unknown): KoreanProseGlossaryLookupResultV1 {
    return this.assert<KoreanProseGlossaryLookupResultV1>("koreanProseGlossaryLookupResult", value);
  }

  pluginUpdateStatus(value: unknown): PluginUpdateStatusV1 {
    return this.assert<PluginUpdateStatusV1>("pluginUpdateStatus", value);
  }

  pluginUpdateNotice(value: unknown): PluginUpdateNoticeV1 {
    return this.assert<PluginUpdateNoticeV1>("pluginUpdateNotice", value);
  }

  modelCatalogV1(value: unknown): ModelCatalogV1 {
    return this.assert<ModelCatalogV1>("modelCatalogV1", value);
  }

  modelRoutingPolicyV1(value: unknown): ModelRoutingPolicyV1 {
    return this.assert<ModelRoutingPolicyV1>("modelRoutingPolicyV1", value);
  }

  hostModelCapabilitiesV1(value: unknown): HostModelCapabilitiesV1 {
    return this.assert<HostModelCapabilitiesV1>("hostModelCapabilitiesV1", value);
  }

  modelSelectionRequestV2(value: unknown): ModelSelectionRequestV2 {
    return this.assert<ModelSelectionRequestV2>("modelSelectionRequestV2", value);
  }

  modelRoutingDecisionV2(value: unknown): ModelRoutingDecisionV2 {
    return this.assert<ModelRoutingDecisionV2>("modelRoutingDecisionV2", value);
  }

  modelApplicationRequestV2(value: unknown): ModelApplicationRequestV2 {
    return this.assert<ModelApplicationRequestV2>("modelApplicationRequestV2", value);
  }

  modelApplicationRecordV2(value: unknown): ModelApplicationRecordV2 {
    return this.assert<ModelApplicationRecordV2>("modelApplicationRecordV2", value);
  }

  modelEvaluationRecordV1(value: unknown): ModelEvaluationRecordV1 {
    return this.assert<ModelEvaluationRecordV1>("modelEvaluationRecordV1", value);
  }

  /** New-contract validation only: legacy Ajv acceptance and v2 runtime methods are unchanged. */
  private assertSemantic<T>(name: keyof ContractValidator["validators"], value: unknown): T {
    assertSemanticJson(value);
    return this.assert<T>(name, value);
  }

  semanticDecisionQuestionV1(value: unknown): SemanticDecisionQuestionV1 {
    const result = this.assertSemantic<SemanticDecisionQuestionV1>("semanticDecisionQuestionV1", value);
    return result;
  }

  semanticDecisionRequestV1(value: unknown): SemanticDecisionRequestV1 {
    const result = this.assertSemantic<SemanticDecisionRequestV1>("semanticDecisionRequestV1", value);
    assertSemanticRequestIntegrity(result);
    return result;
  }

  semanticDecisionAdviceV1(value: unknown): SemanticDecisionAdviceV1 {
    const result = this.assertSemantic<SemanticDecisionAdviceV1>("semanticDecisionAdviceV1", value);
    assertSemanticAdviceIntegrity(result);
    return result;
  }

  semanticDecisionPolicyV1(value: unknown): SemanticDecisionPolicyV1 {
    const result = this.assertSemantic<SemanticDecisionPolicyV1>("semanticDecisionPolicyV1", value);
    assertSemanticPolicyConsistency(result);
    return result;
  }

  semanticModelAssignmentRequestV1(value: unknown): SemanticModelAssignmentRequestV1 {
    const result = this.assertSemantic<SemanticModelAssignmentRequestV1>("semanticModelAssignmentRequestV1", value);
    assertSemanticAssignmentBinding(result);
    return result;
  }

  modelRoutingDecisionV3(value: unknown): ModelRoutingDecisionV3 {
    const result = this.assertSemantic<ModelRoutingDecisionV3>("modelRoutingDecisionV3", value);
    assertSemanticDecisionIntegrity(result);
    return result;
  }

  modelApplicationRequestV3(value: unknown): ModelApplicationRequestV3 {
    const result = this.assertSemantic<ModelApplicationRequestV3>("modelApplicationRequestV3", value);
    return result;
  }

  modelApplicationRecordV3(value: unknown): ModelApplicationRecordV3 {
    const result = this.assertSemantic<ModelApplicationRecordV3>("modelApplicationRecordV3", value);
    assertSemanticRecordIntegrity(result);
    return result;
  }

  /** Cross-artifact integrity is necessary, not proof of AGS admission or execution permission. */
  semanticDecisionAdviceForRequestV1(value: unknown, requestValue: unknown): SemanticDecisionAdviceV1 {
    const request = this.semanticDecisionRequestV1(requestValue);
    const advice = this.semanticDecisionAdviceV1(value);
    assertSemanticAdviceBinding(advice, request);
    return advice;
  }

  modelRoutingDecisionForAdviceV3(value: unknown, adviceValue: unknown, requestValue: unknown): ModelRoutingDecisionV3 {
    const request = this.semanticDecisionRequestV1(requestValue);
    const advice = this.semanticDecisionAdviceForRequestV1(adviceValue, request);
    const decision = this.modelRoutingDecisionV3(value);
    assertSemanticDecisionBinding(decision, advice, request);
    return decision;
  }

  modelApplicationRequestForDecisionV3(value: unknown, decisionValue: unknown): ModelApplicationRequestV3 {
    const decision = this.modelRoutingDecisionV3(decisionValue);
    const application = this.modelApplicationRequestV3(value);
    assertSemanticApplicationBinding(application, decision);
    return application;
  }

  modelApplicationRecordForDecisionV3(value: unknown, decisionValue: unknown): ModelApplicationRecordV3 {
    const decision = this.modelRoutingDecisionV3(decisionValue);
    const record = this.modelApplicationRecordV3(value);
    assertSemanticRecordBinding(record, decision);
    return record;
  }

  providerResult(
    rootDirectory: string,
    resultSchema: SchemaReferenceV1,
    outputSchema: SchemaReferenceV1,
    value: unknown,
  ): ProviderResultV1 {
    // StageResult.output always carries the shared envelope's schemaVersion. Some skills describe
    // their result without it and forbid unknown keys, so it is left out when their schema omits it.
    const declared = this.readBoundSchema(rootDirectory, resultSchema, "provider result");
    const declaresVersion = Boolean(declared.properties && Object.prototype.hasOwnProperty.call(declared.properties, "schemaVersion"));
    let providerView = value;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const record: Record<string, unknown> = declaresVersion
        ? { ...value }
        : Object.fromEntries(Object.entries(value).filter(([key]) => key !== "schemaVersion"));
      if (Array.isArray(record.artifacts)) record.artifacts = record.artifacts.map(artifactDigestView(declared));
      providerView = record;
    }
    this.assertSchemaFile<ProviderResultV1>(rootDirectory, resultSchema, providerView, "provider result");
    const result = value as ProviderResultV1;
    if (result.output !== null) {
      this.assertSchemaFile(rootDirectory, outputSchema, result.output, "provider output");
    }
    return result;
  }

  declaredSchema(
    rootDirectory: string,
    reference: SchemaReferenceV1,
    value: unknown,
    label: string,
  ): Record<string, unknown> {
    return this.assertSchemaFile<Record<string, unknown>>(rootDirectory, reference, value, label);
  }

  referenceOnlyFixedTokens(
    rootDirectory: string,
    reference: SchemaReferenceV1,
  ): Set<string> {
    const schema = this.readBoundSchema(rootDirectory, reference, "reference-only output");
    const tokens = new Set<string>();
    const visit = (value: unknown): void => {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) {
        value.forEach(visit);
        return;
      }
      const record = value as Record<string, unknown>;
      if ((record.type === "object" || record.properties) && record.additionalProperties !== false) {
        throw new WorkflowContractError(
          "INVALID_INPUT",
          "A reference-only provider output schema must close every declared object.",
          { schemaPath: reference.path },
        );
      }
      if (typeof record.const === "string") tokens.add(record.const);
      if (Array.isArray(record.enum)) {
        for (const item of record.enum) if (typeof item === "string") tokens.add(item);
      }
      Object.values(record).forEach(visit);
    };
    visit(schema);
    return tokens;
  }

  private assertSchemaFile<T>(
    rootDirectory: string,
    reference: SchemaReferenceV1,
    value: unknown,
    label: string,
  ): T {
    const root = path.resolve(rootDirectory);
    const targetSchema = this.readBoundSchema(rootDirectory, reference, label);

    const ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(ajv);
    const schemas = new Map<string, JsonSchema>();
    for (const directory of [path.join(root, "contracts"), this.skillSchemaRoot(root, reference.path)]) {
      for (const candidate of this.schemaFiles(directory)) {
        const schema = JSON.parse(readFileSync(candidate, "utf8")) as JsonSchema;
        const id = typeof schema.$id === "string" ? schema.$id : `file://${candidate.split(path.sep).join("/")}`;
        if (!schemas.has(id)) schemas.set(id, schema);
      }
    }
    for (const schema of schemas.values()) ajv.addSchema(schema);
    const targetId = typeof targetSchema.$id === "string" ? targetSchema.$id : undefined;
    const validate = (targetId ? ajv.getSchema(targetId) : undefined) ?? ajv.compile(targetSchema);
    if (!validate(value)) {
      throw new WorkflowContractError("INVALID_INPUT", `${label} does not match its declared schema.`, {
        schemaPath: reference.path,
        validationErrors: errorText(validate.errors),
      });
    }
    return value as T;
  }

  private readBoundSchema(
    rootDirectory: string,
    reference: SchemaReferenceV1,
    label: string,
  ): JsonSchema {
    const root = path.resolve(rootDirectory);
    const schemaPath = path.resolve(root, reference.path);
    if (schemaPath !== root && !schemaPath.startsWith(`${root}${path.sep}`)) {
      throw new WorkflowContractError("INVALID_INPUT", `${label} schema escapes the plugin root.`, {
        schemaPath: reference.path,
      });
    }
    const raw = readFileSync(schemaPath);
    const digest = `sha256:${createHash("sha256").update(raw).digest("hex")}`;
    if (digest !== reference.digest) {
      throw new WorkflowContractError("STALE_REVISION", `${label} schema changed after planning.`, {
        schemaPath: reference.path,
        expectedDigest: reference.digest,
        actualDigest: digest,
      });
    }
    return JSON.parse(raw.toString("utf8")) as JsonSchema;
  }

  private skillSchemaRoot(rootDirectory: string, schemaPath: string): string {
    const segments = schemaPath.split("/");
    return segments[0] === "skills" && segments[1]
      ? path.join(rootDirectory, "skills", segments[1])
      : path.join(rootDirectory, "contracts");
  }

  private schemaFiles(directory: string): string[] {
    const files: string[] = [];
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) files.push(...this.schemaFiles(candidate));
      else if (entry.isFile() && entry.name.endsWith(".schema.json")) files.push(candidate);
    }
    return files;
  }
}
