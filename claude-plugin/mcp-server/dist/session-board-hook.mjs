#!/usr/bin/env node

// mcp-server/src/hook-entry.ts
import path from "node:path";
import { fileURLToPath } from "node:url";
function isHookEntry(url, name) {
  const argument = process.argv[1];
  if (!argument || path.resolve(argument) !== fileURLToPath(url)) return false;
  const basename = path.basename(argument);
  return basename === "".concat(name, ".mjs") || basename === "".concat(name, ".ts");
}

// mcp-server/src/input-observation.ts
import { types as utilTypes } from "node:util";
function actorAccess(actor) {
  const invalid = { allowed: false, reasonCode: "ACTOR_OBSERVATION_INVALID" };
  if (!actor || typeof actor !== "object" || utilTypes.isProxy(actor) || Array.isArray(actor)) return invalid;
  try {
    const role = Object.getOwnPropertyDescriptor(actor, "role")?.value;
    const basis = Object.getOwnPropertyDescriptor(actor, "basis")?.value;
    const reasonCode = Object.getOwnPropertyDescriptor(actor, "reasonCode")?.value;
    if (role !== "root" && role !== "child" && role !== "indeterminate" || basis !== "observed" && basis !== "inferred" && basis !== "unavailable" || typeof reasonCode !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(reasonCode)) return invalid;
    return { allowed: role === "root" && (basis === "observed" || basis === "inferred"), reasonCode };
  } catch {
    return invalid;
  }
}

// mcp-server/src/builtin-hook-host-adapters.ts
import { createHash as createHash2 } from "node:crypto";
import { types as utilTypes3 } from "node:util";

// runtime/failure-diagnostics.mjs
import { createHash } from "node:crypto";
import { types } from "node:util";
var producerReasons = /* @__PURE__ */ new WeakMap();
var producerCauses = /* @__PURE__ */ new WeakMap();
var secondaryFailures = /* @__PURE__ */ new WeakMap();
function tagProducerFailure(error, reason) {
  if (!/^[A-Z][A-Z0-9_]{0,63}$/u.test(reason)) throw new TypeError("Invalid diagnostic reason.");
  if (!producerReasons.has(error)) producerReasons.set(error, reason);
  return error;
}
function retainFailureCause(error, cause) {
  if (!producerCauses.has(error)) producerCauses.set(error, cause);
  return error;
}
function retainFailureSecondary(error, secondary) {
  if (error && (typeof error === "object" || typeof error === "function") && error !== secondary) {
    const prior = secondaryFailures.get(error) ?? [];
    if (prior.length < 2 && !prior.includes(secondary)) secondaryFailures.set(error, [...prior, secondary]);
  }
  return error;
}
function producerFailure(reason, message) {
  if (!/^[A-Z][A-Z0-9_]{0,63}$/u.test(reason)) throw new TypeError("Invalid diagnostic reason.");
  const error = new Error(message);
  Object.defineProperty(error, "code", { value: reason, enumerable: true });
  producerReasons.set(error, reason);
  return error;
}
function producerFailureReason(error) {
  return error && (typeof error === "object" || typeof error === "function") ? producerReasons.get(error) ?? null : null;
}
function failureContext(error) {
  const seen = /* @__PURE__ */ new Set();
  function describe(value, depth) {
    const type = value === null ? "null" : typeof value;
    if (!value || typeof value !== "object" && typeof value !== "function") return { type };
    if (types.isProxy(value)) return { type, opaque: "proxy" };
    if (seen.has(value)) return { type, cycle: true };
    seen.add(value);
    try {
      const prototype = Object.getPrototypeOf(value);
      const context = {
        type: prototype === SyntaxError.prototype ? "syntax-error" : prototype === TypeError.prototype ? "type-error" : prototype === RangeError.prototype ? "range-error" : types.isNativeError(value) ? "error" : type
      };
      const producerReason = producerFailureReason(value);
      if (producerReason) context.producerReason = producerReason;
      if (producerCauses.has(value)) context.producerCause = depth < 2 ? describe(producerCauses.get(value), depth + 1) : { truncated: true };
      const secondary = secondaryFailures.get(value);
      if (secondary) context.secondary = depth < 2 ? secondary.map((error2) => describe(error2, depth + 1)) : { truncated: true };
      const code = Object.getOwnPropertyDescriptor(value, "code");
      if (code) {
        if (!("value" in code)) context.code = { type: "accessor", observed: false };
        else if (typeof code.value === "string") {
          const prefix = code.value.slice(0, 256);
          context.code = {
            type: "string",
            length: code.value.length,
            prefixCodeUnits: prefix.length,
            truncated: prefix.length !== code.value.length,
            encoding: "utf16le",
            prefixSha256: createHash("sha256").update(Buffer.from(prefix, "utf16le")).digest("hex")
          };
        } else context.code = { type: code.value === null ? "null" : typeof code.value, observed: false };
      }
      if (code && "value" in code && code.value === "ERR_SQLITE_ERROR") {
        const detail = Object.getOwnPropertyDescriptor(value, "errcode");
        if (detail && !("value" in detail)) context.sqlite = { type: "accessor", observed: false };
        else if (detail && Number.isInteger(detail.value) && detail.value >= 1 && detail.value <= 65535 && (detail.value & 255) >= 1 && (detail.value & 255) <= 28) {
          context.sqlite = { errcode: detail.value, primaryCode: detail.value & 255 };
        } else context.sqlite = { observed: false };
      }
      const cause = Object.getOwnPropertyDescriptor(value, "cause");
      if (cause) {
        if (!("value" in cause)) context.cause = { type: "accessor", observed: false };
        else context.cause = depth < 2 ? describe(cause.value, depth + 1) : { truncated: true };
      }
      return context;
    } catch {
      return { type, unreadable: true };
    } finally {
      seen.delete(value);
    }
  }
  return describe(error, 0);
}

// mcp-server/src/builtin-hook-host-adapters.ts
import { closeSync, constants, fstatSync, openSync, readSync, statSync } from "node:fs";
import path5 from "node:path";

// mcp-server/src/host-input-adapter.ts
import { AsyncLocalStorage } from "node:async_hooks";

// contracts/types.ts
var WorkflowContractError = class extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.code = code;
    this.details = details;
    this.name = "WorkflowContractError";
  }
  code;
  details;
  toBody() {
    return { code: this.code, message: this.message, details: this.details };
  }
};

// mcp-server/src/host-input-adapter.ts
var hostFailures = {
  selection: ["INVALID_HOOK_HOST_SELECTION", "Invalid or ambiguous hook host."],
  adapter: ["INVALID_HOOK_HOST_ADAPTER", "Invalid hook host adapter."],
  duplicate: ["HOOK_HOST_ADAPTER_DUPLICATE", "Hook host adapter is already registered."],
  unavailable: ["HOST_ADAPTER_UNAVAILABLE", "A host delivery adapter is required."]
};
function hookHostFailure(kind) {
  const [reason, message] = hostFailures[kind];
  return producerFailure(reason, message);
}
function resolveHookHost(arguments_, fallback) {
  const selected = [];
  for (let index = 0; index < arguments_.length; index++) {
    const argument = arguments_[index];
    if (argument === "--host") selected.push(arguments_[++index] ?? "");
    else if (argument.startsWith("--host=")) selected.push(argument.slice(7));
  }
  if (selected.length === 0) {
    if (fallback !== void 0) return fallback;
    throw hookHostFailure("selection");
  }
  if (selected.length !== 1 || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(selected[0])) throw hookHostFailure("selection");
  return selected[0];
}
function adaptHostInput(input, host) {
  const adapter = selectedHookHostAdapter(host);
  if (!adapter) throw hookHostFailure("unavailable");
  const call = callHostAdapter.getStore();
  if (call?.adapted) {
    const toolInput = Object.getOwnPropertyDescriptor(input, "tool_input")?.value;
    if (!toolInput || typeof toolInput !== "object" || Array.isArray(toolInput)) {
      throw new WorkflowContractError("BINDING_REQUIRED", "Canonical hook arguments unavailable.", { reasonCode: "HOST_HOOK_COMPOSITION_UNAVAILABLE" });
    }
    return { ...call.adapted, observation: { ...call.adapted.observation, toolInput } };
  }
  const adapted = adapter.adaptInput?.(input, host) ?? {
    lifecycle: "none",
    outputEventName: "",
    observation: {
      host,
      sessionId: "",
      kind: "unknown",
      actor: { role: "indeterminate", basis: "unavailable", reasonCode: "HOST_ACTOR_OBSERVATION_UNAVAILABLE" }
    }
  };
  if (!call) return adapted;
  const { observation: sourceObservation, ...snapshot } = adapted;
  const observation = { ...sourceObservation };
  if (observation.host !== host) {
    throw new WorkflowContractError("BINDING_REQUIRED", "Host observation differs from its selected composition.", { reasonCode: "HOST_HOOK_OBSERVATION_MISMATCH" });
  }
  const actor = observation.actor;
  const snapshotActor = actorAccess(actor).allowed ? Object.freeze({ role: actor.role, basis: actor.basis, reasonCode: actor.reasonCode }) : actor;
  call.adapted = Object.freeze({ ...snapshot, observation: Object.freeze({ ...observation, actor: snapshotActor }) });
  return call.adapted;
}
function isGovernanceHookTool(host, toolName) {
  return selectedHookHostAdapter(host)?.ownsTool?.(toolName) === true;
}
var hookHostAdapters = /* @__PURE__ */ new Map();
function registerHookHostAdapter(host, adapter) {
  if (typeof host !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(host) || !adapter || typeof adapter.deliveryProfile !== "function" || typeof adapter.processPid !== "function" || adapter.adaptInput !== void 0 && typeof adapter.adaptInput !== "function" || adapter.ownsTool !== void 0 && typeof adapter.ownsTool !== "function" || adapter.attestationKind !== void 0 && (typeof adapter.attestationKind !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(adapter.attestationKind))) throw hookHostFailure("adapter");
  if (hookHostAdapters.has(host)) throw hookHostFailure("duplicate");
  hookHostAdapters.set(host, Object.freeze({ ...adapter }));
}
var callHostAdapter = new AsyncLocalStorage();
function selectedHookHostAdapter(host) {
  const call = callHostAdapter.getStore();
  if (!call) return hookHostAdapters.get(host);
  if (!call.active || call.host !== host) {
    throw new WorkflowContractError("BINDING_REQUIRED", "Host hook composition is inactive or has a different host.", { reasonCode: "HOST_HOOK_COMPOSITION_UNAVAILABLE" });
  }
  return call.adapter;
}

