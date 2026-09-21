# Versioned model assignment (v2)

Read this only for an assignment that uses `schemaVersion: "2.0.0"`. Unversioned resolve and record inputs keep the behavior in [the v1 presets and host adapters](model-routing.md).

## Keep authority where it is

A v2 decision is a proposal. `executionAuthorized` and `trustedGateSatisfied` are always `false`. The task contract, workflow lease, file ownership, dispatch reservation and independent audit stay with the existing governance flow. A peer delivery ACK is not acceptance or completion. A profile changes only the ordering of eligible models; it never changes delegation, agent count, batching, permissions or audit requirements.

## Supply the inputs

- `ModelSelectionRequest.v2` (`contracts/model-selection-request.v2.schema.json`): the binding (assignment, task, run, stage, attempt, revision, input and candidate digests), role, `highRisk`, optional profile and task traits, requirements, and an optional user preference. A `required` preference blocks instead of silently substituting; a `preferred` one records `PREFERRED_CHOICE_UNAVAILABLE` when another model is chosen.
- Capability snapshots (`HostModelCapabilities.v1`) come from a host boundary. Never take them from the request or from a worker's self-report. The MCP resolver reads only stored snapshots; with none, the decision is `blocked`.
- The reviewed catalog under `references/model-catalog/` (index, provider shards, hosts, sources) and its `policy.json`. Read the index and only the shards the assignment needs; do not copy catalog records into the conversation.

## Understand the selection

Hard filters run before ordering: origin allowlist (aliases and advertised fallbacks included), host enablement, access path, catalog status and age, role and trait fit, native reasoning kind, the policy `modelMinimums`, execution boundary, invocation surface, tools, filesystem, runtime mode (a non-standard mode also needs `allowNestedDelegation`), required observability and independence exclusions. High-risk work additionally needs a host listed in the policy `highRiskNativeFloor`, a native enum at or above its floor, all three fields observable, and a snapshot source stronger than configuration.

Native reasoning is `enum`, `token-budget`, `toggle` or `not-exposed`. Never convert a budget into an enum value, and never treat `ultra` or `ultracode` as an effort; they are runtime modes. Equal inputs, snapshots and policy return the same decision.

## Record what actually ran

The dispatched settings must equal the selection, and the binding, target and decision digest must match the stored decision. Model, reasoning and runtime mode are each `matched`, `mismatch` or `unverified`. Only a single-use host observation token admits evidence; raw or self-reported observations stay `unverified`. A mismatch keeps the observed value. A matched record is a diagnostic artifact referenced from stage evidence, not a gate.

## Use the tools

- `node <skill-root>/scripts/model-catalog.mjs index|validate|query [query.json]` reads the offline catalog.
- `node <skill-root>/scripts/model-routing.mjs resolve|record <input.json>` with `{ "schemaVersion": "2.0.0", "request", "capabilities", "now", "application"? }` runs a diagnostic resolve or record. Its supplied snapshots publish nothing and authorize nothing.
- `node <skill-root>/scripts/model-evaluation.mjs <records.json>` aggregates evaluation records into separate cohorts without changing policy.
- MCP: `query_model_catalog`, `resolve_model_assignment` and `record_model_application`.

## Know the current limits

`scripts/adapters/` holds native subagent argument builders, opt-in headless adapters for `gemini-cli` and `grok-build` (disabled by default and not live-verified; argv only, no shell, bounded time and output), and the `gemini-spark` runtime descriptor (`autoDispatch: false`). Native observation hooks and workflow-owned audit history are connected. Without established capability/permission boundaries the resolver remains `blocked`; missing observed fields remain `unverified`. Broker feature negotiation and automatic peer dispatch are not connected yet. Native tool-issuer observations do not prove the whole assignment's mode or terminal outcome.

## Native observation hook

The installed native observer binds `record_model_application` to the current tool issuer's host/session/instance and a previously registered dispatch. It never creates a dispatch or changes an approval. Current-tool observations are not whole-assignment completion evidence: missing effort/mode remains unknown and terminal outcome remains unknown. A delayed exact transcript may produce a new admitted diagnostic artifact after the call; use that returned URI without rewriting the earlier record. The existing high-risk execution gate still applies. Capability snapshots without established execution boundaries do not authorize new assignments.
