#!/usr/bin/env node

// mcp-server/src/session-message-cli.ts
import { readFileSync } from "node:fs";
import path3 from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";
import { setTimeout as delay2 } from "node:timers/promises";

// mcp-server/src/session-message-client.ts
import { types as utilTypes } from "node:util";

// runtime/failure-diagnostics.mjs
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
function producerFailureReason(error) {
  return error && (typeof error === "object" || typeof error === "function") ? producerReasons.get(error) ?? null : null;
}

// mcp-server/src/session-message-client.ts
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path2 from "node:path";
import { performance } from "node:perf_hooks";
import tls from "node:tls";
import { fileURLToPath } from "node:url";

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
function sharedUserStateDirectory(environment, homeDirectory) {
  const configured = environment.AGENT_GOVERNANCE_SHARED_STATE_DIR?.trim();
  if (configured) {
    if (!path.isAbsolute(configured)) {
      throw new Error("AGENT_GOVERNANCE_SHARED_STATE_DIR must be an absolute path.");
    }
    return path.normalize(configured);
  }
  return path.resolve(homeDirectory, ".agent-governance-suite");
}
function resolveSessionMessageStateDirectory(environment = process.env, platform = process.platform, homeDirectory = homedir(), currentWorkingDirectory = process.cwd()) {
  void platform;
  const configured = environment.AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR?.trim();
  if (configured) return path.resolve(currentWorkingDirectory, configured);
  return path.join(sharedUserStateDirectory(environment, homeDirectory), "session-messaging");
}

// mcp-server/src/session-message-protocol.ts
var SESSION_MESSAGE_PROTOCOL = "1.0.0";
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

// mcp-server/src/session-message-client.ts
var BrokerRequestRejected = class extends Error {
  details;
  constructor(message, details = null) {
    super(message);
    tagProducerFailure(this, "BROKER_REQUEST_REJECTED");
    const record = details && typeof details === "object" && !Array.isArray(details) ? details : null;
    this.details = record && (record.scope === "sender" || record.scope === "global") && (record.earliestReleaseAt === null || typeof record.earliestReleaseAt === "string") ? { scope: record.scope, earliestReleaseAt: record.earliestReleaseAt } : null;
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
    endpoint: path2.join(stateDirectory, "endpoint.json"),
    token: path2.join(stateDirectory, "broker.token"),
    certificate: path2.join(stateDirectory, "broker-cert.pem")
  };
}
function deadlineError(message) {
  return tagProducerFailure(new Error(message), "BROKER_DEADLINE_EXPIRED");
}
function clientFailure(reason, message, cause) {
  return utilTypes.isNativeError(cause) ? tagProducerFailure(cause, reason) : retainFailureCause(tagProducerFailure(new Error(message), reason), cause);
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
  const remaining = (inherited?.deadline ?? deadline) - performance.now();
  if (remaining < 1) throw deadlineError(inherited?.message ?? message);
  return remaining;
}
function assertWithinDeadline(deadline, signal, message) {
  remainingMilliseconds(deadline, signal, message);
}
async function withDeadline(timeoutMs, parentSignal, message, work, absoluteDeadline) {
  const parentDeadline = parentSignal ? deadlineMetadata.get(parentSignal) : void 0;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw deadlineError(parentDeadline?.message ?? message);
  const now = performance.now();
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
            frame = `${JSON.stringify({ protocolVersion: SESSION_MESSAGE_PROTOCOL, token, operation, payload })}
`;
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
async function waitForSessionMessageBrokerReady(stateDirectory, child, timeoutMs = BROKER_STARTUP_TIMEOUT_MS, parentSignal) {
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
            throw tagProducerFailure(new Error(
              `The session message broker exited before it was ready (code ${String(child.exitCode)}, signal ${String(child.signalCode)}).`
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
        const adjacentBroker = fileURLToPath(new URL("./session-message-broker.mjs", import.meta.url));
        const brokerPath = existsSync(adjacentBroker) ? adjacentBroker : fileURLToPath(new URL("../dist/session-message-broker.mjs", import.meta.url));
        if (deadlineMetadata.get(signal)?.enforceDeadline) assertWithinDeadline(deadline, signal, BROKER_STARTUP_DEADLINE_MESSAGE);
        let child;
        try {
          child = spawn(process.execPath, [brokerPath, "--state-directory", stateDirectory], {
            detached: true,
            windowsHide: true,
            stdio: "ignore",
            env: sessionMessageBrokerEnvironment()
          });
        } catch (cause) {
          throw clientFailure("BROKER_START_FAILED", "Cannot start the session message broker.", cause);
        }
        child.unref();
        await waitForSessionMessageBrokerReady(
          stateDirectory,
          child,
          remainingMilliseconds(deadline, signal, BROKER_STARTUP_DEADLINE_MESSAGE),
          signal
        );
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
  const absoluteDeadline = options.deadlineMonotonicMs ?? (options.noOperationReplay ? performance.now() + totalTimeoutMs : void 0);
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
        if (error instanceof BrokerRequestRejected || operationWriteAttempted) throw error;
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

// mcp-server/src/session-message-cli.ts
var OPERATIONS = /* @__PURE__ */ new Set(["prepare", "send", "claim", "acknowledge", "status", "pending", "wait", "reconcile-wake-observation"]);
async function runSessionMessageCli(raw, stateDirectory) {
  const request = JSON.parse(raw);
  if (typeof request.operation !== "string" || !OPERATIONS.has(request.operation)) throw new Error("Unsupported session message operation.");
  if (!request.payload || typeof request.payload !== "object" || Array.isArray(request.payload)) throw new Error("payload must be an object.");
  const payload = request.payload;
  if (request.operation === "wait") {
    const timeoutMs = payload.timeoutMs === void 0 ? 0 : payload.timeoutMs;
    if (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 36e5) throw new Error("timeoutMs is out of range.");
    const decision = await sessionMessageRequest("peer-wait", { sender: payload.sender, targets: payload.targets, timeoutMs }, stateDirectory);
    const waitedMs = decision.action === "bounded" ? Math.min(timeoutMs, 1e3) : 0;
    let snapshot = decision;
    if (waitedMs > 0) {
      await delay2(waitedMs);
      snapshot = await sessionMessageRequest("peer-wait", { sender: payload.sender, targets: payload.targets, timeoutMs: 0 }, stateDirectory);
    }
    return { protocolVersion: "1.0.0", ok: true, data: { decision, snapshot, waitedMs, next: decision.resume === "observed" ? "peer-resume" : "bounded-query-or-next-user-turn" } };
  }
  const data = await sessionMessageRequest(request.operation, payload, stateDirectory);
  return { protocolVersion: "1.0.0", ok: true, data };
}
if (path3.resolve(process.argv[1] ?? "") === fileURLToPath2(import.meta.url)) {
  let raw = "";
  try {
    raw = readFileSync(0, "utf8");
  } catch {
  }
  void runSessionMessageCli(raw).then(
    (output) => process.stdout.write(`${JSON.stringify(output)}
`),
    (error) => {
      process.stdout.write(`${JSON.stringify({ protocolVersion: "1.0.0", ok: false, error: error instanceof Error ? error.message : "Session message request failed." })}
`);
      process.exitCode = 1;
    }
  );
}
export {
  runSessionMessageCli
};
