# Versioned model assignment (v2)

Read this only for an assignment that uses `schemaVersion: "2.0.0"`. Unversioned resolve and record inputs keep the behavior in [the v1 presets and host adapters](model-routing.md).

## Keep authority where it is

A v2 decision is a proposal. `executionAuthorized` and `trustedGateSatisfied` are always `false`. The task contract, workflow lease, file ownership, dispatch reservation and independent audit stay with the existing governance flow. A peer delivery ACK is not acceptance or completion. A profile changes only the ordering of eligible models; it never changes delegation, agent count, batching, permissions or audit requirements.

## Supply the inputs

- `ModelSelectionRequest.v2` (`contracts/model-selection-request.v2.schema.json`): the binding (assignment, task, run, stage, attempt, revision, input and candidate digests), role, `highRisk`, optional profile and task traits, requirements, and an optional user preference. A `required` preference blocks instead of silently substituting; a `preferred` one records `PREFERRED_CHOICE_UNAVAILABLE` when another model is chosen.
- Capability snapshots (`HostModelCapabilities.v1`) come from a host boundary. Never take them from the request or from a worker's self-report. The MCP resolver reads a negotiated, authenticated snapshot set from the local session broker plus non-native local adapter snapshots. It never accepts capabilities from tool arguments. With none, the decision is `blocked`.
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

`scripts/adapters/` holds native subagent argument builders, opt-in headless adapters for `gemini-cli` and `grok-build` (disabled by default and not live-verified; argv only, no shell, bounded time and output), and the `gemini-spark` runtime descriptor (`autoDispatch: false`). Native observation hooks and workflow-owned audit history are connected. Without established capability/permission boundaries the resolver remains `blocked`; missing observed fields remain `unverified`. Broker capability negotiation/publication/discovery is connected. Assignment acceptance and automatic peer dispatch are not connected yet. Native tool-issuer observations do not prove the whole assignment's mode or terminal outcome.

## Native observation hook

The installed native observer binds `record_model_application` to the current tool issuer's host/session/instance and a previously registered dispatch. It never creates a dispatch or changes an approval. Current-tool observations are not whole-assignment completion evidence: missing effort/mode remains unknown and terminal outcome remains unknown. A delayed exact transcript may produce a new admitted diagnostic artifact after the call; use that returned URI without rewriting the earlier record. The existing high-risk execution gate still applies. Capability snapshots without established execution boundaries do not authorize new assignments.

## Shared capability discovery

The native hook publishes its validated parent-session snapshot to the existing local TLS broker only after `model-capabilities.v1` is negotiated. The broker checks a domain-separated signed receipt, session/instance liveness, expiry and the snapshot digest. Configuration remains configuration; neither a transport ACK nor a shared snapshot is execution authority. Child publication does not replace the parent slot.

`resolve_model_assignment` reads a fresh, complete shared set per call without importing remote capabilities into the workflow DB. Paging binds both the publication revision and live session state. Ended, expired or replaced sessions are omitted. Partial/changed/malformed pages are discarded. Native-hook local snapshots are not resurrected when shared liveness cannot be established; independent local adapters and all v1 paths keep their existing behavior. The selected decision preserves the exact snapshot digest/source and remains a proposal requiring dispatch-time revalidation, an existing lease, file ownership and independent audit.

Capability exchange adds no worker launch, shell execution, workflow acceptance, completion transition or model-callable publication tool. Old brokers receive no new operation; normal messaging and its 4096-byte bodies remain unchanged.

## Opt-in peer handoff admission

The installed `mcp-server/dist/model-routing-peer-cli.mjs` and the existing native session-message hook can send a signed delta proposal and return a separate admission receipt when `AGENT_GOVERNANCE_PEER_ROUTING=1`. The receiver must already have the matching local workflow/decision and consumed lease; no foreign task or authority is imported. This path stops at `accepted`, never launches a worker and does not satisfy an execution gate. Delivery ACK, acceptance and completion remain distinct. A missing, disabled or unprepared receiver is not treated as an available executor. See the repository's `docs/model-routing-p5-peer-handoff.ko.md` for the stdin contract and unresolved execution-lifecycle integration.
