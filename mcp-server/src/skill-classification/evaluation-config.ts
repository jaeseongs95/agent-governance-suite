import {digestProviderProfileConfiguration, isProviderConfiguration} from "./profiles.js";
import type {ProviderConfiguration, ProviderEvaluationConfigurationV1, SkillClassificationRequestV1} from "./types.js";

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;

/** preparedAt is provenance, never an expiry or authorization. Production uses its separate PASS profile. */
export function isProviderEvaluationConfiguration(value: unknown): value is ProviderEvaluationConfigurationV1 {
  if (!object(value) || !exact(value, ["schemaVersion", "configuration", "configurationDigest", "evaluationState", "preparedAt", "productionRegistryUsable"])
    || value.schemaVersion !== "1.0.0" || value.productionRegistryUsable !== false || !isProviderConfiguration(value.configuration)
    || !text(value.preparedAt) || !Number.isFinite(Date.parse(value.preparedAt)) || new Date(value.preparedAt).toISOString() !== value.preparedAt
    || value.configurationDigest !== digestProviderProfileConfiguration(value.configuration)) return false;
  const state = value.evaluationState;
  return object(state) && exact(state, ["status", "inventoryDigest", "taxonomyRevision", "modelRevision", "promptRevision"])
    && state.status === "NOT_RUN" && text(state.inventoryDigest) && /^sha256:[a-f0-9]{64}$/u.test(state.inventoryDigest)
    && text(state.taxonomyRevision) && state.modelRevision === value.configuration.modelRevision && state.promptRevision === value.configuration.promptRevision;
}

export function createProviderEvaluationConfiguration(configuration: ProviderConfiguration,
  inventory: Pick<SkillClassificationRequestV1, "inventoryDigest" | "taxonomyRevision">, preparedAt: string): ProviderEvaluationConfigurationV1 {
  const value: ProviderEvaluationConfigurationV1 = {schemaVersion: "1.0.0", configuration: structuredClone(configuration),
    configurationDigest: digestProviderProfileConfiguration(configuration), evaluationState: {status: "NOT_RUN", inventoryDigest: inventory.inventoryDigest, taxonomyRevision: inventory.taxonomyRevision,
      modelRevision: configuration.modelRevision, promptRevision: configuration.promptRevision}, preparedAt, productionRegistryUsable: false};
  if (!isProviderEvaluationConfiguration(value)) throw new Error("INVALID_EVALUATION_CONFIGURATION");
  return value;
}

export function validateProviderEvaluationConfiguration(value: unknown,
  inventory: Pick<SkillClassificationRequestV1, "inventoryDigest" | "taxonomyRevision">): string | null {
  if (!isProviderEvaluationConfiguration(value)) return "INVALID_EVALUATION_CONFIGURATION";
  return value.evaluationState.inventoryDigest === inventory.inventoryDigest && value.evaluationState.taxonomyRevision === inventory.taxonomyRevision
    ? null : "EVALUATION_BINDING_MISMATCH";
}
