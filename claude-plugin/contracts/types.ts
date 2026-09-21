/** Public v1 values. Do not add ad-hoc states or error codes at call sites. */
export const CONTRACT_VERSION = "1.0.0" as const;

export const WORKFLOW_STATE = [
  "ready",
  "running",
  "needs-input",
  "needs-approval",
  "needs-redesign",
  "failed",
  "passed",
  "blocked",
] as const;
export type WorkflowState = (typeof WORKFLOW_STATE)[number];

export const ERROR_CODE = [
  "INVALID_INPUT",
  "RUN_NOT_FOUND",
  "STALE_REVISION",
  "INVALID_TRANSITION",
  "MISSING_EVIDENCE",
  "GATE_FAILED",
  "MCP_UNAVAILABLE",
  "LEASE_REQUIRED",
  "LEASE_CONFLICT",
  "FRAME_REVIEW_REQUIRED",
  "ATTEMPT_BUDGET_EXHAUSTED",
  "NEW_EVIDENCE_REQUIRED",
  "ROOT_CONFLICT",
  "CONTINUITY_UNAVAILABLE",
  "BINDING_REQUIRED",
  "BINDING_INVALID",
  "SNAPSHOT_NOT_FOUND",
  "SNAPSHOT_CONFLICT",
  "REQUEST_CONFLICT",
  "INTEGRITY_FAILED",
] as const;
export type ErrorCode = (typeof ERROR_CODE)[number];

export const RISK_LEVEL = ["low", "medium", "high", "critical"] as const;
export type RiskLevel = (typeof RISK_LEVEL)[number];

export const COMPLEXITY = ["simple", "complex"] as const;
export type Complexity = (typeof COMPLEXITY)[number];

export const EXECUTION_MODE = ["direct", "orchestrated"] as const;
export type ExecutionMode = (typeof EXECUTION_MODE)[number];

export const RISK_GATE = ["none", "conditional", "mandatory"] as const;
export type RiskGate = (typeof RISK_GATE)[number];

export const DESCRIPTOR_VERSION = "2.0.0" as const;
export const EXECUTION_CLASS = ["bootstrap", "workflow", "recovery"] as const;
export type ExecutionClass = (typeof EXECUTION_CLASS)[number];
export const BINDING_OPERATION = ["select", "collect", "combine", "require-external"] as const;
export type BindingOperation = (typeof BINDING_OPERATION)[number];
export const GATE_KIND = ["none", "precondition", "completion"] as const;
export type GateKind = (typeof GATE_KIND)[number];

export const MODEL_CLASS = ["lightweight", "general", "deep", "frontier"] as const;
export type ModelClassV1 = (typeof MODEL_CLASS)[number];

export const REASONING_EFFORT = ["low", "medium", "high", "xhigh", "max", "ultra"] as const;
export type ReasoningEffortV1 = (typeof REASONING_EFFORT)[number];

export interface ExecutionContextV1 {
  schemaVersion: typeof CONTRACT_VERSION;
  model: string;
  modelClass: ModelClassV1;
  reasoningEffort: ReasoningEffortV1;
  source: "runtime" | "spawn-result";
  observedAt: string;
  /**
   * Trusted-host binding fields are optional for v1 receipt compatibility.
   * Strict MCP assurance requires all of them and rejects caller-supplied contexts.
   */
  observationId?: string;
  taskId?: string;
  runId?: string | null;
  stageId?: string | null;
  revision?: number | null;
  actorId?: string;
  expiresAt?: string;
}

export interface ExecutionRequirementV1 {
  policyId: "semantic-execution-assurance-v1";
  kind: "deterministic" | "semantic";
  minimumModelClass: ModelClassV1 | null;
  minimumReasoningEffort: ReasoningEffortV1 | null;
  observationRequired: boolean;
}

export const CONTROL_ARTIFACT_ROLE = [
  "validator",
  "rubric",
  "oracle",
  "aggregation",
  "pass-condition",
  "evaluation-input",
] as const;
export type ControlArtifactRole = (typeof CONTROL_ARTIFACT_ROLE)[number];

