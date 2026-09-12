import { ContractError, requireObject } from "./lib.mjs";

/**
 * @param {unknown} value
 * @param {{subagentsAvailable?: boolean}} [environment]
 */
export function validateProviderPlan(value, environment = {}) {
  if (environment.subagentsAvailable !== true) {
    throw new ContractError("SUBAGENTS_UNAVAILABLE", "three independent language actors are required");
  }

  const plan = requireObject(value, "plan");
  if (plan.schemaVersion !== "1.0.0") throw new ContractError("PLAN_SCHEMA_VERSION", "unsupported plan schema version");
  if (!Array.isArray(plan.actorIds) || plan.actorIds.length !== 3) {
    throw new ContractError("ACTOR_COUNT", "actorIds must contain exactly three entries");
  }
  const actorIds = plan.actorIds;
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  if (actorIds.some((actorId) => typeof actorId !== "string" || !uuidPattern.test(actorId))) {
    throw new ContractError("ACTOR_ID", "actorIds must be canonical lowercase UUIDs");
  }
  if (new Set(actorIds).size !== 3) throw new ContractError("ACTOR_UNIQUENESS", "actorIds must be unique");

  const providers = requireObject(plan.providers, "providers");
  for (const [index, name] of ["selection", "editing", "verification"].entries()) {
    const provider = requireObject(providers[name], `providers.${name}`);
    if (provider.kind !== "agent" || provider.actorId !== actorIds[index]) {
      throw new ContractError("PROVIDER_ACTOR_MISMATCH", `${name} must use actorIds[${index}]`);
    }
  }
  const finalization = requireObject(providers.finalization, "providers.finalization");
  if (finalization.kind !== "deterministic" || finalization.entrypoint !== "scripts/finalize.mjs") {
    throw new ContractError("FINALIZER_PROVIDER", "finalization must use the deterministic entrypoint");
  }
  if (Object.hasOwn(finalization, "actorId")) {
    throw new ContractError("FINALIZER_ACTOR", "the deterministic finalizer cannot have an actorId");
  }

  return /** @type {Record<string, unknown> & {actorIds: string[], providers: Record<string, unknown>}} */ (plan);
}
