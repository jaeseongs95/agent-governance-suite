# Provider-neutral model-routing presets

This policy supplies portable model and reasoning-effort recommendations for hosts that expose compatible subagent controls. The machine-readable source is [`model-routing-presets.json`](model-routing-presets.json).

Explicit user choices, higher-priority instructions, repository rules, current host capabilities, and runtime restrictions take precedence over every preset.

## Keep presets separate from delegation

<!-- policy-contract: routing.preset-does-not-delegate -->
<!-- policy-contract: routing.user-override-precedence -->

Apply a preset only after implementation delegation or an independent audit has already been approved. A preset selects a model and reasoning effort for an assigned role; it never triggers delegation, increases agent count, changes batching, broadens authority, or waives a required audit.

Use `balanced` when no preference is available. Ask about `economy`, `balanced`, or `quality` at most once and only when the model or effort choice would materially affect execution. A user-supplied model or effort overrides the preset when the host supports it.

## Map roles before providers

<!-- policy-contract: routing.role-provider-matrix -->

Classify each approved assignment as one of these roles before consulting a provider mapping:

- `discovery`: bounded search, inventory, extraction, or structured processing with a clear check;
- `general-implementation`: ordinary code analysis, feature work, review, and bounded refactoring;
- `complex-reasoning`: difficult diagnosis, multi-module design, conflicting requirements, or costly integration;
- `independent-audit`: a fresh review of high-risk requirements, final changes, evidence, and failure modes.

Select the profile and role first, then resolve the current host's provider entry in `model-routing-presets.json`. Provider model names and effort labels are adapter values, not cross-provider quality equivalences.

## Apply the OpenAI Codex adapter

<!-- policy-contract: routing.codex-adapter -->
<!-- policy-contract: routing.luna-high-minimum -->
<!-- policy-contract: routing.full-history-inherits -->

For Codex collaboration tools, pass the selected `model` and `reasoning_effort` as spawn arguments only when the current schema supports that exact combination. With `fork_turns="all"`, inherit the parent model and reasoning effort; do not set model or reasoning overrides. For an explicit override, use `fork_turns="none"` or a positive recent-turn count and include missing context in the brief.

Use `gpt-5.6-luna` only at `high` reasoning or above. If that combination is unsupported, choose another supported model instead of lowering Luna's reasoning. For other models, use `xhigh`, `max`, or `ultra` only when the added review value is concrete.

