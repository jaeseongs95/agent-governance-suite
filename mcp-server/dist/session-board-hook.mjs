#!/usr/bin/env node

// mcp-server/src/failure-diagnostics.ts
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

// mcp-server/src/session-board-hook.ts
import { readFileSync } from "node:fs";
import path4 from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";

// skills/session-board/scripts/board-store.mjs
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
var SUMMARY_MAX_LENGTH = 200;
var RETAIN_MS = 24 * 36e5;
var READ_ONLY_COMMANDS = /* @__PURE__ */ new Set(["ls", "cat", "pwd", "rg", "grep"]);
var READ_ONLY_GIT = /* @__PURE__ */ new Set(["status", "log", "diff", "show"]);
function openBoard(input, { busyTimeoutMs = 5e3 } = {}) {
  const shared = typeof input === "string" ? null : input;
  const databasePath = shared ? shared.databasePath : input;
  if (!shared && databasePath !== ":memory:") mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });
  const db = shared ? shared.database : new DatabaseSync(databasePath);
  const initialize = () => {
    try {
      if (!shared) db.exec(`PRAGMA busy_timeout = ${Math.trunc(busyTimeoutMs)};`);
      if (!shared && databasePath !== ":memory:") db.exec("PRAGMA journal_mode = WAL;");
      db.exec(`CREATE TABLE IF NOT EXISTS sessions (
      host TEXT NOT NULL,
      session_id TEXT NOT NULL,
      cwd TEXT NOT NULL,
      summary TEXT,
      summary_at TEXT,
      last_prompt_at TEXT,
      denied_for TEXT,
      started_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (host, session_id)
    ) STRICT;`);
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
  db.prepare(`INSERT INTO sessions (host, session_id, cwd, started_at, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (host, session_id) DO UPDATE SET cwd = excluded.cwd, updated_at = excluded.updated_at`).run(host, sessionId, cwd, now, now);
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
  if (!line) throw new Error(`summary must be one non-empty line of at most ${SUMMARY_MAX_LENGTH} characters`);
  touchSession(db, session);
  db.prepare("UPDATE sessions SET summary = ?, summary_at = ? WHERE host = ? AND session_id = ?").run(line, session.now, session.host, session.sessionId);
  return line;
}
function gateDecision(db, session) {
  if (db.transaction && !db.inTransaction) return db.transaction(() => gateDecision(db, session));
  touchSession(db, session);
  const row = db.prepare("SELECT summary_at, last_prompt_at, started_at FROM sessions WHERE host = ? AND session_id = ?").get(session.host, session.sessionId);
  const marker = row.last_prompt_at ?? row.started_at;
  if (row.summary_at && row.summary_at >= marker) return "allow";
  const claimed = db.prepare(`UPDATE sessions SET denied_for = ?
    WHERE host = ? AND session_id = ? AND (denied_for IS NULL OR denied_for <> ?)`).run(marker, session.host, session.sessionId, marker);
  return claimed.changes > 0 ? "deny" : "allow";
}
function pruneSessions(db, now) {
  if (db.transaction && !db.inTransaction) return db.transaction(() => pruneSessions(db, now));
  db.prepare("DELETE FROM sessions WHERE updated_at < ?").run(new Date(Date.parse(now) - RETAIN_MS).toISOString());
}
function isReadOnlyCommand(command) {
  if (typeof command !== "string") return false;
  const text2 = command.trim();
  if (!text2 || /[;&|<>`$@(){}'"\\\r\n]/u.test(text2)) return false;
  const [first, second, ...rest] = text2.split(/\s+/u);
  if ([second, ...rest].some((argument) => /^--(?:output|ext-diff|pre)(?:=|$|-)/u.test(argument ?? ""))) return false;
  if (READ_ONLY_COMMANDS.has(first)) return true;
  if (first !== "git") return false;
  if (READ_ONLY_GIT.has(second)) return true;
  return second === "branch" && (rest.length === 0 || rest.length === 1 && rest[0] === "--list");
}

// contracts/types.ts
var REASONING_EFFORT = ["low", "medium", "high", "xhigh", "max", "ultra"];

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

// mcp-server/src/session-message-client.ts
import { types as utilTypes } from "node:util";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path3 from "node:path";
import { performance } from "node:perf_hooks";
import tls from "node:tls";
import { fileURLToPath } from "node:url";

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
  return utilTypes.isNativeError(cause) ? tagProducerFailure(cause, reason) : retainFailureCause(tagProducerFailure(new Error(message), reason), cause);
}
function signalError(signal) {
  return signal.reason instanceof Error ? signal.reason : deadlineMetadata.has(signal) ? deadlineError(deadlineMetadata.get(signal).message) : new Error("The session message operation was aborted.");
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
  const [rawEndpoint, rawToken, certificate] = await Promise.all([
    readFile(paths.endpoint, { encoding: "utf8", signal }),
    readFile(paths.token, { encoding: "utf8", signal }),
    readFile(paths.certificate, { encoding: "utf8", signal })
  ]);
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
        if (prepareStateDirectory) await prepareStateDirectory(stateDirectory);
        else {
          await mkdir(stateDirectory, { recursive: true, mode: 448 });
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
        const child = spawn(process.execPath, [brokerPath, "--state-directory", stateDirectory], {
          detached: true,
          windowsHide: true,
          stdio: "ignore",
          env: sessionMessageBrokerEnvironment()
        });
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
    try {
      return await requestSessionMessageOnce(
        operation,
        payload,
        stateDirectory,
        remainingMilliseconds(deadline, signal),
        signal,
        { enforceDeadline: options.deadlineMonotonicMs !== void 0 }
      );
    } catch (error) {
      try {
        throwIfAborted(signal);
        if (error instanceof BrokerRequestRejected) throw error;
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
          { enforceDeadline: options.deadlineMonotonicMs !== void 0 }
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
function text(value) {
  return typeof value === "string" ? value : "";
}
function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function actorObservation(input, host) {
  if (!Object.hasOwn(input, "agent_id")) return { kind: "unknown", observedBy: `${host}:hook-payload`, assurance: "unknown" };
  if (typeof input.agent_id !== "string") return { kind: "unknown", observedBy: `${host}:hook-payload`, assurance: "unknown" };
  return {
    kind: text(input.agent_id) ? "subagent" : "main",
    observedBy: `${host}:hook-payload`,
    assurance: "observed"
  };
}
function adaptHostInput(input, host) {
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

// mcp-server/src/input-observation.ts
function isObservedSubagent(observation) {
  return observation.actor.kind === "subagent" && observation.actor.assurance === "observed";
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
var GATED_TOOLS = /* @__PURE__ */ new Set(["Edit", "Write", "MultiEdit", "NotebookEdit", "Bash", "PowerShell", "Agent", "Task", "shell", "local_shell", "exec_command", "apply_patch"]);
var SHELL_TOOLS = /* @__PURE__ */ new Set(["Bash", "PowerShell", "shell", "local_shell", "exec_command"]);
var GATE_REASON = '\uC138\uC158 \uD604\uD669\uD310: \uC774 \uC694\uCCAD\uC5D0\uC11C \uBB34\uC5C7\uC744 \uD558\uB294\uC9C0 \uD55C \uC904\uB85C \uBA3C\uC800 \uC801\uC5B4\uC57C \uD569\uB2C8\uB2E4. update_session_status\uB97C {"schemaVersion":"1.0.0","summary":"<\uBB34\uC5C7\uC744 \xB7 \uC5B4\uB514\uC11C(\uBE0C\uB79C\uCE58) \xB7 \uB2E4\uC74C \uC678\uBD80 \uC791\uC5C5>"}\uB85C \uD638\uCD9C\uD55C \uB4A4 \uB2E4\uC2DC \uC2DC\uB3C4\uD558\uC138\uC694. \uAC19\uC740 \uC791\uC5C5\uC774 \uC774\uC5B4\uC9C0\uBA74 \uAC19\uC740 \uBB38\uC7A5\uB3C4 \uB429\uB2C8\uB2E4. \uB3C4\uAD6C\uB97C \uC4F8 \uC218 \uC5C6\uC73C\uBA74 \uADF8\uB300\uB85C \uB2E4\uC2DC \uC2DC\uB3C4\uD558\uC138\uC694. \uB2E4\uC74C \uC2DC\uB3C4\uB294 \uD5C8\uC6A9\uB429\uB2C8\uB2E4.';
function preToolUse(permissionDecision, extra) {
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision, ...extra } };
}
function handleSessionBoardHook(input, board, host, now = (/* @__PURE__ */ new Date()).toISOString(), verifiedInternalWake = false) {
  const adapted = adaptHostInput(input, host);
  const observation = adapted.observation;
  const sessionId = observation.sessionId;
  if (!sessionId) return {};
  const session = { host, sessionId, cwd: observation.workspaceId || process.cwd(), now };
  const subagent = isObservedSubagent(observation);
  if (adapted.lifecycle === "start") {
    if (subagent) return {};
    pruneSessions(board, now);
    touchSession(board, session);
    return {};
  }
  if (observation.kind === "user-input") {
    if (!subagent) {
      pruneSessions(board, now);
      if (verifiedInternalWake) touchSession(board, session);
      else recordPrompt(board, session);
    }
    return {};
  }
  if (observation.kind !== "tool-boundary" || observation.boundaryPhase !== "before") return {};
  const toolName = observation.toolName ?? "";
  const toolInput = observation.toolInput ?? {};
  const localTool = toolName.split("__").at(-1) ?? "";
  if (toolName.startsWith("mcp__") && BOARD_TOOLS.has(localTool)) {
    if (localTool === "update_session_status") {
      if (subagent) return preToolUse("deny", { permissionDecisionReason: "\uC138\uC158 \uD604\uD669\uD310 \uC904\uC740 \uBA54\uC778 \uC138\uC158\uB9CC \uAC31\uC2E0\uD569\uB2C8\uB2E4. \uC11C\uBE0C\uC5D0\uC774\uC804\uD2B8\uB294 update_session_status\uB97C \uD638\uCD9C\uD558\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4." });
      if (!normalizeSummary(toolInput.summary)) {
        return preToolUse("deny", { permissionDecisionReason: `summary\uB294 ${SUMMARY_MAX_LENGTH}\uC790 \uC774\uD558\uC758 \uD55C \uC904\uC774\uC5B4\uC57C \uD569\uB2C8\uB2E4.` });
      }
      setSummary(board, session, toolInput.summary);
    }
    return preToolUse("allow", { updatedInput: { ...toolInput, _sessionBinding: { host, sessionId } } });
  }
  if (subagent || !GATED_TOOLS.has(toolName)) return {};
  if (SHELL_TOOLS.has(toolName) && isReadOnlyCommand(toolInput.command)) return {};
  return gateDecision(board, session) === "deny" ? preToolUse("deny", { permissionDecisionReason: GATE_REASON }) : {};
}
async function runSessionBoardHook(host, raw, request = sessionMessageRequest) {
  let board = null;
  try {
    const input = JSON.parse(raw);
    const observation = adaptHostInput(input, host).observation;
    let verifiedInternalWake = false;
    if (observation.kind === "user-input" && !isObservedSubagent(observation)) {
      const nonces = observation.wakeCandidates ?? [];
      const sessionId = observation.sessionId;
      let allRecognized = nonces.length > 0;
      if (sessionId) {
        for (const nonce of nonces) {
          try {
            const result = await request("consume-wake", { target: { host, sessionId }, nonce });
            allRecognized &&= result.consumed;
          } catch {
            allRecognized = false;
          }
        }
      } else allRecognized = false;
      verifiedInternalWake = observation.wakeOnly === true && allRecognized;
    }
    board = openBoard(resolveSessionBoardDatabasePath(), { busyTimeoutMs: 500 });
    const output = handleSessionBoardHook(input, board, host, (/* @__PURE__ */ new Date()).toISOString(), verifiedInternalWake);
    return Object.keys(output).length > 0 ? JSON.stringify(output) : "";
  } catch {
    return "";
  } finally {
    try {
      board?.close();
    } catch {
    }
  }
}
if (path4.resolve(process.argv[1] ?? "") === fileURLToPath2(import.meta.url)) {
  let raw = "";
  try {
    raw = readFileSync(0, "utf8");
  } catch {
  }
  try {
    const host = resolveHookHost(process.argv.slice(2), "codex");
    void runSessionBoardHook(host, raw).then((output) => {
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
  GATE_REASON,
  handleSessionBoardHook,
  runSessionBoardHook
};
