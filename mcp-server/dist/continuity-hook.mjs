#!/usr/bin/env node

// mcp-server/src/builtin-hook-host-adapters.ts
import { createHash as createHash3 } from "node:crypto";
import { types as utilTypes } from "node:util";

// runtime/failure-diagnostics.mjs
import { createHash } from "node:crypto";
import { types } from "node:util";
var producerReasons = /* @__PURE__ */ new WeakMap();
var producerCauses = /* @__PURE__ */ new WeakMap();
var secondaryFailures = /* @__PURE__ */ new WeakMap();
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
import { closeSync, constants, fstatSync, openSync, readSync, statSync as statSync2 } from "node:fs";
import path5 from "node:path";

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
  if (selected.length === 0) return fallback;
  if (selected.length !== 1 || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(selected[0])) throw hookHostFailure("selection");
  return selected[0];
}
function adaptHostInput(input, host) {
  const adapter = hookHostAdapters.get(host);
  if (!adapter) throw hookHostFailure("unavailable");
  return adapter.adaptInput?.(input, host) ?? {
    lifecycle: "none",
    outputEventName: "",
    observation: {
      host,
      sessionId: "",
      kind: "unknown",
      actor: { kind: "unknown", observedBy: "".concat(host, ":unconfigured-input"), assurance: "unknown" }
    }
  };
}
function isGovernanceHookTool(host, toolName) {
  return hookHostAdapters.get(host)?.ownsTool?.(toolName) === true;
}
var hookHostAdapters = /* @__PURE__ */ new Map();
function registerHookHostAdapter(host, adapter) {
  if (typeof host !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(host) || !adapter || typeof adapter.deliveryProfile !== "function" || typeof adapter.processPid !== "function" || adapter.adaptInput !== void 0 && typeof adapter.adaptInput !== "function" || adapter.ownsTool !== void 0 && typeof adapter.ownsTool !== "function" || adapter.attestationKind !== void 0 && (typeof adapter.attestationKind !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(adapter.attestationKind))) throw hookHostFailure("adapter");
  if (hookHostAdapters.has(host)) throw hookHostFailure("duplicate");
  hookHostAdapters.set(host, Object.freeze({ ...adapter }));
}

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
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
function resolveWorkflowDatabasePath(environment = process.env, platform = process.platform, homeDirectory = homedir(), currentWorkingDirectory = process.cwd()) {
  const configured = environment.AGENT_GOVERNANCE_DB_PATH?.trim();
  if (configured) return path.resolve(currentWorkingDirectory, configured);
  return path.resolve(userStateDirectory(environment, platform, homeDirectory), "workflows.sqlite3");
}
function userStateDirectory(environment, platform, homeDirectory) {
  let stateRoot;
  if (platform === "win32") {
    stateRoot = environment.LOCALAPPDATA?.trim() || path.join(homeDirectory, "AppData", "Local");
  } else if (platform === "darwin") {
    stateRoot = path.join(homeDirectory, "Library", "Application Support");
  } else {
    stateRoot = environment.XDG_STATE_HOME?.trim() || path.join(homeDirectory, ".local", "state");
  }
  return path.resolve(stateRoot, "agent-governance-suite");
}
function besideWorkflowDatabase(variable, fileName, environment, platform, homeDirectory, currentWorkingDirectory) {
  const configured = environment[variable]?.trim();
  if (configured) return path.resolve(currentWorkingDirectory, configured);
  const workflowPath = resolveWorkflowDatabasePath(
    environment,
    platform,
    homeDirectory,
    currentWorkingDirectory
  );
  if (workflowPath === ":memory:") return ":memory:";
  return path.join(path.dirname(workflowPath), fileName);
}
function resolveContinuityDatabasePath(environment = process.env, platform = process.platform, homeDirectory = homedir(), currentWorkingDirectory = process.cwd()) {
  return besideWorkflowDatabase("AGENT_GOVERNANCE_CONTINUITY_DB_PATH", "continuity.sqlite3", environment, platform, homeDirectory, currentWorkingDirectory);
}
function canonicalDatabasePath(databasePath, platform) {
  if (databasePath === ":memory:") return null;
  const absolute = path.resolve(databasePath);
  const unresolved2 = [];
  let cursor = absolute;
  let resolved = absolute;
  while (true) {
    try {
      resolved = path.join(realpathSync.native(cursor), ...unresolved2.reverse());
      break;
    } catch {
      const parent = path.dirname(cursor);
      if (parent === cursor) break;
      unresolved2.push(path.basename(cursor));
      cursor = parent;
    }
  }
  const normalized = path.normalize(resolved);
  return platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized;
}
function assertDistinctDatabasePaths(workflowDatabasePath, continuityDatabasePath, platform = process.platform) {
  const workflowIdentity = canonicalDatabasePath(workflowDatabasePath, platform);
  const continuityIdentity = canonicalDatabasePath(continuityDatabasePath, platform);
  if (workflowIdentity !== null && workflowIdentity === continuityIdentity) {
    throw new Error("Workflow and continuity databases must use different files.");
  }
}

// mcp-server/src/session-message-protocol.ts
var SESSION_MESSAGE_MAX_REQUEST_BYTES = 32 * 1024;
var SESSION_MESSAGE_MAX_RESPONSE_BYTES = 32 * 1024;

// mcp-server/src/session-message-client.ts
var WAKE_PREFIX = "[agent-governance-suite:wake:";
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

// mcp-server/src/convergence-logic.ts
import { createHash as createHash2 } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import path3 from "node:path";

// mcp-server/src/workspace-identity.ts
import fs from "node:fs";
import path2 from "node:path";
var WALK_LIMIT = 256;
var READ_LIMIT = 4096;
var URI_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]+:\/\//u;
var GLOB_META = /[*?[\]{}]/u;
var SEGMENT_SEPARATOR = process.platform === "win32" ? /[\\/]/u : /\//u;
function isUnsupported(entry) {
  if (URI_PATTERN.test(entry)) return true;
  for (let index = 0; index < entry.length; index += 1) {
    const code = entry.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}
function assertSupportedScopeEntry(entry) {
  if (isUnsupported(entry)) {
    throw new WorkflowContractError(
      "INVALID_INPUT",
      "Scope entries must be file system paths without control characters.",
      { reason: "UNSUPPORTED_SCOPE_ENTRY", entry }
    );
  }
}
function pathWithin(child, parent) {
  return parent === "" || child === parent || child.startsWith("".concat(parent, "/"));
}
function unresolved(target, cause) {
  return new WorkflowContractError(
    "INVALID_INPUT",
    "Workspace identity cannot be resolved for ".concat(target, ": ").concat(cause, "."),
    { reason: "WORKSPACE_IDENTITY_UNRESOLVED", path: target, cause }
  );
}
function normalizedKey(value) {
  const slashed = process.platform === "win32" ? value.replaceAll("\\", "/").toLowerCase() : value;
  return slashed.replace(/\/+$/u, "");
}
function physicalPath(target) {
  let current = path2.resolve(target);
  const suffix = [];
  for (let depth = 0; depth < WALK_LIMIT; depth += 1) {
    try {
      const existing = fs.realpathSync.native(current);
      return { real: path2.join(existing, ...suffix), existing };
    } catch (error) {
      const code = error.code;
      const parent = path2.dirname(current);
      if (code !== "ENOENT" && code !== "ENOTDIR" || parent === current) throw unresolved(target, code ?? "unreadable");
      suffix.unshift(path2.basename(current));
      current = parent;
    }
  }
  throw unresolved(target, "walk limit reached");
}
function isDirectory(target) {
  return fs.statSync(target, { throwIfNoEntry: false })?.isDirectory() === true;
}
function readHead(file) {
  const descriptor = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(READ_LIMIT + 1);
    const length = fs.readSync(descriptor, buffer, 0, READ_LIMIT + 1, 0);
    if (length > READ_LIMIT) throw unresolved(file, "pointer file too large");
    return buffer.toString("utf8", 0, length);
  } finally {
    fs.closeSync(descriptor);
  }
}
function discoverGit(physical) {
  let evidence = physical.existing;
  try {
    let directory = isDirectory(physical.existing) ? physical.existing : path2.dirname(physical.existing);
    for (let depth = 0; depth < WALK_LIMIT; depth += 1) {
      evidence = path2.join(directory, ".git");
      const stat = fs.statSync(evidence, { throwIfNoEntry: false });
      if (stat) {
        let gitDir = evidence;
        if (!stat.isDirectory()) {
          const pointer = /^gitdir: ([^\r\n]+)/u.exec(readHead(evidence))?.[1];
          if (!pointer) throw unresolved(evidence, "missing gitdir line");
          gitDir = path2.resolve(directory, pointer);
          if (!isDirectory(gitDir)) throw unresolved(gitDir, "gitdir is not a directory");
        }
        let commonDir = gitDir;
        evidence = path2.join(gitDir, "commondir");
        if (fs.statSync(evidence, { throwIfNoEntry: false })) {
          const pointer = readHead(evidence).trim();
          if (!pointer) throw unresolved(evidence, "empty commondir");
          commonDir = path2.resolve(gitDir, pointer);
          if (!isDirectory(commonDir)) throw unresolved(commonDir, "commondir is not a directory");
        }
        return {
          commonDir: normalizedKey(fs.realpathSync.native(commonDir)),
          checkoutRoot: normalizedKey(directory),
          relative: normalizedKey(path2.relative(directory, physical.real))
        };
      }
      const parent = path2.dirname(directory);
      if (parent === directory) return null;
      directory = parent;
    }
    throw unresolved(physical.existing, "walk limit reached");
  } catch (error) {
    if (error instanceof WorkflowContractError) throw error;
    throw unresolved(evidence, error.code ?? "unreadable");
  }
}
function repositoryCheckouts(commonDir) {
  const roots = /* @__PURE__ */ new Set();
  const complete = false;
  try {
    if (!isDirectory(commonDir)) return { roots: [], complete: false };
    if (path2.basename(commonDir) === ".git") roots.add(normalizedKey(physicalPath(path2.dirname(commonDir)).real));
    const worktrees = path2.join(commonDir, "worktrees");
    if (fs.statSync(worktrees, { throwIfNoEntry: false })) {
      const listing = fs.opendirSync(worktrees);
      try {
        for (let count = 0; ; count += 1) {
          const name = listing.readSync()?.name;
          if (name === void 0) break;
          if (count >= WALK_LIMIT) {
            break;
          }
          try {
            const pointer = readHead(path2.join(worktrees, name, "gitdir")).trim();
            if (!pointer || isUnsupported(pointer) || normalizedKey(path2.basename(pointer)) !== ".git") {
              continue;
            }
            roots.add(normalizedKey(physicalPath(path2.dirname(path2.resolve(worktrees, name, pointer))).real));
          } catch {
          }
        }
      } finally {
        listing.closeSync();
      }
    }
  } catch {
  }
  return { roots: [...roots], complete };
}
function repositoryInDirectory(container, commonDir) {
  const pending = [container];
  const visited = /* @__PURE__ */ new Set();
  let inspected = 0;
  try {
    while (pending.length > 0) {
      if (++inspected > READ_LIMIT) return "unknown";
      const directory = fs.realpathSync.native(pending.pop());
      const key = normalizedKey(directory);
      if (visited.has(key)) continue;
      visited.add(key);
      if (fs.statSync(path2.join(directory, ".git"), { throwIfNoEntry: false })) {
        if (discoverGit({ real: directory, existing: directory })?.commonDir === commonDir) return "overlap";
      }
      const listing = fs.opendirSync(directory);
      try {
        for (let entry = listing.readSync(); entry; entry = listing.readSync()) {
          if (++inspected > READ_LIMIT) return "unknown";
          if (entry.name === ".git") continue;
          const child = path2.join(directory, entry.name);
          if (entry.isDirectory()) pending.push(child);
          else if (entry.isSymbolicLink()) {
            if (isDirectory(child)) pending.push(child);
            else if (identify(child).git?.commonDir === commonDir) return "overlap";
          }
        }
      } finally {
        listing.closeSync();
      }
    }
    return "none";
  } catch {
    return "unknown";
  }
}
function identify(target) {
  const physical = physicalPath(target);
  return { physical: normalizedKey(physical.real), git: discoverGit(physical) };
}
function resolveRootIdentity(workspaceLocator, entries, options = {}) {
  if (!options.legacy) for (const entry of entries) assertSupportedScopeEntry(entry);
  const workspace = identify(workspaceLocator);
  const surfaces = entries.map((entry) => {
    if (isUnsupported(entry)) return { entry, ...workspace, conservative: "legacy-unsupported" };
    const segments = entry.split(SEGMENT_SEPARATOR);
    const globIndex = segments.findIndex((segment) => GLOB_META.test(segment));
    if (globIndex === 0) {
      return workspace.git ? { entry, physical: workspace.git.checkoutRoot, git: { ...workspace.git, relative: "" }, conservative: "leading-glob" } : { entry, ...workspace, conservative: "leading-glob" };
    }
    const target = globIndex < 0 ? entry : "".concat(segments.slice(0, globIndex).join("/"), "/");
    return {
      entry,
      ...identify(path2.resolve(workspaceLocator, target)),
      conservative: globIndex < 0 ? null : "glob-prefix"
    };
  });
  return { version: 1, workspacePhysical: workspace.physical, surfaces };
}

