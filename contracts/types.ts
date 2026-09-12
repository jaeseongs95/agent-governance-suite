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
  integrityToken: string;
  executionMode: ExecutionMode;
  state: WorkflowState;
  selectedSkills: string[];
  stages: PlannedStageV1[];
  currentStageId: string | null;
  nextStageId: string | null;
  errors: ContractErrorBody[];
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