export const TARGET_ARTIFACT_ROLE = ["target", "candidate"] as const;
export type TargetArtifactRole = (typeof TARGET_ARTIFACT_ROLE)[number];
export type ConvergenceArtifactRole = ControlArtifactRole | TargetArtifactRole;

export const CONVERGENCE_ROOT_STATE = [
  "open",
  "needs-review",
  "needs-user",
  "completed",
  "abandoned",
] as const;
export type ConvergenceRootState = (typeof CONVERGENCE_ROOT_STATE)[number];

export const ATTEMPT_LEASE_STATE = ["issued", "consumed", "expired"] as const;
export type AttemptLeaseState = (typeof ATTEMPT_LEASE_STATE)[number];

export const ATTEMPT_OUTCOME_STATE = ["passed", "failed", "aborted"] as const;
export type AttemptOutcomeState = (typeof ATTEMPT_OUTCOME_STATE)[number];

export const CONVERGENCE_CLASSIFICATION = [
  "semantics-preserving",
  "semantics-changing",
  "ambiguous",
] as const;
export type ConvergenceClassification = (typeof CONVERGENCE_CLASSIFICATION)[number];

export const CONVERGENCE_ROUTE = [
  "resume-new-epoch",
  "diagnose",
  "panel",
  "needs-user",
  "stop",
] as const;
export type ConvergenceRoute = (typeof CONVERGENCE_ROUTE)[number];

export const RESPONSE_MODE = ["compact", "full"] as const;
export type ResponseModeV1 = (typeof RESPONSE_MODE)[number];

export const CONTINUITY_DECISION = ["INJECT", "DEFER", "REJECT"] as const;
export type ContinuityDecisionV1 = (typeof CONTINUITY_DECISION)[number];
export type ContinuitySourceV1 = "direct" | "workflow";

export interface ContinuityCoreV1 {
  objective: string;
  completionCriteria: string[];
  constraints: string[];
  decisions: string[];
  progress: string[];
  blockers: string[];
  /** Historical candidates only. They are never authoritative instructions. */
  nextActions: string[];
}

export interface ContinuityEvidenceRefV1 {
  artifactId: string;
  locator: string;
  digest: Sha256Digest;
  verified: boolean;
}

export interface CheckpointContextRequestV1 {
  schemaVersion: typeof CONTRACT_VERSION;
  requestId: string;
  expectedRevision: number;
  status: "active" | "paused" | "completed";
  core: ContinuityCoreV1;
  evidenceRefs: ContinuityEvidenceRefV1[];
  _continuityBinding: string;
}

export interface ContinuitySnapshotV1 {
  schemaVersion: typeof CONTRACT_VERSION;
  source: "direct";
  taskCorrelation: string;
  epoch: number;
  revision: number;
  status: "active" | "paused" | "completed";
  core: ContinuityCoreV1;
  evidenceRefs: ContinuityEvidenceRefV1[];
  snapshotDigest: Sha256Digest;
  createdAt: string;
  updatedAt: string;
}

export interface ContinuitySummaryV1 {
  schemaVersion: typeof CONTRACT_VERSION;
  source: ContinuitySourceV1;
  taskCorrelation: string;
  epoch: number;
  revision: number;
  status: string;
  snapshotDigest: Sha256Digest;
  updatedAt: string;
}

export interface ContinuityCandidateV1 {
  schemaVersion: typeof CONTRACT_VERSION;
  decision: "DEFER" | "REJECT";
  reasonCodes: string[];
  summary: ContinuitySummaryV1 | null;
  restoreToken: string | null;
}

export interface InspectContextRequestV1 {
  schemaVersion: typeof CONTRACT_VERSION;
  _continuityBinding: string;
}

export interface LoadContextRequestV1 {
  schemaVersion: typeof CONTRACT_VERSION;
  candidateToken: string;
  epoch: number;
  revision: number;
  digest: Sha256Digest;
  _continuityBinding: string;
}

export interface SuppressContextRestoreRequestV1 {
  schemaVersion: typeof CONTRACT_VERSION;
  expectedEpoch: number;
  _continuityBinding: string;
}