// mcp-server/src/session-message-client.ts
import { types as utilTypes2 } from "node:util";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path3 from "node:path";
import { performance as performance2 } from "node:perf_hooks";
import tls from "node:tls";
import { fileURLToPath as fileURLToPath2 } from "node:url";

// skills/coordinate-subagents/references/model-routing-presets.json
var model_routing_presets_default = {
  schema_version: 1,
  policy_revision: "2026-10-24.r02",
  default_profile: "balanced",
  roles: [
    "discovery",
    "general-implementation",
    "complex-reasoning",
    "independent-audit"
  ],
  model_class_order: [
    "lightweight",
    "general",
    "deep",
    "frontier"
  ],
  effort_order: [
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
    "ultra"
  ],
  invariants: {
    controls_delegation: false,
    controls_agent_count: false,
    controls_batching: false,
    user_override_precedence: true,
    capability_check_required: true,
    high_risk_minimum_model_class: "general",
    high_risk_minimum_effort: "high"
  },
  providers: {
    "openai-codex": {
      host: "codex",
      minimum_efforts: { "gpt-5.6-luna": "high" },
      catalog: {
        matching: "exact-only",
        models: {
          "gpt-6-astra": {
            model_class: "frontier",
            supported_efforts: ["low", "medium", "high", "xhigh", "max", "ultra"]
          },
          "gpt-6-sol": {
            model_class: "general",
            supported_efforts: ["low", "medium", "high", "xhigh", "max", "ultra"]
          },
          "gpt-6.1-sol": {
            model_class: "general",
            supported_efforts: ["low", "medium", "high", "xhigh", "max", "ultra"]
          },
          "gpt-6-luna": {
            model_class: "lightweight",
            supported_efforts: ["low", "medium", "high", "xhigh", "max", "ultra"]
          },
          "gpt-5.6-sol": {
            model_class: "deep",
            supported_efforts: ["low", "medium", "high", "xhigh", "max", "ultra"]
          },
          "gpt-5.6-terra": {
            model_class: "general",
            supported_efforts: ["low", "medium", "high", "xhigh", "max", "ultra"]
          },
          "gpt-5.6-luna": {
            model_class: "lightweight",
            minimum_effort: "high",
            supported_efforts: ["low", "medium", "high", "xhigh", "max", "ultra"]
          }
        },
        aliases: {}
      },
      application: {
        full_history_overrides: false,
        context_field: "fork_turns",
        default_context: "all",
        full_history_value: "all",
        limited_context_value: "none",
        model_field: "model",
        effort_field: "reasoning_effort",
        model_delivery: ["spawn-argument"],
        effort_delivery: ["spawn-argument"],
        verification: "spawn-result"
      },
      profiles: {
        economy: {
          discovery: { model: "gpt-5.6-luna", effort: "high", model_class: "lightweight" },
          "general-implementation": { model: "gpt-5.6-terra", effort: "medium", model_class: "general" },
          "complex-reasoning": { model: "gpt-5.6-sol", effort: "medium", model_class: "deep" },
          "independent-audit": { model: "gpt-5.6-sol", effort: "high", model_class: "deep" }
        },
        balanced: {
          discovery: { model: "gpt-5.6-luna", effort: "high", model_class: "lightweight" },
          "general-implementation": { model: "gpt-5.6-terra", effort: "medium", model_class: "general" },
          "complex-reasoning": { model: "gpt-5.6-sol", effort: "high", model_class: "deep" },
          "independent-audit": { model: "gpt-6-astra", effort: "high", model_class: "frontier" }
        },
        quality: {
          discovery: { model: "gpt-5.6-terra", effort: "medium", model_class: "general" },
          "general-implementation": { model: "gpt-5.6-sol", effort: "high", model_class: "deep" },
          "complex-reasoning": { model: "gpt-6-astra", effort: "high", model_class: "frontier" },
          "independent-audit": { model: "gpt-6-astra", effort: "xhigh", model_class: "frontier" }
        }
      }
    },
    "anthropic-claude-code": {
      host: "claude-code",
      catalog: {
        matching: "claude-family-or-exact",
        models: {
          haiku: {
            model_class: "lightweight",
            supported_efforts: ["low", "medium", "high", "xhigh", "max", "ultra"]
          },
          sonnet: {
            model_class: "general",
            supported_efforts: ["low", "medium", "high", "xhigh", "max", "ultra"]
          },
          opus: {
            model_class: "deep",
            supported_efforts: ["low", "medium", "high", "xhigh", "max", "ultra"]
          },
          fable: {
            model_class: "frontier",
            supported_efforts: ["low", "medium", "high", "xhigh", "max", "ultra"]
          }
        },
        aliases: {}
      },
      application: {
        model_field: "model",
        effort_field: "effort",
        model_delivery: ["per-invocation-argument", "subagent-frontmatter"],
        effort_delivery: ["subagent-frontmatter", "cli-agent-definition"],
        verification: "tasks-view"
      },
      profiles: {
        economy: {
          discovery: { model: "haiku", effort: "low", model_class: "lightweight" },
          "general-implementation": { model: "sonnet", effort: "medium", model_class: "general" },
          "complex-reasoning": { model: "opus", effort: "medium", model_class: "deep" },
          "independent-audit": { model: "opus", effort: "high", model_class: "deep" }
        },
        balanced: {
          discovery: { model: "haiku", effort: "high", model_class: "lightweight" },
          "general-implementation": { model: "sonnet", effort: "high", model_class: "general" },
          "complex-reasoning": { model: "opus", effort: "high", model_class: "deep" },
          "independent-audit": { model: "fable", effort: "high", model_class: "frontier" }
        },
        quality: {
          discovery: { model: "sonnet", effort: "high", model_class: "general" },
          "general-implementation": { model: "opus", effort: "high", model_class: "deep" },
          "complex-reasoning": { model: "fable", effort: "xhigh", model_class: "frontier" },
          "independent-audit": { model: "fable", effort: "xhigh", model_class: "frontier" }
        }
      }
    },
    "google-gemini": {
      host: "gemini",
      catalog: {
        matching: "gemini-family-or-exact",
        models: {
          "flash-lite": {
            model_class: "lightweight",
            supported_efforts: ["low", "medium", "high", "xhigh", "max", "ultra"]
          },
          "flash-8b": {
            model_class: "lightweight",
            supported_efforts: ["low", "medium", "high", "xhigh", "max", "ultra"]
          },
          flash: {
            model_class: "general",
            supported_efforts: ["low", "medium", "high", "xhigh", "max", "ultra"]
          },
          pro: {
            model_class: "deep",
            supported_efforts: ["low", "medium", "high", "xhigh", "max", "ultra"]
          },
          ultra: {
            model_class: "frontier",
            supported_efforts: ["low", "medium", "high", "xhigh", "max", "ultra"]
          }
        },
        aliases: {
          flash_lite: "flash-lite"
        }
      },
      application: {
        model_field: "model",
        effort_field: "effort",
        model_delivery: ["invoke-argument", "subagent-frontmatter"],
        effort_delivery: ["subagent-frontmatter"],
        verification: "host-task-view"
      },
      profiles: {
        economy: {
          discovery: { model: "flash-lite", effort: "low", model_class: "lightweight" },
          "general-implementation": { model: "flash", effort: "medium", model_class: "general" },
          "complex-reasoning": { model: "pro", effort: "medium", model_class: "deep" },
          "independent-audit": { model: "pro", effort: "high", model_class: "deep" }
        },
        balanced: {
          discovery: { model: "flash-lite", effort: "high", model_class: "lightweight" },
          "general-implementation": { model: "flash", effort: "high", model_class: "general" },
          "complex-reasoning": { model: "pro", effort: "high", model_class: "deep" },
          "independent-audit": { model: "ultra", effort: "high", model_class: "frontier" }
        },
        quality: {
          discovery: { model: "flash", effort: "high", model_class: "general" },
          "general-implementation": { model: "pro", effort: "high", model_class: "deep" },
          "complex-reasoning": { model: "ultra", effort: "xhigh", model_class: "frontier" },
          "independent-audit": { model: "ultra", effort: "xhigh", model_class: "frontier" }
        }
      }
    }
  }
};

