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

export type Sha256Digest = `sha256:${string}`;

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
  satisfiedCapabilities: string[];
  skillId: string;
  phase: string;
  selectionReason: string;
  state: WorkflowState;
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
  taskDigest: Sha256Digest;
  integrityToken: string;
  executionMode: ExecutionMode;
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
  createdAt: string;
  updatedAt: string;
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

export interface StageResultV1 {
  schemaVersion: typeof CONTRACT_VERSION;
  runId: string;
  stageId: string;
  expectedRevision: number;
  state: "needs-input" | "needs-approval" | "needs-redesign" | "failed" | "passed" | "blocked";
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