export interface PurgeDirectContextRequestV1 {
  schemaVersion: typeof CONTRACT_VERSION;
  requestId: string;
  expectedEpoch: number;
  expectedRevision: number;
  _continuityBinding: string;
}

/** Added by the session board hook from host hook input; callers never supply it. */
export interface SessionBindingV1 {
  host: string;
  sessionId: string;
}

export interface CollaborationSessionBindingV1 extends SessionBindingV1 {
  actorKind?: "main" | "subagent" | "unknown";
  observedBy?: string;
  assurance?: string;
}

export type CollaborationSourceOriginKindV1 = InputOriginKindV1 | "unknown" | "tool" | "delegated";

export interface CollaborationDecisionV1 {
  schemaVersion: "1.0.0" | "1.1.0" | "1.2.0";
  sourceOriginKind: CollaborationSourceOriginKindV1;
  sourceReceiptId: string | null;
  authorityEffect: "none";
  userDirective: "require" | "forbid" | "unspecified";
  netBenefitCriteria: {
    independentlyCompletable: boolean;
    parallelBottleneckReduced: boolean;
    limitedContextSufficient: boolean;
    singleWriterOwnership: boolean;
    netBenefitAfterOverhead: boolean;
  };
  fullHistoryContext?: { sufficient: boolean; reason: string };
  auditSeparationRequired: boolean;
  route: "direct" | "delegate" | "audit-only" | "needs-input";
}

export interface ValidateCollaborationDecisionRequestV1 {
  decision: CollaborationDecisionV1;
  _sessionBinding?: CollaborationSessionBindingV1;
}

export interface CollaborationDecisionValidationV1 {
  structuralValidity: "valid" | "invalid";
  structuralErrors: string[];
  receiptFound: boolean;
  receiptIntegrity: "valid" | "invalid" | null;
  receiptBoundToCaller: boolean | null;
  receiptFreshness: "fresh" | "stale" | null;
  sourceClaimMatch: boolean | null;
  callerObservation: CollaborationSessionBindingV1 | null;
  callerBindingAssurance: "observational" | null;
  authorityCapabilities: {
    directUserInputAttestation: false;
    authorityIssuance: false;
    scopedDelegation: false;
  };
}

export type InputOriginKindV1 =
  | "user-turn"
  | "peer"
  | "system"
  | "developer"
  | "project"
  | "artifact";

export interface InputSourceReceiptV1 {
  schemaVersion: typeof CONTRACT_VERSION;
  receiptId: string;
  originKind: InputOriginKindV1;
  host: string;
  sessionId: string;
  eventId: string;
  contentDigest: Sha256Digest;
  observedAt: string;
  expiresAt: string;
  authorityEffect: "none" | "restrict-only";
  attestation: {
    kind: "host-direct-user-event" | "broker-peer-envelope" | "verified-internal-wake" | "unverified-host-event";
    adapter: string;
    capabilityVersion: string;
  };
  integrityToken: string;
}

export interface UpdateSessionStatusRequestV1 {
  schemaVersion: typeof CONTRACT_VERSION;
  summary: string;
  _sessionBinding?: SessionBindingV1;
}

export interface ListSessionStatusRequestV1 {
  schemaVersion: typeof CONTRACT_VERSION;
  _sessionBinding?: SessionBindingV1;
}

export interface SendSessionMessageRequestV1 {
  schemaVersion: typeof CONTRACT_VERSION;
  targetHost: string;
  targetSessionId: string;
  body: string;
  ttlSeconds?: number;
  messageId?: string;
  _sessionBinding?: SessionBindingV1;
}

export interface AcknowledgeSessionMessagesRequestV1 {
  schemaVersion: typeof CONTRACT_VERSION;
  messageIds: string[];
  _sessionBinding?: SessionBindingV1;
}

export interface GetSessionMessageStatusRequestV1 {
  schemaVersion: typeof CONTRACT_VERSION;
  messageId: string;
  _sessionBinding?: SessionBindingV1;
}

export interface StateCleanupPolicyV1 {
  workflowRetentionDays: 180;
  continuityPayloadRetentionDays: 30;
  continuityRecordRetentionDays: 180;
}