// skills/coordinate-subagents/scripts/model-catalog-adapter.mjs
function escapeRegExp(literal) {
  return literal.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
function buildClaudeFamilyRegex(keys) {
  if (keys.length === 0) return null;
  const sorted = [...keys].sort((left, right) => right.length - left.length).map(escapeRegExp);
  return new RegExp(
    "^(?:[a-z]{2,6}(?:-[a-z]{2,4})?\\.)?(?:anthropic\\.)?claude-(?:\\d+(?:-\\d+)?-)?(".concat(sorted.join("|"), ")(?:[-@:.]|$)"),
    "u"
  );
}
function buildGeminiFamilyRegex(prefixedKeys, bareKeys) {
  if (prefixedKeys.length === 0 && bareKeys.length === 0) return null;
  const sortedPrefixed = [...prefixedKeys].sort((left, right) => right.length - left.length).map(escapeRegExp);
  const sortedBare = [...bareKeys].sort((left, right) => right.length - left.length).map(escapeRegExp);
  const branches = [];
  if (sortedPrefixed.length > 0) {
    branches.push(
      "^(?:[a-z]{2,6}(?:-[a-z]{2,4})?\\.)?(?:google[./-])?(?:models\\/)?(?:gemini-(?:\\d+(?:\\.\\d+)?-)?)" + "(".concat(sortedPrefixed.join("|"), ")(?:[-@:.]|$)")
    );
  }
  if (sortedBare.length > 0) {
    branches.push("^(".concat(sortedBare.join("|"), ")$"));
  }
  return new RegExp(branches.join("|"), "u");
}
function resolveCatalogModel(catalog, rawModel, { allowProfileKeys = false } = {}) {
  if (typeof rawModel !== "string" || rawModel.length === 0 || !catalog) return null;
  const models = catalog.models ?? {};
  const aliases = catalog.aliases ?? {};
  let matchedToken = null;
  if (allowProfileKeys && ["exact-only", "claude-family-or-exact", "gemini-family-or-exact"].includes(catalog.matching) && (Object.hasOwn(models, rawModel) || Object.hasOwn(aliases, rawModel))) {
    matchedToken = rawModel;
  } else if (catalog.matching === "exact-only") {
    if (Object.hasOwn(models, rawModel) || Object.hasOwn(aliases, rawModel)) {
      matchedToken = rawModel;
    }
  } else if (catalog.matching === "claude-family-or-exact") {
    const allKeys = [.../* @__PURE__ */ new Set([...Object.keys(models), ...Object.keys(aliases)])];
    const familyRegex = buildClaudeFamilyRegex(allKeys);
    matchedToken = familyRegex?.exec(rawModel)?.[1] ?? null;
  } else if (catalog.matching === "gemini-family-or-exact") {
    const allKeys = [.../* @__PURE__ */ new Set([...Object.keys(models), ...Object.keys(aliases)])];
    const bareKeys = allKeys.filter((key) => key !== "flash-8b");
    const familyRegex = buildGeminiFamilyRegex(allKeys, bareKeys);
    const match = familyRegex?.exec(rawModel);
    matchedToken = match?.[1] ?? match?.[2] ?? null;
    if (!matchedToken && (Object.hasOwn(models, rawModel) || Object.hasOwn(aliases, rawModel)) && rawModel !== "flash-8b") {
      matchedToken = rawModel;
    }
  }
  if (!matchedToken) return null;
  const canonicalKey = Object.hasOwn(aliases, matchedToken) ? aliases[matchedToken] : matchedToken;
  if (!Object.hasOwn(models, canonicalKey)) return null;
  return canonicalKey;
}

// mcp-server/src/host-execution-adapters.ts
function resolveFromProviderCatalog(providerId, host, policyRevision, providerEntry, rawModel, provenance = "adapter-policy") {
  if (typeof rawModel !== "string" || rawModel.length === 0 || !providerEntry?.catalog) return null;
  const catalog = providerEntry.catalog;
  const models = catalog.models ?? {};
  const minimumEfforts = providerEntry.minimum_efforts ?? {};
  const canonicalKey = resolveCatalogModel(catalog, rawModel);
  if (!canonicalKey) return null;
  const entry = models[canonicalKey];
  const minimumReasoningEffort = minimumEfforts[rawModel] ?? minimumEfforts[canonicalKey] ?? entry.minimum_effort ?? null;
  const supportedEfforts = entry.supported_efforts ?? [];
  return {
    provider: providerId,
    host,
    rawModel,
    resolvedModel: canonicalKey,
    modelClass: entry.model_class,
    minimumReasoningEffort,
    supportedEfforts,
    aliasUsed: rawModel !== canonicalKey,
    policyRevision,
    provenance
  };
}
function createHostAdapter(providerId, host, policyRevision, providerEntry) {
  return Object.freeze({
    host,
    provider: providerId,
    policyRevision,
    resolveModel(model, provenance = "".concat(host, ":adapter-policy")) {
      return resolveFromProviderCatalog(providerId, host, policyRevision, providerEntry, model, provenance);
    },
    modelClassForModel(model) {
      return resolveFromProviderCatalog(providerId, host, policyRevision, providerEntry, model)?.modelClass ?? null;
    }
  });
}
function createCatalogExecutionAdapters(presets = model_routing_presets_default) {
  if (!presets || typeof presets !== "object" || Array.isArray(presets) || !presets.providers || typeof presets.providers !== "object" || Array.isArray(presets.providers)) throw new Error("INVALID_EXECUTION_ADAPTER_CONFIGURATION");
  const policyRevision = typeof presets.policy_revision === "string" && presets.policy_revision.length > 0 ? presets.policy_revision : "1.0.0";
  const adapters = /* @__PURE__ */ new Map();
  for (const [providerId, entry] of Object.entries(presets.providers)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("INVALID_EXECUTION_ADAPTER_HOST");
    const host = entry.host;
    if (typeof host !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(host)) throw new Error("INVALID_EXECUTION_ADAPTER_HOST");
    if (adapters.has(host)) throw new Error("DUPLICATE_EXECUTION_ADAPTER_HOST");
    adapters.set(host, createHostAdapter(providerId, host, policyRevision, entry));
  }
  const view = Object.freeze({
    size: adapters.size,
    get: (host) => adapters.get(host),
    has: (host) => adapters.has(host),
    entries: () => adapters.entries(),
    keys: () => adapters.keys(),
    values: () => adapters.values(),
    forEach(callback, thisArg) {
      adapters.forEach((value, key) => callback.call(thisArg, value, key, view));
    },
    [Symbol.iterator]: () => adapters[Symbol.iterator](),
    [Symbol.toStringTag]: "ReadonlyMap"
  });
  return Object.freeze({ policyRevision, adapters: view });
}
var defaultSuite = createCatalogExecutionAdapters();
var defaultExecutionAdapters = defaultSuite.adapters;
var claudeCodeExecutionAdapter = defaultSuite.adapters.get("claude-code");
var codexExecutionAdapter = defaultSuite.adapters.get("codex");
var geminiExecutionAdapter = defaultSuite.adapters.get("gemini");

// mcp-server/src/runtime-config.ts
import { homedir } from "node:os";
import path2 from "node:path";
function sharedUserStateDirectory(environment, homeDirectory) {
  const configured = environment.AGENT_GOVERNANCE_SHARED_STATE_DIR?.trim();
  if (configured) {
    if (!path2.isAbsolute(configured)) {
      throw new Error("AGENT_GOVERNANCE_SHARED_STATE_DIR must be an absolute path.");
    }
    return path2.normalize(configured);
  }
  return path2.resolve(homeDirectory, ".agent-governance-suite");
}
function resolveSessionMessageStateDirectory(environment = process.env, platform = process.platform, homeDirectory = homedir(), currentWorkingDirectory = process.cwd()) {
  void platform;
  const configured = environment.AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR?.trim();
  if (configured) return path2.resolve(currentWorkingDirectory, configured);
  return path2.join(sharedUserStateDirectory(environment, homeDirectory), "session-messaging");
}
function resolveSessionBoardDatabasePath(environment = process.env, platform = process.platform, homeDirectory = homedir(), currentWorkingDirectory = process.cwd()) {
  void platform;
  const configured = environment.AGENT_GOVERNANCE_SESSION_BOARD_DB_PATH?.trim();
  if (configured) return path2.resolve(currentWorkingDirectory, configured);
  return path2.join(sharedUserStateDirectory(environment, homeDirectory), "session-board.sqlite3");
}

// mcp-server/src/session-message-protocol.ts
var SESSION_MESSAGE_PROTOCOL = "1.0.0";
var BROKER_STARTUP_CODES = /* @__PURE__ */ new Set([
  "EACCES",
  "EPERM",
  "ENOENT",
  "ENOSPC",
  "EMFILE",
  "ENFILE",
  "EADDRINUSE",
  "ETIMEDOUT",
  "SQLITE_BUSY",
  "SQLITE_CANTOPEN",
  "SQLITE_CORRUPT",
  "SQLITE_IOERR",
  "SQLITE_READONLY",
  "BROKER_LOCK_BUDGET_EXPIRED",
  "BROKER_LOCK_OWNER_UNVERIFIED",
  "BROKER_LOCK_UNSUPPORTED_PATH",
  "BROKER_LOCK_EMPTY_DIRECTORY",
  "BROKER_LOCK_UNRECOGNIZED_OWNER",
  "BROKER_LOCK_CHANGED",
  "BROKER_LOCK_PREPARATION_CLEANUP_FAILED",
  "BROKER_IDENTITY_BUDGET_EXPIRED",
  "BROKER_IDENTITY_BUDGET_INVALID",
  "STARTUP_FAILED"
]);
function brokerStartupCode(value) {
  return typeof value === "string" && BROKER_STARTUP_CODES.has(value) ? value : null;
}
var SESSION_MESSAGE_MAX_REQUEST_BYTES = 32 * 1024;
var SESSION_MESSAGE_MAX_RESPONSE_BYTES = 32 * 1024;
function sessionMessageLineReader(limitBytes) {
  let pending = Buffer.alloc(0);
  return (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    const newline = pending.indexOf(10);
    if ((newline < 0 ? pending.length : newline + 1) > limitBytes) throw new RangeError("The session message line exceeds its limit.");
    if (newline < 0) return null;
    const line = pending.toString("utf8", 0, newline);
    pending = Buffer.alloc(0);
    return line;
  };
}

// mcp-server/src/broker-identity-budget.ts
function encodeIdentityDeadline(deadlineMonotonicMs) {
  const before = process.hrtime.bigint();
  const remaining = Math.floor(deadlineMonotonicMs - performance.now());
  if (!Number.isFinite(remaining) || remaining < 1) throw producerFailure("BROKER_IDENTITY_BUDGET_EXPIRED", "The broker identity budget expired.");
  return String(before + BigInt(remaining) * 1000000n);
}

// mcp-server/src/session-message-client.ts
var WAKE_PREFIX = "[agent-governance-suite:wake:";
var BrokerRequestRejected = class extends Error {
  details;
  constructor(message, details = null) {
    super(message);
    tagProducerFailure(this, "BROKER_REQUEST_REJECTED");
    const record2 = details && typeof details === "object" && !Array.isArray(details) ? details : null;
    this.details = record2 && (record2.scope === "sender" || record2.scope === "global") && (record2.earliestReleaseAt === null || typeof record2.earliestReleaseAt === "string") ? { scope: record2.scope, earliestReleaseAt: record2.earliestReleaseAt } : null;
  }
};
var BROKER_STARTUP_TIMEOUT_MS = 15e3;
var SESSION_MESSAGE_REQUEST_TIMEOUT_MS = 2e4;
var BROKER_REQUEST_TIMEOUT_MS = 2500;
var BROKER_STARTUP_DEADLINE_MESSAGE = "The session message broker did not become ready before the startup deadline.";
var SESSION_MESSAGE_REQUEST_DEADLINE_MESSAGE = "The session message request deadline expired.";
var deadlineMetadata = /* @__PURE__ */ new WeakMap();
function statePaths(stateDirectory = resolveSessionMessageStateDirectory()) {
  return {
    stateDirectory,
    endpoint: path3.join(stateDirectory, "endpoint.json"),
    token: path3.join(stateDirectory, "broker.token"),
    certificate: path3.join(stateDirectory, "broker-cert.pem")
  };
}
function deadlineError(message) {
  return tagProducerFailure(new Error(message), "BROKER_DEADLINE_EXPIRED");
}
function clientFailure(reason, message, cause) {
  return utilTypes2.isNativeError(cause) ? tagProducerFailure(cause, reason) : retainFailureCause(tagProducerFailure(new Error(message), reason), cause);
}
function signalError(signal) {
  return signal.reason instanceof Error ? signal.reason : deadlineMetadata.has(signal) ? deadlineError(deadlineMetadata.get(signal).message) : retainFailureCause(tagProducerFailure(new Error("The session message operation was aborted."), "BROKER_OPERATION_ABORTED"), signal.reason);
}
function throwIfAborted(signal) {
  if (signal?.aborted) throw signalError(signal);
}
function remainingMilliseconds(deadline, signal, message = SESSION_MESSAGE_REQUEST_DEADLINE_MESSAGE) {
  throwIfAborted(signal);
  const inherited = signal ? deadlineMetadata.get(signal) : void 0;
  const remaining = (inherited?.deadline ?? deadline) - performance2.now();
  if (remaining < 1) throw deadlineError(inherited?.message ?? message);
  return remaining;
}
function assertWithinDeadline(deadline, signal, message) {
  remainingMilliseconds(deadline, signal, message);
}
async function withDeadline(timeoutMs, parentSignal, message, work, absoluteDeadline) {
  const parentDeadline = parentSignal ? deadlineMetadata.get(parentSignal) : void 0;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw deadlineError(parentDeadline?.message ?? message);
  const now = performance2.now();
  if (absoluteDeadline !== void 0 && !Number.isFinite(absoluteDeadline)) throw deadlineError(message);
  const requestedDeadline = Math.min(now + timeoutMs, absoluteDeadline ?? Infinity);
  const inherited = parentDeadline && parentDeadline.deadline <= requestedDeadline ? parentDeadline : void 0;
  const deadline = inherited?.deadline ?? requestedDeadline;
  const deadlineMessage = inherited?.message ?? message;
  const remaining = deadline - now;
  if (remaining < 1) throw deadlineError(deadlineMessage);
  const controller = new AbortController();
  const onParentAbort = () => controller.abort(parentSignal ? signalError(parentSignal) : deadlineError(message));
  if (parentSignal?.aborted) onParentAbort();
  else parentSignal?.addEventListener("abort", onParentAbort, { once: true });
  deadlineMetadata.set(controller.signal, {
    deadline,
    message: deadlineMessage,
    enforceDeadline: absoluteDeadline !== void 0 || parentDeadline?.enforceDeadline === true
  });
  const timer = setTimeout(() => controller.abort(deadlineError(deadlineMessage)), remaining);
  let removeAbortListener = () => {
  };
  try {
    throwIfAborted(controller.signal);
    const aborted = new Promise((_resolve, reject) => {
      const onAbort = () => reject(signalError(controller.signal));
      controller.signal.addEventListener("abort", onAbort, { once: true });
      removeAbortListener = () => controller.signal.removeEventListener("abort", onAbort);
    });
    return await Promise.race([work(controller.signal, deadline), aborted]);
  } finally {
    removeAbortListener();
    clearTimeout(timer);
    parentSignal?.removeEventListener("abort", onParentAbort);
  }
}
function sessionMessageBrokerEnvironment(environment = process.env) {
  const sanitized = { ...environment };
  delete sanitized.CLAUDE_CODE_MESSAGING_SOCKET;
  delete sanitized.CLAUDE_CODE_MESSAGING_TOKEN;
  return sanitized;
}
async function readEndpoint(stateDirectory, signal) {
  throwIfAborted(signal);
  const paths = statePaths(stateDirectory);
  let rawEndpoint;
  let rawToken;
  let certificate;
  try {
    [rawEndpoint, rawToken, certificate] = await Promise.all([
      readFile(paths.endpoint, { encoding: "utf8", signal }),
      readFile(paths.token, { encoding: "utf8", signal }),
      readFile(paths.certificate, { encoding: "utf8", signal })
    ]);
  } catch (cause) {
    throwIfAborted(signal);
    throw clientFailure("BROKER_ENDPOINT_READ_FAILED", "Cannot read the session message broker endpoint.", cause);
  }
  let endpoint;
  try {
    endpoint = JSON.parse(rawEndpoint);
    if (endpoint.protocolVersion !== SESSION_MESSAGE_PROTOCOL || endpoint.address !== "127.0.0.1" || !Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535 || !/^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/u.test(endpoint.certificateFingerprint256) || !/^[A-Za-z0-9_-]{43}$/u.test(rawToken.trim())) {
      throw new Error("The session message broker endpoint is invalid.");
    }
  } catch (cause) {
    throw clientFailure("BROKER_ENDPOINT_INVALID", "The session message broker endpoint is invalid.", cause);
  }
  return { endpoint, token: rawToken.trim(), certificate };
}
async function requestSessionMessageOnce(operation, payload, stateDirectory, timeoutMs = BROKER_REQUEST_TIMEOUT_MS, parentSignal, options = {}) {
  return withDeadline(Math.min(BROKER_REQUEST_TIMEOUT_MS, timeoutMs), parentSignal, "The session message broker timed out.", async (signal, deadline) => {
    const enforceDeadline = options.enforceDeadline === true || deadlineMetadata.get(signal)?.enforceDeadline === true;
    const { endpoint, token, certificate } = await readEndpoint(stateDirectory, signal);
    if (enforceDeadline) assertWithinDeadline(deadline, signal, "The session message broker timed out.");
    return new Promise((resolve, reject) => {
      let settled = false;
      const readLine = sessionMessageLineReader(SESSION_MESSAGE_MAX_RESPONSE_BYTES);
      const socket = tls.connect({
        host: endpoint.address,
        port: endpoint.port,
        ca: certificate,
        servername: "localhost",
        minVersion: "TLSv1.3",
        maxVersion: "TLSv1.3",
        rejectUnauthorized: true,
        checkServerIdentity: (_host, certificate2) => certificate2.fingerprint256 === endpoint.certificateFingerprint256 ? void 0 : tagProducerFailure(new Error("The session message broker certificate pin did not match."), "BROKER_CERTIFICATE_PIN_MISMATCH")
      });
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        socket.destroy();
        if (error) reject(error);
        else resolve(value);
      };
      const onAbort = () => finish(signalError(signal));
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) return onAbort();
      let writeObserved = false;
      socket.once("secureConnect", () => {
        if (settled) return;
        try {
          if (enforceDeadline) assertWithinDeadline(deadline, signal, "The session message broker timed out.");
          const peer = socket.getPeerCertificate();
          if (!peer.fingerprint256 || peer.fingerprint256 !== endpoint.certificateFingerprint256) {
            finish(tagProducerFailure(new Error("The session message broker certificate pin did not match."), "BROKER_CERTIFICATE_PIN_MISMATCH"));
            return;
          }
          let frame;
          try {
            frame = "".concat(JSON.stringify({
              protocolVersion: SESSION_MESSAGE_PROTOCOL,
              token,
              operation,
              payload,
              ...["ensure-relay", "acquire-relay"].includes(operation) ? { identityDeadlineNs: encodeIdentityDeadline(deadline) } : {}
            }), "\n");
          } catch (cause) {
            throw clientFailure("BROKER_REQUEST_ENCODING_FAILED", "Cannot encode the broker request.", cause);
          }
          if (enforceDeadline) assertWithinDeadline(deadline, signal, "The session message broker timed out.");
          try {
            socket.write(frame);
          } catch (cause) {
            throw clientFailure("BROKER_WRITE_FAILED", "The broker write failed.", cause);
          } finally {
            if (!writeObserved) {
              writeObserved = true;
              try {
                Promise.resolve(options.onOperationWrite?.()).catch(() => {
                });
              } catch {
              }
            }
          }
        } catch (error) {
          finish(clientFailure("BROKER_REQUEST_PREPARATION_FAILED", "The broker request preparation failed.", error));
        }
      });
      socket.on("data", (chunk) => {
        if (settled) return;
        let line;
        try {
          line = readLine(chunk);
        } catch (cause) {
          return finish(retainFailureCause(tagProducerFailure(new Error("The broker response exceeded its limit."), "BROKER_RESPONSE_TOO_LARGE"), cause));
        }
        if (line === null) return;
        try {
          const response = JSON.parse(line);
          if (!response.ok) finish(new BrokerRequestRejected(response.error || "The broker rejected the request.", response.details));
          else {
            if (enforceDeadline) assertWithinDeadline(deadline, signal, "The session message broker timed out.");
            finish(void 0, response.data);
          }
        } catch (error) {
          const failure = enforceDeadline && error instanceof Error ? error : new Error("The broker returned invalid JSON.");
          finish(producerFailureReason(failure) ? failure : failure === error ? tagProducerFailure(failure, "BROKER_RESPONSE_INVALID_JSON") : retainFailureCause(tagProducerFailure(failure, "BROKER_RESPONSE_INVALID_JSON"), error));
        }
      });
      socket.once("error", (error) => finish(tagProducerFailure(error, "BROKER_TRANSPORT_FAILED")));
      if (enforceDeadline) {
        const onClosed = () => finish(tagProducerFailure(new Error("The broker connection closed before a complete response."), "BROKER_RESPONSE_INCOMPLETE"));
        socket.once("end", onClosed);
        socket.once("close", onClosed);
      }
    });
  });
}
async function delay(milliseconds, signal) {
  throwIfAborted(signal);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(finish, milliseconds);
    const onAbort = () => finish(signalError(signal));
    function finish(error) {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve();
    }
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}
async function waitForSessionMessageBrokerReady(stateDirectory, child, timeoutMs = BROKER_STARTUP_TIMEOUT_MS, parentSignal, startupDiagnostic) {
  let diagnostic = "";
  let diagnosticOverflow = false;
  let diagnosticDone = !startupDiagnostic;
  let diagnosticEnded = false;
  let diagnosticFailed = false;
  const onDiagnosticData = (chunk) => {
    if (diagnosticOverflow) return;
    if (Buffer.byteLength(diagnostic, "utf8") + chunk.length > 128) {
      diagnostic = "";
      diagnosticOverflow = true;
      return;
    }
    diagnostic += chunk.toString("utf8");
  };
  const onDiagnosticEnd = () => {
    diagnosticEnded = true;
    diagnosticDone = true;
  };
  const onDiagnosticClose = () => {
    diagnosticDone = true;
  };
  const onDiagnosticError = () => {
    diagnosticFailed = true;
    diagnosticDone = true;
  };
  startupDiagnostic?.on("data", onDiagnosticData);
  startupDiagnostic?.once("end", onDiagnosticEnd);
  startupDiagnostic?.once("close", onDiagnosticClose);
  startupDiagnostic?.once("error", onDiagnosticError);
  let probeFailed = false;
  let lastProbeFailure;
  try {
    return await withDeadline(timeoutMs, parentSignal, BROKER_STARTUP_DEADLINE_MESSAGE, async (signal, deadline) => {
      let spawnError = null;
      const onError = (error) => {
        spawnError = tagProducerFailure(error, "BROKER_START_FAILED");
      };
      child.once("error", onError);
      const retainLastProbe = () => {
        if (probeFailed) retainFailureSecondary(signal.reason, lastProbeFailure);
      };
      signal.addEventListener("abort", retainLastProbe, { once: true });
      try {
        while (true) {
          throwIfAborted(signal);
          if (spawnError) throw spawnError;
          if (child.exitCode !== null && child.exitCode !== 0 || child.signalCode !== null) {
            if (startupDiagnostic && !diagnosticDone) await new Promise((resolve) => {
              const done = () => {
                startupDiagnostic.off("end", done);
                startupDiagnostic.off("close", done);
                startupDiagnostic.off("error", done);
                signal.removeEventListener("abort", done);
                resolve();
              };
              startupDiagnostic.once("end", done);
              startupDiagnostic.once("close", done);
              startupDiagnostic.once("error", done);
              signal.addEventListener("abort", done, { once: true });
              if (diagnosticDone || signal.aborted) done();
            });
            throwIfAborted(signal);
            const frame = diagnosticEnded && !diagnosticFailed && !diagnosticOverflow ? /^([A-Z0-9_]+)\n$/u.exec(diagnostic) : null;
            const code = brokerStartupCode(frame?.[1]);
            throw tagProducerFailure(new Error(
              "The session message broker exited before it was ready (code ".concat(String(child.exitCode), ", signal ").concat(String(child.signalCode), ")").concat(code ? "; startup diagnostic: ".concat(code) : "", ".")
            ), "BROKER_EXITED_BEFORE_READY");
          }
          await delay(Math.min(100, remainingMilliseconds(deadline, signal, BROKER_STARTUP_DEADLINE_MESSAGE)), signal);
          try {
            await requestSessionMessageOnce(
              "ping",
              {},
              stateDirectory,
              remainingMilliseconds(deadline, signal, BROKER_STARTUP_DEADLINE_MESSAGE),
              signal
            );
            if (child.pid !== void 0 && child.exitCode === null) {
              const { endpoint } = await readEndpoint(stateDirectory, signal);
              if (!Number.isSafeInteger(endpoint.pid) || endpoint.pid < 1 || endpoint.pid !== child.pid) continue;
            }
            if (spawnError || child.signalCode !== null || child.exitCode !== null && child.exitCode !== 0) continue;
            return;
          } catch (error) {
            if (!signal.aborted) {
              probeFailed = true;
              lastProbeFailure = error;
            }
            throwIfAborted(signal);
            if (error instanceof BrokerRequestRejected) throw error;
          }
        }
      } finally {
        signal.removeEventListener("abort", retainLastProbe);
        child.off("error", onError);
      }
    });
  } catch (error) {
    if (probeFailed) retainFailureSecondary(error, lastProbeFailure);
    throw error;
  } finally {
    startupDiagnostic?.off("data", onDiagnosticData);
    startupDiagnostic?.off("end", onDiagnosticEnd);
    startupDiagnostic?.off("close", onDiagnosticClose);
    startupDiagnostic?.off("error", onDiagnosticError);
    startupDiagnostic?.destroy();
  }
}
async function ensureSessionMessageBroker(stateDirectory = resolveSessionMessageStateDirectory(), timeoutMs = BROKER_STARTUP_TIMEOUT_MS, parentSignal, prepareStateDirectory) {
  return withDeadline(Math.min(BROKER_STARTUP_TIMEOUT_MS, timeoutMs), parentSignal, BROKER_STARTUP_DEADLINE_MESSAGE, async (signal, deadline) => {
    try {
      await requestSessionMessageOnce(
        "ping",
        {},
        stateDirectory,
        remainingMilliseconds(deadline, signal, BROKER_STARTUP_DEADLINE_MESSAGE),
        signal
      );
      return;
    } catch (error) {
      const retainInitialFailure = () => {
        retainFailureSecondary(signal.reason, error);
      };
      signal.addEventListener("abort", retainInitialFailure, { once: true });
      try {
        throwIfAborted(signal);
        if (error instanceof BrokerRequestRejected) throw error;
        if (deadlineMetadata.get(signal)?.enforceDeadline) assertWithinDeadline(deadline, signal, BROKER_STARTUP_DEADLINE_MESSAGE);
        try {
          if (prepareStateDirectory) await prepareStateDirectory(stateDirectory);
          else await mkdir(stateDirectory, { recursive: true, mode: 448 });
        } catch (cause) {
          throw clientFailure("BROKER_STATE_DIRECTORY_FAILED", "Cannot prepare the session message state directory.", cause);
        }
        if (!prepareStateDirectory) {
          if (deadlineMetadata.get(signal)?.enforceDeadline) assertWithinDeadline(deadline, signal, BROKER_STARTUP_DEADLINE_MESSAGE);
          try {
            await chmod(stateDirectory, 448);
          } catch {
          }
        }
        throwIfAborted(signal);
        assertWithinDeadline(deadline, signal, BROKER_STARTUP_DEADLINE_MESSAGE);
        const adjacentBroker = fileURLToPath2(new URL("./session-message-broker.mjs", import.meta.url));
        const brokerPath = existsSync(adjacentBroker) ? adjacentBroker : fileURLToPath2(new URL("../dist/session-message-broker.mjs", import.meta.url));
        if (deadlineMetadata.get(signal)?.enforceDeadline) assertWithinDeadline(deadline, signal, BROKER_STARTUP_DEADLINE_MESSAGE);
        let child;
        try {
          child = spawn(process.execPath, [
            brokerPath,
            "--state-directory",
            stateDirectory,
            "--startup-identity-deadline-ns",
            encodeIdentityDeadline(deadline),
            "--startup-diagnostic"
          ], {
            detached: true,
            windowsHide: true,
            stdio: ["ignore", "ignore", "ignore", "pipe"],
            env: sessionMessageBrokerEnvironment()
          });
        } catch (cause) {
          throw clientFailure("BROKER_START_FAILED", "Cannot start the session message broker.", cause);
        }
        child.unref();
        const diagnostic = child.stdio[3];
        try {
          await waitForSessionMessageBrokerReady(
            stateDirectory,
            child,
            remainingMilliseconds(deadline, signal, BROKER_STARTUP_DEADLINE_MESSAGE),
            signal,
            diagnostic
          );
        } finally {
          diagnostic?.destroy();
        }
      } catch (recoveryError) {
        throw retainFailureSecondary(recoveryError, error);
      } finally {
        signal.removeEventListener("abort", retainInitialFailure);
      }
    }
  });
}
async function sessionMessageRequest(operation, payload, stateDirectory = resolveSessionMessageStateDirectory(), options = {}) {
  options = { ...options };
  const totalTimeoutMs = options.totalTimeoutMs ?? SESSION_MESSAGE_REQUEST_TIMEOUT_MS;
  const absoluteDeadline = options.deadlineMonotonicMs ?? (options.noOperationReplay ? performance2.now() + totalTimeoutMs : void 0);
  return withDeadline(totalTimeoutMs, void 0, SESSION_MESSAGE_REQUEST_DEADLINE_MESSAGE, async (signal, deadline) => {
    if (options.noOperationReplay) {
      await ensureSessionMessageBroker(stateDirectory, remainingMilliseconds(deadline, signal), signal, options.prepareStateDirectory);
      assertWithinDeadline(deadline, signal, SESSION_MESSAGE_REQUEST_DEADLINE_MESSAGE);
      return requestSessionMessageOnce(
        operation,
        payload,
        stateDirectory,
        remainingMilliseconds(deadline, signal),
        signal,
        { enforceDeadline: true, ...options.onOperationWrite ? { onOperationWrite: options.onOperationWrite } : {} }
      );
    }
    let operationWriteAttempted = false;
    const onOperationWrite = () => {
      operationWriteAttempted = true;
      return options.onOperationWrite?.();
    };
    try {
      return await requestSessionMessageOnce(
        operation,
        payload,
        stateDirectory,
        remainingMilliseconds(deadline, signal),
        signal,
        { enforceDeadline: options.deadlineMonotonicMs !== void 0, onOperationWrite }
      );
    } catch (error) {
      try {
        throwIfAborted(signal);
        if (error instanceof BrokerRequestRejected || operationWriteAttempted && operation !== "send") throw error;
        await ensureSessionMessageBroker(
          stateDirectory,
          remainingMilliseconds(deadline, signal),
          signal,
          options.prepareStateDirectory
        );
        throwIfAborted(signal);
        return await requestSessionMessageOnce(
          operation,
          payload,
          stateDirectory,
          remainingMilliseconds(deadline, signal),
          signal,
          { enforceDeadline: options.deadlineMonotonicMs !== void 0, onOperationWrite }
        );
      } catch (recoveryError) {
        throw retainFailureSecondary(recoveryError, error);
      }
    }
  }, absoluteDeadline);
}
function parseWakeMessages(value) {
  if (typeof value !== "string") return { nonces: [], wakeOnly: false };
  const lines = value.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  const nonces = [];
  let wakeOnly = lines.length > 0;
  for (const line of lines) {
    if (!line.startsWith(WAKE_PREFIX) || !line.endsWith("]")) {
      wakeOnly = false;
      continue;
    }
    const nonce = line.slice(WAKE_PREFIX.length, -1);
    if (!/^[A-Za-z0-9_-]{22,128}$/u.test(nonce)) {
      wakeOnly = false;
      continue;
    }
    nonces.push(nonce);
  }
  return { nonces: [...new Set(nonces)], wakeOnly };
}

