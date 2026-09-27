/** Declarations for the pure v2 core and its internal, non-authorizing projections. */
import type {
  HostModelCapabilitiesV1, ModelCatalogV1, ModelRoutingPolicyV1,
  ModelSelectionRequestV2, ModelRoutingDecisionV2, ModelApplicationRequestV2,
  ModelApplicationRecordV2,
} from "../../../contracts/model-routing-types.js";
export declare const ROLES: readonly string[];
export declare const ORIGINS: readonly string[];
export declare const TRAITS: readonly string[];
export declare class RoutingError extends Error {
  code: string;
  constructor(code: string, message: string);
}
export declare function assert(condition: unknown, code: string, message?: string): asserts condition;
export declare function object(value: unknown, name: string): Record<string, unknown>;
export declare function keys(value: unknown, allowed: string[], required?: string[], name?: string): void;
export declare function text(value: unknown, name: string, maximum?: number): void;
export declare function identifier(value: unknown, name: string): void;
export declare function digestValue(value: unknown, name: string): void;
export declare function instant(value: unknown, name: string): number;
export declare function canonical(value: unknown): string;
export declare function digest(value: unknown): string;
export declare function seal<T extends object, K extends string>(value: T, field: K): Omit<T, K> & Record<K, string>;
export declare function verifySeal(value: unknown, field: string): void;
export declare function validateBinding(value: unknown): ModelSelectionRequestV2["binding"];
export declare function validateTarget(value: unknown): NonNullable<ModelRoutingDecisionV2["target"]>;
export declare function validateReasoning(value: unknown): NonNullable<ModelRoutingDecisionV2["selected"]>["nativeReasoning"];
export declare function validateSelection(value: unknown): NonNullable<ModelRoutingDecisionV2["selected"]>;
export declare function validateCapabilities(value: unknown): HostModelCapabilitiesV1;
export declare function validatePolicy(value: unknown): ModelRoutingPolicyV1;
export declare function validateRequest(value: unknown): ModelSelectionRequestV2;
export declare function validateCatalog(value: unknown): ModelCatalogV1;
export type RoutingEnvironmentV2 = {
  catalog: ModelCatalogV1; policy: ModelRoutingPolicyV1;
  capabilities: HostModelCapabilitiesV1[]; now: string;
};
export declare function legacyFloor(
  binding: HostModelCapabilitiesV1["supportedBindings"][number],
  host: string,
  model: ModelCatalogV1["models"][number] | undefined,
  policy: ModelRoutingPolicyV1,
): boolean;
/** Internal data only; not a wire contract, admission receipt, or host observation. */
export type EligibleCandidateV2 = {
  key: string;
  model: ModelCatalogV1["models"][number];
  snapshot: HostModelCapabilitiesV1;
  binding: HostModelCapabilitiesV1["supportedBindings"][number];
};
export type EligibleCandidatesV2 = {
  candidates: EligibleCandidateV2[];
  rejectedCandidates: ModelRoutingDecisionV2["rejectedCandidates"];
  capabilitySetDigest: ModelRoutingDecisionV2["capabilitySetDigest"];
};
export declare function collectEligibleCandidatesV2(request: ModelSelectionRequestV2, environment: RoutingEnvironmentV2): EligibleCandidatesV2;
/** Detached baseline order only; not a wire contract or admission receipt. */
export type BaselineCandidateMetadataV2 = { candidateKey: string; preferenceGroup: number; baselineRank: number };
export declare function getBaselineCandidateMetadataV2(
  candidates: readonly EligibleCandidateV2[],
  request: ModelSelectionRequestV2,
  environment: Pick<RoutingEnvironmentV2, "catalog" | "policy">,
): BaselineCandidateMetadataV2[];
/** Reorders a detached copy; does not validate or admit caller-made candidates. */
export declare function rankBaselineCandidatesV2(
  candidates: readonly EligibleCandidateV2[],
  request: ModelSelectionRequestV2,
  environment: Pick<RoutingEnvironmentV2, "catalog" | "policy">,
): EligibleCandidateV2[];
export declare function resolveV2(request: ModelSelectionRequestV2, environment: RoutingEnvironmentV2): ModelRoutingDecisionV2;
export declare function revalidateDispatch(request: ModelSelectionRequestV2, decision: ModelRoutingDecisionV2, environment: RoutingEnvironmentV2 & { presence: { host: string; sessionId: string; instanceId: string; state: string; leaseUntil: string } }): { decisionDigest: string; preflight: "current"; executionAuthorized: false };
export declare function recordV2(input: ModelApplicationRequestV2, environment: RoutingEnvironmentV2 & {
  request: ModelSelectionRequestV2; decision: ModelRoutingDecisionV2;
  admittedObservation?: NonNullable<ModelApplicationRequestV2["observation"]> | null;
}): ModelApplicationRecordV2;