// mcp-server/src/convergence-logic.ts
function canonicalJson(value, subject = "Convergence input") {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new WorkflowContractError("INVALID_INPUT", "".concat(subject, " contains a non-finite number."));
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return "[".concat(value.map((item) => canonicalJson(item, subject)).join(","), "]");
  if (value && typeof value === "object") {
    const record2 = value;
    return "{".concat(Object.keys(record2).sort().map((key) => "".concat(JSON.stringify(key), ":").concat(canonicalJson(record2[key], subject))).join(","), "}");
  }
  throw new WorkflowContractError("INVALID_INPUT", "".concat(subject, " contains a non-serializable value."));
}
function convergenceDigest(value) {
  return "sha256:".concat(createHash2("sha256").update(canonicalJson(value), "utf8").digest("hex"));
}
function writeSurface(root) {
  return [
    ...root.taskEnvelope.scope.included,
    ...root.taskEnvelope.workUnits.flatMap((unit) => unit.writeTargets),
    ...root.frame.targetArtifacts.map((artifact) => artifact.locator)
  ];
}
function rootIdentity(root, legacy = false) {
  return resolveRootIdentity(root.frame.workspace.locator, writeSurface(root), { legacy });
}
function surfaceDigest(root) {
  return convergenceDigest({ locator: root.frame.workspace.locator, entries: writeSurface(root) });
}
function normalizedScope(value, workspaceLocator) {
  const normalized = path3.resolve(workspaceLocator, value).replaceAll("\\", "/").replace(/\/+$/u, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
function inferredSurfaces(identity) {
  return identity.surfaces.map((surface) => !existsSync(surface.physical || "/"));
}
function coversEarlierCheckout(current, earlier) {
  if (earlier.git === null) return false;
  if (current.git === null) return true;
  return earlier.git.checkoutRoot !== current.git.checkoutRoot && pathWithin(earlier.git.checkoutRoot, current.git.checkoutRoot);
}
function surfaceBacked(surface, observedOutsideCheckouts) {
  const unchanged = observedOutsideCheckouts && surface.git === null && !surface.conservative;
  return existsSync((unchanged ? path3.posix.dirname(surface.physical) : surface.physical) || "/");
}
function activeRootIdentity(root, stored) {
  const digest = surfaceDigest(root);
  const observed = stored && stored.surfaceDigest === digest ? stored.identity : null;
  const wasInferred = (index) => observed !== null && stored.inferred[index] === true;
  const known = { root, legacy: stored === null, observedWorkspace: observed !== null, surfaceDigest: digest };
  if (observed && observed.surfaces.every((surface, index) => surface.git !== null && !wasInferred(index))) {
    return { ...known, identity: observed, resolved: true, fresh: false, inferred: stored.inferred };
  }
  let derived = null;
  try {
    derived = rootIdentity(root, true);
  } catch (cause) {
    if (!(cause instanceof WorkflowContractError)) throw cause;
  }
  const locator = root.frame.workspace.locator;
  if (!observed && !derived) {
    const identity2 = {
      version: 1,
      workspacePhysical: normalizedScope(".", locator),
      surfaces: writeSurface(root).map((entry) => ({ entry, physical: normalizedScope(entry, locator), git: null, conservative: null }))
    };
    return { ...known, identity: identity2, resolved: false, fresh: false, inferred: [] };
  }
  const workspaceExists = existsSync(locator);
  let resolved = true;
  const surfaces = (observed ?? derived).surfaces.map((surface, index) => {
    const current = derived?.surfaces[index];
    if (wasInferred(index)) {
      if (!current) resolved = false;
      return current && !coversEarlierCheckout(current, surface) ? current : surface;
    }
    if (observed && surface.git !== null) return surface;
    if (current && workspaceExists && surfaceBacked(current, observed !== null)) return current;
    resolved = false;
    return surface;
  });
  const identity = {
    version: 1,
    workspacePhysical: observed?.workspacePhysical ?? derived.workspacePhysical,
    surfaces
  };
  const inferred = surfaces.map((surface, index) => wasInferred(index) && !existsSync(surface.physical || "/"));
  const fresh = resolved && JSON.stringify({ identity, inferred }) !== JSON.stringify({ identity: observed, inferred: stored?.inferred });
  return { ...known, identity, resolved, fresh, inferred };
}
var GATED_STATES = ["needs-review", "needs-user"];
function overlaps(left, right) {
  return pathWithin(left, right) || pathWithin(right, left);
}
function sharesLineage(left, right) {
  return left.git !== null && right.git !== null && left.git.commonDir === right.git.commonDir;
}
function insideParentSurface(surface, parent) {
  return parent.surfaces.some((owned) => pathWithin(surface.physical, owned.physical) || sharesLineage(surface, owned) && pathWithin(surface.git.relative, owned.git.relative));
}
function lineageRelation(left, right, checkouts, scans) {
  if (sharesLineage(left, right) && overlaps(left.git.relative, right.git.relative)) {
    return "overlap";
  }
  let uncertain = false;
  for (const [container, member] of [[left, right], [right, left]]) {
    if (!member.git || container.conservative === null && statSync(container.physical || "/", { throwIfNoEntry: false })?.isDirectory() !== true) continue;
    const commonDir = member.git.commonDir;
    if (!checkouts.has(commonDir)) checkouts.set(commonDir, repositoryCheckouts(commonDir));
    const listing = checkouts.get(commonDir);
    if (listing.roots.some((checkout) => pathWithin(checkout, container.physical))) return "overlap";
    if (!listing.complete) {
      const scanKey = "".concat(commonDir, "\0").concat(container.physical);
      if (!scans.has(scanKey)) scans.set(scanKey, repositoryInDirectory(container.physical || "/", commonDir));
      const scanned = scans.get(scanKey);
      if (scanned === "overlap") return "overlap";
      uncertain ||= scanned === "unknown";
    }
  }
  return uncertain ? "unknown" : "none";
}
function outsideEveryRepository(surface) {
  return surface.git === null && surface.conservative === null && statSync(surface.physical || "/", { throwIfNoEntry: false })?.isDirectory() !== true;
}
function findRootConflict(candidate, parent, actives) {
  const checkouts = /* @__PURE__ */ new Map();
  const scans = /* @__PURE__ */ new Map();
  for (const active of actives) {
    if (active.root.rootId === candidate.root.parentRootId) continue;
    for (const requested of candidate.identity.surfaces) {
      for (const existing of active.identity.surfaces) {
        if (overlaps(requested.physical, existing.physical)) {
          return { root: active.root, kind: "physical", requested, existing };
        }
      }
    }
    if (!GATED_STATES.includes(active.root.state)) continue;
    for (const requested of candidate.identity.surfaces) {
      if (parent && insideParentSurface(requested, parent)) continue;
      for (const existing of active.identity.surfaces) {
        if (!active.resolved) {
          if (outsideEveryRepository(requested)) continue;
          return { root: active.root, kind: "lineage-unresolved", requested, existing };
        }
        const relation = lineageRelation(requested, existing, checkouts, scans);
        if (relation !== "none") {
          return { root: active.root, kind: relation === "overlap" ? "lineage" : "lineage-unresolved", requested, existing };
        }
      }
    }
  }
  return null;
}
function replacementMatch(candidate, parent) {
  if (!parent.resolved) {
    if (!parent.legacy) {
      return parent.observedWorkspace && candidate.identity.workspacePhysical === parent.identity.workspacePhysical ? "physical" : null;
    }
    const sameNamedWorkspace = parent.root.frame.workspace.workspaceId === candidate.root.frame.workspace.workspaceId && normalizeWorkspaceLocator(parent.root.frame.workspace.locator) === normalizeWorkspaceLocator(candidate.root.frame.workspace.locator);
    return sameNamedWorkspace ? "legacy-locator" : null;
  }
  if (candidate.identity.workspacePhysical === parent.identity.workspacePhysical) return "physical";
  const parentRepositories = new Set(parent.identity.surfaces.flatMap((surface) => surface.git ? [surface.git.commonDir] : []));
  const sameLineage = candidate.identity.surfaces.length > 0 && candidate.identity.surfaces.every((surface) => surface.git !== null && parentRepositories.has(surface.git.commonDir));
  return sameLineage ? "lineage" : null;
}
function planRootInsertion(root, actives) {
  const identity = rootIdentity(root);
  let parent = null;
  let match = null;
  if (root.parentRootId) {
    parent = actives.find((active) => active.root.rootId === root.parentRootId) ?? null;
    if (!parent || !GATED_STATES.includes(parent.root.state)) {
      throw new WorkflowContractError("INVALID_TRANSITION", "Only a gated convergence root may be replaced.", {
        parentRootId: root.parentRootId,
        parentState: parent?.root.state ?? null
      });
    }
    match = replacementMatch({ root, identity }, parent);
    if (!match) {
      throw new WorkflowContractError("INVALID_INPUT", "A replacement root must remain bound to the same workspace.", {
        parentRootId: root.parentRootId,
        ...parent.resolved ? {} : { reason: "WORKSPACE_IDENTITY_UNRESOLVED" }
      });
    }
  }
  return {
    identity,
    surfaceDigest: surfaceDigest(root),
    inferred: inferredSurfaces(identity),
    match,
    conflict: findRootConflict({ root, identity }, parent?.identity ?? null, actives)
  };
}
function normalizeWorkspaceLocator(locator) {
  const resolved = path3.resolve(locator);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

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
function actorObservation(input, host) {
  if (!Object.hasOwn(input, "agent_id")) return { kind: "unknown", observedBy: "".concat(host, ":hook-payload"), assurance: "unknown" };
  if (typeof input.agent_id !== "string") return { kind: "unknown", observedBy: "".concat(host, ":hook-payload"), assurance: "unknown" };
  return {
    kind: text(input.agent_id) ? "subagent" : "main",
    observedBy: "".concat(host, ":hook-payload"),
    assurance: "observed"
  };
}
function adaptBuiltinHookInput(input, host) {
  const event = text(input.hook_event_name);
  let kind = "unknown";
  let lifecycle = "none";
  let boundaryPhase;
  if (event === "SessionStart") lifecycle = "start";
  else if (event === "SessionEnd") {
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
  const wake = kind === "user-input" ? parseWakeMessages(input.prompt) : { nonces: [], wakeOnly: false };
  const workspaceId = text(input.workspace_id) || text(input.cwd);
  const collaborationId = text(input.collaboration_id);
  const role = text(input.role);
  return {
    lifecycle,
    outputEventName: event,
    observation: {
      host,
      sessionId: text(input.session_id),
      kind,
      actor: actorObservation(input, host),
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
  const adapted = adaptBuiltinHookInput(input, host);
  if (adapted.lifecycle === "none") return adapted;
  if (Object.hasOwn(input, "agent_type")) {
    adapted.observation.actor = { kind: "unknown", observedBy: "".concat(host, ":root-lifecycle-conflict"), assurance: "unknown" };
  } else if (!Object.hasOwn(input, "agent_id")) {
    adapted.observation.actor = { kind: "main", observedBy: "".concat(host, ":native-root-lifecycle"), assurance: "observed" };
  }
  return adapted;
}
function adaptClaudeHookInput(input, host) {
  const adapted = adaptBuiltinHookInput(input, host);
  const hasAgentId = Object.hasOwn(input, "agent_id");
  const knownEvent = adapted.lifecycle !== "none" || adapted.observation.kind !== "unknown";
  const validAgentType = !Object.hasOwn(input, "agent_type") || typeof input.agent_type === "string" && input.agent_type.trim().length > 0;
  if (!knownEvent || !adapted.observation.sessionId.trim() || !validAgentType || hasAgentId && (typeof input.agent_id !== "string" || !input.agent_id.trim())) {
    adapted.observation.actor = { kind: "unknown", observedBy: "".concat(host, ":invalid-native-actor"), assurance: "unknown" };
  } else if (!hasAgentId) {
    adapted.observation.actor = { kind: "main", observedBy: "".concat(host, ":hook-payload"), assurance: "observed" };
  }
  return adapted;
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
    if (!error || typeof error !== "object" || utilTypes.isProxy(error)) return false;
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
    validDirectory = statSync2(directory).isDirectory();
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
    adaptInput: adaptBuiltinHookInput,
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
    queryRevision: createHash3("sha256").update(JSON.stringify([...cursors].sort())).digest("hex")
  };
}
for (const [host, adapter] of builtinHookHostAdapters) registerHookHostAdapter(host, adapter);

// mcp-server/src/continuity-hook.ts
import { readFileSync } from "node:fs";
import path8 from "node:path";
import { fileURLToPath } from "node:url";
import { types as types2 } from "node:util";

// mcp-server/src/continuity-service.ts
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// mcp-server/src/continuity-store.ts
import { chmodSync, mkdirSync } from "node:fs";
import path6 from "node:path";
import { DatabaseSync as DatabaseSync2 } from "node:sqlite";
var SCHEMA_VERSION = 2;
var MAX_COMPATIBLE_SCHEMA_VERSION = 3;
var SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/u;
var TABLE_SIGNATURES = {
  continuity_metadata: "key:TEXT:0:1 value:TEXT:1:0",
  continuity_tasks: "task_correlation:TEXT:0:1 current_epoch:INTEGER:1:0 root_id:TEXT:0:0 suppressed:INTEGER:1:0:0 last_auto_injected_revision:INTEGER:0:0 pending_source:TEXT:0:0 pending_revision:INTEGER:0:0 pending_digest:TEXT:0:0 pending_root_id:TEXT:0:0 pending_consumed:INTEGER:1:0:0 updated_at:TEXT:1:0",
  continuity_snapshots: "task_correlation:TEXT:1:1 epoch:INTEGER:1:2 revision:INTEGER:1:0 snapshot_digest:TEXT:1:0 snapshot_json:TEXT:1:0 updated_at:TEXT:1:0",
  continuity_requests: "task_correlation:TEXT:1:1 epoch:INTEGER:1:2 request_hash:TEXT:1:3 command_digest:TEXT:1:0 result_json:TEXT:1:0 created_at:TEXT:1:0",
  continuity_tombstones: "task_correlation:TEXT:1:1 epoch:INTEGER:1:2 revision:INTEGER:1:0 payload_digest:TEXT:1:0 purged_at:TEXT:1:0",
  continuity_observations: "observation_id:INTEGER:0:1 task_correlation:TEXT:1:0 epoch:INTEGER:1:0 event:TEXT:1:0 turn_hash:TEXT:0:0 success:INTEGER:1:0 observed_at:TEXT:1:0",
  continuity_delta_state: "task_correlation:TEXT:1:1 epoch:INTEGER:1:2 receiver_host:TEXT:1:0 receiver_session:TEXT:1:0 receiver_instance:TEXT:1:0 context_generation:INTEGER:1:0 sequence:INTEGER:1:0 origin_digest:TEXT:1:0 checkpoint_digest:TEXT:1:0 checkpoint_json:TEXT:1:0 last_delta_digest:TEXT:0:0 state_ack_json:TEXT:0:0"
};
function hasExactKeys(value, keys) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
function isBodyFreeRequestReceipt(value) {
  if (!value || value.schemaVersion !== "1.0.0") return false;
  if (value.kind === "checkpoint") {
    return hasExactKeys(value, ["schemaVersion", "kind", "epoch", "revision", "snapshotDigest"]) && Number.isInteger(value.epoch) && Number.isInteger(value.revision) && typeof value.snapshotDigest === "string" && SHA256_DIGEST.test(value.snapshotDigest);
  }
  if (value.kind === "purged-request") {
    return hasExactKeys(value, ["schemaVersion", "kind", "epoch", "revision", "tombstoneDigest", "purgedAt"]) && Number.isInteger(value.epoch) && Number.isInteger(value.revision) && typeof value.tombstoneDigest === "string" && SHA256_DIGEST.test(value.tombstoneDigest) && typeof value.purgedAt === "string";
  }
  return value.purged === true && hasExactKeys(value, ["schemaVersion", "purged", "epoch", "revision", "tombstoneDigest", "purgedAt"]) && Number.isInteger(value.epoch) && Number.isInteger(value.revision) && typeof value.tombstoneDigest === "string" && SHA256_DIGEST.test(value.tombstoneDigest) && typeof value.purgedAt === "string";
}
var ContinuityStoreError = class extends Error {
  constructor(message, causeValue, reason = "STORE_UNAVAILABLE") {
    super(message);
    this.causeValue = causeValue;
    this.reason = reason;
    this.name = "ContinuityStoreError";
  }
  causeValue;
  reason;
};
function continuityUnavailableReason(error) {
  if (error instanceof ContinuityStoreError) return error.reason;
  const code = error && typeof error === "object" && "errcode" in error ? error.errcode : null;
  return code === 11 || code === 26 ? "CORRUPT_DATABASE" : "STORE_UNAVAILABLE";
}
function purgedRequestJson(epoch, revision, tombstoneDigest, purgedAt) {
  return JSON.stringify({ schemaVersion: "1.0.0", kind: "purged-request", epoch, revision, tombstoneDigest, purgedAt });
}
function taskRecord(row) {
  return {
    taskCorrelation: row.task_correlation,
    currentEpoch: row.current_epoch,
    rootId: row.root_id,
    suppressed: row.suppressed === 1,
    lastAutoInjectedRevision: row.last_auto_injected_revision,
    pendingSource: row.pending_source,
    pendingRevision: row.pending_revision,
    pendingDigest: row.pending_digest,
    pendingRootId: row.pending_root_id,
    pendingConsumed: row.pending_consumed === 1,
    updatedAt: row.updated_at
  };
}
var SqliteContinuityStore = class {
  database;
  shared;
  databasePath;
  closed = false;
  constructor(input) {
    this.shared = typeof input === "string" ? void 0 : input;
    this.databasePath = typeof input === "string" ? input : input.databasePath;
    const databasePath = this.databasePath;
    if (this.shared) {
      this.database = this.shared.database;
      this.shared.initialize(() => this.initializeSchema());
      return;
    }
    if (!databasePath.trim()) throw new ContinuityStoreError("Continuity database path must not be empty.");
    if (databasePath !== ":memory:") mkdirSync(path6.dirname(path6.resolve(databasePath)), { recursive: true, mode: 448 });
    let opened = null;
    try {
      opened = new DatabaseSync2(databasePath);
      this.database = opened;
      this.database.exec("PRAGMA busy_timeout = 5000;");
      this.database.exec("PRAGMA synchronous = FULL;");
      this.initializeSchema();
      if (databasePath !== ":memory:") this.database.exec("PRAGMA journal_mode = WAL;");
      if (databasePath !== ":memory:" && process.platform !== "win32") chmodSync(path6.resolve(databasePath), 384);
    } catch (cause) {
      try {
        opened?.close();
      } catch {
      }
      throw new ContinuityStoreError("Cannot initialize the continuity database.", cause, continuityUnavailableReason(cause));
    }
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
  }
  getOrCreateSecret(create) {
    const existing = this.database.prepare("SELECT value FROM continuity_metadata WHERE key = 'signing-secret'").get();
    if (existing) return existing.value;
    const value = create();
    this.database.prepare("INSERT OR IGNORE INTO continuity_metadata(key, value) VALUES ('signing-secret', ?)").run(value);
    const stored = this.database.prepare("SELECT value FROM continuity_metadata WHERE key = 'signing-secret'").get();
    if (!stored) throw new ContinuityStoreError("Cannot initialize the continuity signing secret.");
    return stored.value;
  }
  ensureTask(taskCorrelation, now) {
    this.assertSupportedSchema();
    const existing = this.readTask(taskCorrelation);
    if (existing) return existing;
    return this.transaction("Cannot initialize the continuity task.", () => {
      this.database.prepare("\n        INSERT INTO continuity_tasks(task_correlation, current_epoch, updated_at)\n        VALUES (?, 1, ?)\n        ON CONFLICT(task_correlation) DO NOTHING\n      ").run(taskCorrelation, now);
      return this.getTask(taskCorrelation);
    }, taskCorrelation);
  }
  getTask(taskCorrelation) {
    this.assertCompatibleTask(taskCorrelation);
    return this.readTask(taskCorrelation);
  }
  readTask(taskCorrelation) {
    const row = this.database.prepare("SELECT * FROM continuity_tasks WHERE task_correlation = ?").get(taskCorrelation);
    return row ? taskRecord(row) : null;
  }
  rotateEpoch(taskCorrelation, now) {
    this.ensureTask(taskCorrelation, now);
    return this.transaction("Cannot rotate the continuity epoch.", () => {
      this.database.prepare("\n        UPDATE continuity_tasks\n        SET current_epoch = current_epoch + 1, root_id = NULL, suppressed = 0,\n            last_auto_injected_revision = NULL, pending_source = NULL,\n            pending_revision = NULL, pending_digest = NULL, pending_root_id = NULL,\n            pending_consumed = 0, updated_at = ?\n        WHERE task_correlation = ?\n      ").run(now, taskCorrelation);
      return this.getTask(taskCorrelation);
    }, taskCorrelation);
  }
  bindRoot(taskCorrelation, epoch, rootId, now) {
    return this.transaction("Cannot bind the continuity root.", () => {
      const result = this.database.prepare("\n        UPDATE continuity_tasks SET root_id = ?, suppressed = 0, updated_at = ?\n        WHERE task_correlation = ? AND current_epoch = ?\n      ").run(rootId, now, taskCorrelation, epoch);
      return result.changes === 1;
    }, taskCorrelation);
  }
  setSuppressed(taskCorrelation, epoch, now) {
    return this.transaction("Cannot suppress continuity restore.", () => {
      const result = this.database.prepare("\n        UPDATE continuity_tasks SET suppressed = 1, updated_at = ?\n        WHERE task_correlation = ? AND current_epoch = ?\n      ").run(now, taskCorrelation, epoch);
      return result.changes === 1;
    }, taskCorrelation);
  }
  /** Synchronous critical read; clear/root changes cannot commit between guard and body.
   * Historical getSnapshot remains available for authorized old-epoch purge.
   */
  readCurrentState(taskCorrelation, epoch, source, read, allowSuppressed = false) {
    return this.transaction("Cannot read current continuity state.", () => {
      const task = this.readTask(taskCorrelation);
      if (!task || task.currentEpoch !== epoch) return { kind: "epoch-mismatch" };
      if (source === "direct" && task.rootId !== null || source === "workflow" && task.rootId === null) return { kind: "source-conflict" };
      if (task.suppressed && !allowSuppressed) return { kind: "suppressed" };
      return { kind: "available", task, value: read(task) };
    }, taskCorrelation);
  }
  getSnapshot(taskCorrelation, epoch) {
    const row = this.database.prepare("\n      SELECT snapshot_json FROM continuity_snapshots WHERE task_correlation = ? AND epoch = ?\n    ").get(taskCorrelation, epoch);
    this.assertCompatibleTask(taskCorrelation);
    return row ? JSON.parse(row.snapshot_json) : null;
  }
  getRequest(taskCorrelation, epoch, requestHash) {
    const row = this.database.prepare("\n      SELECT command_digest, result_json FROM continuity_requests\n      WHERE task_correlation = ? AND epoch = ? AND request_hash = ?\n    ").get(taskCorrelation, epoch, requestHash);
    return row ? { commandDigest: row.command_digest, resultJson: row.result_json } : null;
  }
  getTombstone(taskCorrelation, epoch) {
    const row = this.database.prepare("\n      SELECT revision, payload_digest, purged_at FROM continuity_tombstones\n      WHERE task_correlation = ? AND epoch = ?\n    ").get(taskCorrelation, epoch);
    return row ? { revision: row.revision, payloadDigest: row.payload_digest, purgedAt: row.purged_at } : null;
  }
  checkpoint(taskCorrelation, epoch, expectedRevision, requestHash, commandDigest, snapshot) {
    return this.transaction("Cannot store the continuity checkpoint.", () => {
      const task = this.readTask(taskCorrelation);
      if (!task || task.currentEpoch !== epoch) return { kind: "epoch-mismatch" };
      if (task.rootId !== null) return { kind: "source-conflict" };
      const replay = this.getRequest(taskCorrelation, epoch, requestHash);
      if (replay) return replay.commandDigest === commandDigest ? { kind: "replay", request: replay } : { kind: "conflict" };
      const current = this.getSnapshot(taskCorrelation, epoch);
      const actualRevision = current?.revision ?? this.getTombstone(taskCorrelation, epoch)?.revision ?? 0;
      if (actualRevision !== expectedRevision) return { kind: "stale", actualRevision };
      const json = JSON.stringify(snapshot);
      const resultJson = JSON.stringify({
        schemaVersion: "1.0.0",
        kind: "checkpoint",
        epoch,
        revision: snapshot.revision,
        snapshotDigest: snapshot.snapshotDigest
      });
      this.database.prepare("\n        INSERT INTO continuity_snapshots(task_correlation, epoch, revision, snapshot_digest, snapshot_json, updated_at)\n        VALUES (?, ?, ?, ?, ?, ?)\n        ON CONFLICT(task_correlation, epoch) DO UPDATE SET\n          revision = excluded.revision, snapshot_digest = excluded.snapshot_digest,\n          snapshot_json = excluded.snapshot_json, updated_at = excluded.updated_at\n      ").run(taskCorrelation, epoch, snapshot.revision, snapshot.snapshotDigest, json, snapshot.updatedAt);
      this.database.prepare("\n        INSERT INTO continuity_requests(task_correlation, epoch, request_hash, command_digest, result_json, created_at)\n        VALUES (?, ?, ?, ?, ?, ?)\n      ").run(taskCorrelation, epoch, requestHash, commandDigest, resultJson, snapshot.updatedAt);
      return { kind: "stored" };
    }, taskCorrelation);
  }
  purge(taskCorrelation, epoch, expectedRevision, requestHash, commandDigest, tombstoneDigest, now, authorityEpoch) {
    return this.transaction("Cannot purge the continuity checkpoint.", () => {
      const task = this.readTask(taskCorrelation);
      if (!task || task.currentEpoch !== authorityEpoch) return { kind: "epoch-mismatch" };
      const replay = this.getRequest(taskCorrelation, epoch, requestHash);
      if (replay) return replay.commandDigest === commandDigest ? { kind: "replay", request: replay } : { kind: "conflict" };
      const current = this.getSnapshot(taskCorrelation, epoch);
      const actualRevision = current?.revision ?? 0;
      if (!current || actualRevision !== expectedRevision) return { kind: "stale", actualRevision };
      this.tombstone(taskCorrelation, epoch, expectedRevision, tombstoneDigest, now);
      const scrubbedRequestJson = purgedRequestJson(epoch, expectedRevision, tombstoneDigest, now);
      const storedRequests = this.database.prepare("\n        SELECT request_hash, result_json FROM continuity_requests\n        WHERE task_correlation = ? AND epoch = ?\n      ").all(taskCorrelation, epoch);
      const scrubRequest = this.database.prepare("\n        UPDATE continuity_requests SET result_json = ?\n        WHERE task_correlation = ? AND epoch = ? AND request_hash = ?\n      ");
      for (const storedRequest of storedRequests) {
        let parsed = null;
        try {
          const value = JSON.parse(storedRequest.result_json);
          parsed = value && typeof value === "object" && !Array.isArray(value) ? value : null;
        } catch {
        }
        if (!isBodyFreeRequestReceipt(parsed)) {
          scrubRequest.run(scrubbedRequestJson, taskCorrelation, epoch, storedRequest.request_hash);
        }
      }
      const resultJson = JSON.stringify({ schemaVersion: "1.0.0", purged: true, epoch, revision: expectedRevision, tombstoneDigest, purgedAt: now });
      this.database.prepare("\n        INSERT INTO continuity_requests(task_correlation, epoch, request_hash, command_digest, result_json, created_at)\n        VALUES (?, ?, ?, ?, ?, ?)\n      ").run(taskCorrelation, epoch, requestHash, commandDigest, resultJson, now);
      return { kind: "purged" };
    }, taskCorrelation);
  }
  setPendingMarker(taskCorrelation, epoch, source, revision, digest, rootId, now) {
    return this.transaction("Cannot mark pending continuity restore.", () => {
      const task = this.readTask(taskCorrelation);
      if (!task || task.currentEpoch !== epoch || task.suppressed) return false;
      if (source === "direct" ? task.rootId !== null || rootId !== null : !rootId || task.rootId !== rootId) return false;
      const result = this.database.prepare("\n        UPDATE continuity_tasks SET pending_source = ?, pending_revision = ?, pending_digest = ?,\n          pending_root_id = ?, pending_consumed = 0, updated_at = ?\n        WHERE task_correlation = ? AND current_epoch = ?\n      ").run(source, revision, digest, rootId, now, taskCorrelation, epoch);
      return result.changes === 1;
    }, taskCorrelation);
  }
  consumeWorkflowMarker(taskCorrelation, epoch, rootId, revision, digest, now) {
    return this.transaction("Cannot consume continuity restore.", () => {
      const result = this.database.prepare("\n        UPDATE continuity_tasks SET pending_consumed = 1, last_auto_injected_revision = ?, updated_at = ?\n        WHERE task_correlation = ? AND current_epoch = ? AND suppressed = 0\n          AND root_id = ? AND pending_root_id = ? AND pending_source = 'workflow'\n          AND pending_revision = ? AND pending_digest = ? AND pending_consumed = 0\n      ").run(revision, now, taskCorrelation, epoch, rootId, rootId, revision, digest);
      return result.changes === 1;
    }, taskCorrelation);
  }
  recordObservation(taskCorrelation, epoch, event, turnHash, success, now) {
    this.transaction("Cannot record the continuity observation.", () => {
      this.database.prepare("\n        INSERT INTO continuity_observations(task_correlation, epoch, event, turn_hash, success, observed_at)\n        VALUES (?, ?, ?, ?, ?, ?)\n      ").run(taskCorrelation, epoch, event, turnHash, success ? 1 : 0, now);
    }, taskCorrelation);
  }
  getSchemaVersion() {
    return this.shared?.getSchemaVersion() ?? this.database.prepare("PRAGMA user_version").get().user_version;
  }
  previewCleanup(payloadCutoff, recordCutoff) {
    this.assertSupportedSchema();
    const snapshotRows = this.database.prepare("\n      SELECT snapshots.task_correlation, tasks.root_id, snapshots.epoch, snapshots.revision,\n             snapshots.snapshot_digest, snapshots.snapshot_json, snapshots.updated_at\n      FROM continuity_snapshots snapshots\n      LEFT JOIN continuity_tasks tasks ON tasks.task_correlation = snapshots.task_correlation\n      WHERE snapshots.updated_at <= ?\n      ORDER BY snapshots.task_correlation, snapshots.epoch\n    ").all(payloadCutoff);
    let protectedActiveTasks = 0;
    const snapshots = [];
    for (const row of snapshotRows) {
      if (this.hasReceiverState(row.task_correlation)) {
        protectedActiveTasks += 1;
        continue;
      }
      const snapshot = JSON.parse(row.snapshot_json);
      if (snapshot.status === "active") {
        protectedActiveTasks += 1;
        continue;
      }
      snapshots.push({
        taskCorrelation: row.task_correlation,
        rootId: row.root_id,
        epoch: row.epoch,
        revision: row.revision,
        snapshotDigest: row.snapshot_digest,
        updatedAt: row.updated_at
      });
    }
    const taskRows = this.database.prepare("\n      SELECT task_correlation, current_epoch, root_id, updated_at\n      FROM continuity_tasks tasks\n      WHERE updated_at <= ?\n        AND NOT EXISTS (\n          SELECT 1 FROM continuity_snapshots snapshots\n          WHERE snapshots.task_correlation = tasks.task_correlation AND snapshots.updated_at > ?\n        )\n        AND NOT EXISTS (\n          SELECT 1 FROM continuity_requests requests\n          WHERE requests.task_correlation = tasks.task_correlation AND requests.created_at > ?\n        )\n        AND NOT EXISTS (\n          SELECT 1 FROM continuity_tombstones tombstones\n          WHERE tombstones.task_correlation = tasks.task_correlation AND tombstones.purged_at > ?\n        )\n        AND NOT EXISTS (\n          SELECT 1 FROM continuity_observations observations\n          WHERE observations.task_correlation = tasks.task_correlation AND observations.observed_at > ?\n        )\n      ORDER BY task_correlation\n    ").all(recordCutoff, recordCutoff, recordCutoff, recordCutoff, recordCutoff);
    const tasks = [];
    for (const row of taskRows) {
      if (this.hasReceiverState(row.task_correlation)) {
        protectedActiveTasks += 1;
        continue;
      }
      const active = this.database.prepare("\n        SELECT snapshot_json FROM continuity_snapshots WHERE task_correlation = ?\n      ").all(row.task_correlation);
      if (active.some((item) => JSON.parse(item.snapshot_json).status === "active")) {
        protectedActiveTasks += 1;
        continue;
      }
      tasks.push({
        taskCorrelation: row.task_correlation,
        currentEpoch: row.current_epoch,
        rootId: row.root_id,
        updatedAt: row.updated_at
      });
    }
    const fullTaskIds = new Set(tasks.map((task) => task.taskCorrelation));
    return { snapshots: snapshots.filter((snapshot) => !fullTaskIds.has(snapshot.taskCorrelation)), tasks, protectedActiveTasks };
  }
  backupTo(targetPath) {
    if (this.shared) throw new Error("SHARED_BACKUP_OWNER_REQUIRED: a shared database backup requires an explicit owner contract.");
    if (this.databasePath === ":memory:") throw new ContinuityStoreError("An in-memory continuity database cannot be cleaned destructively.");
    try {
      this.database.prepare("VACUUM INTO ?").run(targetPath);
      const backup = new DatabaseSync2(targetPath, { readOnly: true });
      try {
        const result = backup.prepare("PRAGMA integrity_check").get();
        if (result.integrity_check !== "ok") throw new Error("integrity_check returned ".concat(result.integrity_check));
      } finally {
        backup.close();
      }
    } catch (cause) {
      throw new ContinuityStoreError("Cannot create a verified continuity cleanup backup.", cause);
    }
  }
  executeCleanup(preview, now, payloadCutoff, recordCutoff) {
    return this.transaction("Cannot execute continuity state cleanup.", () => {
      this.assertSupportedSchema();
      const verifySnapshot = this.database.prepare("\n        SELECT snapshots.revision, snapshots.snapshot_digest, snapshots.snapshot_json,\n               snapshots.updated_at, tasks.root_id\n        FROM continuity_snapshots snapshots\n        LEFT JOIN continuity_tasks tasks ON tasks.task_correlation = snapshots.task_correlation\n        WHERE snapshots.task_correlation = ? AND snapshots.epoch = ?\n      ");
      const verifyTask = this.database.prepare("\n        SELECT current_epoch, root_id, updated_at FROM continuity_tasks WHERE task_correlation = ?\n      ");
      for (const snapshot of preview.snapshots) {
        this.assertCompatibleTask(snapshot.taskCorrelation);
        const row = verifySnapshot.get(snapshot.taskCorrelation, snapshot.epoch);
        const status = row ? JSON.parse(row.snapshot_json).status : null;
        if (!row || status === "active" || row.updated_at > payloadCutoff || row.root_id !== snapshot.rootId || row.revision !== snapshot.revision || row.snapshot_digest !== snapshot.snapshotDigest || row.updated_at !== snapshot.updatedAt) {
          throw new ContinuityStoreError("Continuity snapshot ".concat(snapshot.taskCorrelation, "/").concat(snapshot.epoch, " changed after preview."));
        }
      }
      for (const task of preview.tasks) {
        this.assertCompatibleTask(task.taskCorrelation);
        const row = verifyTask.get(task.taskCorrelation);
        if (!row || row.current_epoch !== task.currentEpoch || row.root_id !== task.rootId || row.updated_at !== task.updatedAt) {
          throw new ContinuityStoreError("Continuity task ".concat(task.taskCorrelation, " changed after preview."));
        }
        const childState = this.database.prepare("\n          SELECT\n            EXISTS(\n              SELECT 1 FROM continuity_snapshots\n              WHERE task_correlation = ? AND (updated_at > ? OR json_extract(snapshot_json, '$.status') = 'active')\n            ) AS invalid_snapshot,\n            EXISTS(SELECT 1 FROM continuity_requests WHERE task_correlation = ? AND created_at > ?) AS recent_request,\n            EXISTS(SELECT 1 FROM continuity_tombstones WHERE task_correlation = ? AND purged_at > ?) AS recent_tombstone,\n            EXISTS(SELECT 1 FROM continuity_observations WHERE task_correlation = ? AND observed_at > ?) AS recent_observation\n        ").get(
          task.taskCorrelation,
          recordCutoff,
          task.taskCorrelation,
          recordCutoff,
          task.taskCorrelation,
          recordCutoff,
          task.taskCorrelation,
          recordCutoff
        );
        if (childState.invalid_snapshot || childState.recent_request || childState.recent_tombstone || childState.recent_observation) {
          throw new ContinuityStoreError("Continuity task ".concat(task.taskCorrelation, " gained active or recent child state after preview."));
        }
      }
      const scrubbed = this.database.prepare("\n        UPDATE continuity_requests SET result_json = ?\n        WHERE task_correlation = ? AND epoch = ?\n      ");
      for (const snapshot of preview.snapshots) {
        this.tombstone(snapshot.taskCorrelation, snapshot.epoch, snapshot.revision, snapshot.snapshotDigest, now);
        scrubbed.run(
          purgedRequestJson(snapshot.epoch, snapshot.revision, snapshot.snapshotDigest, now),
          snapshot.taskCorrelation,
          snapshot.epoch
        );
        this.database.prepare("UPDATE continuity_tasks SET updated_at = ? WHERE task_correlation = ?").run(now, snapshot.taskCorrelation);
      }
      const deleteByTask = [
        "continuity_snapshots",
        "continuity_requests",
        "continuity_tombstones",
        "continuity_observations"
      ].map((table) => this.database.prepare("DELETE FROM ".concat(table, " WHERE task_correlation = ?")));
      for (const task of preview.tasks) {
        for (const statement of deleteByTask) statement.run(task.taskCorrelation);
        this.database.prepare("DELETE FROM continuity_tasks WHERE task_correlation = ?").run(task.taskCorrelation);
      }
      return { snapshots: preview.snapshots.length, tasks: preview.tasks.length };
    });
  }
  /** Deletes the snapshot payload and keeps only its revision and digest. */
  tombstone(taskCorrelation, epoch, revision, payloadDigest, purgedAt) {
    this.database.prepare("DELETE FROM continuity_snapshots WHERE task_correlation = ? AND epoch = ?").run(taskCorrelation, epoch);
    this.database.prepare("\n      INSERT INTO continuity_tombstones(task_correlation, epoch, revision, payload_digest, purged_at)\n      VALUES (?, ?, ?, ?, ?)\n      ON CONFLICT(task_correlation, epoch) DO UPDATE SET\n        revision = excluded.revision, payload_digest = excluded.payload_digest, purged_at = excluded.purged_at\n    ").run(taskCorrelation, epoch, revision, payloadDigest, purgedAt);
  }
  /**
   * Runs a write transaction. Early returns commit without having written;
   * failures roll back and surface as ContinuityStoreError.
   */
  transaction(message, operation, taskCorrelation) {
    if (this.shared) {
      try {
        return this.shared.transaction(() => {
          if (taskCorrelation !== void 0) this.assertCompatibleTask(taskCorrelation);
          return operation();
        });
      } catch (cause) {
        if (cause instanceof ContinuityStoreError) throw cause;
        throw new ContinuityStoreError(message, cause);
      }
    }
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      if (taskCorrelation !== void 0) this.assertCompatibleTask(taskCorrelation);
      const result = operation();
      this.database.exec("COMMIT;");
      return result;
    } catch (cause) {
      try {
        this.database.exec("ROLLBACK;");
      } catch {
      }
      if (cause instanceof ContinuityStoreError) throw cause;
      throw new ContinuityStoreError(message, cause);
    }
  }
  assertSupportedSchema() {
    const version = this.getSchemaVersion();
    if (version < 0 || version > MAX_COMPATIBLE_SCHEMA_VERSION) {
      throw new ContinuityStoreError("Unsupported continuity schema version ".concat(version, "."), void 0, "UNSUPPORTED_SCHEMA");
    }
    return version;
  }
  hasReceiverState(taskCorrelation) {
    const table = this.database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'continuity_delta_state'").get();
    return Boolean(table && this.database.prepare("SELECT 1 FROM continuity_delta_state WHERE task_correlation = ? LIMIT 1").get(taskCorrelation));
  }
  assertCompatibleTask(taskCorrelation) {
    this.assertSupportedSchema();
    if (this.hasReceiverState(taskCorrelation)) {
      throw new ContinuityStoreError(
        "This task has checkpoint receiver state that requires a newer continuity client.",
        void 0,
        "RECEIVER_STATE_UNSUPPORTED"
      );
    }
  }
  validateExistingSchema(version) {
    for (const [table, expected] of Object.entries(TABLE_SIGNATURES)) {
      if (table === "continuity_delta_state" && version < 3) continue;
      const columns = this.database.prepare("PRAGMA table_info(".concat(table, ")")).all();
      const actual = columns.map((column) => "".concat(column.name, ":").concat(column.type, ":").concat(column.notnull, ":").concat(column.pk) + (column.dflt_value === null ? "" : ":".concat(column.dflt_value))).join(" ");
      if (actual !== expected) {
        throw new ContinuityStoreError("The continuity database schema is incompatible.", void 0, "INCOMPATIBLE_SCHEMA");
      }
    }
    const integrity = this.database.prepare("PRAGMA quick_check").all();
    if (integrity.length !== 1 || integrity[0]?.quick_check !== "ok") {
      throw new ContinuityStoreError("The continuity database integrity check failed.", void 0, "CORRUPT_DATABASE");
    }
  }
  initializeSchema() {
    const version = this.assertSupportedSchema();
    if (version >= SCHEMA_VERSION) {
      this.validateExistingSchema(version);
      return;
    }
    this.database.exec("\n      CREATE TABLE IF NOT EXISTS continuity_metadata (\n        key TEXT PRIMARY KEY,\n        value TEXT NOT NULL\n      );\n      CREATE TABLE IF NOT EXISTS continuity_tasks (\n        task_correlation TEXT PRIMARY KEY,\n        current_epoch INTEGER NOT NULL CHECK (current_epoch >= 1),\n        root_id TEXT,\n        suppressed INTEGER NOT NULL DEFAULT 0 CHECK (suppressed IN (0, 1)),\n        last_auto_injected_revision INTEGER,\n        pending_source TEXT CHECK (pending_source IN ('direct', 'workflow')),\n        pending_revision INTEGER,\n        pending_digest TEXT,\n        pending_root_id TEXT,\n        pending_consumed INTEGER NOT NULL DEFAULT 0 CHECK (pending_consumed IN (0, 1)),\n        updated_at TEXT NOT NULL\n      );\n      CREATE TABLE IF NOT EXISTS continuity_snapshots (\n        task_correlation TEXT NOT NULL,\n        epoch INTEGER NOT NULL,\n        revision INTEGER NOT NULL CHECK (revision >= 1),\n        snapshot_digest TEXT NOT NULL,\n        snapshot_json TEXT NOT NULL,\n        updated_at TEXT NOT NULL,\n        PRIMARY KEY(task_correlation, epoch)\n      );\n      CREATE TABLE IF NOT EXISTS continuity_requests (\n        task_correlation TEXT NOT NULL,\n        epoch INTEGER NOT NULL,\n        request_hash TEXT NOT NULL,\n        command_digest TEXT NOT NULL,\n        result_json TEXT NOT NULL,\n        created_at TEXT NOT NULL,\n        PRIMARY KEY(task_correlation, epoch, request_hash)\n      );\n      CREATE TABLE IF NOT EXISTS continuity_tombstones (\n        task_correlation TEXT NOT NULL,\n        epoch INTEGER NOT NULL,\n        revision INTEGER NOT NULL,\n        payload_digest TEXT NOT NULL,\n        purged_at TEXT NOT NULL,\n        PRIMARY KEY(task_correlation, epoch)\n      );\n      CREATE TABLE IF NOT EXISTS continuity_observations (\n        observation_id INTEGER PRIMARY KEY AUTOINCREMENT,\n        task_correlation TEXT NOT NULL,\n        epoch INTEGER NOT NULL,\n        event TEXT NOT NULL,\n        turn_hash TEXT,\n        success INTEGER NOT NULL CHECK (success IN (0, 1)),\n        observed_at TEXT NOT NULL\n      );\n      CREATE INDEX IF NOT EXISTS continuity_snapshots_cleanup\n        ON continuity_snapshots(updated_at, task_correlation, epoch);\n      CREATE INDEX IF NOT EXISTS continuity_tasks_cleanup\n        ON continuity_tasks(updated_at, task_correlation);\n      CREATE INDEX IF NOT EXISTS continuity_requests_cleanup\n        ON continuity_requests(created_at, task_correlation, epoch);\n      CREATE INDEX IF NOT EXISTS continuity_tombstones_cleanup\n        ON continuity_tombstones(purged_at, task_correlation, epoch);\n      CREATE INDEX IF NOT EXISTS continuity_observations_cleanup\n        ON continuity_observations(observed_at, task_correlation, epoch);\n    ");
    if (this.shared) this.shared.setSchemaVersion(SCHEMA_VERSION);
    else this.database.exec("PRAGMA user_version = ".concat(SCHEMA_VERSION, ";"));
  }
};

// mcp-server/src/continuity-service.ts
var TOOL_TOKEN_TTL_SECONDS = 300;
var CANDIDATE_TOKEN_TTL_SECONDS = 3600;
function ok(data) {
  return { schemaVersion: "1.0.0", ok: true, data, error: null };
}
function failure(code, message, details = null) {
  return { schemaVersion: "1.0.0", ok: false, data: null, error: { code, message, details } };
}
function withoutBinding(value) {
  const result = { ...value };
  delete result._continuityBinding;
  return result;
}
function purgeReceipt(value) {
  const receipt = value && typeof value === "object" && !Array.isArray(value) ? value : null;
  return receipt && receipt.purged === true && isBodyFreeRequestReceipt(receipt) ? receipt : null;
}
function boundedText(value, maxLength) {
  return value.length <= maxLength ? value : "".concat(value.slice(0, maxLength - 1), "\u2026");
}
function boundedStrings(values, maxItems, maxLength) {
  return values.slice(0, maxItems).map((value, index) => {
    const omitted = values.length > maxItems && index === maxItems - 1 ? " [+".concat(values.length - maxItems, " omitted]") : "";
    return boundedText(value, maxLength - omitted.length) + omitted;
  });
}
function encode(value) {
  return Buffer.from(canonicalJson(value), "utf8").toString("base64url");
}
function parseJsonToken(value) {
  const [body, signature, extra] = value.split(".");
  if (!body || !signature || extra) return null;
  try {
    const bodyBytes = Buffer.from(body, "base64url");
    const signatureBytes = Buffer.from(signature, "base64url");
    if (bodyBytes.toString("base64url") !== body || signatureBytes.toString("base64url") !== signature) return null;
    return {
      payload: JSON.parse(bodyBytes.toString("utf8")),
      body,
      signature: signatureBytes
    };
  } catch {
    return null;
  }
}
var ContinuityService = class {
  constructor(store, validator, workflowStore = null, now = () => /* @__PURE__ */ new Date()) {
    this.store = store;
    this.validator = validator;
    this.workflowStore = workflowStore;
    this.now = now;
    this.secret = store.getOrCreateSecret(() => randomBytes(32).toString("base64url"));
  }
  store;
  validator;
  workflowStore;
  now;
  secret;
  correlateSession(rawSessionId) {
    return "hmac-sha256:".concat(this.hmac("session\0".concat(rawSessionId)));
  }
  hashOpaque(kind, value) {
    return "hmac-sha256:".concat(this.hmac("".concat(kind, "\0").concat(value)));
  }
  ensureSession(rawSessionId) {
    return this.store.ensureTask(this.correlateSession(rawSessionId), this.now().toISOString());
  }
  clearSession(rawSessionId) {
    return this.store.rotateEpoch(this.correlateSession(rawSessionId), this.now().toISOString());
  }
  issueToolBinding(rawSessionId, toolName, input) {
    const task = this.ensureSession(rawSessionId);
    const payload = {
      v: 1,
      c: task.taskCorrelation,
      e: task.currentEpoch,
      t: toolName,
      d: convergenceDigest(withoutBinding(input)),
      x: Math.floor(this.now().getTime() / 1e3) + TOOL_TOKEN_TTL_SECONDS
    };
    return this.sign(payload);
  }
  checkpointContext(value) {
    return this.guard(() => {
      const request = this.validator.checkpointContextRequest(value);
      const binding = this.verifyToolBinding("checkpoint_context", request, request._continuityBinding);
      const task = this.currentTask(binding);
      if (task.rootId) throw new WorkflowContractError("SNAPSHOT_CONFLICT", "Direct checkpoints are disabled after a workflow root is bound.", { rootId: task.rootId });
      const now = this.now().toISOString();
      const current = this.currentReadValue(this.store.readCurrentState(
        binding.c,
        binding.e,
        "direct",
        () => this.store.getSnapshot(binding.c, binding.e),
        true
      ));
      const base = {
        schemaVersion: "1.0.0",
        source: "direct",
        taskCorrelation: binding.c,
        epoch: binding.e,
        revision: request.expectedRevision + 1,
        status: request.status,
        core: request.core,
        evidenceRefs: request.evidenceRefs,
        createdAt: current?.createdAt ?? now,
        updatedAt: now
      };
      const snapshot = { ...base, snapshotDigest: convergenceDigest(base) };
      const requestHash = this.hashOpaque("request", request.requestId);
      const commandDigest = convergenceDigest(withoutBinding(request));
      const stored = this.store.checkpoint(binding.c, binding.e, request.expectedRevision, requestHash, commandDigest, snapshot);
      if (stored.kind === "epoch-mismatch") return failure("BINDING_INVALID", "Continuity task binding is stale.");
      if (stored.kind === "source-conflict") return failure("SNAPSHOT_CONFLICT", "Direct checkpoints are disabled after a workflow root is bound.");
      if (stored.kind === "replay") {
        const receipt = JSON.parse(stored.request.resultJson);
        const replaySnapshot = this.currentReadValue(this.store.readCurrentState(
          binding.c,
          binding.e,
          "direct",
          () => this.store.getSnapshot(binding.c, binding.e),
          true
        ));
        if (receipt.kind !== "checkpoint" || receipt.epoch !== binding.e || !replaySnapshot || replaySnapshot.revision !== receipt.revision || replaySnapshot.snapshotDigest !== receipt.snapshotDigest) {
          return failure("STALE_REVISION", "The idempotent checkpoint result is no longer available after replacement or purge.");
        }
        return ok(replaySnapshot);
      }
      if (stored.kind === "conflict") return failure("REQUEST_CONFLICT", "requestId was already used for different checkpoint content.");
      if (stored.kind === "stale") return failure("STALE_REVISION", "The direct checkpoint revision changed.", { expectedRevision: request.expectedRevision, actualRevision: stored.actualRevision });
      return ok(snapshot);
    });
  }
  inspectContext(value) {
    return this.guard(() => {
      const request = this.validator.inspectContextRequest(value);
      const binding = this.verifyToolBinding("inspect_context", request, request._continuityBinding);
      this.currentTask(binding);
      return ok(this.candidateFor(binding.c, binding.e));
    });
  }
  loadContext(value) {
    return this.guard(() => {
      const request = this.validator.loadContextRequest(value);
      const binding = this.verifyToolBinding("load_context", request, request._continuityBinding);
      const candidate = this.verifyCandidate(request.candidateToken);
      if (candidate.c !== binding.c || candidate.e !== binding.e || candidate.e !== request.epoch || candidate.r !== request.revision || candidate.d !== request.digest) throw new WorkflowContractError("BINDING_INVALID", "Restore candidate does not match the current task and requested state.");
      const task = this.currentTask(binding);
      if (task.suppressed) throw new WorkflowContractError("SNAPSHOT_NOT_FOUND", "Restore is suppressed for the current epoch.");
      if (candidate.s === "direct") {
        const snapshot = this.currentReadValue(this.store.readCurrentState(
          binding.c,
          binding.e,
          "direct",
          () => this.store.getSnapshot(binding.c, binding.e)
        ));
        if (!snapshot || snapshot.revision !== candidate.r || snapshot.snapshotDigest !== candidate.d) {
          throw new WorkflowContractError("STALE_REVISION", "The direct restore candidate is stale.");
        }
        const { snapshotDigest, ...base } = snapshot;
        if (convergenceDigest(base) !== snapshotDigest) throw new WorkflowContractError("INTEGRITY_FAILED", "The direct snapshot digest is invalid.");
        return ok(snapshot);
      }
      const card = this.currentReadValue(this.store.readCurrentState(
        binding.c,
        binding.e,
        "workflow",
        (current) => this.workflowProjection(current)
      ));
      if (!card || card.revision !== candidate.r || card.snapshotDigest !== candidate.d) {
        throw new WorkflowContractError("STALE_REVISION", "The workflow restore candidate is stale.");
      }
      return ok(card);
    });
  }
  suppressContextRestore(value) {
    return this.guard(() => {
      const request = this.validator.suppressContextRestoreRequest(value);
      const binding = this.verifyToolBinding("suppress_context_restore", request, request._continuityBinding);
      if (request.expectedEpoch !== binding.e) throw new WorkflowContractError("STALE_REVISION", "The continuity epoch changed.", { actualEpoch: binding.e });
      if (!this.store.setSuppressed(binding.c, binding.e, this.now().toISOString())) throw new WorkflowContractError("STALE_REVISION", "The continuity epoch changed.");
      return ok({ schemaVersion: "1.0.0", suppressed: true, epoch: binding.e });
    });
  }
  purgeDirectContext(value) {
    return this.guard(() => {
      const request = this.validator.purgeDirectContextRequest(value);
      const binding = this.verifyToolBinding("purge_direct_context", request, request._continuityBinding);
      this.currentTask(binding);
      const current = this.store.getSnapshot(binding.c, request.expectedEpoch);
      if (current && current.revision !== request.expectedRevision) {
        return failure("STALE_REVISION", "The direct checkpoint revision changed.", {
          expectedRevision: request.expectedRevision,
          actualRevision: current.revision
        });
      }
      const requestHash = this.hashOpaque("request", request.requestId);
      const commandDigest = convergenceDigest(withoutBinding(request));
      const tombstoneDigest = convergenceDigest({
        taskCorrelation: binding.c,
        epoch: request.expectedEpoch,
        revision: request.expectedRevision,
        payloadDigest: current?.snapshotDigest ?? null,
        purgeRequestHash: requestHash
      });
      const now = this.now().toISOString();
      const purged = this.store.purge(binding.c, request.expectedEpoch, request.expectedRevision, requestHash, commandDigest, tombstoneDigest, now, binding.e);
      if (purged.kind === "epoch-mismatch") return failure("BINDING_INVALID", "Continuity task binding is stale.");
      if (purged.kind === "replay") {
        let replay = null;
        try {
          replay = purgeReceipt(JSON.parse(purged.request.resultJson));
        } catch {
        }
        const tombstone = this.store.getTombstone(binding.c, request.expectedEpoch);
        if (!replay || !tombstone || replay.epoch !== request.expectedEpoch || replay.revision !== request.expectedRevision || replay.revision !== tombstone.revision || replay.tombstoneDigest !== tombstone.payloadDigest || replay.purgedAt !== tombstone.purgedAt) {
          return failure("STALE_REVISION", "The idempotent purge result is no longer available.");
        }
        return ok({
          schemaVersion: "1.0.0",
          purged: true,
          epoch: replay.epoch,
          revision: replay.revision,
          tombstoneDigest: replay.tombstoneDigest,
          purgedAt: replay.purgedAt
        });
      }
      if (purged.kind === "conflict") return failure("REQUEST_CONFLICT", "requestId was already used for a different purge request.");
      if (purged.kind === "stale") return failure("STALE_REVISION", "The direct checkpoint revision changed or no payload exists.", { expectedRevision: request.expectedRevision, actualRevision: purged.actualRevision });
      return ok({ schemaVersion: "1.0.0", purged: true, epoch: request.expectedEpoch, revision: request.expectedRevision, tombstoneDigest, purgedAt: now });
    });
  }
  bindOpenedRoot(value, rootId) {
    try {
      const args = value && typeof value === "object" && !Array.isArray(value) ? value : {};
      const token = typeof args._continuityBinding === "string" ? args._continuityBinding : "";
      const binding = this.verifyToolBinding("open_convergence_root", args, token);
      return this.store.bindRoot(binding.c, binding.e, rootId, this.now().toISOString());
    } catch {
      return false;
    }
  }
  candidateForSession(rawSessionId) {
    const task = this.ensureSession(rawSessionId);
    return this.candidateFor(task.taskCorrelation);
  }
  markPreCompact(rawSessionId) {
    const task = this.ensureSession(rawSessionId);
    if (task.suppressed) return;
    const summary = this.summary(task);
    if (!summary) return;
    this.store.setPendingMarker(task.taskCorrelation, task.currentEpoch, summary.source, summary.revision, summary.snapshotDigest, task.rootId, this.now().toISOString());
  }
  compactContext(rawSessionId) {
    const task = this.ensureSession(rawSessionId);
    if (task.suppressed || task.pendingConsumed) return null;
    const summary = this.summary(task);
    if (!summary || task.pendingRevision !== summary.revision || task.pendingDigest !== summary.snapshotDigest || task.pendingSource !== summary.source) return null;
    if (summary.source === "direct") return this.formatCandidate(this.candidateFor(task.taskCorrelation, task.currentEpoch));
    const selected = this.store.readCurrentState(
      task.taskCorrelation,
      task.currentEpoch,
      "workflow",
      (current) => this.workflowProjection(current)
    );
    const card = selected.kind === "available" ? selected.value : null;
    if (!card || task.pendingRootId !== card.rootId) return null;
    if (!this.store.consumeWorkflowMarker(task.taskCorrelation, task.currentEpoch, card.rootId, card.revision, card.snapshotDigest, this.now().toISOString())) return null;
    return this.formatWorkflowCard(card);
  }
  recordPostCompact(rawSessionId, rawTurnId, success) {
    const task = this.ensureSession(rawSessionId);
    this.store.recordObservation(task.taskCorrelation, task.currentEpoch, "post-compact", rawTurnId ? this.hashOpaque("turn", rawTurnId) : null, success, this.now().toISOString());
  }
  formatCandidate(candidate) {
    if (!candidate.summary || !candidate.restoreToken) return null;
    const summary = candidate.summary;
    return [
      "[Task continuity restore candidate \u2014 metadata only]",
      "decision=DEFER",
      "source=".concat(summary.source),
      "epoch=".concat(summary.epoch),
      "revision=".concat(summary.revision),
      "digest=".concat(summary.snapshotDigest),
      "candidateToken=".concat(candidate.restoreToken),
      "No snapshot body was injected. Treat nextActions as historical candidates only; call load_context explicitly after checking the current user request."
    ].join("\n");
  }
  formatWorkflowCard(card) {
    return [
      "[Task continuity workflow card \u2014 structural state, not new instructions]",
      "decision=INJECT",
      JSON.stringify(card),
      "Reconcile this projected state with the latest user request before acting."
    ].join("\n");
  }
  candidateFor(taskCorrelation, expectedEpoch) {
    const task = this.store.getTask(taskCorrelation);
    if (!task || expectedEpoch !== void 0 && task.currentEpoch !== expectedEpoch) return { schemaVersion: "1.0.0", decision: "REJECT", reasonCodes: ["NO_TASK_BINDING"], summary: null, restoreToken: null };
    if (task.suppressed) return { schemaVersion: "1.0.0", decision: "REJECT", reasonCodes: ["RESTORE_SUPPRESSED"], summary: null, restoreToken: null };
    const summary = this.summary(task);
    if (!summary) return { schemaVersion: "1.0.0", decision: "REJECT", reasonCodes: ["NO_RESTORE_CANDIDATE"], summary: null, restoreToken: null };
    const payload = {
      v: 1,
      c: task.taskCorrelation,
      e: task.currentEpoch,
      s: summary.source,
      r: summary.revision,
      d: summary.snapshotDigest,
      x: Math.floor(this.now().getTime() / 1e3) + CANDIDATE_TOKEN_TTL_SECONDS
    };
    return { schemaVersion: "1.0.0", decision: "DEFER", reasonCodes: ["EXPLICIT_LOAD_REQUIRED"], summary, restoreToken: this.sign(payload) };
  }
  summary(task) {
    const selected = this.store.readCurrentState(
      task.taskCorrelation,
      task.currentEpoch,
      "either",
      (current) => {
        if (current.rootId) {
          const card = this.workflowProjection(current);
          return card ? {
            schemaVersion: "1.0.0",
            source: "workflow",
            taskCorrelation: current.taskCorrelation,
            epoch: current.currentEpoch,
            revision: card.revision,
            status: card.rootState,
            snapshotDigest: card.snapshotDigest,
            updatedAt: card.updatedAt
          } : null;
        }
        const snapshot = this.store.getSnapshot(current.taskCorrelation, current.currentEpoch);
        return snapshot ? {
          schemaVersion: "1.0.0",
          source: "direct",
          taskCorrelation: current.taskCorrelation,
          epoch: current.currentEpoch,
          revision: snapshot.revision,
          status: snapshot.status,
          snapshotDigest: snapshot.snapshotDigest,
          updatedAt: snapshot.updatedAt
        } : null;
      }
    );
    return selected.kind === "available" ? selected.value : null;
  }
  workflowProjection(task) {
    if (!task.rootId || !this.workflowStore) return null;
    const snapshot = this.workflowStore.getConvergenceSnapshot(task.rootId);
    if (!snapshot) return null;
    const latestRunId = snapshot.workflowRunIds.at(-1);
    const receipt = latestRunId ? this.workflowStore.getRun(latestRunId) : null;
    const base = {
      schemaVersion: "1.0.0",
      source: "workflow",
      taskCorrelation: task.taskCorrelation,
      epoch: task.currentEpoch,
      revision: snapshot.root.revision,
      rootId: boundedText(snapshot.root.rootId, 160),
      rootState: snapshot.root.state,
      taskId: boundedText(snapshot.root.taskEnvelope.taskId, 160),
      objective: boundedText(snapshot.root.taskEnvelope.objective, 800),
      includedScope: boundedStrings(snapshot.root.taskEnvelope.scope.included, 4, 120),
      acceptanceCriteria: boundedStrings(snapshot.root.taskEnvelope.acceptanceCriteria, 4, 240),
      constraints: boundedStrings(snapshot.root.taskEnvelope.constraints, 4, 240),
      authorization: {
        allowedActions: boundedStrings(snapshot.root.taskEnvelope.authorization.allowedActions, 4, 120),
        prohibitedActions: boundedStrings(snapshot.root.taskEnvelope.authorization.prohibitedActions, 4, 120),
        approvalRequired: boundedStrings(snapshot.root.taskEnvelope.authorization.approvalRequired, 4, 120)
      },
      workflowState: receipt?.state ?? null,
      currentStageId: receipt?.plan.currentStageId ?? null,
      nextStageId: receipt?.plan.nextStageId ?? null,
      blockers: boundedStrings(receipt?.blockers ?? [], 4, 200),
      unresolved: boundedStrings(receipt?.unresolved ?? [], 4, 200),
      evidenceRefs: (receipt?.stageResults ?? []).flatMap((result) => result.output.artifacts.map((item) => ({
        artifactId: boundedText(item.artifactId, 80),
        locator: boundedText(item.locator, 160),
        digest: item.digest,
        verified: item.verified
      }))).slice(0, 6),
      updatedAt: snapshot.root.updatedAt
    };
    return { ...base, snapshotDigest: convergenceDigest(base) };
  }
  currentReadValue(result) {
    if (result.kind === "epoch-mismatch") throw new WorkflowContractError("BINDING_INVALID", "Continuity task binding is stale.");
    if (result.kind === "source-conflict") throw new WorkflowContractError("SNAPSHOT_CONFLICT", "The continuity source changed.");
    if (result.kind === "suppressed") throw new WorkflowContractError("SNAPSHOT_NOT_FOUND", "Restore is suppressed for the current epoch.");
    return result.value;
  }
  currentTask(binding) {
    const task = this.store.getTask(binding.c);
    if (!task || task.currentEpoch !== binding.e) throw new WorkflowContractError("BINDING_INVALID", "Continuity task binding is stale.");
    return task;
  }
  verifyToolBinding(toolName, value, token) {
    if (!token) throw new WorkflowContractError("BINDING_REQUIRED", "A current continuity binding token is required.");
    const payload = this.verifySigned(token);
    const now = Math.floor(this.now().getTime() / 1e3);
    if (payload.v !== 1 || payload.t !== toolName || payload.x < now || payload.d !== convergenceDigest(withoutBinding(value))) {
      throw new WorkflowContractError("BINDING_INVALID", "Continuity binding token is invalid, expired, or bound to different input.");
    }
    return payload;
  }
  verifyCandidate(token) {
    const payload = this.verifySigned(token);
    if (payload.v !== 1 || payload.x < Math.floor(this.now().getTime() / 1e3) || !["direct", "workflow"].includes(payload.s)) {
      throw new WorkflowContractError("BINDING_INVALID", "Restore candidate token is invalid or expired.");
    }
    return payload;
  }
  sign(value) {
    const body = encode(value);
    const signature = createHmac("sha256", this.secret).update(body).digest("base64url");
    return "".concat(body, ".").concat(signature);
  }
  verifySigned(token) {
    const parsed = parseJsonToken(token);
    if (!parsed) throw new WorkflowContractError("BINDING_INVALID", "Signed continuity token is malformed.");
    const expected = createHmac("sha256", this.secret).update(parsed.body).digest();
    if (expected.length !== parsed.signature.length || !timingSafeEqual(expected, parsed.signature)) {
      throw new WorkflowContractError("BINDING_INVALID", "Signed continuity token failed verification.");
    }
    return parsed.payload;
  }
  hmac(value) {
    return createHmac("sha256", this.secret).update(value, "utf8").digest("hex");
  }
  guard(action) {
    try {
      return action();
    } catch (error) {
      if (error instanceof WorkflowContractError) return failure(error.code, error.message, error.details);
      if (error instanceof ContinuityStoreError) return failure("CONTINUITY_UNAVAILABLE", error.message, { reason: error.reason });
      return failure("CONTINUITY_UNAVAILABLE", "Continuity operation failed.", { reason: continuityUnavailableReason(error) });
    }
  }
};

// mcp-server/src/sqlite-workflow-store.ts
import { chmodSync as chmodSync2, mkdirSync as mkdirSync2 } from "node:fs";
import path7 from "node:path";
import { DatabaseSync as DatabaseSync3 } from "node:sqlite";

// mcp-server/src/plugin-version.ts
function parseStableVersion(version) {
  const match = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u.exec(version);
  if (!match) return null;
  const parts = match.slice(1).map((part) => Number.parseInt(part, 10));
  return parts.length === 3 && parts.every(Number.isSafeInteger) ? [parts[0], parts[1], parts[2]] : null;
}
function compareStableVersionNumbers(leftVersion, rightVersion) {
  const left = parseStableVersion(leftVersion);
  const right = parseStableVersion(rightVersion);
  if (!left || !right) throw new Error("A plugin version is not strict stable SemVer.");
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] < right[index]) return -1;
    if (left[index] > right[index]) return 1;
  }
  return 0;
}

// mcp-server/src/workflow-store.ts
function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

// mcp-server/src/plugin-update-store.ts
function timestamp(value) {
  if (value === null) return -1;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : -1;
}
function comparison(currentVersion, latestVersion) {
  if (!latestVersion) return "unknown";
  const order = compareStableVersionNumbers(currentVersion, latestVersion);
  return order < 0 ? "update-available" : order > 0 ? "ahead-of-stable" : "up-to-date";
}
function mergePluginUpdateState(existing, incoming) {
  if (!existing) return clone(incoming);
  const incomingSuccessTime = timestamp(incoming.lastSuccessfulCheckAt);
  const existingSuccessTime = timestamp(existing.lastSuccessfulCheckAt);
  const sameTimeVersionIsNotOlder = incoming.latestVersion !== null && (existing.latestVersion === null || compareStableVersionNumbers(incoming.latestVersion, existing.latestVersion) >= 0);
  const incomingSuccessIsNewer = incoming.lastSuccessfulCheckAt !== null && (incomingSuccessTime > existingSuccessTime || incomingSuccessTime === existingSuccessTime && sameTimeVersionIsNotOlder);
  const incomingAttemptIsNewer = timestamp(incoming.lastAttemptAt) >= timestamp(existing.lastAttemptAt);
  const latestVersion = incomingSuccessIsNewer ? incoming.latestVersion : existing.latestVersion;
  return {
    targetId: incoming.targetId,
    currentVersion: incoming.currentVersion,
    latestVersion,
    latestTag: incomingSuccessIsNewer ? incoming.latestTag : existing.latestTag,
    latestCommit: incomingSuccessIsNewer ? incoming.latestCommit : existing.latestCommit,
    etag: incomingSuccessIsNewer ? incoming.etag : existing.etag,
    comparison: comparison(incoming.currentVersion, latestVersion),
    lastAttemptAt: incomingAttemptIsNewer ? incoming.lastAttemptAt : existing.lastAttemptAt,
    lastSuccessfulCheckAt: incomingSuccessIsNewer ? incoming.lastSuccessfulCheckAt : existing.lastSuccessfulCheckAt,
    nextCheckAt: incomingAttemptIsNewer ? incoming.nextCheckAt : existing.nextCheckAt,
    lastNotifiedVersion: existing.lastNotifiedVersion,
    lastNotifiedAt: existing.lastNotifiedAt,
    lastErrorCode: incomingAttemptIsNewer ? incoming.lastErrorCode : existing.lastErrorCode
  };
}

// mcp-server/src/sqlite-workflow-store.ts
var SCHEMA_VERSION2 = 5;
var SqliteWorkflowStore = class {
  database;
  shared;
  databasePath;
  closed = false;
  constructor(input) {
    this.shared = typeof input === "string" ? void 0 : input;
    this.databasePath = typeof input === "string" ? input : input.databasePath;
    const databasePath = this.databasePath;
    if (this.shared) {
      this.database = this.shared.database;
      this.shared.initialize(() => this.initializeSchema());
      return;
    }
    if (!databasePath.trim()) {
      throw new WorkflowContractError("INVALID_INPUT", "Workflow database path must not be empty.");
    }
    if (databasePath !== ":memory:") {
      mkdirSync2(path7.dirname(path7.resolve(databasePath)), { recursive: true, mode: 448 });
    }
    let openedDatabase = null;
    try {
      openedDatabase = new DatabaseSync3(databasePath);
      this.database = openedDatabase;
      this.database.exec("PRAGMA busy_timeout = 5000;");
      this.database.exec("PRAGMA synchronous = FULL;");
      if (databasePath !== ":memory:") this.database.exec("PRAGMA journal_mode = WAL;");
      this.initializeSchema();
      if (databasePath !== ":memory:" && process.platform !== "win32") {
        chmodSync2(path7.resolve(databasePath), 384);
      }
    } catch (cause) {
      try {
        openedDatabase?.close();
      } catch {
      }
      throw this.storageError("Cannot initialize the workflow database.", cause);
    }
  }
  getOrCreateSecret(name, create) {
    return this.guard("Cannot read or create workflow metadata.", { key: name }, () => this.transaction(() => {
      const existing = this.database.prepare("SELECT value FROM workflow_metadata WHERE key = ?").get(name);
      if (existing) return existing.value;
      const value = create();
      this.database.prepare("\n        INSERT INTO workflow_metadata (key, value, updated_at)\n        VALUES (?, ?, ?)\n      ").run(name, value, (/* @__PURE__ */ new Date()).toISOString());
      return value;
    }));
  }
  claimExecutionObservation(observationId, expiresAt, consumedAt) {
    return this.guard("Cannot claim the trusted execution observation.", { observationId }, () => this.transaction(() => {
      const result = this.database.prepare("\n        INSERT OR IGNORE INTO execution_observation_claims(observation_id, expires_at, consumed_at)\n        VALUES (?, ?, ?)\n      ").run(observationId, expiresAt, consumedAt);
      return Number(result.changes) === 1;
    }));
  }
  nextRunSequence() {
    return this.guard("Cannot reserve the next workflow run sequence.", {}, () => this.transaction(() => {
      const row = this.database.prepare("SELECT value FROM workflow_metadata WHERE key = 'run-sequence'").get();
      const valid = !row || /^(0|[1-9][0-9]*)$/.test(row.value);
      const current = row && valid ? Number.parseInt(row.value, 10) : 0;
      if (!valid || !Number.isSafeInteger(current) || current < 0) {
        throw new WorkflowContractError("INVALID_INPUT", "Workflow run sequence is invalid.", { value: row?.value ?? null });
      }
      const next = current + 1;
      if (!Number.isSafeInteger(next)) {
        throw new WorkflowContractError("INVALID_INPUT", "Workflow run sequence is exhausted.", { value: row?.value ?? null });
      }
      this.database.prepare("\n        INSERT INTO workflow_metadata (key, value, updated_at)\n        VALUES ('run-sequence', ?, ?)\n        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at\n      ").run(String(next), (/* @__PURE__ */ new Date()).toISOString());
      return next;
    }));
  }
  insertRun(receipt) {
    const now = (/* @__PURE__ */ new Date()).toISOString();
    this.guard("Cannot persist the workflow run.", { runId: receipt.runId }, () => this.insertRunRow(receipt, now));
  }
  getRun(runId) {
    return this.guard("Cannot read the workflow run.", { runId }, () => {
      const row = this.database.prepare("\n        SELECT revision, receipt_json\n        FROM workflow_runs\n        WHERE run_id = ?\n      ").get(runId);
      if (!row) return null;
      const receipt = JSON.parse(row.receipt_json);
      if (receipt.runId !== runId || receipt.revision !== row.revision) {
        throw new WorkflowContractError("INVALID_INPUT", "Stored workflow receipt metadata does not match its payload.", {
          runId,
          storedRevision: row.revision,
          receiptRunId: receipt.runId,
          receiptRevision: receipt.revision
        });
      }
      return receipt;
    });
  }
  updateRun(receipt, expectedRevision, convergence) {
    return this.guard("Cannot update the workflow run.", { runId: receipt.runId }, () => this.transaction(() => {
      const result = this.database.prepare("\n        UPDATE workflow_runs\n        SET revision = ?, state = ?, receipt_json = ?, updated_at = ?\n        WHERE run_id = ? AND revision = ?\n      ").run(
        receipt.revision,
        receipt.state,
        JSON.stringify(receipt),
        (/* @__PURE__ */ new Date()).toISOString(),
        receipt.runId,
        expectedRevision
      );
      if (Number(result.changes) !== 1) return false;
      if (!convergence) return true;
      if (!this.casRoot(convergence.root, convergence.expectedRootRevision)) throw new WorkflowContractError("STALE_REVISION", "Convergence root changed while recording the workflow outcome.");
      const attemptUpdate = this.database.prepare("\n        UPDATE convergence_attempts\n        SET state = ?, outcome_json = ?, updated_at = ?\n        WHERE run_id = ? AND outcome_json IS NULL\n      ").run(
        convergence.outcome.state,
        JSON.stringify(convergence.outcome),
        convergence.outcome.recordedAt,
        receipt.runId
      );
      if (Number(attemptUpdate.changes) !== 1) throw new WorkflowContractError("LEASE_CONFLICT", "Guarded attempt outcome was already recorded or is missing.", { runId: receipt.runId });
      return true;
    }));
  }
  insertConvergenceRoot(root) {
    return this.guard("Cannot persist the convergence root.", { rootId: root.rootId }, () => this.transaction(() => {
      const parentRow = root.parentRootId ? this.rootRow(root.parentRootId) : void 0;
      if (root.parentRootId && !parentRow) {
        throw new WorkflowContractError("INVALID_INPUT", "Parent convergence root was not found.", { rootId: root.parentRootId });
      }
      const rows = this.database.prepare("\n        SELECT roots.root_id, roots.root_json, roots.revision, identities.identity_json, identities.surface_digest\n        FROM convergence_roots AS roots\n        LEFT JOIN convergence_root_identities AS identities ON identities.root_id = roots.root_id\n        WHERE roots.state NOT IN ('completed', 'abandoned')\n      ").all();
      const actives = rows.map((row) => {
        const active = activeRootIdentity(
          JSON.parse(row.root_json),
          row.identity_json && row.surface_digest ? this.storedIdentity(row.identity_json, row.surface_digest) : null
        );
        if (active.fresh) this.saveRootIdentity(row.root_id, active.identity, active.inferred, active.surfaceDigest, null, root.createdAt);
        return active;
      });
      const plan = planRootInsertion(root, actives);
      if (plan.conflict) return plan.conflict;
      if (parentRow) {
        const parent = JSON.parse(parentRow.root_json);
        parent.state = "abandoned";
        parent.revision += 1;
        parent.updatedAt = root.createdAt;
        this.casRoot(parent, parentRow.revision);
      }
      this.database.prepare("\n        INSERT INTO convergence_roots (root_id, revision, state, workspace_id, workspace_locator, root_json, created_at, updated_at)\n        VALUES (?, ?, ?, ?, ?, ?, ?, ?)\n      ").run(
        root.rootId,
        root.revision,
        root.state,
        root.frame.workspace.workspaceId,
        normalizeWorkspaceLocator(root.frame.workspace.locator),
        JSON.stringify(root),
        root.createdAt,
        root.updatedAt
      );
      this.insertEpoch(root, root.createdAt);
      this.saveRootIdentity(root.rootId, plan.identity, plan.inferred, plan.surfaceDigest, plan.match, root.createdAt);
      return null;
    }));
  }
  getConvergenceSnapshot(rootId) {
    return this.guard("Cannot read convergence state.", { rootId }, () => this.transaction(() => {
      const rootRow = this.rootRow(rootId);
      if (!rootRow) return null;
      const leases = this.database.prepare("SELECT lease_json, proposal_json FROM convergence_leases WHERE root_id = ? ORDER BY epoch, ordinal, issued_at").all(rootId);
      const outcomes = this.database.prepare("SELECT outcome_json FROM convergence_attempts WHERE root_id = ? AND outcome_json IS NOT NULL ORDER BY epoch, ordinal").all(rootId);
      const reviews = this.database.prepare("SELECT review_json FROM convergence_reviews WHERE root_id = ? ORDER BY reviewed_at, review_id").all(rootId);
      const links = this.database.prepare("SELECT run_id FROM workflow_attempt_links WHERE root_id = ? ORDER BY epoch, ordinal").all(rootId);
      return {
        root: JSON.parse(rootRow.root_json),
        proposals: leases.map((row) => JSON.parse(row.proposal_json)),
        leases: leases.map((row) => JSON.parse(row.lease_json)),
        outcomes: outcomes.map((row) => JSON.parse(row.outcome_json)),
        reviews: reviews.map((row) => JSON.parse(row.review_json)),
        workflowRunIds: links.map((row) => row.run_id)
      };
    }, "BEGIN;"));
  }
  updateConvergenceRoot(root, expectedRevision, review) {
    return this.guard("Cannot update the convergence root.", { rootId: root.rootId }, () => this.transaction(() => {
      const current = this.rootRow(root.rootId);
      if (!current || current.revision !== expectedRevision) return false;
      const previous = JSON.parse(current.root_json);
      if (!this.casRoot(root, expectedRevision)) return false;
      if (root.currentEpoch !== previous.currentEpoch) this.insertEpoch(root, root.updatedAt);
      if (review) {
        this.database.prepare("\n          INSERT INTO convergence_reviews (review_id, root_id, epoch, review_json, reviewed_at)\n          VALUES (?, ?, ?, ?, ?)\n        ").run(review.reviewId, review.rootId, review.epoch, JSON.stringify(review), review.reviewedAt);
      }
      return true;
    }));
  }
  insertAttemptLease(root, expectedRevision, proposal, lease) {
    return this.guard("Cannot claim the convergence attempt lease.", { rootId: root.rootId }, () => this.transaction(() => {
      if (this.shared && Date.parse(lease.expiresAt) <= this.shared.time(Date.parse(lease.issuedAt))) return false;
      if (!this.casRoot(root, expectedRevision)) return false;
      this.database.prepare("\n        INSERT INTO convergence_leases (\n          lease_id, root_id, root_revision, epoch, ordinal, state, lease_json, proposal_json, issued_at, expires_at\n        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)\n      ").run(
        lease.leaseId,
        lease.rootId,
        lease.rootRevision,
        lease.epoch,
        lease.ordinal,
        lease.state,
        JSON.stringify(lease),
        JSON.stringify(proposal),
        lease.issuedAt,
        lease.expiresAt
      );
      return true;
    }), "The convergence database is busy; read status before retrying the lease claim.");
  }
  expireAttemptLease(leaseId) {
    return this.guard("Cannot expire the convergence attempt lease.", { leaseId }, () => this.transaction(() => {
      const row = this.leaseRow(leaseId);
      if (!row) return false;
      const lease = JSON.parse(row.lease_json);
      if (lease.state !== "issued") return false;
      lease.state = "expired";
      const result = this.database.prepare("\n        UPDATE convergence_leases SET state = 'expired', lease_json = ? WHERE lease_id = ? AND state = 'issued'\n      ").run(JSON.stringify(lease), leaseId);
      return Number(result.changes) === 1;
    }));
  }
  getAttemptLease(leaseId) {
    return this.guard("Cannot read the convergence attempt lease.", { leaseId }, () => {
      const row = this.leaseRow(leaseId);
      if (!row) return null;
      const lease = JSON.parse(row.lease_json);
      const proposal = JSON.parse(row.proposal_json);
      const rootRow = this.rootRow(lease.rootId);
      if (!rootRow) return null;
      return { root: JSON.parse(rootRow.root_json), proposal, lease };
    });
  }
  insertGuardedRun(receipt, leaseId, expectedRootRevision, consumedAt) {
    return this.guard("Cannot start the guarded workflow run.", { leaseId }, () => this.transaction(() => {
      const leaseRow = this.leaseRow(leaseId);
      if (!leaseRow) return null;
      const lease = JSON.parse(leaseRow.lease_json);
      const proposal = JSON.parse(leaseRow.proposal_json);
      const decisionTime = this.shared ? this.shared.time(Date.parse(consumedAt)) : Math.max(Date.parse(consumedAt), Date.now());
      if (lease.state !== "issued" || lease.rootRevision !== expectedRootRevision || Date.parse(lease.expiresAt) <= decisionTime) return null;
      const rootRow = this.rootRow(lease.rootId);
      if (!rootRow || rootRow.revision !== expectedRootRevision) return null;
      const root = JSON.parse(rootRow.root_json);
      lease.state = "consumed";
      const leaseUpdate = this.database.prepare("\n        UPDATE convergence_leases SET state = 'consumed', lease_json = ?\n        WHERE lease_id = ? AND state = 'issued'\n      ").run(JSON.stringify(lease), leaseId);
      if (Number(leaseUpdate.changes) !== 1) return null;
      root.revision += 1;
      root.updatedAt = consumedAt;
      if (!this.casRoot(root, expectedRootRevision)) return null;
      this.insertRunRow(receipt, consumedAt);
      this.database.prepare("\n        INSERT INTO convergence_attempts (\n          root_id, epoch, ordinal, lease_id, run_id, state, outcome_json, started_at, updated_at\n        ) VALUES (?, ?, ?, ?, ?, 'running', NULL, ?, ?)\n      ").run(root.rootId, lease.epoch, lease.ordinal, lease.leaseId, receipt.runId, consumedAt, consumedAt);
      this.database.prepare("\n        INSERT INTO workflow_attempt_links (run_id, root_id, lease_id, epoch, ordinal)\n        VALUES (?, ?, ?, ?, ?)\n      ").run(receipt.runId, root.rootId, lease.leaseId, lease.epoch, lease.ordinal);
      return { root, proposal, lease, outcome: null };
    }), "The convergence database is busy or the lease was consumed concurrently.");
  }
  getGuardedRunBinding(runId) {
    return this.guard("Cannot read the guarded workflow binding.", { runId }, () => {
      const link = this.database.prepare("SELECT root_id, lease_id FROM workflow_attempt_links WHERE run_id = ?").get(runId);
      if (!link) return null;
      const rootRow = this.rootRow(link.root_id);
      const leaseRow = this.leaseRow(link.lease_id);
      const outcomeRow = this.database.prepare("SELECT outcome_json FROM convergence_attempts WHERE run_id = ?").get(runId);
      if (!rootRow || !leaseRow) return null;
      return {
        root: JSON.parse(rootRow.root_json),
        proposal: JSON.parse(leaseRow.proposal_json),
        lease: JSON.parse(leaseRow.lease_json),
        outcome: outcomeRow?.outcome_json ? JSON.parse(outcomeRow.outcome_json) : null
      };
    });
  }
  getPluginUpdateState(targetId) {
    return this.guard("Cannot read plugin update state.", { targetId }, () => this.readPluginUpdateStateRow(targetId));
  }
  putPluginUpdateState(state) {
    this.guard("Cannot persist plugin update state.", { targetId: state.targetId }, () => this.transaction(() => {
      const merged = mergePluginUpdateState(this.readPluginUpdateStateRow(state.targetId), state);
      this.database.prepare("\n      INSERT INTO plugin_update_state (\n        target_id, current_version, latest_version, latest_tag, latest_commit, etag,\n        comparison, last_attempt_at, last_successful_check_at, next_check_at,\n        last_notified_version, last_notified_at, last_error_code\n      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)\n      ON CONFLICT(target_id) DO UPDATE SET\n        current_version = excluded.current_version,\n        latest_version = excluded.latest_version,\n        latest_tag = excluded.latest_tag,\n        latest_commit = excluded.latest_commit,\n        etag = excluded.etag,\n        comparison = excluded.comparison,\n        last_attempt_at = excluded.last_attempt_at,\n        last_successful_check_at = excluded.last_successful_check_at,\n        next_check_at = excluded.next_check_at,\n        last_notified_version = excluded.last_notified_version,\n        last_notified_at = excluded.last_notified_at,\n        last_error_code = excluded.last_error_code\n      ").run(
        merged.targetId,
        merged.currentVersion,
        merged.latestVersion,
        merged.latestTag,
        merged.latestCommit,
        merged.etag,
        merged.comparison,
        merged.lastAttemptAt,
        merged.lastSuccessfulCheckAt,
        merged.nextCheckAt,
        merged.lastNotifiedVersion,
        merged.lastNotifiedAt,
        merged.lastErrorCode
      );
    }));
  }
  claimPluginUpdateNotice(targetId, latestVersion, notifiedAt) {
    return this.guard("Cannot claim plugin update notice.", { targetId, latestVersion }, () => this.transaction(() => {
      const state = this.readPluginUpdateStateRow(targetId);
      if (!state || state.latestVersion !== latestVersion || state.lastNotifiedVersion !== null && compareStableVersionNumbers(state.lastNotifiedVersion, latestVersion) >= 0) return false;
      const result = this.database.prepare("\n      UPDATE plugin_update_state\n      SET last_notified_version = ?, last_notified_at = ?\n      WHERE target_id = ?\n        AND latest_version = ?\n      ").run(latestVersion, notifiedAt, targetId, latestVersion);
      return Number(result.changes) === 1;
    }));
  }
  getSchemaVersion() {
    return this.shared?.getSchemaVersion() ?? this.database.prepare("PRAGMA user_version").get().user_version;
  }
  isConvergenceRootActive(rootId) {
    const row = this.database.prepare("\n      SELECT 1 AS active FROM convergence_roots\n      WHERE root_id = ? AND state IN ('open', 'needs-review', 'needs-user')\n    ").get(rootId);
    return Boolean(row);
  }
  withInactiveRootGuard(rootIds, operation) {
    return this.transaction(() => {
      const readState = this.database.prepare("SELECT state FROM convergence_roots WHERE root_id = ?");
      for (const rootId of [...new Set(rootIds)].sort()) {
        const row = readState.get(rootId);
        if (row && ["open", "needs-review", "needs-user"].includes(row.state)) {
          throw new WorkflowContractError("STALE_REVISION", "A continuity cleanup root became active after preview.", { rootId });
        }
      }
      return operation();
    });
  }
  previewCleanup(cutoff) {
    return this.guard("Cannot preview workflow state cleanup.", {}, () => this.transaction(() => {
      const roots = this.database.prepare("\n      SELECT root_id, revision, state, updated_at\n      FROM convergence_roots\n      WHERE state IN ('completed', 'abandoned') AND updated_at <= ?\n      ORDER BY root_id\n    ").all(cutoff);
      const linkedRuns = this.database.prepare("\n      SELECT links.run_id, runs.revision, runs.state, runs.updated_at\n      FROM workflow_attempt_links links LEFT JOIN workflow_runs runs ON runs.run_id = links.run_id\n      WHERE links.root_id = ? ORDER BY links.run_id\n    ");
      const linkedSnapshots = [];
      const rootCandidates = [];
      let linkedNonTerminalRoots = 0;
      let linkedRecentRoots = 0;
      let linkedMissingReceiptRoots = 0;
      let protectedLinkedRoots = 0;
      for (const root of roots) {
        const rows = linkedRuns.all(root.root_id);
        const reasons = /* @__PURE__ */ new Set();
        for (const row of rows) {
          if (row.revision === null || row.state === null || row.updated_at === null) {
            reasons.add("missing");
            continue;
          }
          if (!["failed", "passed", "blocked"].includes(row.state)) reasons.add("non-terminal");
          if (row.updated_at > cutoff) reasons.add("recent");
        }
        if (reasons.size > 0) {
          if (reasons.has("non-terminal")) linkedNonTerminalRoots++;
          if (reasons.has("recent")) linkedRecentRoots++;
          if (reasons.has("missing")) linkedMissingReceiptRoots++;
          protectedLinkedRoots++;
          continue;
        }
        const runs2 = rows.map((row) => ({ runId: row.run_id, revision: row.revision, state: row.state, updatedAt: row.updated_at }));
        rootCandidates.push({
          rootId: root.root_id,
          revision: root.revision,
          state: root.state,
          updatedAt: root.updated_at,
          runIds: runs2.map((run) => run.runId)
        });
        linkedSnapshots.push({ rootId: root.root_id, runs: runs2 });
      }
      const runs = this.database.prepare("\n      SELECT run_id, revision, state, updated_at\n      FROM workflow_runs\n      WHERE state IN ('failed', 'passed', 'blocked')\n        AND updated_at <= ?\n        AND NOT EXISTS (SELECT 1 FROM workflow_attempt_links links WHERE links.run_id = workflow_runs.run_id)\n      ORDER BY run_id\n    ").all(cutoff);
      const protectedRow = this.database.prepare("\n      SELECT COUNT(*) AS count FROM convergence_roots\n      WHERE state IN ('open', 'needs-review', 'needs-user')\n    ").get();
      return {
        roots: rootCandidates,
        standaloneRuns: runs.map((run) => ({
          runId: run.run_id,
          revision: run.revision,
          state: run.state,
          updatedAt: run.updated_at
        })),
        protectedActiveRoots: protectedRow.count,
        rootProtection: {
          activeRoots: protectedRow.count,
          linkedNonTerminalRoots,
          linkedRecentRoots,
          linkedMissingReceiptRoots,
          totalProtectedRoots: protectedRow.count + protectedLinkedRoots
        },
        linkedRuns: linkedSnapshots
      };
    }));
  }
  claimCleanupPlan(planId, planDigest, claimedAt) {
    return this.guard("Cannot claim the state cleanup plan.", { planId }, () => {
      const result = this.database.prepare("\n        INSERT OR IGNORE INTO state_cleanup_claims(plan_id, plan_digest, claimed_at)\n        VALUES (?, ?, ?)\n      ").run(planId, planDigest, claimedAt);
      return Number(result.changes) === 1;
    });
  }
  backupTo(targetPath) {
    if (this.shared) throw new Error("SHARED_BACKUP_OWNER_REQUIRED: a shared database backup requires an explicit owner contract.");
    if (this.databasePath === ":memory:") {
      throw new WorkflowContractError("INVALID_INPUT", "An in-memory workflow database cannot be cleaned destructively.");
    }
    this.guard("Cannot create a verified workflow cleanup backup.", { targetPath }, () => {
      this.database.prepare("VACUUM INTO ?").run(targetPath);
      const backup = new DatabaseSync3(targetPath, { readOnly: true });
      try {
        const result = backup.prepare("PRAGMA integrity_check").get();
        if (result.integrity_check !== "ok") throw new Error("integrity_check returned ".concat(result.integrity_check));
      } finally {
        backup.close();
      }
    });
  }
  executeCleanup(preview) {
    return this.guard("Cannot execute workflow state cleanup.", {}, () => this.transaction(() => {
      const verifyRoot = this.database.prepare("\n        SELECT state, revision, updated_at FROM convergence_roots WHERE root_id = ?\n      ");
      const verifyRun = this.database.prepare("\n        SELECT state, revision, updated_at FROM workflow_runs WHERE run_id = ?\n      ");
      for (const root of preview.roots) {
        const row = verifyRoot.get(root.rootId);
        if (!row || row.state !== root.state || row.revision !== root.revision || row.updated_at !== root.updatedAt) {
          throw new WorkflowContractError("STALE_REVISION", "A cleanup root changed after preview.", { rootId: root.rootId });
        }
        const actualRunIds = this.database.prepare("\n          SELECT run_id FROM workflow_attempt_links WHERE root_id = ? ORDER BY run_id\n        ").all(root.rootId).map((item) => item.run_id);
        if (JSON.stringify(actualRunIds) !== JSON.stringify(root.runIds)) {
          throw new WorkflowContractError("STALE_REVISION", "A cleanup root's linked runs changed after preview.", { rootId: root.rootId });
        }
        const expected = preview.linkedRuns.find((item) => item.rootId === root.rootId);
        if (!expected || JSON.stringify(expected.runs.map((run) => run.runId)) !== JSON.stringify(root.runIds)) {
          throw new WorkflowContractError("STALE_REVISION", "A cleanup root's linked receipt snapshot is missing.", { rootId: root.rootId });
        }
        for (const run of expected.runs) {
          const row2 = verifyRun.get(run.runId);
          if (!row2 || row2.state !== run.state || row2.revision !== run.revision || row2.updated_at !== run.updatedAt) {
            throw new WorkflowContractError("STALE_REVISION", "A cleanup linked workflow run changed after preview.", { rootId: root.rootId, runId: run.runId });
          }
        }
      }
      for (const run of preview.standaloneRuns) {
        const row = verifyRun.get(run.runId);
        if (!row || row.state !== run.state || row.revision !== run.revision || row.updated_at !== run.updatedAt) {
          throw new WorkflowContractError("STALE_REVISION", "A cleanup workflow run changed after preview.", { runId: run.runId });
        }
      }
      const deleteLinks = this.database.prepare("DELETE FROM workflow_attempt_links WHERE root_id = ?");
      const deleteAttempts = this.database.prepare("DELETE FROM convergence_attempts WHERE root_id = ?");
      const deleteReviews = this.database.prepare("DELETE FROM convergence_reviews WHERE root_id = ?");
      const deleteLeases = this.database.prepare("DELETE FROM convergence_leases WHERE root_id = ?");
      const deleteEpochs = this.database.prepare("DELETE FROM convergence_epochs WHERE root_id = ?");
      const deleteIdentity = this.database.prepare("DELETE FROM convergence_root_identities WHERE root_id = ?");
      const deleteRoot = this.database.prepare("DELETE FROM convergence_roots WHERE root_id = ?");
      const deleteRun = this.database.prepare("DELETE FROM workflow_runs WHERE run_id = ?");
      let deletedRuns = 0;
      for (const root of preview.roots) {
        deleteLinks.run(root.rootId);
        deleteAttempts.run(root.rootId);
        deleteReviews.run(root.rootId);
        deleteLeases.run(root.rootId);
        deleteEpochs.run(root.rootId);
        deleteIdentity.run(root.rootId);
        deleteRoot.run(root.rootId);
        for (const runId of root.runIds) {
          deletedRuns += Number(deleteRun.run(runId).changes);
        }
      }
      for (const run of preview.standaloneRuns) deletedRuns += Number(deleteRun.run(run.runId).changes);
      return { roots: preview.roots.length, runs: deletedRuns };
    }));
  }
  close() {
    if (this.closed) return;
    this.database.close();
    this.closed = true;
  }
  initializeSchema() {
    this.transaction(() => {
      const row = { user_version: this.getSchemaVersion() };
      if (row.user_version > SCHEMA_VERSION2) {
        throw new WorkflowContractError("INVALID_INPUT", "Workflow database schema is newer than this server supports.", {
          databasePath: this.databasePath,
          supportedVersion: SCHEMA_VERSION2,
          actualVersion: row.user_version
        });
      }
      if (row.user_version > 0 && row.user_version < 4) {
        this.database.exec("\n          ALTER TABLE workflow_runs ADD COLUMN state TEXT;\n          ALTER TABLE workflow_runs ADD COLUMN created_at TEXT;\n          UPDATE workflow_runs\n          SET state = COALESCE(json_extract(receipt_json, '$.state'), 'blocked'),\n              created_at = updated_at;\n        ");
      }
      this.database.exec("\n        CREATE TABLE IF NOT EXISTS workflow_metadata (\n          key TEXT PRIMARY KEY,\n          value TEXT NOT NULL,\n          updated_at TEXT NOT NULL\n        ) STRICT;\n        CREATE TABLE IF NOT EXISTS workflow_runs (\n          run_id TEXT PRIMARY KEY,\n          revision INTEGER NOT NULL CHECK (revision >= 0),\n          state TEXT NOT NULL CHECK (state IN ('ready', 'running', 'needs-input', 'needs-approval', 'needs-redesign', 'failed', 'passed', 'blocked')),\n          receipt_json TEXT NOT NULL,\n          created_at TEXT NOT NULL,\n          updated_at TEXT NOT NULL\n        ) STRICT;\n        CREATE INDEX IF NOT EXISTS workflow_runs_cleanup\n          ON workflow_runs(state, updated_at);\n        CREATE TABLE IF NOT EXISTS plugin_update_state (\n          target_id TEXT PRIMARY KEY,\n          current_version TEXT NOT NULL,\n          latest_version TEXT,\n          latest_tag TEXT,\n          latest_commit TEXT,\n          etag TEXT,\n          comparison TEXT NOT NULL CHECK (comparison IN ('unknown', 'up-to-date', 'update-available', 'ahead-of-stable')),\n          last_attempt_at TEXT,\n          last_successful_check_at TEXT,\n          next_check_at TEXT NOT NULL,\n          last_notified_version TEXT,\n          last_notified_at TEXT,\n          last_error_code TEXT CHECK (\n            last_error_code IS NULL\n            OR last_error_code IN ('TIMEOUT', 'NETWORK', 'HTTP', 'INVALID_RESPONSE', 'NO_STABLE_TAG')\n          )\n        ) STRICT;\n        CREATE TABLE IF NOT EXISTS convergence_roots (\n          root_id TEXT PRIMARY KEY,\n          revision INTEGER NOT NULL CHECK (revision >= 0),\n          state TEXT NOT NULL CHECK (state IN ('open', 'needs-review', 'needs-user', 'completed', 'abandoned')),\n          workspace_id TEXT NOT NULL,\n          workspace_locator TEXT NOT NULL,\n          root_json TEXT NOT NULL,\n          created_at TEXT NOT NULL,\n          updated_at TEXT NOT NULL\n        ) STRICT;\n        CREATE INDEX IF NOT EXISTS convergence_active_roots_by_workspace\n          ON convergence_roots(workspace_id, state);\n        CREATE INDEX IF NOT EXISTS convergence_active_roots_by_locator\n          ON convergence_roots(workspace_locator, state);\n        CREATE TABLE IF NOT EXISTS convergence_root_identities (\n          root_id TEXT PRIMARY KEY,\n          identity_json TEXT NOT NULL,\n          surface_digest TEXT NOT NULL,\n          replacement_match TEXT CHECK (replacement_match IS NULL OR replacement_match IN ('physical', 'lineage', 'legacy-locator')),\n          created_at TEXT NOT NULL\n        ) STRICT;\n        CREATE TABLE IF NOT EXISTS convergence_epochs (\n          root_id TEXT NOT NULL REFERENCES convergence_roots(root_id),\n          epoch INTEGER NOT NULL CHECK (epoch >= 1 AND epoch <= 2),\n          frame_digest TEXT NOT NULL,\n          created_at TEXT NOT NULL,\n          PRIMARY KEY (root_id, epoch)\n        ) STRICT;\n        CREATE TABLE IF NOT EXISTS convergence_leases (\n          lease_id TEXT PRIMARY KEY,\n          root_id TEXT NOT NULL REFERENCES convergence_roots(root_id),\n          root_revision INTEGER NOT NULL CHECK (root_revision >= 0),\n          epoch INTEGER NOT NULL CHECK (epoch >= 1 AND epoch <= 2),\n          ordinal INTEGER NOT NULL CHECK (ordinal >= 1 AND ordinal <= 3),\n          state TEXT NOT NULL CHECK (state IN ('issued', 'consumed', 'expired')),\n          lease_json TEXT NOT NULL,\n          proposal_json TEXT NOT NULL,\n          issued_at TEXT NOT NULL,\n          expires_at TEXT NOT NULL,\n          UNIQUE (root_id, epoch, ordinal, lease_id)\n        ) STRICT;\n        CREATE UNIQUE INDEX IF NOT EXISTS convergence_one_issued_lease\n          ON convergence_leases(root_id) WHERE state = 'issued';\n        CREATE TABLE IF NOT EXISTS convergence_attempts (\n          root_id TEXT NOT NULL REFERENCES convergence_roots(root_id),\n          epoch INTEGER NOT NULL CHECK (epoch >= 1 AND epoch <= 2),\n          ordinal INTEGER NOT NULL CHECK (ordinal >= 1 AND ordinal <= 3),\n          lease_id TEXT NOT NULL UNIQUE REFERENCES convergence_leases(lease_id),\n          run_id TEXT NOT NULL UNIQUE REFERENCES workflow_runs(run_id),\n          state TEXT NOT NULL CHECK (state IN ('running', 'passed', 'failed', 'aborted')),\n          outcome_json TEXT,\n          started_at TEXT NOT NULL,\n          updated_at TEXT NOT NULL,\n          PRIMARY KEY (root_id, epoch, ordinal)\n        ) STRICT;\n        CREATE TABLE IF NOT EXISTS convergence_reviews (\n          review_id TEXT PRIMARY KEY,\n          root_id TEXT NOT NULL REFERENCES convergence_roots(root_id),\n          epoch INTEGER NOT NULL CHECK (epoch >= 1 AND epoch <= 2),\n          review_json TEXT NOT NULL,\n          reviewed_at TEXT NOT NULL\n        ) STRICT;\n        CREATE TABLE IF NOT EXISTS workflow_attempt_links (\n          run_id TEXT PRIMARY KEY REFERENCES workflow_runs(run_id),\n          root_id TEXT NOT NULL REFERENCES convergence_roots(root_id),\n          lease_id TEXT NOT NULL UNIQUE REFERENCES convergence_leases(lease_id),\n          epoch INTEGER NOT NULL CHECK (epoch >= 1 AND epoch <= 2),\n          ordinal INTEGER NOT NULL CHECK (ordinal >= 1 AND ordinal <= 3)\n        ) STRICT;\n        CREATE TABLE IF NOT EXISTS state_cleanup_claims (\n          plan_id TEXT PRIMARY KEY,\n          plan_digest TEXT NOT NULL,\n          claimed_at TEXT NOT NULL\n        ) STRICT;\n        CREATE TABLE IF NOT EXISTS execution_observation_claims (\n          observation_id TEXT PRIMARY KEY,\n          expires_at TEXT NOT NULL,\n          consumed_at TEXT NOT NULL\n        ) STRICT;\n\n      ");
      if (this.shared) this.shared.setSchemaVersion(SCHEMA_VERSION2);
      else this.database.exec("PRAGMA user_version = ".concat(SCHEMA_VERSION2, ";"));
    });
  }
  rootRow(rootId) {
    return this.database.prepare("SELECT root_json, revision FROM convergence_roots WHERE root_id = ?").get(rootId);
  }
  leaseRow(leaseId) {
    return this.database.prepare("SELECT lease_json, proposal_json FROM convergence_leases WHERE lease_id = ?").get(leaseId);
  }
  /** Writes the root only if it is still at expectedRevision; true when exactly one row changed. */
  casRoot(root, expectedRevision) {
    const result = this.database.prepare("\n      UPDATE convergence_roots SET revision = ?, state = ?, root_json = ?, updated_at = ?\n      WHERE root_id = ? AND revision = ?\n    ").run(root.revision, root.state, JSON.stringify(root), root.updatedAt, root.rootId, expectedRevision);
    return Number(result.changes) === 1;
  }
  /**
   * Derived from root_json, which is never rewritten. No foreign key and no schema version bump:
   * a server without this table keeps opening and cleaning the same database, and rows it
   * leaves behind are recomputed or ignored. A refreshed identity replaces the stored one; how
   * the root was bound to its parent is kept.
   */
  saveRootIdentity(rootId, identity, inferred, surfaceDigest2, match, createdAt) {
    this.database.prepare("\n      INSERT INTO convergence_root_identities (root_id, identity_json, surface_digest, replacement_match, created_at)\n      VALUES (?, ?, ?, ?, ?)\n      ON CONFLICT(root_id) DO UPDATE SET identity_json = excluded.identity_json, surface_digest = excluded.surface_digest\n    ").run(rootId, JSON.stringify({ ...identity, inferred }), surfaceDigest2, match, createdAt);
  }
  /** `inferred` travels inside identity_json; rows written without it hold observed surfaces only. */
  storedIdentity(identityJson, surfaceDigest2) {
    const { inferred = [], ...identity } = JSON.parse(identityJson);
    return { identity, surfaceDigest: surfaceDigest2, inferred };
  }
  insertEpoch(root, createdAt) {
    this.database.prepare("\n      INSERT INTO convergence_epochs (root_id, epoch, frame_digest, created_at)\n      VALUES (?, ?, ?, ?)\n    ").run(root.rootId, root.currentEpoch, root.frameDigest, createdAt);
  }
  insertRunRow(receipt, createdAt) {
    this.database.prepare("\n      INSERT INTO workflow_runs (run_id, revision, state, receipt_json, created_at, updated_at)\n      VALUES (?, ?, ?, ?, ?, ?)\n    ").run(receipt.runId, receipt.revision, receipt.state, JSON.stringify(receipt), createdAt, createdAt);
  }
  readPluginUpdateStateRow(targetId) {
    const row = this.database.prepare("\n      SELECT target_id, current_version, latest_version, latest_tag, latest_commit, etag,\n             comparison, last_attempt_at, last_successful_check_at, next_check_at,\n             last_notified_version, last_notified_at, last_error_code\n      FROM plugin_update_state\n      WHERE target_id = ?\n    ").get(targetId);
    return row ? {
      targetId: row.target_id,
      currentVersion: row.current_version,
      latestVersion: row.latest_version,
      latestTag: row.latest_tag,
      latestCommit: row.latest_commit,
      etag: row.etag,
      comparison: row.comparison,
      lastAttemptAt: row.last_attempt_at,
      lastSuccessfulCheckAt: row.last_successful_check_at,
      nextCheckAt: row.next_check_at,
      lastNotifiedVersion: row.last_notified_version,
      lastNotifiedAt: row.last_notified_at,
      lastErrorCode: row.last_error_code
    } : null;
  }
  /** Writers take the lock up front with BEGIN IMMEDIATE; snapshot reads pass "BEGIN;". */
  transaction(operation, begin = "BEGIN IMMEDIATE;") {
    if (this.shared) return this.shared.transaction(operation);
    this.database.exec(begin);
    try {
      const result = operation();
      this.database.exec("COMMIT;");
      return result;
    } catch (cause) {
      try {
        this.database.exec("ROLLBACK;");
      } catch {
      }
      throw cause;
    }
  }
  /**
   * Keeps contract errors as they are and wraps any other failure as a storage
   * error; with contentionMessage, a busy database or a duplicate issued lease
   * becomes LEASE_CONFLICT instead.
   */
  guard(message, details, operation, contentionMessage) {
    try {
      return operation();
    } catch (cause) {
      if (cause instanceof WorkflowContractError) throw cause;
      if (contentionMessage && this.isLeaseContention(cause)) {
        throw new WorkflowContractError("LEASE_CONFLICT", contentionMessage, details);
      }
      throw this.storageError(message, cause, details);
    }
  }
  isLeaseContention(cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return /database is locked|SQLITE_BUSY|UNIQUE constraint failed: convergence_leases/iu.test(message);
  }
  /**
   * A storage or driver failure means the workflow persistence layer is unavailable, never that the
   * caller's input was invalid. A contract error raised inside the failed step keeps its own code;
   * the original cause text and SQLite result code stay in details.
   */
  storageError(message, cause, details = {}) {
    const errcode = typeof cause === "object" && cause !== null ? cause.errcode : void 0;
    return new WorkflowContractError(cause instanceof WorkflowContractError ? cause.code : "MCP_UNAVAILABLE", message, {
      ...details,
      databasePath: this.databasePath,
      cause: cause instanceof Error ? cause.message : String(cause),
      ...typeof errcode === "number" ? { sqliteErrcode: errcode } : {}
    });
  }
};

// mcp-server/src/continuity-hook.ts
var BOUND_TOOLS = /* @__PURE__ */ new Set([
  "open_convergence_root",
  "checkpoint_context",
  "inspect_context",
  "load_context",
  "suppress_context_restore",
  "purge_direct_context"
]);
function localToolName(host, canonicalName) {
  if (!isGovernanceHookTool(host, canonicalName)) return null;
  const tool = canonicalName.includes("__") ? canonicalName.split("__").at(-1) : canonicalName;
  return BOUND_TOOLS.has(tool) ? tool : null;
}
function sessionOutput(additionalContext) {
  return additionalContext ? {
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext }
  } : {};
}
function handleContinuityHook(input, service, host = "codex") {
  const adapted = adaptHostInput(input, host);
  const observation = adapted.observation;
  const event = typeof input.hook_event_name === "string" ? input.hook_event_name : "";
  const sessionId = observation.sessionId;
  if (!sessionId) return {};
  if (event === "SessionStart") {
    const source = input.source;
    if (source === "startup") {
      service.ensureSession(sessionId);
      return {};
    }
    if (source === "clear") {
      service.clearSession(sessionId);
      return {};
    }
    if (source === "resume") return sessionOutput(service.formatCandidate(service.candidateForSession(sessionId)));
    if (source === "compact") return sessionOutput(service.compactContext(sessionId));
    return {};
  }
  if (event === "PreCompact") {
    service.markPreCompact(sessionId);
    return {};
  }
  if (event === "PostCompact") {
    const turnId = typeof input.turn_id === "string" ? input.turn_id : null;
    service.recordPostCompact(sessionId, turnId, input.error === void 0 || input.error === null);
    return {};
  }
  if (observation.kind === "tool-boundary" && observation.boundaryPhase === "before") {
    if (observation.actor.kind !== "main" || observation.actor.assurance !== "observed") return {};
    const toolName = localToolName(host, observation.toolName ?? "");
    if (!toolName) return {};
    const toolInput = observation.toolInput ?? {};
    const token = service.issueToolBinding(sessionId, toolName, toolInput);
    return {
      hookSpecificOutput: {
        hookEventName: adapted.outputEventName,
        updatedInput: { ...toolInput, _continuityBinding: token }
      }
    };
  }
  return {};
}
function reportContinuityFailure(phase, cause) {
  try {
    const isObject = Boolean(cause) && (typeof cause === "object" || typeof cause === "function");
    const storeError = isObject && !types2.isProxy(cause) && cause instanceof ContinuityStoreError ? cause : null;
    const reason = producerFailureReason(cause) ?? (storeError ? storeError.reason : phase === "input" && isObject && !types2.isProxy(cause) && cause instanceof SyntaxError ? "INVALID_JSON" : "UNEXPECTED_FAILURE");
    console.error("[agent-governance-suite] continuity-hook-failure " + JSON.stringify({
      phase,
      reason,
      context: failureContext(cause),
      ...storeError && storeError.causeValue !== void 0 ? { storeCause: failureContext(storeError.causeValue) } : {}
    }));
  } catch {
  }
}
function runContinuityHook(raw, environment = process.env, host = "codex") {
  let phase = "input";
  let continuity = null;
  let workflow = null;
  try {
    const input = JSON.parse(raw);
    phase = "storage";
    const workflowDatabasePath = resolveWorkflowDatabasePath(environment);
    const continuityDatabasePath = resolveContinuityDatabasePath(environment);
    assertDistinctDatabasePaths(workflowDatabasePath, continuityDatabasePath);
    continuity = new SqliteContinuityStore(continuityDatabasePath);
    const event = input.hook_event_name;
    const source = input.source;
    const needsWorkflowProjection = event === "PreCompact" || event === "SessionStart" && (source === "resume" || source === "compact");
    if (needsWorkflowProjection) {
      try {
        workflow = new SqliteWorkflowStore(workflowDatabasePath);
      } catch (cause) {
        reportContinuityFailure("workflow-store", cause);
        workflow = null;
      }
    }
    phase = "handle";
    const output = handleContinuityHook(input, new ContinuityService(continuity, null, workflow), host);
    return Object.keys(output).length > 0 ? JSON.stringify(output) : "";
  } catch (cause) {
    reportContinuityFailure(phase, cause);
    return "";
  } finally {
    try {
      workflow?.close();
    } catch (cause) {
      reportContinuityFailure("close", cause);
    }
    try {
      continuity?.close();
    } catch (cause) {
      reportContinuityFailure("close", cause);
    }
  }
}
function main() {
  let raw;
  try {
    raw = readFileSync(0, "utf8");
  } catch (cause) {
    reportContinuityFailure("stdin", cause);
    return;
  }
  let output;
  try {
    output = runContinuityHook(raw, process.env, resolveHookHost(process.argv.slice(2), "codex"));
  } catch (cause) {
    reportContinuityFailure("host-entry", cause);
    return;
  }
  if (!output) return;
  try {
    process.stdout.write(output);
  } catch (cause) {
    reportContinuityFailure("stdout", cause);
  }
}
if (path8.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) main();
export {
  handleContinuityHook,
  runContinuityHook
};
