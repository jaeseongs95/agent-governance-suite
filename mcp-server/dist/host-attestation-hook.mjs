#!/usr/bin/env node

// mcp-server/src/failure-diagnostics.ts
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
import { createHash as createHash3 } from "node:crypto";
import { types as utilTypes } from "node:util";
import { closeSync, constants, fstatSync, openSync, readSync, statSync as statSync2 } from "node:fs";
import path5 from "node:path";

// contracts/types.ts
var MODEL_CLASS = ["lightweight", "general", "deep", "frontier"];
var REASONING_EFFORT = ["low", "medium", "high", "xhigh", "max", "ultra"];
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
    `^(?:[a-z]{2,6}(?:-[a-z]{2,4})?\\.)?(?:anthropic\\.)?claude-(?:\\d+(?:-\\d+)?-)?(${sorted.join("|")})(?:[-@:.]|$)`,
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
      `^(?:[a-z]{2,6}(?:-[a-z]{2,4})?\\.)?(?:google[./-])?(?:models\\/)?(?:gemini-(?:\\d+(?:\\.\\d+)?-)?)(${sortedPrefixed.join("|")})(?:[-@:.]|$)`
    );
  }
  if (sortedBare.length > 0) {
    branches.push(`^(${sortedBare.join("|")})$`);
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
  const supportedEfforts = entry.supported_efforts && entry.supported_efforts.length > 0 ? entry.supported_efforts : REASONING_EFFORT;
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
    resolveModel(model, provenance = `${host}:adapter-policy`) {
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

// mcp-server/src/session-message-protocol.ts
var SESSION_MESSAGE_MAX_REQUEST_BYTES = 32 * 1024;
var SESSION_MESSAGE_MAX_RESPONSE_BYTES = 32 * 1024;

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
var hookHostAdapters = /* @__PURE__ */ new Map();
function registerHookHostAdapter(host, adapter) {
  if (typeof host !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(host) || !adapter || typeof adapter.deliveryProfile !== "function" || typeof adapter.processPid !== "function" || adapter.attestationKind !== void 0 && !["codex-rollout", "claude-hook"].includes(adapter.attestationKind)) throw hookHostFailure("adapter");
  if (hookHostAdapters.has(host)) throw hookHostFailure("duplicate");
  hookHostAdapters.set(host, Object.freeze({ ...adapter }));
}
function hookAttestationKind(host) {
  return hookHostAdapters.get(host)?.attestationKind;
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
  return parent === "" || child === parent || child.startsWith(`${parent}/`);
}
function unresolved(target, cause) {
  return new WorkflowContractError(
    "INVALID_INPUT",
    `Workspace identity cannot be resolved for ${target}: ${cause}.`,
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
    const target = globIndex < 0 ? entry : `${segments.slice(0, globIndex).join("/")}/`;
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
      throw new WorkflowContractError("INVALID_INPUT", `${subject} contains a non-finite number.`);
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item, subject)).join(",")}]`;
  if (value && typeof value === "object") {
    const record5 = value;
    return `{${Object.keys(record5).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record5[key], subject)}`).join(",")}}`;
  }
  throw new WorkflowContractError("INVALID_INPUT", `${subject} contains a non-serializable value.`);
}
function convergenceDigest(value) {
  return `sha256:${createHash2("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;
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
  const digest2 = surfaceDigest(root);
  const observed = stored && stored.surfaceDigest === digest2 ? stored.identity : null;
  const wasInferred = (index) => observed !== null && stored.inferred[index] === true;
  const known = { root, legacy: stored === null, observedWorkspace: observed !== null, surfaceDigest: digest2 };
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
      const scanKey = `${commonDir}\0${container.physical}`;
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
    if (typeof projectId !== "string" || !projectId.trim()) return "definite-failure";
    targetProjectId = projectId;
  } catch {
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
        socket.end(`${JSON.stringify({ type: "auth", token })}
${JSON.stringify({ type: "user", message: { role: "user", content: message }, priority: "next" })}
`);
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
function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
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
    deliveryProfile: (environment, diagnose) => deliveryProfile(codexQueueEnabled(environment, diagnose) ? "codex-queue" : "codex-deferred", true),
    processPid: (pid) => pid,
    attestationKind: "codex-rollout",
    peerWait: codexNativePeerWait
  }],
  ["claude-code", {
    deliveryProfile: () => deliveryProfile("claude-inbox", false),
    processPid: () => process.ppid,
    attestationKind: "claude-hook"
  }],
  ["gemini", {
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

// mcp-server/src/host-attestation-hook.ts
import { mkdirSync as mkdirSync2, readFileSync, renameSync, writeFileSync, writeSync } from "node:fs";
import path7 from "node:path";
import { fileURLToPath } from "node:url";

// mcp-server/src/host-attestation.ts
import { createHash as createHash4, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
var HOST_ATTESTATION_FIELD = "_hostAttestation";
var HOST_ATTESTATION_TOOLS = /* @__PURE__ */ new Set(["plan_workflow", "record_stage_result", "classify_skills", "record_skill_selection"]);
var HOST_ATTESTATION_KEY = "host_attestation_key_v1";
var TOKEN_PREFIX = "aghs1";
var TOKEN_TTL_MS = 5 * 60 * 1e3;
function record2(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}
function nonEmpty(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}
var hostIdentityDigest = (value) => createHash4("sha256").update(value, "utf8").digest("hex").slice(0, 24);
function hostActorId(host, sessionId, agentId = null) {
  return `${host}:session-${hostIdentityDigest(sessionId)}${agentId ? `:agent-${hostIdentityDigest(agentId)}` : ""}`;
}
function lowerReasoningEffort(left, right) {
  return REASONING_EFFORT.indexOf(left) <= REASONING_EFFORT.indexOf(right) ? left : right;
}
function isReasoningEffort(value) {
  return typeof value === "string" && REASONING_EFFORT.includes(value);
}
function resolveAdapterModelCapability(adapter, model, provenance = `${adapter.host}:runtime`) {
  if (typeof model !== "string" || model.length === 0) return null;
  if (typeof adapter.resolveModel === "function") {
    const resolved = adapter.resolveModel(model, provenance);
    if (!resolved || !MODEL_CLASS.includes(resolved.modelClass)) return null;
    return resolved;
  }
  const modelClass = adapter.modelClassForModel(model);
  if (!modelClass || !MODEL_CLASS.includes(modelClass)) return null;
  return {
    provider: adapter.provider ?? adapter.host,
    host: adapter.host,
    rawModel: model,
    resolvedModel: model,
    modelClass,
    minimumReasoningEffort: null,
    supportedEfforts: REASONING_EFFORT,
    aliasUsed: false,
    policyRevision: adapter.policyRevision ?? "1.0.0",
    provenance
  };
}
function satisfiesModelEffortPolicy(capability, effort) {
  if (!capability.supportedEfforts.includes(effort)) return false;
  if (capability.minimumReasoningEffort && REASONING_EFFORT.indexOf(effort) < REASONING_EFFORT.indexOf(capability.minimumReasoningEffort)) {
    return false;
  }
  return true;
}
function withoutHostAttestation(input) {
  const copy = { ...input };
  delete copy[HOST_ATTESTATION_FIELD];
  return copy;
}
function hostAttestationBinding(tool, input) {
  if (tool === "classify_skills") {
    const taskId = nonEmpty(input.requestId);
    return taskId ? { phase: "bootstrap", taskId, runId: null, stageId: null, revision: null } : null;
  }
  if (tool === "record_skill_selection") {
    const taskId = nonEmpty(record2(input.decision)?.requestDigest);
    return taskId ? { phase: "bootstrap", taskId, runId: null, stageId: null, revision: null } : null;
  }
  if (tool === "plan_workflow") {
    const taskId = nonEmpty(record2(input.taskEnvelope)?.taskId) ?? nonEmpty(input.taskId);
    return taskId ? { phase: "bootstrap", taskId, runId: null, stageId: null, revision: null } : null;
  }
  if (tool === "record_stage_result") {
    const runId = nonEmpty(input.runId);
    const stageId = nonEmpty(input.stageId);
    const revision = input.expectedRevision;
    if (!runId || !stageId || !Number.isSafeInteger(revision)) return null;
    return { phase: "stage", taskId: null, runId, stageId, revision };
  }
  return null;
}
function signingKey(store) {
  const key = Buffer.from(
    store.getOrCreateSecret(HOST_ATTESTATION_KEY, () => randomBytes(32).toString("base64url")),
    "base64url"
  );
  if (key.length !== 32) throw new WorkflowContractError("INVALID_INPUT", "Stored host attestation key is invalid.");
  return key;
}
function mac(key, body) {
  return createHmac("sha256", key).update(body, "utf8").digest("base64url");
}
function issueHostAttestation(store, adapter, observation) {
  if (!HOST_ATTESTATION_TOOLS.has(observation.tool)) return null;
  const input = withoutHostAttestation(observation.input);
  const binding = hostAttestationBinding(observation.tool, input);
  const provenance = nonEmpty(observation.provenance) ?? `${adapter.host}:runtime`;
  const capability = resolveAdapterModelCapability(adapter, observation.model, provenance);
  if (!binding || !capability || !MODEL_CLASS.includes(capability.modelClass) || !adapter.host || !isReasoningEffort(observation.reasoningEffort) || !satisfiesModelEffortPolicy(capability, observation.reasoningEffort) || !observation.actorId || !observation.sessionId || !observation.toolUseId || observation.actorId !== hostActorId(adapter.host, observation.sessionId, observation.agentId ?? null)) return null;
  const now = observation.now ?? /* @__PURE__ */ new Date();
  const scope = {
    host: adapter.host,
    session: hostIdentityDigest(observation.sessionId),
    agent: observation.agentId ? hostIdentityDigest(observation.agentId) : null,
    turn: observation.turnId ? hostIdentityDigest(observation.turnId) : null,
    call: hostIdentityDigest(observation.toolUseId)
  };
  const payload = {
    v: 1,
    ...scope,
    provider: capability.provider,
    tool: observation.tool,
    inputDigest: convergenceDigest(input),
    ...binding,
    model: observation.model,
    resolvedModel: capability.resolvedModel,
    modelClass: capability.modelClass,
    reasoningEffort: observation.reasoningEffort,
    policyRevision: capability.policyRevision,
    provenance: capability.provenance,
    actorId: observation.actorId,
    // Retrying the same host call cannot mint a second consumable observation.
    observationId: createHash4("sha256").update(JSON.stringify(scope), "utf8").digest("base64url"),
    observedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + TOKEN_TTL_MS).toISOString()
  };
  const body = `${TOKEN_PREFIX}.${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}`;
  return `${body}.${mac(signingKey(store), body)}`;
}

// mcp-server/src/codex-host-observation.ts
import { closeSync as closeSync2, fstatSync as fstatSync2, openSync as openSync2, readSync as readSync2 } from "node:fs";
var CODEX_METADATA_HEAD_BYTES = 256 * 1024;
var CODEX_METADATA_TAIL_BYTES = 8 * 1024 * 1024;
function record3(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}
var text = (value) => typeof value === "string" && value.length > 0 ? value : null;
function readCodexMetadata(file) {
  let descriptor = null;
  try {
    descriptor = openSync2(file, "r");
    const stats = fstatSync2(descriptor);
    if (!stats.isFile()) return null;
    const read = (position2, bytes) => {
      const buffer = Buffer.alloc(bytes);
      return buffer.subarray(0, readSync2(descriptor, buffer, 0, bytes, position2)).toString("utf8");
    };
    const head = read(0, Math.min(stats.size, CODEX_METADATA_HEAD_BYTES));
    const position = Math.max(0, stats.size - CODEX_METADATA_TAIL_BYTES);
    const tail = read(position, stats.size - position);
    return { head, tail: position > 0 ? tail.slice(tail.indexOf("\n") + 1) : tail };
  } catch {
    return null;
  } finally {
    if (descriptor !== null) closeSync2(descriptor);
  }
}
function observeCodexHook(input, options = {}) {
  const missing = (reason) => ({ observation: null, reason });
  const adapter = options.adapter ?? codexExecutionAdapter;
  const sessionId = text(input.session_id);
  const turnId = text(input.turn_id);
  const toolUseId = text(input.tool_use_id);
  const model = text(input.model);
  const transcript = text(input.transcript_path);
  if (!sessionId || !turnId || !toolUseId || !model || !transcript) return missing("missing-current-session-turn-call-model-or-transcript");
  if (text(input.agent_id)) return missing("subagent-identity-not-supported");
  const window = (options.readMetadata ?? readCodexMetadata)(transcript);
  if (!window) return missing("host-metadata-unreadable");
  let metadata = null;
  try {
    const first = record3(JSON.parse(window.head.split("\n", 1)[0] ?? ""));
    if (first?.type === "session_meta") metadata = record3(first.payload);
  } catch {
  }
  if (!metadata || metadata.id !== sessionId || metadata.session_id !== void 0 && metadata.session_id !== sessionId) {
    return missing("host-session-mismatch-or-unsupported-metadata");
  }
  if (record3(metadata.source)?.subagent || record3(metadata.thread_source)?.subagent) return missing("subagent-identity-not-supported");
  let context = null;
  const lines = window.tail.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line) continue;
    try {
      const entry = record3(JSON.parse(line));
      if (entry?.type === "turn_context") {
        context = record3(entry.payload);
        break;
      }
    } catch {
    }
  }
  if (!context) return missing("current-turn-metadata-outside-bounded-window-or-missing");
  if (context.turn_id !== turnId) return missing("host-turn-mismatch");
  if (context.model !== model) return missing("host-model-mismatch");
  if (!isReasoningEffort(context.effort)) return missing("host-reasoning-effort-missing-or-unsupported");
  const capability = resolveAdapterModelCapability(adapter, model, `${adapter.host}:rollout-turn-context`);
  if (!capability) return missing("host-model-policy-unsupported");
  if (!satisfiesModelEffortPolicy(capability, context.effort)) return missing("host-reasoning-effort-below-model-minimum-or-unsupported");
  return {
    observation: {
      model,
      reasoningEffort: context.effort,
      actorId: hostActorId(adapter.host, sessionId),
      sessionId,
      turnId,
      toolUseId,
      provenance: capability.provenance
    },
    reason: null
  };
}

// mcp-server/src/sqlite-workflow-store.ts
import { chmodSync, mkdirSync } from "node:fs";
import path6 from "node:path";
import { DatabaseSync as DatabaseSync2 } from "node:sqlite";

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
var SCHEMA_VERSION = 5;
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
      mkdirSync(path6.dirname(path6.resolve(databasePath)), { recursive: true, mode: 448 });
    }
    let openedDatabase = null;
    try {
      openedDatabase = new DatabaseSync2(databasePath);
      this.database = openedDatabase;
      this.database.exec("PRAGMA busy_timeout = 5000;");
      this.database.exec("PRAGMA synchronous = FULL;");
      if (databasePath !== ":memory:") this.database.exec("PRAGMA journal_mode = WAL;");
      this.initializeSchema();
      if (databasePath !== ":memory:" && process.platform !== "win32") {
        chmodSync(path6.resolve(databasePath), 384);
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
      this.database.prepare(`
        INSERT INTO workflow_metadata (key, value, updated_at)
        VALUES (?, ?, ?)
      `).run(name, value, (/* @__PURE__ */ new Date()).toISOString());
      return value;
    }));
  }
  claimExecutionObservation(observationId, expiresAt, consumedAt) {
    return this.guard("Cannot claim the trusted execution observation.", { observationId }, () => this.transaction(() => {
      const result = this.database.prepare(`
        INSERT OR IGNORE INTO execution_observation_claims(observation_id, expires_at, consumed_at)
        VALUES (?, ?, ?)
      `).run(observationId, expiresAt, consumedAt);
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
      this.database.prepare(`
        INSERT INTO workflow_metadata (key, value, updated_at)
        VALUES ('run-sequence', ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `).run(String(next), (/* @__PURE__ */ new Date()).toISOString());
      return next;
    }));
  }
  insertRun(receipt) {
    const now = (/* @__PURE__ */ new Date()).toISOString();
    this.guard("Cannot persist the workflow run.", { runId: receipt.runId }, () => this.insertRunRow(receipt, now));
  }
  getRun(runId) {
    return this.guard("Cannot read the workflow run.", { runId }, () => {
      const row = this.database.prepare(`
        SELECT revision, receipt_json
        FROM workflow_runs
        WHERE run_id = ?
      `).get(runId);
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
      const result = this.database.prepare(`
        UPDATE workflow_runs
        SET revision = ?, state = ?, receipt_json = ?, updated_at = ?
        WHERE run_id = ? AND revision = ?
      `).run(
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
      const attemptUpdate = this.database.prepare(`
        UPDATE convergence_attempts
        SET state = ?, outcome_json = ?, updated_at = ?
        WHERE run_id = ? AND outcome_json IS NULL
      `).run(
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
      const rows = this.database.prepare(`
        SELECT roots.root_id, roots.root_json, roots.revision, identities.identity_json, identities.surface_digest
        FROM convergence_roots AS roots
        LEFT JOIN convergence_root_identities AS identities ON identities.root_id = roots.root_id
        WHERE roots.state NOT IN ('completed', 'abandoned')
      `).all();
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
      this.database.prepare(`
        INSERT INTO convergence_roots (root_id, revision, state, workspace_id, workspace_locator, root_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
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
      const leases = this.database.prepare(`SELECT lease_json, proposal_json FROM convergence_leases WHERE root_id = ? ORDER BY epoch, ordinal, issued_at`).all(rootId);
      const outcomes = this.database.prepare(`SELECT outcome_json FROM convergence_attempts WHERE root_id = ? AND outcome_json IS NOT NULL ORDER BY epoch, ordinal`).all(rootId);
      const reviews = this.database.prepare(`SELECT review_json FROM convergence_reviews WHERE root_id = ? ORDER BY reviewed_at, review_id`).all(rootId);
      const links = this.database.prepare(`SELECT run_id FROM workflow_attempt_links WHERE root_id = ? ORDER BY epoch, ordinal`).all(rootId);
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
        this.database.prepare(`
          INSERT INTO convergence_reviews (review_id, root_id, epoch, review_json, reviewed_at)
          VALUES (?, ?, ?, ?, ?)
        `).run(review.reviewId, review.rootId, review.epoch, JSON.stringify(review), review.reviewedAt);
      }
      return true;
    }));
  }
  insertAttemptLease(root, expectedRevision, proposal, lease) {
    return this.guard("Cannot claim the convergence attempt lease.", { rootId: root.rootId }, () => this.transaction(() => {
      if (this.shared && Date.parse(lease.expiresAt) <= this.shared.time(Date.parse(lease.issuedAt))) return false;
      if (!this.casRoot(root, expectedRevision)) return false;
      this.database.prepare(`
        INSERT INTO convergence_leases (
          lease_id, root_id, root_revision, epoch, ordinal, state, lease_json, proposal_json, issued_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
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
      const result = this.database.prepare(`
        UPDATE convergence_leases SET state = 'expired', lease_json = ? WHERE lease_id = ? AND state = 'issued'
      `).run(JSON.stringify(lease), leaseId);
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
      const decisionTime = this.shared ? this.shared.time(Date.parse(consumedAt)) : Date.parse(consumedAt);
      if (lease.state !== "issued" || lease.rootRevision !== expectedRootRevision || Date.parse(lease.expiresAt) <= decisionTime) return null;
      const rootRow = this.rootRow(lease.rootId);
      if (!rootRow || rootRow.revision !== expectedRootRevision) return null;
      const root = JSON.parse(rootRow.root_json);
      lease.state = "consumed";
      const leaseUpdate = this.database.prepare(`
        UPDATE convergence_leases SET state = 'consumed', lease_json = ?
        WHERE lease_id = ? AND state = 'issued'
      `).run(JSON.stringify(lease), leaseId);
      if (Number(leaseUpdate.changes) !== 1) return null;
      root.revision += 1;
      root.updatedAt = consumedAt;
      if (!this.casRoot(root, expectedRootRevision)) return null;
      this.insertRunRow(receipt, consumedAt);
      this.database.prepare(`
        INSERT INTO convergence_attempts (
          root_id, epoch, ordinal, lease_id, run_id, state, outcome_json, started_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'running', NULL, ?, ?)
      `).run(root.rootId, lease.epoch, lease.ordinal, lease.leaseId, receipt.runId, consumedAt, consumedAt);
      this.database.prepare(`
        INSERT INTO workflow_attempt_links (run_id, root_id, lease_id, epoch, ordinal)
        VALUES (?, ?, ?, ?, ?)
      `).run(receipt.runId, root.rootId, lease.leaseId, lease.epoch, lease.ordinal);
      return { root, proposal, lease, outcome: null };
    }), "The convergence database is busy or the lease was consumed concurrently.");
  }
  getGuardedRunBinding(runId) {
    return this.guard("Cannot read the guarded workflow binding.", { runId }, () => {
      const link = this.database.prepare(`SELECT root_id, lease_id FROM workflow_attempt_links WHERE run_id = ?`).get(runId);
      if (!link) return null;
      const rootRow = this.rootRow(link.root_id);
      const leaseRow = this.leaseRow(link.lease_id);
      const outcomeRow = this.database.prepare(`SELECT outcome_json FROM convergence_attempts WHERE run_id = ?`).get(runId);
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
      this.database.prepare(`
      INSERT INTO plugin_update_state (
        target_id, current_version, latest_version, latest_tag, latest_commit, etag,
        comparison, last_attempt_at, last_successful_check_at, next_check_at,
        last_notified_version, last_notified_at, last_error_code
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(target_id) DO UPDATE SET
        current_version = excluded.current_version,
        latest_version = excluded.latest_version,
        latest_tag = excluded.latest_tag,
        latest_commit = excluded.latest_commit,
        etag = excluded.etag,
        comparison = excluded.comparison,
        last_attempt_at = excluded.last_attempt_at,
        last_successful_check_at = excluded.last_successful_check_at,
        next_check_at = excluded.next_check_at,
        last_notified_version = excluded.last_notified_version,
        last_notified_at = excluded.last_notified_at,
        last_error_code = excluded.last_error_code
      `).run(
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
      const result = this.database.prepare(`
      UPDATE plugin_update_state
      SET last_notified_version = ?, last_notified_at = ?
      WHERE target_id = ?
        AND latest_version = ?
      `).run(latestVersion, notifiedAt, targetId, latestVersion);
      return Number(result.changes) === 1;
    }));
  }
  getSchemaVersion() {
    return this.shared?.getSchemaVersion() ?? this.database.prepare("PRAGMA user_version").get().user_version;
  }
  isConvergenceRootActive(rootId) {
    const row = this.database.prepare(`
      SELECT 1 AS active FROM convergence_roots
      WHERE root_id = ? AND state IN ('open', 'needs-review', 'needs-user')
    `).get(rootId);
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
      const roots = this.database.prepare(`
      SELECT root_id, revision, state, updated_at
      FROM convergence_roots
      WHERE state IN ('completed', 'abandoned') AND updated_at <= ?
      ORDER BY root_id
    `).all(cutoff);
      const linkedRuns = this.database.prepare(`
      SELECT links.run_id, runs.revision, runs.state, runs.updated_at
      FROM workflow_attempt_links links LEFT JOIN workflow_runs runs ON runs.run_id = links.run_id
      WHERE links.root_id = ? ORDER BY links.run_id
    `);
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
      const runs = this.database.prepare(`
      SELECT run_id, revision, state, updated_at
      FROM workflow_runs
      WHERE state IN ('failed', 'passed', 'blocked')
        AND updated_at <= ?
        AND NOT EXISTS (SELECT 1 FROM workflow_attempt_links links WHERE links.run_id = workflow_runs.run_id)
      ORDER BY run_id
    `).all(cutoff);
      const protectedRow = this.database.prepare(`
      SELECT COUNT(*) AS count FROM convergence_roots
      WHERE state IN ('open', 'needs-review', 'needs-user')
    `).get();
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
      const result = this.database.prepare(`
        INSERT OR IGNORE INTO state_cleanup_claims(plan_id, plan_digest, claimed_at)
        VALUES (?, ?, ?)
      `).run(planId, planDigest, claimedAt);
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
      const backup = new DatabaseSync2(targetPath, { readOnly: true });
      try {
        const result = backup.prepare("PRAGMA integrity_check").get();
        if (result.integrity_check !== "ok") throw new Error(`integrity_check returned ${result.integrity_check}`);
      } finally {
        backup.close();
      }
    });
  }
  executeCleanup(preview) {
    return this.guard("Cannot execute workflow state cleanup.", {}, () => this.transaction(() => {
      const verifyRoot = this.database.prepare(`
        SELECT state, revision, updated_at FROM convergence_roots WHERE root_id = ?
      `);
      const verifyRun = this.database.prepare(`
        SELECT state, revision, updated_at FROM workflow_runs WHERE run_id = ?
      `);
      for (const root of preview.roots) {
        const row = verifyRoot.get(root.rootId);
        if (!row || row.state !== root.state || row.revision !== root.revision || row.updated_at !== root.updatedAt) {
          throw new WorkflowContractError("STALE_REVISION", "A cleanup root changed after preview.", { rootId: root.rootId });
        }
        const actualRunIds = this.database.prepare(`
          SELECT run_id FROM workflow_attempt_links WHERE root_id = ? ORDER BY run_id
        `).all(root.rootId).map((item) => item.run_id);
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
    const row = { user_version: this.getSchemaVersion() };
    if (row.user_version > SCHEMA_VERSION) {
      throw new WorkflowContractError("INVALID_INPUT", "Workflow database schema is newer than this server supports.", {
        databasePath: this.databasePath,
        supportedVersion: SCHEMA_VERSION,
        actualVersion: row.user_version
      });
    }
    this.transaction(() => {
      if (row.user_version > 0 && row.user_version < 4) {
        this.database.exec(`
          ALTER TABLE workflow_runs ADD COLUMN state TEXT;
          ALTER TABLE workflow_runs ADD COLUMN created_at TEXT;
          UPDATE workflow_runs
          SET state = COALESCE(json_extract(receipt_json, '$.state'), 'blocked'),
              created_at = updated_at;
        `);
      }
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS workflow_metadata (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS workflow_runs (
          run_id TEXT PRIMARY KEY,
          revision INTEGER NOT NULL CHECK (revision >= 0),
          state TEXT NOT NULL CHECK (state IN ('ready', 'running', 'needs-input', 'needs-approval', 'needs-redesign', 'failed', 'passed', 'blocked')),
          receipt_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;
        CREATE INDEX IF NOT EXISTS workflow_runs_cleanup
          ON workflow_runs(state, updated_at);
        CREATE TABLE IF NOT EXISTS plugin_update_state (
          target_id TEXT PRIMARY KEY,
          current_version TEXT NOT NULL,
          latest_version TEXT,
          latest_tag TEXT,
          latest_commit TEXT,
          etag TEXT,
          comparison TEXT NOT NULL CHECK (comparison IN ('unknown', 'up-to-date', 'update-available', 'ahead-of-stable')),
          last_attempt_at TEXT,
          last_successful_check_at TEXT,
          next_check_at TEXT NOT NULL,
          last_notified_version TEXT,
          last_notified_at TEXT,
          last_error_code TEXT CHECK (
            last_error_code IS NULL
            OR last_error_code IN ('TIMEOUT', 'NETWORK', 'HTTP', 'INVALID_RESPONSE', 'NO_STABLE_TAG')
          )
        ) STRICT;
        CREATE TABLE IF NOT EXISTS convergence_roots (
          root_id TEXT PRIMARY KEY,
          revision INTEGER NOT NULL CHECK (revision >= 0),
          state TEXT NOT NULL CHECK (state IN ('open', 'needs-review', 'needs-user', 'completed', 'abandoned')),
          workspace_id TEXT NOT NULL,
          workspace_locator TEXT NOT NULL,
          root_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;
        CREATE INDEX IF NOT EXISTS convergence_active_roots_by_workspace
          ON convergence_roots(workspace_id, state);
        CREATE INDEX IF NOT EXISTS convergence_active_roots_by_locator
          ON convergence_roots(workspace_locator, state);
        CREATE TABLE IF NOT EXISTS convergence_root_identities (
          root_id TEXT PRIMARY KEY,
          identity_json TEXT NOT NULL,
          surface_digest TEXT NOT NULL,
          replacement_match TEXT CHECK (replacement_match IS NULL OR replacement_match IN ('physical', 'lineage', 'legacy-locator')),
          created_at TEXT NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS convergence_epochs (
          root_id TEXT NOT NULL REFERENCES convergence_roots(root_id),
          epoch INTEGER NOT NULL CHECK (epoch >= 1 AND epoch <= 2),
          frame_digest TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (root_id, epoch)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS convergence_leases (
          lease_id TEXT PRIMARY KEY,
          root_id TEXT NOT NULL REFERENCES convergence_roots(root_id),
          root_revision INTEGER NOT NULL CHECK (root_revision >= 0),
          epoch INTEGER NOT NULL CHECK (epoch >= 1 AND epoch <= 2),
          ordinal INTEGER NOT NULL CHECK (ordinal >= 1 AND ordinal <= 3),
          state TEXT NOT NULL CHECK (state IN ('issued', 'consumed', 'expired')),
          lease_json TEXT NOT NULL,
          proposal_json TEXT NOT NULL,
          issued_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          UNIQUE (root_id, epoch, ordinal, lease_id)
        ) STRICT;
        CREATE UNIQUE INDEX IF NOT EXISTS convergence_one_issued_lease
          ON convergence_leases(root_id) WHERE state = 'issued';
        CREATE TABLE IF NOT EXISTS convergence_attempts (
          root_id TEXT NOT NULL REFERENCES convergence_roots(root_id),
          epoch INTEGER NOT NULL CHECK (epoch >= 1 AND epoch <= 2),
          ordinal INTEGER NOT NULL CHECK (ordinal >= 1 AND ordinal <= 3),
          lease_id TEXT NOT NULL UNIQUE REFERENCES convergence_leases(lease_id),
          run_id TEXT NOT NULL UNIQUE REFERENCES workflow_runs(run_id),
          state TEXT NOT NULL CHECK (state IN ('running', 'passed', 'failed', 'aborted')),
          outcome_json TEXT,
          started_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (root_id, epoch, ordinal)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS convergence_reviews (
          review_id TEXT PRIMARY KEY,
          root_id TEXT NOT NULL REFERENCES convergence_roots(root_id),
          epoch INTEGER NOT NULL CHECK (epoch >= 1 AND epoch <= 2),
          review_json TEXT NOT NULL,
          reviewed_at TEXT NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS workflow_attempt_links (
          run_id TEXT PRIMARY KEY REFERENCES workflow_runs(run_id),
          root_id TEXT NOT NULL REFERENCES convergence_roots(root_id),
          lease_id TEXT NOT NULL UNIQUE REFERENCES convergence_leases(lease_id),
          epoch INTEGER NOT NULL CHECK (epoch >= 1 AND epoch <= 2),
          ordinal INTEGER NOT NULL CHECK (ordinal >= 1 AND ordinal <= 3)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS state_cleanup_claims (
          plan_id TEXT PRIMARY KEY,
          plan_digest TEXT NOT NULL,
          claimed_at TEXT NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS execution_observation_claims (
          observation_id TEXT PRIMARY KEY,
          expires_at TEXT NOT NULL,
          consumed_at TEXT NOT NULL
        ) STRICT;

      `);
      if (this.shared) this.shared.setSchemaVersion(SCHEMA_VERSION);
      else this.database.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
    });
  }
  rootRow(rootId) {
    return this.database.prepare(`SELECT root_json, revision FROM convergence_roots WHERE root_id = ?`).get(rootId);
  }
  leaseRow(leaseId) {
    return this.database.prepare(`SELECT lease_json, proposal_json FROM convergence_leases WHERE lease_id = ?`).get(leaseId);
  }
  /** Writes the root only if it is still at expectedRevision; true when exactly one row changed. */
  casRoot(root, expectedRevision) {
    const result = this.database.prepare(`
      UPDATE convergence_roots SET revision = ?, state = ?, root_json = ?, updated_at = ?
      WHERE root_id = ? AND revision = ?
    `).run(root.revision, root.state, JSON.stringify(root), root.updatedAt, root.rootId, expectedRevision);
    return Number(result.changes) === 1;
  }
  /**
   * Derived from root_json, which is never rewritten. No foreign key and no schema version bump:
   * a server without this table keeps opening and cleaning the same database, and rows it
   * leaves behind are recomputed or ignored. A refreshed identity replaces the stored one; how
   * the root was bound to its parent is kept.
   */
  saveRootIdentity(rootId, identity, inferred, surfaceDigest2, match, createdAt) {
    this.database.prepare(`
      INSERT INTO convergence_root_identities (root_id, identity_json, surface_digest, replacement_match, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(root_id) DO UPDATE SET identity_json = excluded.identity_json, surface_digest = excluded.surface_digest
    `).run(rootId, JSON.stringify({ ...identity, inferred }), surfaceDigest2, match, createdAt);
  }
  /** `inferred` travels inside identity_json; rows written without it hold observed surfaces only. */
  storedIdentity(identityJson, surfaceDigest2) {
    const { inferred = [], ...identity } = JSON.parse(identityJson);
    return { identity, surfaceDigest: surfaceDigest2, inferred };
  }
  insertEpoch(root, createdAt) {
    this.database.prepare(`
      INSERT INTO convergence_epochs (root_id, epoch, frame_digest, created_at)
      VALUES (?, ?, ?, ?)
    `).run(root.rootId, root.currentEpoch, root.frameDigest, createdAt);
  }
  insertRunRow(receipt, createdAt) {
    this.database.prepare(`
      INSERT INTO workflow_runs (run_id, revision, state, receipt_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(receipt.runId, receipt.revision, receipt.state, JSON.stringify(receipt), createdAt, createdAt);
  }
  readPluginUpdateStateRow(targetId) {
    const row = this.database.prepare(`
      SELECT target_id, current_version, latest_version, latest_tag, latest_commit, etag,
             comparison, last_attempt_at, last_successful_check_at, next_check_at,
             last_notified_version, last_notified_at, last_error_code
      FROM plugin_update_state
      WHERE target_id = ?
    `).get(targetId);
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
  storageError(message, cause, details = {}) {
    return new WorkflowContractError("INVALID_INPUT", message, {
      ...details,
      databasePath: this.databasePath,
      cause: cause instanceof Error ? cause.message : String(cause)
    });
  }
};

// mcp-server/src/host-attestation-hook.ts
var HOST_SKILL_OBSERVATION_FIELD = "_hostSkillObservation";
function withoutCallerHostClaims(input) {
  const clean = withoutHostAttestation(input);
  delete clean[HOST_SKILL_OBSERVATION_FIELD];
  return clean;
}
var HookObservationFailure = class extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
  code;
};
function reportObservationFailure(phase, reason, cause) {
  try {
    writeSync(2, JSON.stringify({
      component: "host-attestation-hook",
      phase,
      reason,
      ...cause === void 0 ? {} : { context: failureContext(cause) }
    }) + "\n");
  } catch {
  }
}
function record4(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}
function text2(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}
function readTextOrNull(file) {
  try {
    return readFileSync(file, "utf8");
  } catch (cause) {
    if (cause.code === "ENOENT") return null;
    throw new HookObservationFailure("TRANSCRIPT_READ_FAILED");
  }
}
var digest = hostIdentityDigest;
function claudeCodeActorId(sessionId, agentId) {
  return hostActorId(claudeCodeExecutionAdapter.host, sessionId, agentId);
}
function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}
function transcriptCandidates(transcriptPath, sessionId, agentId) {
  const candidates = [transcriptPath];
  if (agentId) {
    candidates.push(path7.join(path7.dirname(transcriptPath), sessionId, "subagents", `agent-${agentId}.jsonl`));
  }
  return [...new Set(candidates)];
}
function findToolUseObservation(transcript, toolUseId, sessionId, agentId) {
  const lines = transcript.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line || !mentionsToolUseId(line, toolUseId)) continue;
    let entry;
    try {
      entry = record4(JSON.parse(line));
    } catch {
      continue;
    }
    if (!entry || entry.type !== "assistant") continue;
    const message = record4(entry.message);
    const content = Array.isArray(message?.content) ? message.content : [];
    const issued = content.some((block) => record4(block)?.type === "tool_use" && record4(block)?.id === toolUseId);
    if (!issued) continue;
    if (entry.sessionId !== void 0 && entry.sessionId !== sessionId) return null;
    if (agentId ? entry.agentId !== agentId : entry.isSidechain === true) return null;
    const model = text2(message?.model);
    if (!model) return null;
    return { model, effort: text2(entry.effort) };
  }
  return null;
}
function findLatestAssistantObservation(transcript, sessionId, agentId, nowMs = Date.now(), adapter = claudeCodeExecutionAdapter) {
  const lines = transcript.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line?.includes('"assistant"')) continue;
    let entry;
    try {
      entry = record4(JSON.parse(line));
    } catch {
      continue;
    }
    if (!entry || entry.type !== "assistant") continue;
    if (entry.sessionId !== sessionId) continue;
    if (agentId ? entry.agentId !== agentId : entry.isSidechain === true) continue;
    const at = Date.parse(text2(entry.timestamp) ?? "");
    if (Number.isNaN(at) || at > nowMs) continue;
    const model = text2(record4(entry.message)?.model);
    if (!model || !resolveAdapterModelCapability(adapter, model, `${adapter.host}:transcript-latest`)) continue;
    return { model, at };
  }
  return null;
}
function mentionsToolUseId(line, toolUseId) {
  if (line.includes(toolUseId)) return true;
  if (!line.includes("\\")) return false;
  if (/^[A-Za-z0-9._:-]+$/u.test(toolUseId) && !line.includes("\\u")) return false;
  const decoded = line.replace(
    /\\(?:u[0-9a-fA-F]{4}|["\\/bfnrt])/gu,
    (escape) => JSON.parse('"' + escape + '"')
  );
  return decoded.includes(toolUseId);
}
function probeIssuingMessage(transcript, toolUseId) {
  for (const line of transcript.split("\n")) {
    if (!mentionsToolUseId(line, toolUseId)) continue;
    let entry;
    try {
      entry = record4(JSON.parse(line));
    } catch {
      return { state: "indeterminate", reason: "CURRENT_CALL_INVALID_JSON" };
    }
    if (!entry) return { state: "indeterminate", reason: "CURRENT_CALL_INVALID_SHAPE" };
    const message = record4(entry.message);
    if (entry.type !== "assistant") {
      if (entry.type !== "user" && entry.type !== "system" && Array.isArray(message?.content) && message.content.some((value) => record4(value)?.id === toolUseId)) {
        return { state: "indeterminate", reason: "CURRENT_CALL_INVALID_SHAPE" };
      }
      continue;
    }
    if (!message || !Array.isArray(message.content)) {
      return { state: "indeterminate", reason: "CURRENT_CALL_INVALID_SHAPE" };
    }
    for (const value of message.content) {
      const block = record4(value);
      if (!block) {
        if (typeof value === "string" && value.includes(toolUseId))
          return { state: "indeterminate", reason: "CURRENT_CALL_INVALID_SHAPE" };
        continue;
      }
      if (block.id === toolUseId) {
        if (block.type === "tool_use") return { state: "present" };
        if (block.type !== "text" && block.type !== "tool_result")
          return { state: "indeterminate", reason: "CURRENT_CALL_INVALID_SHAPE" };
      }
      if (block.type !== "tool_use") continue;
      if (!text2(block.id)) return { state: "indeterminate", reason: "CURRENT_CALL_INVALID_SHAPE" };
    }
  }
  return { state: "absent" };
}
function sessionModelUpdate(input, now = /* @__PURE__ */ new Date()) {
  const sessionId = text2(input.session_id);
  if (!sessionId || text2(input.agent_id)) return null;
  const source = input.hook_event_name === "SessionStart" ? "session-start" : input.hook_event_name === "PostModelSwitch" ? "model-switch" : null;
  const model = source === "session-start" ? text2(input.model) : source === "model-switch" ? text2(input.to_model) : null;
  return source && model ? { sessionId, record: { model, source, observedAt: now.toISOString() } } : null;
}
function sessionModelFile(directory, sessionId) {
  return path7.join(directory, `${digest(sessionId)}.json`);
}
function writeSessionModel(directory, sessionId, value) {
  mkdirSync2(directory, { recursive: true });
  const file = sessionModelFile(directory, sessionId);
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value), "utf8");
  renameSync(temporary, file);
}
function readSessionModel(directory, sessionId) {
  try {
    const value = record4(JSON.parse(readFileSync(sessionModelFile(directory, sessionId), "utf8")));
    const model = text2(value?.model);
    const source = value?.source === "session-start" || value?.source === "model-switch" ? value.source : null;
    const observedAt = text2(value?.observedAt);
    if (!model || !source || !observedAt || Number.isNaN(Date.parse(observedAt))) {
      throw new HookObservationFailure("SESSION_MODEL_INVALID");
    }
    return { model, source, observedAt };
  } catch (cause) {
    if (cause.code === "ENOENT") return null;
    if (cause instanceof HookObservationFailure) throw cause;
    throw new HookObservationFailure(cause instanceof SyntaxError ? "SESSION_MODEL_INVALID" : "SESSION_MODEL_READ_FAILED");
  }
}
function attestedToolInput(input) {
  if (input.hook_event_name !== "PreToolUse") return null;
  const canonicalName = text2(input.tool_name) ?? "";
  if (!/^mcp__(?:plugin_agent-governance-suite_agent-governance-suite|agent[-_]governance[-_]suite)__/u.test(canonicalName)) return null;
  const tool = canonicalName.split("__").at(-1) ?? "";
  const toolInput = record4(input.tool_input);
  return HOST_ATTESTATION_TOOLS.has(tool) && toolInput ? { tool, toolInput } : null;
}
function withoutCallerAttestation(input) {
  const target = attestedToolInput(input);
  if (!target || !Object.prototype.hasOwnProperty.call(target.toolInput, HOST_ATTESTATION_FIELD) && !Object.prototype.hasOwnProperty.call(target.toolInput, HOST_SKILL_OBSERVATION_FIELD)) return {};
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      updatedInput: withoutCallerHostClaims(target.toolInput)
    }
  };
}
function observedEffort(hookEffort, messageEffort) {
  const hook = isReasoningEffort(hookEffort) ? hookEffort : null;
  const message = isReasoningEffort(messageEffort) ? messageEffort : null;
  if (hook && message) return lowerReasoningEffort(hook, message);
  return hook ?? message;
}
function handleHostAttestationHook(input, store, options = {}) {
  const target = attestedToolInput(input);
  if (!target) return {};
  const { tool } = target;
  const adapter = options.adapter ?? claudeCodeExecutionAdapter;
  const toolInput = withoutCallerHostClaims(target.toolInput);
  const unattested = () => withoutCallerAttestation(input);
  const sessionId = text2(input.session_id);
  const toolUseId = text2(input.tool_use_id);
  const transcriptPath = text2(input.transcript_path);
  if (!sessionId || !toolUseId || !transcriptPath) return unattested();
  const agentId = text2(input.agent_id);
  const readText = options.readText ?? readTextOrNull;
  const sleep = options.sleep ?? sleepSync;
  const maxWaitMs = options.maxWaitMs ?? 300;
  const pollIntervalMs = options.pollIntervalMs ?? 100;
  const candidates = transcriptCandidates(transcriptPath, sessionId, agentId);
  let observation = null;
  let provenance = `${adapter.host}:transcript-tool-use`;
  for (let waited = 0; ; waited += pollIntervalMs) {
    for (const candidate of candidates) {
      const transcript = readText(candidate);
      observation = transcript ? findToolUseObservation(transcript, toolUseId, sessionId, agentId) : null;
      if (observation) break;
    }
    if (observation || waited >= maxWaitMs) break;
    sleep(pollIntervalMs);
  }
  if (!observation) {
    const transcripts = candidates.map((candidate) => readText(candidate) ?? "");
    for (const transcript of transcripts) {
      const probe = probeIssuingMessage(transcript, toolUseId);
      if (probe.state === "indeterminate") {
        reportObservationFailure("fallback", probe.reason);
        return unattested();
      }
      if (probe.state === "present") return unattested();
    }
    const nowMs = (options.now?.() ?? /* @__PURE__ */ new Date()).getTime();
    let latest = null;
    for (const transcript of transcripts) {
      latest = findLatestAssistantObservation(transcript, sessionId, agentId, nowMs, adapter);
      if (latest) break;
    }
    const session = agentId ? null : options.readSessionModel?.(sessionId) ?? null;
    const useSession = Boolean(session && (!latest || Date.parse(session.observedAt) >= latest.at));
    const model = useSession ? session.model : latest?.model;
    provenance = useSession ? `${adapter.host}:${session.source}` : `${adapter.host}:transcript-latest`;
    observation = model ? { model, effort: null } : null;
  }
  if (!observation) return unattested();
  const effort = observedEffort(text2(record4(input.effort)?.level), observation.effort);
  if (!effort) return unattested();
  const token = issueHostAttestation(store, adapter, {
    tool,
    input: toolInput,
    model: observation.model,
    reasoningEffort: effort,
    actorId: hostActorId(adapter.host, sessionId, agentId),
    sessionId,
    agentId,
    turnId: text2(input.turn_id),
    toolUseId,
    provenance,
    ...options.now ? { now: options.now() } : {}
  });
  if (!token) return unattested();
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      updatedInput: { ...toolInput, [HOST_ATTESTATION_FIELD]: token }
    }
  };
}
function handleCodexHostAttestationHook(input, store, options = {}) {
  const target = attestedToolInput(input);
  if (!target) return {};
  const adapter = options.adapter ?? codexExecutionAdapter;
  const observed = observeCodexHook(input, options);
  const clean = withoutCallerHostClaims(target.toolInput);
  const token = observed.observation ? issueHostAttestation(store, adapter, {
    ...observed.observation,
    tool: target.tool,
    input: clean,
    ...options.now ? { now: options.now() } : {}
  }) : null;
  return {
    ...!token ? { systemMessage: `AGS execution observation unavailable: ${observed.reason ?? "invalid-workflow-binding"}. Requires the current host session/turn/model/effort and tool call; caller settings cannot supply them.` } : {},
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      updatedInput: token ? { ...clean, [HOST_ATTESTATION_FIELD]: token } : clean
    }
  };
}
async function main() {
  let store = null;
  let input = {};
  let output;
  let codex = false;
  let phase = "input";
  try {
    const parsed = record4(JSON.parse(readFileSync(0, "utf8")));
    if (!parsed) throw new HookObservationFailure("INVALID_HOOK_INPUT");
    input = parsed;
    phase = "host-entry";
    const host = resolveHookHost(process.argv.slice(2), "claude-code");
    const attestationKind = hookAttestationKind(host);
    if (!attestationKind) {
      output = withoutCallerAttestation(input);
      if (Object.keys(output).length > 0) process.stdout.write(JSON.stringify(output));
      return;
    }
    codex = attestationKind === "codex-rollout";
    phase = "storage";
    const databasePath = resolveWorkflowDatabasePath();
    const modelDirectory = path7.join(path7.dirname(databasePath), "host-models");
    const update = codex ? null : sessionModelUpdate(input);
    if (update) {
      writeSessionModel(modelDirectory, update.sessionId, update.record);
      return;
    }
    store = new SqliteWorkflowStore(databasePath);
    phase = "observation";
    output = codex ? handleCodexHostAttestationHook(input, store) : handleHostAttestationHook(input, store, { readSessionModel: (sessionId) => readSessionModel(modelDirectory, sessionId) });
  } catch (cause) {
    const reason = producerFailureReason(cause) ?? (cause instanceof HookObservationFailure ? cause.code : cause instanceof SyntaxError && phase === "input" ? "INVALID_JSON" : "OBSERVATION_UNAVAILABLE");
    reportObservationFailure(phase, reason, cause);
    output = withoutCallerAttestation(input);
    if (codex && attestedToolInput(input)) {
      output.systemMessage = "AGS execution observation unavailable: adapter-read-or-storage-failed. No caller attestation is trusted.";
      if (record4(output.hookSpecificOutput)) output.hookSpecificOutput.permissionDecision = "allow";
    }
  } finally {
    try {
      store?.close();
    } catch {
      reportObservationFailure("store-close", "STORE_CLOSE_FAILED");
    }
  }
  if (Object.keys(output).length > 0) process.stdout.write(JSON.stringify(output));
}
if (path7.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) await main();
export {
  claudeCodeActorId,
  findLatestAssistantObservation,
  findToolUseObservation,
  handleCodexHostAttestationHook,
  handleHostAttestationHook,
  observedEffort,
  probeIssuingMessage,
  readSessionModel,
  sessionModelUpdate,
  transcriptCandidates,
  withoutCallerAttestation,
  writeSessionModel
};
