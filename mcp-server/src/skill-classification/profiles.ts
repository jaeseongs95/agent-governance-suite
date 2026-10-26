import {validateBuiltinProviderConfiguration} from "./providers.js";
import {validateBoundProviderProfile} from "./profile-validation.js";
import type {ProviderProfile, SkillClassificationRequestV1} from "./types.js";
export {loadProviderProfileRegistry, isProviderConfiguration, digestProviderProfileConfiguration, isProviderProfileRegistry,
  selectFixedProfile, estimateTokenCostUsd, type TokenPrices} from "./profile-validation.js";
export {JEV_SKILL_SELECTION_CHOICE_ADAPTER_REVISION, JEV_SKILL_SELECTION_CHOICE_PROMPT_REVISION,
  JEV_SKILL_SELECTION_CHOICE_LONG_CONTEXT_ADAPTER_REVISION} from "./providers.js";

/** Legacy three-argument pure inspection, not dispatch authority. Live paths use their actual bound route. */
export function validateProviderProfile(profile: ProviderProfile, request: SkillClassificationRequestV1, nowMs: number): string | null {
  return validateBoundProviderProfile(profile, request, nowMs, validateBuiltinProviderConfiguration);
}