// mcp-server/src/peer-wait-policy.ts
function identityKey(identity) {
  return JSON.stringify([identity.host, identity.sessionId]);
}
function normalizePeerWaitTargets(targets) {
  const unique = new Map(targets.map((target) => [identityKey(target), { host: target.host, sessionId: target.sessionId }]));
  return [...unique.keys()].sort().map((key) => unique.get(key));
}

// mcp-server/src/session-message-wake-port.ts
import { execFile } from "node:child_process";
import { existsSync as existsSync2 } from "node:fs";
import net from "node:net";
import path4 from "node:path";

// mcp-server/src/trust-store.ts
import { DatabaseSync } from "node:sqlite";

// mcp-server/src/workspace-identity.ts
var SEGMENT_SEPARATOR = process.platform === "win32" ? /[\\/]/u : /\//u;

// mcp-server/src/session-message-wake-port.ts
function codexWakeOutcome(error, spawned) {
  return !error ? "submitted" : spawned ? "accepted-or-unknown" : "definite-failure";
}
function claudeWakeOutcome(hadError, connected, wrote) {
  return !hadError && wrote ? "submitted" : connected || wrote ? "accepted-or-unknown" : "definite-failure";
}
function geminiWakeOutcome(error, spawned) {
  return !error ? "submitted" : spawned ? "accepted-or-unknown" : "definite-failure";
}
function resolveGeminiAgentApi(environment = process.env, platform = process.platform) {
  const configured = environment.ANTIGRAVITY_AGENTAPI_EXE;
  if (configured) {
    if (platform === "win32") {
      const root = path4.win32.parse(configured).root;
      if (!path4.win32.isAbsolute(configured) || root === "\\" || root === "/" || path4.win32.extname(configured).toLowerCase() !== ".exe") return null;
    }
    return { command: configured, argsPrefix: ["agentapi"] };
  }
  if (platform === "win32") return null;
  const homeDir = environment.USERPROFILE || environment.HOME || "";
  const command = path4.join(homeDir, ".gemini", "antigravity", "bin", "agentapi");
  return { command: existsSync2(command) ? command : "agentapi", argsPrefix: [] };
}
function reportWakeFailure(phase, error) {
  console.error("agent-governance-suite wake diagnostic ".concat(JSON.stringify({ phase, reason: producerFailureReason(error), context: failureContext(error) })));
}
async function ringGemini(sessionId, message, environment = process.env) {
  const childEnv = { ...environment };
  const sourceProjectId = childEnv.ANTIGRAVITY_PROJECT_ID;
  if (typeof sourceProjectId !== "string" || !sourceProjectId.trim()) return "definite-failure";
  const launch = resolveGeminiAgentApi(childEnv);
  if (!launch) return "definite-failure";
  const { command, argsPrefix } = launch;
  let targetProjectId;
  try {
    const meta = await new Promise((resolve, reject) => {
      execFile(
        command,
        [...argsPrefix, "get-conversation-metadata", sessionId],
        { windowsHide: true, timeout: 5e3, env: childEnv, shell: false, windowsVerbatimArguments: false },
        (error, stdout) => error ? reject(error) : resolve(stdout)
      );
    });
    const parsed = JSON.parse(meta);
    const projectId = parsed.response?.conversationMetadata?.metadata?.projectId;
    if (typeof projectId !== "string" || !projectId.trim()) {
      throw producerFailure("GEMINI_METADATA_PROJECT_MISSING", "Gemini conversation metadata has no project identity.");
    }
    targetProjectId = projectId;
  } catch (cause) {
    const error = producerFailureReason(cause) ? cause : retainFailureCause(producerFailure("GEMINI_METADATA_FAILED", "Gemini conversation metadata lookup failed."), cause);
    reportWakeFailure("gemini-metadata", error);
    return "definite-failure";
  }
  if (sourceProjectId !== targetProjectId) return "definite-failure";
  return new Promise((resolve) => {
    let spawned = false;
    try {
      const child = execFile(
        command,
        [...argsPrefix, "send-message", sessionId, message],
        { windowsHide: true, timeout: 1e4, env: childEnv, shell: false, windowsVerbatimArguments: false },
        (error) => resolve(geminiWakeOutcome(error, spawned))
      );
      child.once("spawn", () => {
        spawned = true;
      });
      child.once("error", (error) => resolve(geminiWakeOutcome(error, spawned)));
    } catch {
      resolve("definite-failure");
    }
  });
}
function ringCodex(sessionId, message) {
  return new Promise((resolve) => {
    let spawned = false;
    const child = execFile(
      "codex",
      ["queue", "--thread", sessionId, "--message", message],
      { windowsHide: true, timeout: 1e4 },
      (error) => resolve(codexWakeOutcome(error, spawned))
    );
    child.once("spawn", () => {
      spawned = true;
    });
  });
}
async function ringClaude(message) {
  const socketPath = process.env.CLAUDE_CODE_MESSAGING_SOCKET;
  const token = process.env.CLAUDE_CODE_MESSAGING_TOKEN;
  if (!socketPath || !token) return "definite-failure";
  return new Promise((resolve) => {
    let settled = false;
    let connected = false;
    let wrote = false;
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };
    const socket = net.createConnection(socketPath);
    socket.setTimeout(5e3, () => socket.destroy(new Error("Claude inbox timed out.")));
    socket.once("connect", () => {
      connected = true;
      try {
        wrote = true;
        socket.end("".concat(JSON.stringify({ type: "auth", token }), "\n").concat(JSON.stringify({ type: "user", message: { role: "user", content: message }, priority: "next" }), "\n"));
      } catch {
        finish("accepted-or-unknown");
      }
    });
    socket.once("close", (hadError) => finish(claudeWakeOutcome(hadError, connected, wrote)));
    socket.once("error", () => finish(claudeWakeOutcome(true, connected, wrote)));
  });
}
var ports = /* @__PURE__ */ new Map([
  ["claude-inbox", {
    capabilities: { supportedInjection: ["peer-wake", "tool-boundary", "turn-end"], idleWake: "silent" },
    dispatch: (_target, message) => ringClaude(message)
  }],
  ["codex-queue", {
    capabilities: { supportedInjection: ["peer-wake", "tool-boundary"], idleWake: "user-message" },
    dispatch: (target, message) => ringCodex(target.sessionId, message)
  }],
  ["codex-deferred", {
    capabilities: { supportedInjection: ["tool-boundary"], idleWake: "none" },
    dispatch: async () => "definite-failure"
  }],
  ["gemini-queue", {
    capabilities: { supportedInjection: ["peer-wake", "tool-boundary"], idleWake: "user-message" },
    dispatch: (target, message) => ringGemini(target.sessionId, message)
  }]
]);
function transportWakePort(transport) {
  const port = ports.get(transport);
  if (!port) throw new Error("Wake transport adapter is unavailable.");
  return port;
}
function transportDeliveryCapabilities(transport) {
  const capabilities = transportWakePort(transport).capabilities;
  return { supportedInjection: [...capabilities.supportedInjection], idleWake: capabilities.idleWake };
}

