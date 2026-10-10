export type ClassificationStatus = "SUCCESS" | "PARTIAL" | "UNAVAILABLE" | "INVALID" | "UNCERTAIN";
export type Judgment = "needed" | "not-needed" | "uncertain";
export type DispatchState = "not-started" | "started" | "unknown";
export interface SkillMetadata {
  skillId: string;
  version: string;
  description: string;
  enabled: boolean;
  installed: boolean;
  hostSupported: boolean;
  capabilities: string[];
  actions: string[];
  targets: string[];
  constraints: string[];
  applicability: string[];
  exclusions: string[];
  dependencies: string[];
  phases: {capability: string; phase: string; phaseOrder: number; requiredInputArtifacts: string[]; producedArtifacts: string[]; gate?: Record<string, unknown>; inputBindings?: {targetArtifact: string; sources: string[]; operation: string}[]}[];
  sourceRefs: {path: string; digest: string}[];
  sourceMap?: {field: string; path: string; startLine?: number; endLine?: number; digest: string}[];
}
export interface SkillInventory {
  skills: SkillMetadata[];
  inventoryDigest: string;
  taxonomyRevision: string;
  issues: {skillId: string | null; code: string; field: string}[];
}
export interface ConfirmedContext {
  taskRevision: string | null;
  objective: string | null;
  actions: string[] | null;
  targets: string[] | null;
  constraints: string[] | null;
  prohibitedActions: string[] | null;
  background: string | null;
}
export interface SkillClassificationRequestV1 {
  schemaVersion: "1.0.0";
  requestId: string;
  operationId: string;
  originalPrompt: string;
  promptDigest: string;
  confirmedContext: ConfirmedContext;
  contextSources: {field: string; reference: string}[];
  skills: SkillMetadata[];
  inventoryDigest: string;
  taxonomyRevision: string;
  classificationCriteriaRef: string;
  requestDigest: string;
}
export interface ClassificationError {
  code: string;
  retryable: boolean;
  dispatchState: DispatchState;
}
export interface SkillClassificationResponseV1 {
  schemaVersion: "1.0.0";
  requestId: string;
  operationId: string;
  requestDigest: string;
  inventoryDigest: string;
  status: ClassificationStatus;
  judgments: {skillId: string; judgment: Judgment; reasonRefs: string[]; uncertaintyReason: string | null}[];
  unresolvedItems: {skillId: string | null; reasonCode: string}[];
  error: ClassificationError | null;
}
export interface ProviderProfile {
  profileId: string;
  providerKind: "jev" | "vendor";
  vendorId: string;
  modelId: string;
  modelRevision: string;
  reasoningEffort: string | null;
  supportedOptions: {reasoningEfforts: (string | null)[]; structuredOutput: boolean};
  approvedRouteRef: string;
  qualificationRevision: string;
  qualification: {status: "PASS" | "FAIL" | "NOT_RUN"; inventoryDigest: string; taxonomyRevision: string; modelRevision: string; promptRevision: string; validUntil: string; profileConfigurationDigest: string};
  adapterRevision: string;
  promptRevision: string;
  maximumInputBytes: number;
  maximumOutputTokens: number;
  maximumCostUsd: number | null;
  judgmentPolicy: {neededAt: number; notNeededAt: number} | null;
}
export interface ProviderProfileRegistry {
  schemaVersion: "1.0.0";
  profileRevision: string;
  profiles: ProviderProfile[];
}
/** Wire configuration is shared; evaluation preparation never creates production qualification. */
export type ProviderConfiguration = Omit<ProviderProfile, "qualification">;
export interface ProviderEvaluationConfigurationV1 {
  schemaVersion: "1.0.0";
  configuration: ProviderConfiguration;
  configurationDigest: string;
  evaluationState: {status: "NOT_RUN"; inventoryDigest: string; taxonomyRevision: string; modelRevision: string; promptRevision: string};
  preparedAt: string;
  productionRegistryUsable: false;
}
export interface ClassificationConfig {
  jevEnabled: boolean;
  mode: "shadow" | "select";
  providerProfileRegistryRef: string;
  externalClassificationAllowed: boolean;
  configRevision: string;
  timeoutMs: number;
}
export interface ProviderAvailability {
  available: boolean;
  approved: boolean;
  routeKind: "native" | "remote";
  reasonCode: string | null;
}
export interface ClassificationUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  actualCostUsd: number | null;
}
export interface ClassificationRateLimitObservation {
  httpStatus: 429 | 529;
  retryAfter: {kind: "delay-seconds"; seconds: number} | {kind: "http-date"; at: string} | null;
}
export interface ClassificationScoreDiagnostics {scoreKind: string; scores: {skillId: string; value: number}[]}
export interface ProviderEvaluation {
  response: SkillClassificationResponseV1;
  usage: ClassificationUsage;
  dispatchState: DispatchState;
  diagnostics: ClassificationScoreDiagnostics | null;
  rateLimitObservation?: ClassificationRateLimitObservation | null;
}
export interface SkillClassificationProviderPort {
  availability(profile: ProviderProfile): Promise<ProviderAvailability>;
  /** Synchronous trusted state fence, consumed immediately before the actual side effect. */
  classify(request: SkillClassificationRequestV1, profile: ProviderProfile, signal: AbortSignal, beforeDispatch?: () => void): Promise<ProviderEvaluation>;
}
export interface ClassificationAttempt {
  providerKind: "jev" | "vendor";
  profileId: string;
  modelId: string;
  reasoningEffort: string | null;
  dispatchState: DispatchState;
  status: ClassificationStatus;
  errorCode: string | null;
  timedOut: boolean;
  usage: ClassificationUsage;
  reservedCostUsd: number;
  diagnostics?: ClassificationScoreDiagnostics | null;
  rateLimitObservation?: ClassificationRateLimitObservation | null;
}
export interface ClassificationSnapshot {
  taskRevision: string | null;
  configRevision: string;
  profileRevision: string;
  inventoryDigest: string;
  requestDigest: string;
  cancelled: boolean;
}
export interface ClassificationResult {
  request: SkillClassificationRequestV1;
  response: SkillClassificationResponseV1;
  config: ClassificationConfig;
  profileRevision: string;
  attempts: ClassificationAttempt[];
  snapshot: ClassificationSnapshot;
}
export interface HostSelectionReceipt {
  receiptId: string;
  host: string;
  requestDigest: string;
  inventoryDigest: string;
  agentSelectedSkillIds: string[];
  acceptedAt: string;
}
export interface SkillSelectionDecisionV1 {
  schemaVersion: "1.0.0";
  classificationResponseRef: string;
  requestDigest: string;
  inventoryDigest: string;
  taskRevision: string | null;
  configRevision: string;
  profileRevision: string;
  explicitSkillIds: string[];
  ruleRequiredSkillIds: string[];
  agentSelectedSkillIds: string[] | null;
  selectionReasons: {skillId: string; reason: string}[];
  applicabilityChecks: {skillId: string; applies: boolean | null; excluded: boolean | null; reasonRefs: string[]}[];
  unresolvedSkillReferences: {reference: string; reason: string}[];
  selectionStatus: "PROPOSED" | "SELECTED" | "PARTIAL" | "NEEDS_INPUT";
  adviceApplied: boolean;
  hostReceipt: HostSelectionReceipt | null;
}
