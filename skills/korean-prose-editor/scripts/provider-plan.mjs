import { ContractError, requireObject } from "./lib.mjs";
import { hostText } from "../../../runtime/i18n.mjs";

/**
 * @param {unknown} value
 * @param {{subagentsAvailable?: boolean}} [environment]
 */
export function validateProviderPlan(value, environment = {}) {
  if (environment.subagentsAvailable !== true) {
    throw new ContractError("SUBAGENTS_UNAVAILABLE", hostText("skillChecks.koreanProseEditor.threeActorsRequired"));
  }

  const plan = requireObject(value, "plan");
  if (plan.schemaVersion !== "1.0.0") throw new ContractError("PLAN_SCHEMA_VERSION", hostText("skillChecks.koreanProseEditor.planSchemaVersionUnsupported"));
  if (!Array.isArray(plan.actorIds) || plan.actorIds.length !== 3) {
    throw new ContractError("ACTOR_COUNT", hostText("skillChecks.koreanProseEditor.actorIdsCount"));
  }
  const actorIds = plan.actorIds;
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  if (actorIds.some((actorId) => typeof actorId !== "string" || !uuidPattern.test(actorId))) {
    throw new ContractError("ACTOR_ID", hostText("skillChecks.koreanProseEditor.actorIdsFormat"));
  }
  if (new Set(actorIds).size !== 3) throw new ContractError("ACTOR_UNIQUENESS", hostText("skillChecks.koreanProseEditor.actorIdsUnique"));

  const providers = requireObject(plan.providers, "providers");
  for (const [index, name] of ["selection", "editing", "verification"].entries()) {
    const provider = requireObject(providers[name], `providers.${name}`);
    if (provider.kind !== "agent" || provider.actorId !== actorIds[index]) {
      throw new ContractError("PROVIDER_ACTOR_MISMATCH", hostText("skillChecks.koreanProseEditor.providerActorMismatch", { name, index }));
    }
  }
  const finalization = requireObject(providers.finalization, "providers.finalization");
  if (finalization.kind !== "deterministic" || finalization.entrypoint !== "scripts/finalize.mjs") {
    throw new ContractError("FINALIZER_PROVIDER", hostText("skillChecks.koreanProseEditor.finalizerProvider"));
  }
  if (Object.hasOwn(finalization, "actorId")) {
    throw new ContractError("FINALIZER_ACTOR", hostText("skillChecks.koreanProseEditor.finalizerActor"));
  }

  return /** @type {Record<string, unknown> & {actorIds: string[], providers: Record<string, unknown>}} */ (plan);
}