// mcp-server/src/session-message-relay.ts
var IDENTITY_RECHECK_MS = 10 * 6e4;

// mcp-server/src/builtin-hook-host-adapters.ts
function text(value) {
  return typeof value === "string" ? value : "";
}
function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function adaptBuiltinHookInput(input, host, actor) {
  const event = text(input.hook_event_name);
  let kind = "unknown";
  let lifecycle = "none";
  let continuityAction;
  let boundaryPhase;
  if (event === "SessionStart") {
    lifecycle = "start";
    const source = input.source;
    if (source === "startup" || source === "clear" || source === "resume" || source === "compact") continuityAction = { kind: source };
  } else if (event === "SessionEnd") {
    kind = "turn-end";
    lifecycle = "end";
  } else if (event === "UserPromptSubmit") kind = "user-input";
  else if (event === "PreToolUse") {
    kind = "tool-boundary";
    boundaryPhase = "before";
  } else if (event === "PostToolUse") {
    kind = "tool-boundary";
    boundaryPhase = "after";
  } else if (event === "Stop") kind = "turn-end";
  if (event === "PreCompact") continuityAction = { kind: "pre-compact" };
  else if (event === "PostCompact") {
    const turnId = input.turn_id, error = input.error;
    continuityAction = { kind: "post-compact", turnId: typeof turnId === "string" ? turnId : null, successful: error === void 0 || error === null };
  }
  const wake = kind === "user-input" ? parseWakeMessages(input.prompt) : { nonces: [], wakeOnly: false };
  const workspaceId = text(input.workspace_id) || text(input.cwd);
  const callId = text(input.tool_use_id).trim();
  const collaborationId = text(input.collaboration_id);
  const role = text(input.role);
  return {
    lifecycle,
    outputEventName: event,
    ...continuityAction ? { continuityAction } : {},
    observation: {
      host,
      sessionId: text(input.session_id),
      kind,
      actor,
      ...callId ? { callId } : {},
      ...boundaryPhase === void 0 ? {} : { boundaryPhase },
      ...kind === "tool-boundary" ? { toolName: text(input.tool_name), toolInput: record(input.tool_input) } : {},
      ...kind === "user-input" ? { wakeCandidates: wake.nonces, wakeOnly: wake.wakeOnly } : {},
      ...workspaceId ? { workspaceId } : {},
      ...collaborationId ? { collaborationId } : {},
      ...role ? { role } : {}
    }
  };
}
function adaptCodexHookInput(input, host) {
  return adaptBuiltinHookInput(input, host, {
    role: "indeterminate",
    basis: "unavailable",
    reasonCode: "CODEX_NATIVE_CAPTURE_REQUIRED"
  });
}
function adaptClaudeHookInput(input, host) {
  const actor = {
    role: "indeterminate",
    basis: "unavailable",
    reasonCode: "CLAUDE_NATIVE_EVENT_UNRECOGNIZED"
  };
  const adapted = adaptBuiltinHookInput(input, host, actor);
  const knownEvent = adapted.lifecycle !== "none" || adapted.observation.kind !== "unknown";
  if (!knownEvent) return adapted;
  if (!adapted.observation.sessionId.trim()) actor.reasonCode = "CLAUDE_NATIVE_SESSION_ID_INVALID";
  else if (Object.hasOwn(input, "agent_type") && (typeof input.agent_type !== "string" || !input.agent_type.trim())) {
    actor.reasonCode = "CLAUDE_NATIVE_AGENT_TYPE_INVALID";
  } else if (Object.hasOwn(input, "agent_id")) {
    if (typeof input.agent_id !== "string" || !input.agent_id.trim()) actor.reasonCode = "CLAUDE_NATIVE_AGENT_ID_INVALID";
    else Object.assign(actor, { role: "child", basis: "observed", reasonCode: "CLAUDE_NATIVE_CHILD_AGENT_ID" });
  } else Object.assign(actor, { role: "root", basis: "inferred", reasonCode: "CLAUDE_NATIVE_ROOT_AGENT_ID_ABSENT" });
  return adapted;
}
function adaptGeminiHookInput(input, host) {
  return adaptBuiltinHookInput(input, host, {
    role: "indeterminate",
    basis: "unavailable",
    reasonCode: "GEMINI_ACTOR_OBSERVATION_UNSUPPORTED"
  });
}
function adaptAntigravityHookInput(input, host) {
  return adaptBuiltinHookInput(input, host, {
    role: "indeterminate",
    basis: "unavailable",
    reasonCode: "ANTIGRAVITY_ACTOR_OBSERVATION_UNSUPPORTED"
  });
}
var GOVERNANCE_TOOL_PREFIXES = /* @__PURE__ */ new Set([
  "mcp__agent_governance_suite__",
  "mcp__agent-governance-suite__",
  "mcp__plugin_agent-governance-suite_agent-governance-suite__"
]);
function ownsGovernanceTool(toolName) {
  const separator = toolName.lastIndexOf("__");
  return separator > 0 && GOVERNANCE_TOOL_PREFIXES.has(toolName.slice(0, separator + 2));
}
function queueEnabled(host, explicit, environment, diagnose, defaultEnabled = false) {
  const disabled = (reason, observation) => {
    if (observation) diagnose(reason, Object.freeze(observation));
    else diagnose(reason);
    return false;
  };
  const failed = (phase, cause) => retainFailureCause(
    producerFailure(
      phase === "directory-stat" ? "QUEUE_SETTINGS_DIRECTORY_STAT_FAILED" : phase === "open" ? "QUEUE_SETTINGS_OPEN_FAILED" : phase === "read" ? "QUEUE_SETTINGS_READ_FAILED" : "QUEUE_SETTINGS_CLOSE_FAILED",
      "Queue settings I/O failed."
    ),
    cause
  );
  const absent = (error) => {
    if (!error || typeof error !== "object" || utilTypes3.isProxy(error)) return false;
    try {
      return Object.getOwnPropertyDescriptor(error, "code")?.value === "ENOENT";
    } catch {
      return false;
    }
  };
  if (explicit !== void 0) {
    if (explicit === "1") return true;
    return explicit === "0" ? false : disabled("invalid-environment");
  }
  const directory = environment.PLUGIN_DATA;
  if (directory === void 0) return defaultEnabled;
  if (!path5.isAbsolute(directory) || process.platform === "win32" && ["\\", "/"].includes(path5.parse(directory).root)) {
    return disabled("invalid-plugin-data");
  }
  let descriptor = -1;
  let validDirectory;
  let acquisitionPhase = "directory-stat";
  try {
    validDirectory = statSync(directory).isDirectory();
    if (validDirectory) {
      acquisitionPhase = "open";
      descriptor = openSync(path5.join(directory, "session-messaging.json"), constants.O_RDONLY | constants.O_NONBLOCK);
    }
  } catch (cause) {
    return absent(cause) ? defaultEnabled : disabled("read-failed", { phase: acquisitionPhase, cleanup: "not-acquired", failure: failed(acquisitionPhase, cause) });
  }
  if (!validDirectory) return disabled("invalid-plugin-data");
  let enabled = false;
  let issue;
  let primary;
  let primaryPhase = "read";
  let missingRead = false;
  let closeFailed = false;
  const rejected = (reason) => {
    issue = reason;
    return false;
  };
  try {
    enabled = (() => {
      const stat = fstatSync(descriptor);
      if (!stat.isFile()) return rejected("invalid-file-type");
      if (stat.size > 4096) return rejected("too-large");
      const bytes = Buffer.alloc(4097);
      let length = 0;
      while (length < bytes.length) {
        const count = readSync(descriptor, bytes, length, bytes.length - length, null);
        if (count === 0) break;
        length += count;
      }
      if (length > 4096) return rejected("too-large");
      let settings;
      try {
        settings = record(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length))));
      } catch {
        return rejected("invalid-settings");
      }
      const hostSettings = record(settings[host]);
      if (settings.schemaVersion !== "1.0.0" || typeof hostSettings.queueWake !== "boolean") return rejected("invalid-settings");
      return hostSettings.queueWake;
    })();
  } catch (cause) {
    missingRead = absent(cause);
    primary = failed("read", cause);
  } finally {
    try {
      closeSync(descriptor);
    } catch (cause) {
      closeFailed = true;
      const closeFailure = failed("close", cause);
      if (primary) retainFailureSecondary(primary, closeFailure);
      else {
        primary = closeFailure;
        primaryPhase = "close";
      }
    }
  }
  if (missingRead && !closeFailed) return defaultEnabled;
  if (primary) return disabled(
    issue ?? (primaryPhase === "close" ? "close-failed" : "read-failed"),
    { phase: primaryPhase, cleanup: closeFailed ? "unknown" : "closed", failure: primary }
  );
  return issue === void 0 ? enabled : disabled(issue);
}
function codexQueueEnabled(environment, diagnose) {
  return queueEnabled("codex", environment.AGENT_GOVERNANCE_CODEX_QUEUE_WAKE, environment, diagnose);
}
function geminiQueueEnabled(environment, diagnose, defaultQueueWake) {
  const defaultEnabled = defaultQueueWake === true || Boolean(environment.ANTIGRAVITY_AGENTAPI_EXE || environment.ANTIGRAVITY_CONVERSATION_ID || environment.ANTIGRAVITY_AGENT);
  return queueEnabled("gemini", environment.AGENT_GOVERNANCE_GEMINI_QUEUE_WAKE, environment, diagnose, defaultEnabled);
}
var builtinHookHostAdapters = /* @__PURE__ */ new Map([
  ["codex", {
    adaptInput: adaptCodexHookInput,
    ownsTool: ownsGovernanceTool,
    deliveryProfile: (environment, diagnose) => deliveryProfile(codexQueueEnabled(environment, diagnose) ? "codex-queue" : "codex-deferred", true),
    processPid: (pid) => pid,
    attestationKind: "codex-rollout",
    peerWait: codexNativePeerWait
  }],
  ["claude-code", {
    adaptInput: adaptClaudeHookInput,
    ownsTool: ownsGovernanceTool,
    deliveryProfile: () => deliveryProfile("claude-inbox", false),
    processPid: () => process.ppid,
    attestationKind: "claude-hook"
  }],
  ["gemini", {
    adaptInput: adaptGeminiHookInput,
    ownsTool: ownsGovernanceTool,
    deliveryProfile: (environment, diagnose, defaultQueueWake) => deliveryProfile(geminiQueueEnabled(environment, diagnose, defaultQueueWake) ? "gemini-queue" : "codex-deferred", false),
    processPid: (pid, observation) => observation ? pid : void 0
  }],
  ["antigravity", {
    adaptInput: adaptAntigravityHookInput,
    ownsTool: ownsGovernanceTool,
    deliveryProfile: (environment, diagnose, defaultQueueWake) => deliveryProfile(geminiQueueEnabled(environment, diagnose, defaultQueueWake) ? "gemini-queue" : "codex-deferred", false),
    processPid: (pid, observation) => observation ? pid : void 0
  }]
]);
function deliveryProfile(transport, blocksEmptyWakePrompt) {
  return { transport, capabilities: transportDeliveryCapabilities(transport), blocksEmptyWakePrompt };
}
function codexNativePeerWait(observation) {
  if (observation.toolName !== "mcp__codex_app__wait_threads") return null;
  const input = observation.toolInput ?? {};
  const timeoutMs = input.timeoutMs === void 0 ? 12e4 : input.timeoutMs;
  if (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 36e5) return null;
  if (!Array.isArray(input.targets) || input.targets.length < 1 || input.targets.length > 8) return null;
  const targets = [];
  const cursors = /* @__PURE__ */ new Set();
  for (const value of input.targets) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const target = value;
    if (typeof target.threadId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(target.threadId)) return null;
    if (target.hostId !== void 0 && target.hostId !== "local") return null;
    if (target.afterCursor !== void 0 && typeof target.afterCursor !== "string") return null;
    targets.push({ host: "codex", sessionId: target.threadId });
    cursors.add(JSON.stringify([target.threadId, target.afterCursor ?? null]));
  }
  return {
    targets: normalizePeerWaitTargets(targets),
    timeoutMs,
    queryRevision: createHash2("sha256").update(JSON.stringify([...cursors].sort())).digest("hex")
  };
}
for (const [host, adapter] of builtinHookHostAdapters) registerHookHostAdapter(host, adapter);