Consult the current collaboration tool schema first and use the [official OpenAI model-selection guide](https://developers.openai.com/api/docs/guides/latest-model) when current product guidance is needed.

## Apply the Anthropic Claude Code adapter

<!-- policy-contract: routing.claude-code-adapter -->

For Claude Code, prefer stable aliases such as `haiku`, `sonnet`, `opus`, and `fable` instead of pinning dated model IDs. Apply `model` and `effort` in a custom subagent definition or CLI agent definition; a per-invocation model argument may override the definition when the current host supports it. Keep effort in the subagent definition or inherit the active effort when per-invocation effort is unavailable.

Before dispatch, check the installed Claude Code version, organization allowlist, provider availability, and any environment variable that forces a model. After dispatch, use the task view to confirm the actual model and effort when verification matters. Claude Code effort levels are calibrated within each model, so do not treat the same label as an exact match to a Codex reasoning level.

Use the official Claude Code documentation for [model configuration](https://code.claude.com/docs/en/model-config) and [custom subagents](https://code.claude.com/docs/en/sub-agents) when current support or precedence is uncertain.

## Apply runtime constraints

<!-- policy-contract: routing.settings-supported -->
<!-- policy-contract: routing.unsupported-fallback -->

Inspect the current host schema and capabilities before setting an override. Never report an unsupported or unverified setting as applied. Treat subscription details as context, not proof that a model, usage allowance, or runtime control is available.

For high-risk work, do not use a model class below `general` or effort below `high`. If a preset falls below that floor, promote the role to the same profile's `general-implementation` selection and then raise effort to `high` if needed.

Use modes such as `Fast` and `Pro`, or effort levels such as `ultra` and `ultracode`, only when the user explicitly requests them and the current host documents and exposes the control. If a preferred override is unavailable but inherited execution is supported and its observed settings satisfy the assignment's risk floor, delegate with the inherited configuration. Otherwise choose a supported adequate configuration or keep the unit pending; unknown inherited settings cannot establish a mandatory risk floor. If neither is supported, report the capability limit without changing the approved work's scope.

## Resolve and record the actual dispatch

Use the dependency-free [model-routing CLI](../scripts/model-routing.mjs) before dispatch:

```text
node <skill-root>/scripts/model-routing.mjs resolve <selection-input.json>
```

Supply `provider`, `profile` (default `balanced`), `role`, explicit `highRisk` (`true` is required for `independent-audit`), and `supported` entries `{model, modelClass, efforts}` from current host capabilities. Use `modelClass: null` when unknown; do not infer a class from a name. The bundled recommendation supplies maintainers' model classes for its listed models, not a host observation. Optional `user: {model, effort}` supports either override separately; optional `inherited: {model, effort}` is an observed inherited combination. When the host supports inheritance but hides its effective settings, set `inheritanceSupported: true` without inventing `inherited` values. This permits low-risk inheritance with `unverified` application; it never establishes a high-risk floor. Set `inheritOnly: true` when the host/context prevents overrides. Unknown providers can use a supported explicit user combination or inheritance. A partial user override uses a known inherited combination as its baseline when no provider recommendation exists; missing values remain explicit nulls rather than silently discarding the user choice. Application recording requires a declared provider adapter. A `blocked` result is not permission to weaken the risk floor.

For example, this input selects a supported ordinary implementation configuration:

```json
{
  "provider": "openai-codex", "profile": "balanced",
  "role": "general-implementation", "highRisk": false,
  "supported": [{"model": "gpt-5.6-terra", "modelClass": "general", "efforts": ["medium", "high"]}]
}
```

Translate the returned `selection` into the current host adapter's actual fields. For Codex explicit delivery, pass both `model` and `reasoning_effort` with `fork_turns="none"` or a positive recent-turn count. For inherited delivery, pass neither override. Inspect the actual call rather than copying the intended selection into a record.

After dispatch, run `node <skill-root>/scripts/model-routing.mjs record <dispatch-input.json>`. Supply `assignmentId`, `selectionReason`, the same selection input under `options`, `spawnArguments` containing the actual model, effort, and context arguments in the host adapter's field names, and `contextReason` for full history. For Codex, copy `model`, `reasoning_effort`, and `fork_turns` from the actual call; omitted `fork_turns` defaults to full history. The recorder derives `contextMode` and normalized `dispatched` from these arguments and rejects a contradictory optional `contextMode`. For adapters without a context field, provide `contextMode` (`limited` or `full-history`) explicitly. Keep task bodies and secrets out of the settings record. Supply `observation: null` if the response exposes no effective settings. Otherwise supply `{model, effort, source, reference}`: source is `spawn-result`, `host-task-view`, or an explicit `tool-contract` guaranteeing the passed combination; reference locates the evidence seen by the caller.

The result distinguishes `applied`, `inherited`, and `unverified`. Passing both arguments alone does not prove application. Worker self-report, assumed parent settings, and later evaluator inspection are not caller-visible host evidence. Keep later inspection separate as posthoc evidence. If the observed settings differ, preserve them and investigate before relying on the worker for a mandatory risk floor. `unverified` never establishes that floor. The CLI validates records against supplied observations; it does not authenticate evidence, launch agents, or grant permission.

For actual host verification, follow [the live dispatch check](live-dispatch-check.md). Deterministic routing tests do not prove host execution or concurrency.

## Diagnose before retrying

<!-- policy-contract: routing.no-mechanical-retry -->

Do not retry through progressively different models when the failure comes from missing information, permissions, tools, an unsupported setting, or an incomplete specification. Resolve the actual blocker or report it.

The preset matrix is a versioned maintainer recommendation. Update provider mappings and deterministic fixtures when host capabilities change; keep the core delegation policy usable when every listed model name becomes unavailable.
