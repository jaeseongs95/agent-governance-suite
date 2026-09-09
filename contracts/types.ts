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

export interface PlannedStageV1 {
  stageId: string;
  order: number;
  requiredCapability: string;
  skillId: string;
  phase: string;
  selectionReason: string;
  state: WorkflowState;
  requiredArtifacts: string[];
  riskGate: RiskGate;
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

export interface StageResultV1 {
  schemaVersion: typeof CONTRACT_VERSION;
  runId: string;
  stageId: string;
  expectedRevision: number;
  state: "needs-input" | "needs-approval" | "needs-redesign" | "failed" | "passed" | "blocked";
  output: Record<string, unknown> | null;
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