export interface PrepareStateCleanupRequestV1 {
  schemaVersion: typeof CONTRACT_VERSION;
}

export interface StateCleanupPlanV1 {
  schemaVersion: typeof CONTRACT_VERSION;
  planId: string;
  createdAt: string;
  expiresAt: string;
  policy: StateCleanupPolicyV1;
  cutoffs: {
    workflow: string;
    continuityPayload: string;
    continuityRecord: string;
  };
  candidates: {
    workflowRoots: Array<{ rootId: string; revision: number; state: string; updatedAt: string; runIds: string[] }>;
    standaloneWorkflowRuns: Array<{ runId: string; revision: number; state: string; updatedAt: string }>;
    continuitySnapshots: Array<{ taskCorrelation: string; rootId: string | null; epoch: number; revision: number; snapshotDigest: string; updatedAt: string }>;
    continuityTasks: Array<{ taskCorrelation: string; currentEpoch: number; rootId: string | null; updatedAt: string }>;
  };
  counts: {
    workflowRoots: number;
    workflowRuns: number;
    continuitySnapshots: number;
    continuityTasks: number;
    protectedActiveRoots: number;
    protectedActiveContinuityTasks: number;
  };
  candidateDigest: Sha256Digest;
  protection: "os-managed-unverified" | "filesystem-mode-0600";
  planToken: string;
}

export interface ExecuteStateCleanupRequestV1 {
  schemaVersion: typeof CONTRACT_VERSION;
  planToken: string;
}

export interface StateCleanupReceiptV1 {
  schemaVersion: typeof CONTRACT_VERSION;
  planId: string;
  status: "completed" | "partial" | "no-op";
  executedAt: string;
  candidateDigest: Sha256Digest;
  databases: {
    workflow: { status: "completed" | "skipped" | "failed"; backupPath: string | null; deletedRoots: number; deletedRuns: number; error: string | null };
    continuity: { status: "completed" | "skipped" | "unavailable" | "failed"; backupPath: string | null; deletedSnapshots: number; deletedTasks: number; error: string | null };
  };
  backupRetention: "manual-deletion-only";
  protection: "os-managed-unverified" | "filesystem-mode-0600";
}

export type Sha256Digest = `sha256:${string}`;

export type KoreanProseGlossaryStatusV1 =
  | "matched"
  | "no-match"
  | "unavailable"
  | "limit-exceeded"
  | "unsupported-normalization";

export interface KoreanProseGlossaryLookupRequestV1 {
  schemaVersion: typeof CONTRACT_VERSION;
  sourceText: string;
  sourceDigest: string;
}

export interface KoreanProseGlossaryMatchV1 {
  start: number;
  end: number;
  entryId: string;
  policy: "protect" | "prefer" | "allow" | "avoid";
  canonicalForm: string;
  priority: number;
}

export interface KoreanProseGlossaryLookupResultV1 {
  schemaVersion: typeof CONTRACT_VERSION;
  status: KoreanProseGlossaryStatusV1;
  sourceDigest: string;
  glossary: { id: string; version: string; contentDigest: string } | null;
  matches: KoreanProseGlossaryMatchV1[];
  matchSetDigest: string | null;
  warnings: Array<"GLOSSARY_UNAVAILABLE" | "GLOSSARY_MATCH_LIMIT_EXCEEDED" | "GLOSSARY_UNSUPPORTED_NORMALIZATION">;
}

export const POLICY_CAPABILITY = {
  coordination: "subagent-coordination",
  deliberation: "independent-deliberation",
  audit: "independent-audit",
} as const;

export interface ContractErrorBody {
  code: ErrorCode;
  message: string;
  details: Record<string, unknown> | null;
}

export interface ApiResultV1<T> {
  schemaVersion: typeof CONTRACT_VERSION;
  ok: boolean;
  data: T | null;
  error: ContractErrorBody | null;
}

export const PLUGIN_UPDATE_COMPARISON = [
  "unknown",
  "up-to-date",
  "update-available",
  "ahead-of-stable",
] as const;
export type PluginUpdateComparison = (typeof PLUGIN_UPDATE_COMPARISON)[number];