// mcp-server/src/session-board-hook.ts
import { readFileSync } from "node:fs";

// skills/session-board/scripts/board-store.mjs
import { mkdirSync } from "node:fs";
import path6 from "node:path";
import { DatabaseSync as DatabaseSync2 } from "node:sqlite";
var SUMMARY_MAX_LENGTH = 200;
var RETAIN_MS = 24 * 36e5;
function openBoard(input, { busyTimeoutMs = 5e3 } = {}) {
  const shared = typeof input === "string" ? null : input;
  const databasePath = shared ? shared.databasePath : input;
  if (!shared && databasePath !== ":memory:") mkdirSync(path6.dirname(path6.resolve(databasePath)), { recursive: true });
  const db = shared ? shared.database : new DatabaseSync2(databasePath);
  const initialize = () => {
    try {
      if (!shared) db.exec("PRAGMA busy_timeout = ".concat(Math.trunc(busyTimeoutMs), ";"));
      if (!shared && databasePath !== ":memory:") db.exec("PRAGMA journal_mode = WAL;");
      db.exec("CREATE TABLE IF NOT EXISTS sessions (\n      host TEXT NOT NULL,\n      session_id TEXT NOT NULL,\n      cwd TEXT NOT NULL,\n      summary TEXT,\n      summary_at TEXT,\n      last_prompt_at TEXT,\n      denied_for TEXT,\n      started_at TEXT NOT NULL,\n      updated_at TEXT NOT NULL,\n      PRIMARY KEY (host, session_id)\n    ) STRICT;");
    } catch (error) {
      db.close();
      throw error;
    }
    if (shared) shared.setSchemaVersion(0);
  };
  if (shared) shared.initialize(initialize);
  else initialize();
  return db;
}
function touchSession(db, { host, sessionId, cwd, now }) {
  if (db.transaction && !db.inTransaction) return db.transaction(() => touchSession(db, { host, sessionId, cwd, now }));
  db.prepare("INSERT INTO sessions (host, session_id, cwd, started_at, updated_at) VALUES (?, ?, ?, ?, ?)\n    ON CONFLICT (host, session_id) DO UPDATE SET cwd = excluded.cwd, updated_at = excluded.updated_at").run(host, sessionId, cwd, now, now);
}
function recordPrompt(db, session) {
  if (db.transaction && !db.inTransaction) return db.transaction(() => recordPrompt(db, session));
  touchSession(db, session);
  db.prepare("UPDATE sessions SET last_prompt_at = ? WHERE host = ? AND session_id = ?").run(session.now, session.host, session.sessionId);
}
function normalizeSummary(value) {
  if (typeof value !== "string") return null;
  const line = value.trim();
  return line && !/[\r\n]/u.test(line) && line.length <= SUMMARY_MAX_LENGTH ? line : null;
}
function setSummary(db, session, summary) {
  if (db.transaction && !db.inTransaction) return db.transaction(() => setSummary(db, session, summary));
  const line = normalizeSummary(summary);
  if (!line) throw new Error("summary must be one non-empty line of at most ".concat(SUMMARY_MAX_LENGTH, " characters"));
  touchSession(db, session);
  db.prepare("UPDATE sessions SET summary = ?, summary_at = ? WHERE host = ? AND session_id = ?").run(line, session.now, session.host, session.sessionId);
  return line;
}
function pruneSessions(db, now) {
  if (db.transaction && !db.inTransaction) return db.transaction(() => pruneSessions(db, now));
  db.prepare("DELETE FROM sessions WHERE updated_at < ?").run(new Date(Date.parse(now) - RETAIN_MS).toISOString());
}