export const PLUGIN_UPDATE_ERROR_CODE = [
  "TIMEOUT",
  "NETWORK",
  "HTTP",
  "INVALID_RESPONSE",
  "NO_STABLE_TAG",
] as const;
export type PluginUpdateErrorCode = (typeof PLUGIN_UPDATE_ERROR_CODE)[number];

export interface PluginUpdateStatusV1 {
  schemaVersion: typeof CONTRACT_VERSION;
  pluginId: string;
  currentVersion: string;
  latestVersion: string | null;
  latestTag: string | null;
  latestCommit: string | null;
  comparison: PluginUpdateComparison;
  lastAttemptAt: string | null;
  lastSuccessfulCheckAt: string | null;
  nextCheckAt: string;
  stale: boolean;
  lastErrorCode: PluginUpdateErrorCode | null;
  automaticInstall: false;
}

export interface PluginUpdateNoticeV1 {
  schemaVersion: typeof CONTRACT_VERSION;
  kind: "plugin-update-notice";
  pluginId: string;
  currentVersion: string;
  latestVersion: string;
  latestTag: string;
  latestCommit: string;
  checkedAt: string;
  tagUrl: string;
  automaticInstall: false;
}

export interface TaskEnvelopeV1 {
  schemaVersion: typeof CONTRACT_VERSION;
  taskId: string;
  objective: string;
  scope: {
    included: string[];
    excluded: string[];
  };
  acceptanceCriteria: string[];
  riskLevel: RiskLevel;
  workUnits: WorkUnitV1[];
  requiredCapabilities: string[];
  constraints: string[];
  authorization: {
    allowedActions: string[];
    prohibitedActions: string[];
    approvalRequired: string[];
  };
  decision: {
    complexity: Complexity;
    hasConflicts: boolean;
  };
  orchestration: {
    requested: boolean;
    mcpAvailable: boolean;
  };
}

export type EvaluationAuditPurposeV1 = "design-readiness" | "quality-or-release";

export interface AssuredPlanWorkflowRequestV1 {
  schemaVersion: typeof CONTRACT_VERSION;
  taskEnvelope: TaskEnvelopeV1;
  evaluationAuditPurpose?: EvaluationAuditPurposeV1;
}

export type PlanWorkflowRequestV1 = TaskEnvelopeV1 | AssuredPlanWorkflowRequestV1;

export interface WorkUnitV1 {
  id: string;
  objective: string;
  dependencies: string[];
  writeTargets: string[];
}

export interface SkillDescriptorV1 {
  schemaVersion: typeof CONTRACT_VERSION;
  id: string;
  version: string;
  path: string;
  phase: string;
  capabilities: string[];
  priority: number;
  selectionCriteria: string[];
  preconditions: string[];
  requiredArtifacts: string[];
  producedArtifacts: string[];
  riskGate: RiskGate;
  enabled: boolean;
}

export interface InputBindingV2 {
  targetArtifact: string;
  sources: string[];
  operation: BindingOperation;
  optional?: boolean;
}

export interface StateMappingRuleV2 {
  state: Exclude<WorkflowState, "ready" | "running">;
  errorRequired: boolean;
  allowedErrorCodes?: ErrorCode[];
}

export interface StateMappingV2 {
  selector?: string;
  values?: Record<string, StateMappingRuleV2>;
  default: "reject" | StateMappingRuleV2;
  adapterErrors: ErrorCode[];
}

export interface SchemaReferenceV1 {
  path: string;
  digest: string;
}

export interface GateDescriptorV2 {
  kind: GateKind;
  policy: RiskGate;
  validator?: string | null;
  validatorSchema?: SchemaReferenceV1 | null;
}

export interface ReceiptPolicyV1 {
  mode: "reference-only";
  actorIdPointer?: string;
  uniqueness?: "run";
  /** JSON pointer relative to ProviderResult.v1, paired with actorIdsMatch. */
  actorIdsPointer?: string;
  /** Require the ordered actor bindings from all earlier policy stages. */
  actorIdsMatch?: "prior-policy-actors";
}

export interface SkillProviderV2 {
  capabilities: string[];
  executionClass: ExecutionClass;
  phase: string;
  phaseOrder: number;
  requiredInputArtifacts: string[];
  inputBindings: InputBindingV2[];
  producedArtifacts: string[];
  outputSchema: string;
  resultSchema: string;
  stateMapping: StateMappingV2;
  selectionCriteria: string[];
  preconditions: string[];
  failureHandling: string | Record<string, unknown>;
  gate: GateDescriptorV2;
  receiptPolicy?: ReceiptPolicyV1;
}

export interface SkillDescriptorV2 {
  schemaVersion: typeof DESCRIPTOR_VERSION;
  skillId: string;
  version: string;
  path: string;
  enabled: boolean;
  priority: number;
  providers: SkillProviderV2[];
}

export interface RoutedSkillProviderV2 extends SkillProviderV2 {
  skillId: string;
  version: string;
  path: string;
  enabled: boolean;
  priority: number;
  providerKey: string;
  outputSchemaDigest: string;
  resultSchemaDigest: string;
}

export interface PlannedStageV1 {
  stageId: string;
  order: number;
  requiredCapability: string;
  evaluationAuditPurpose?: EvaluationAuditPurposeV1;
  satisfiedCapabilities: string[];
  skillId: string;
  phase: string;
  selectionReason: string;
  state: WorkflowState;
  executionRequirement?: ExecutionRequirementV1;
  requiredArtifacts: string[];
  riskGate: RiskGate;
  providerKey: string;
  executionClass: Exclude<ExecutionClass, "bootstrap">;
  phaseOrder: number;
  requiredInputArtifacts: string[];
  inputBindings: InputBindingV2[];
  producedArtifacts: string[];
  outputSchema: SchemaReferenceV1;
  resultSchema: SchemaReferenceV1;
  stateMapping: StateMappingV2;
  gate: GateDescriptorV2;
  receiptPolicy?: ReceiptPolicyV1;
}

export interface WorkflowPlanV1 {
  schemaVersion: typeof CONTRACT_VERSION;
  taskId: string;
  taskDigest?: Sha256Digest;
  integrityToken: string;
  executionMode: ExecutionMode;
  bootstrapExecution?: {
    requirement: ExecutionRequirementV1;
    context: ExecutionContextV1;
  } | null;
  state: WorkflowState;
  selectedSkills: string[];
  stages: PlannedStageV1[];
  currentStageId: string | null;
  nextStageId: string | null;
  errors: ContractErrorBody[];
}

export interface ConvergenceWorkspaceV1 {
  workspaceId: string;
  locator: string;
}

export interface ConvergenceArtifactV1<
  Role extends ConvergenceArtifactRole = ConvergenceArtifactRole,
> {
  artifactId: string;
  role: Role;
  locator: string;
  digest: Sha256Digest;
}

export interface ConvergenceOperationalSettingsV1 {
  maxAttemptsPerEpoch: 3;
  maxEpochs: 2;
  leaseTtlSeconds: number;
}

export interface ConvergenceFrameV1 {
  schemaVersion: typeof CONTRACT_VERSION;
  workspace: ConvergenceWorkspaceV1;
  controlArtifacts: ConvergenceArtifactV1<ControlArtifactRole>[];
  targetArtifacts: ConvergenceArtifactV1<TargetArtifactRole>[];
  operationalSettings: ConvergenceOperationalSettingsV1;
}

export interface ConvergenceRootV1 {
  schemaVersion: typeof CONTRACT_VERSION;
  rootId: string;
  parentRootId: string | null;
  revision: number;
  state: ConvergenceRootState;
  currentEpoch: number;
  taskEnvelope: TaskEnvelopeV1;
  frame: ConvergenceFrameV1;
  taskDigest: Sha256Digest;
  frameDigest: Sha256Digest;
  workspaceDigest: Sha256Digest;
  controlDigest: Sha256Digest;
  targetDigest: Sha256Digest;
  operationalDigest: Sha256Digest;
  userApprovalRefs: string[];
  retryRejections?: RetryRejectionV1[];
  createdAt: string;
  updatedAt: string;
}