// mcp-server/src/session-board-hook.ts
function reportBoardFailure(phase, cause) {
  try {
    console.error("[agent-governance-suite] board-hook-failure " + JSON.stringify({
      phase,
      reason: producerFailureReason(cause) ?? "UNEXPECTED_FAILURE",
      context: failureContext(cause)
    }));
  } catch {
  }
}
var BOARD_TOOLS = /* @__PURE__ */ new Set(["update_session_status", "list_session_status"]);
function preToolUse(permissionDecision, extra) {
  return { hookSpecificOutput: { hookEventName: "PreToolUse", ...permissionDecision ? { permissionDecision } : {}, ...extra } };
}
function handleSessionBoardHook(input, board, host, now = (/* @__PURE__ */ new Date()).toISOString(), verifiedInternalWake = false) {
  const adapted = adaptHostInput(input, host);
  const observation = adapted.observation;
  const sessionId = observation.sessionId;
  if (!sessionId) return {};
  const main = actorAccess(observation.actor).allowed;
  const toolName = observation.toolName ?? "";
  const toolInput = observation.toolInput ?? {};
  const localTool = toolName.split("__").at(-1) ?? "";
  const boardTool = observation.kind === "tool-boundary" && observation.boundaryPhase === "before" && isGovernanceHookTool(host, toolName) && BOARD_TOOLS.has(localTool);
  if (boardTool && !main) return preToolUse("deny", {
    permissionDecisionReason: "\uC138\uC158 \uD604\uD669\uD310 \uC870\uD68C\uC640 \uAC31\uC2E0\uC740 \uAD00\uCE21\uB41C \uBA54\uC778 \uC138\uC158\uB9CC \uC218\uD589\uD569\uB2C8\uB2E4."
  });
  if (!main || !board) return {};
  const session = { host, sessionId, cwd: observation.workspaceId || process.cwd(), now };
  if (adapted.lifecycle === "start") {
    pruneSessions(board, now);
    touchSession(board, session);
    return {};
  }
  if (observation.kind === "user-input") {
    pruneSessions(board, now);
    if (verifiedInternalWake) touchSession(board, session);
    else recordPrompt(board, session);
    return {};
  }
  if (observation.kind !== "tool-boundary" || observation.boundaryPhase !== "before") return {};
  if (boardTool) {
    if (localTool === "update_session_status") {
      if (!normalizeSummary(toolInput.summary)) {
        return preToolUse("deny", { permissionDecisionReason: "summary\uB294 ".concat(SUMMARY_MAX_LENGTH, "\uC790 \uC774\uD558\uC758 \uD55C \uC904\uC774\uC5B4\uC57C \uD569\uB2C8\uB2E4.") });
      }
      setSummary(board, session, toolInput.summary);
    }
    return preToolUse(void 0, { updatedInput: { ...toolInput, _sessionBinding: { host, sessionId } } });
  }
  return {};
}
async function runSessionBoardHook(host, raw, request = sessionMessageRequest, failClosed = false) {
  let board = null;
  let phase = "stdin";
  let primary;
  let failed = false;
  let result = "";
  let cleanup;
  let cleanupFailed = false;
  try {
    const text2 = typeof raw === "function" ? raw() : raw;
    phase = "input";
    const input = JSON.parse(text2);
    const observation = adaptHostInput(input, host).observation;
    const main = actorAccess(observation.actor).allowed;
    let verifiedInternalWake = false;
    if (observation.kind === "user-input" && main) {
      const nonces = observation.wakeCandidates ?? [];
      const sessionId = observation.sessionId;
      let allRecognized = nonces.length > 0;
      if (sessionId) {
        for (const nonce of nonces) {
          try {
            const result2 = await request("consume-wake", { target: { host, sessionId }, nonce });
            allRecognized &&= result2.consumed;
          } catch (cause) {
            allRecognized = false;
            reportBoardFailure("consume-wake", cause);
          }
        }
      } else allRecognized = false;
      verifiedInternalWake = observation.wakeOnly === true && allRecognized;
    }
    if (main) {
      phase = "open";
      board = openBoard(resolveSessionBoardDatabasePath(), { busyTimeoutMs: 500 });
    }
    phase = "handle";
    const output = handleSessionBoardHook(input, board, host, (/* @__PURE__ */ new Date()).toISOString(), verifiedInternalWake);
    result = Object.keys(output).length > 0 ? JSON.stringify(output) : "";
  } catch (cause) {
    primary = cause;
    failed = true;
    reportBoardFailure(phase, cause);
  } finally {
    try {
      board?.close();
    } catch (cause) {
      reportBoardFailure("close", cause);
      cleanup = cause;
      cleanupFailed = true;
      if (failClosed && failed && primary instanceof Error) retainFailureSecondary(primary, cause);
    }
  }
  if (failClosed && failed) throw primary;
  if (failClosed && cleanupFailed) throw cleanup;
  return result;
}
if (isHookEntry(import.meta.url, "session-board-hook")) {
  try {
    const host = resolveHookHost(process.argv.slice(2), "codex");
    void runSessionBoardHook(host, () => readFileSync(0, "utf8")).then((output) => {
      if (!output) return;
      let reported = false;
      const outputFailed = (cause) => {
        if (reported) return;
        reported = true;
        reportBoardFailure("stdout", cause);
      };
      process.stdout.on("error", outputFailed);
      try {
        process.stdout.write(output, (cause) => {
          if (cause) outputFailed(cause);
        });
      } catch (cause) {
        outputFailed(cause);
      }
    }).catch((cause) => reportBoardFailure("stdout", cause));
  } catch (cause) {
    reportBoardFailure("host-entry", cause);
  }
}
export {
  handleSessionBoardHook,
  runSessionBoardHook
};