/** One rejected retry claim, kept so its evidence cannot be recycled as new. */
export interface RetryRejectionV1 {
  epoch: number;
  reason: "stale-fingerprint" | "stale-evidence";
  actorId?: string;
  expectedFingerprint?: string | null;
  targetDigest?: Sha256Digest;
  evidenceRefs: string[];
  rejectedAt: string;
}

export interface OpenConvergenceRootRequestV1 {
  schemaVersion: typeof CONTRACT_VERSION;
  parentRootId: string | null;
  taskEnvelope: TaskEnvelopeV1;
  frame: ConvergenceFrameV1;
  userApprovalRefs: string[];
}

export interface PriorFailureV1 {
  fingerprint: string;
  hypothesis: string;
  changeSummary: string;
  discriminator: string;
  evidenceRefs: string[];
}

export interface AttemptProposalV1 {
  schemaVersion: typeof CONTRACT_VERSION;
  rootId: string;
  expectedRevision: number;
  taskEnvelope: TaskEnvelopeV1;
  frame: ConvergenceFrameV1;
  plan: WorkflowPlanV1;
  actorId: string;
  outputTargets: string[];
  priorFailure: PriorFailureV1 | null;
}

export interface AttemptLeaseV1 {
  schemaVersion: typeof CONTRACT_VERSION;
  leaseId: string;
  rootId: string;
  rootRevision: number;
  epoch: number;
  ordinal: number;
  proposalDigest: Sha256Digest;
  taskDigest: Sha256Digest;
  frameDigest: Sha256Digest;
  workspaceDigest: Sha256Digest;
  controlDigest: Sha256Digest;
  targetDigest: Sha256Digest;
  operationalDigest: Sha256Digest;
  outputTargetsDigest: Sha256Digest;
  planIntegrityToken: string;
  actorId: string;
  outputTargets: string[];
  issuedAt: string;
  expiresAt: string;
  state: AttemptLeaseState;
}

export interface GuardedWorkflowStartRequestV1 {
  schemaVersion: typeof CONTRACT_VERSION;
  leaseId: string;
  expectedRootRevision: number;
  plan: WorkflowPlanV1;
}

export interface AttemptOutcomeV1 {
  schemaVersion: typeof CONTRACT_VERSION;
  outcomeId: string;
  rootId: string;
  rootRevision: number;
  leaseId: string;
  epoch: number;
  ordinal: number;
  workflowRunId: string;
  state: AttemptOutcomeState;
  receiptDigest: Sha256Digest | null;
  failureFingerprint: string | null;
  evidenceRefs: string[];
  recordedAt: string;
}

export interface ConvergenceFreshContextV1 {
  confirmed: boolean;
  evidenceRef: string;
}

export interface ConvergenceComparabilityV1 {
  comparable: boolean;
  rationale: string;
}

export interface ConvergenceReviewV1 {
  schemaVersion: typeof CONTRACT_VERSION;
  reviewId: string;
  rootId: string;
  rootRevision: number;
  epoch: number;
  reviewerActorId: string;
  implementationActorIds: string[];
  freshContext: ConvergenceFreshContextV1;
  classification: ConvergenceClassification;
  comparability: ConvergenceComparabilityV1;
  route: ConvergenceRoute;
  proposedFrame: ConvergenceFrameV1 | null;
  evidenceRefs: string[];
  userApprovalRefs: string[];
  reviewedAt: string;
}

export interface ResolveConvergenceGateRequestV1 {
  schemaVersion: typeof CONTRACT_VERSION;
  rootId: string;
  expectedRevision: number;
  review: ConvergenceReviewV1;
}

export interface ConvergenceStatusV1 {
  schemaVersion: typeof CONTRACT_VERSION;
  root: ConvergenceRootV1;
  currentEpoch: number;
  maxAttemptsPerEpoch: 3;
  maxEpochs: 2;
  attemptsUsedInEpoch: number;
  attemptsRemainingInEpoch: number;
  proposals: AttemptProposalV1[];
  leases: AttemptLeaseV1[];
  outcomes: AttemptOutcomeV1[];
  reviews: ConvergenceReviewV1[];
  workflowRunIds: string[];
  gateError: ContractErrorBody | null;
}

export interface ConvergenceRootHandleV1 {
  schemaVersion: typeof CONTRACT_VERSION;
  rootId: string;
  revision: number;
  state: ConvergenceRootState;
  currentEpoch: number;
  taskDigest: Sha256Digest;
  frameDigest: Sha256Digest;
  workspaceDigest: Sha256Digest;
  controlDigest: Sha256Digest;
  targetDigest: Sha256Digest;
  operationalDigest: Sha256Digest;
}

export interface ConvergenceStatusSummaryV1 {
  schemaVersion: typeof CONTRACT_VERSION;
  root: ConvergenceRootHandleV1;
  currentEpoch: number;
  maxAttemptsPerEpoch: 3;
  maxEpochs: 2;
  attemptsUsedInEpoch: number;
  attemptsRemainingInEpoch: number;
  issuedLeaseId: string | null;
  latestWorkflowRunId: string | null;
  latestOutcomeId: string | null;
  latestOutcomeState: AttemptOutcomeState | null;
  latestOutcomeReceiptDigest: Sha256Digest | null;
  proposalCount: number;
  leaseCount: number;
  outcomeCount: number;
  reviewCount: number;
  gateErrorCode: ErrorCode | null;
}

export interface EvidenceReferenceV1 {
  artifactId: string;
  kind: "user-input" | "file" | "test" | "document" | "tool";
  locator: string;
  verified: boolean;
  note: string;
}

export interface ProviderArtifactV1 {
  artifactId: string;
  schemaId: string;
  locator: string;
  digest: string;
  targetDigest: string;
  verified: boolean;
}

export interface ProviderResultV1 {
  schemaVersion: typeof CONTRACT_VERSION;
  kind: "output" | "adapter-error";
  output: Record<string, unknown> | null;
  artifacts: ProviderArtifactV1[];
  error: ContractErrorBody | null;
}

export interface StageOutputFileV1 {
  locator: string;
  digest: Sha256Digest;
}

export interface StageResultV1 {
  schemaVersion: typeof CONTRACT_VERSION;
  runId: string;
  stageId: string;
  expectedRevision: number;
  state: "needs-input" | "needs-approval" | "needs-redesign" | "failed" | "passed" | "blocked";
  executionContext?: ExecutionContextV1 | null;
  /** Large provider output passed by local file reference; output.output is then null. */
  outputFile?: StageOutputFileV1;
  output: ProviderResultV1;
  evidence: EvidenceReferenceV1[];
  findings: string[];
  blockers: string[];
  error: ContractErrorBody | null;
}

export interface WorkflowReceiptV1 {
  schemaVersion: typeof CONTRACT_VERSION;
  runId: string;
  revision: number;
  state: WorkflowState;
  plan: WorkflowPlanV1;
  stageResults: StageResultV1[];
  blockers: string[];
  unresolved: string[];
  error: ContractErrorBody | null;
}

export interface WorkflowStatusSummaryV1 {
  schemaVersion: typeof CONTRACT_VERSION;
  runId: string;
  revision: number;
  state: WorkflowState;
  currentStageId: string | null;
  nextStageId: string | null;
  lastRecordedStageId: string | null;
  completedStageCount: number;
  totalStageCount: number;
  blockerCount: number;
  unresolvedCount: number;
  errorCode: ErrorCode | null;
  receiptDigest: Sha256Digest;
}

export class WorkflowContractError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details: Record<string, unknown> | null = null,
  ) {
    super(message);
    this.name = "WorkflowContractError";
  }

  toBody(): ContractErrorBody {
    return { code: this.code, message: this.message, details: this.details };
  }
}

export type {
  HostModelCapabilitiesV1,
  ModelApplicationRecordV2,
  ModelApplicationRequestV2,
  ModelCatalogV1,
  ModelEvaluationRecordV1,
  ModelRoutingDecisionV2,
  ModelRoutingPolicyV1,
  ModelSelectionRequestV2,
} from "./model-routing-types.js";
