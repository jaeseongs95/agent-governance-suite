import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readdir, realpath, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

import { hostText } from "../../../runtime/i18n.mjs";

export const FIELDS = Object.freeze([
  "input_tokens",
  "cached_input_tokens",
  "cache_write_input_tokens",
  "output_tokens",
  "reasoning_output_tokens",
  "total_tokens"
]);

// The "unknown" labels are rendered values, not constants: the host locale decides the text, and every
// comparison in one analysis runs in one process with one locale.
const unknownModel = () => hostText("skillReportsKo.codexTokenUsageAnalyzer.unknownModel");
const unknownEffort = () => hostText("skillReportsKo.codexTokenUsageAnalyzer.unknown");
const UUID_SOURCE = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const THREAD_ID = new RegExp(`^${UUID_SOURCE}$`);
const THREAD_LINK = new RegExp(`^codex://threads/(${UUID_SOURCE})$`);
const UUID_IN_TEXT = new RegExp(UUID_SOURCE, "gi");
const UUID_LIKE = /^[0-9a-fA-F-]{32,40}$/;
const REPORT_META = Symbol.for("codex-token-usage-analyzer.report-meta");
const INDEX_META = Symbol.for("codex-token-usage-analyzer.index-meta");
const PROJECT_LABEL = /^(?<name>.+?)\s+프로젝트$/iu;
const PROJECT_USAGE_REQUEST = /^(?<name>.+?)\s+프로젝트(?:의)?\s+(?:전체\s+)?(?:(?:token|토큰)\s+)?사용량(?:을|를)?\s+집계(?:해\s*줘|해줘|해\s*주세요|해주세요|해|하라)?[.!?]?$/iu;
const BAD_FILENAME = /[<>:"/\\|?*\u0000-\u001f]/g;
const WINDOWS_RESERVED = new Set(["CON", "PRN", "AUX", "NUL", ...Array.from({ length: 9 }, (_, index) => `COM${index + 1}`), ...Array.from({ length: 9 }, (_, index) => `LPT${index + 1}`)]);
const MIN_TIME = -8_640_000_000_000_000;

function emptyUsage(value = 0) {
  return Object.fromEntries(FIELDS.map((name) => [name, value]));
}

export function pick(value, ...keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  for (const key of keys) {
    if (value[key] !== null && value[key] !== undefined && value[key] !== "") return value[key];
  }
  return null;
}

export function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string" || typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

export function digest(value) {
  return `sha256:${createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value : canonicalJson(value)).digest("hex")}`;
}

export async function* records(file) {
  const input = createReadStream(file, { encoding: "utf8" });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  let lineNumber = 0;
  for await (const line of lines) {
    lineNumber += 1;
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line);
      yield [lineNumber, value && typeof value === "object" && !Array.isArray(value) ? value : null];
    } catch {
      yield [lineNumber, null];
    }
  }
}

export async function metadata(file) {
  for await (const [, record] of records(file)) {
    if (!record || record.type !== "session_meta") continue;
    const payload = record.payload;
    const rawId = pick(payload, "id", "thread_id", "threadId", "session_id");
    if (typeof rawId !== "string" || !THREAD_ID.test(rawId)) return null;
    const id = rawId.toLowerCase();
    const rawParent = pick(payload, "parent_thread_id", "parentThreadId", "parent_session_id", "parentSessionId", "parent_id");
    const validParent = typeof rawParent === "string" && THREAD_ID.test(rawParent);
    const invalidParent = rawParent !== null && rawParent !== undefined && (!validParent || rawParent.toLowerCase() === id);
    const rawTitle = pick(payload, "title", "thread_title", "threadTitle", "name");
    const rawCwd = pick(payload, "cwd", "working_directory", "workingDirectory");
    return {
      id,
      parent: validParent && rawParent.toLowerCase() !== id ? rawParent.toLowerCase() : invalidParent ? "__invalid_parent__" : null,
      title: typeof rawTitle === "string" ? rawTitle : null,
      cwd: typeof rawCwd === "string" ? rawCwd : null,
      files: [file],
      metadataConflict: invalidParent
    };
  }
  return null;
}

async function jsonlFiles(root) {
  const output = [];
  async function visit(directory) {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(candidate);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".jsonl")) output.push(candidate);
    }
  }
  await visit(root);
  return output.sort((left, right) => left.toLowerCase().localeCompare(right.toLowerCase()));
}

export async function indexSessions(root) {
  const index = new Map();
  const inaccessibleThreads = new Set();
  let unidentifiedInaccessibleFiles = 0;
  for (const file of await jsonlFiles(root)) {
    const fileIds = [...path.basename(file, ".jsonl").matchAll(UUID_IN_TEXT)].map((match) => match[0].toLowerCase());
    let item = null;
    try {
      item = await metadata(file);
    } catch {
      item = null;
    }
    if (!item) {
      const discoveredIds = new Set(fileIds);
      try {
        for await (const [, record] of records(file)) {
          const candidate = pick(record?.payload, "id", "thread_id", "threadId", "session_id");
          if (typeof candidate === "string" && THREAD_ID.test(candidate)) discoveredIds.add(candidate.toLowerCase());
        }
      } catch { /* Keep file-level inaccessibility recorded even when stream reading fails. */ }
      if (discoveredIds.size > 0) {
        for (const discoveredId of discoveredIds) inaccessibleThreads.add(discoveredId);
      } else {
        unidentifiedInaccessibleFiles += 1;
      }
      continue;
    }
    const old = index.get(item.id);
    if (!old) {
      index.set(item.id, item);
      continue;
    }
    if (!old.files.includes(file)) old.files.push(file);
    if (old.parent && item.parent && old.parent !== item.parent) old.metadataConflict = true;
    old.parent ||= item.parent;
    old.title ||= item.title;
    old.cwd ||= item.cwd;
  }
  for (const id of index.keys()) inaccessibleThreads.delete(id);
  Object.defineProperty(index, INDEX_META, {
    value: { inaccessibleThreads, unidentifiedInaccessibleFiles },
    enumerable: false,
    configurable: true
  });
  return index;
}

export async function loadTitles(indexFile) {
  const titles = new Map();
  try {
    if (!(await stat(indexFile)).isFile()) return titles;
  } catch (error) {
    if (error?.code === "ENOENT") return titles;
    throw error;
  }
  for await (const [, item] of records(indexFile)) {
    if (!item) continue;
    const id = pick(item, "id", "thread_id", "threadId");
    const title = pick(item, "thread_name", "title", "name");
    if (typeof id === "string" && THREAD_ID.test(id) && typeof title === "string") titles.set(id.toLowerCase(), title);
  }
  return titles;
}

export function directId(query) {
  const cleaned = query.trim();
  const match = THREAD_LINK.exec(cleaned);
  if (match) return match[1].toLowerCase();
  return THREAD_ID.test(cleaned) ? cleaned.toLowerCase() : null;
}

export function explicitProjectName(query) {
  const cleaned = query.trim();
  for (const pattern of [PROJECT_USAGE_REQUEST, PROJECT_LABEL]) {
    const match = pattern.exec(cleaned);
    if (match?.groups?.name?.trim()) return match.groups.name.trim();
  }
  return null;
}

function trimSeparators(value) {
  return value.replace(/[\\/]+$/u, "");
}

function pathLeaf(value) {
  const parts = trimSeparators(value).split(/[\\/]/u);
  return parts.at(-1) ?? "";
}

function isWindowsPath(value) {
  return /^[A-Za-z]:[\\/]/u.test(value)
    || /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+/u.test(value)
    || value.includes("\\");
}

function projectPathKey(value) {
  const trimmed = trimSeparators(value);
  return isWindowsPath(trimmed) ? trimmed.replaceAll("\\", "/").toLocaleLowerCase() : trimmed;
}

function projectNameMatches(query, cwd) {
  const leaf = pathLeaf(cwd);
  return isWindowsPath(cwd) ? leaf.toLocaleLowerCase() === query.toLocaleLowerCase() : leaf === query;
}

export function matchProject(query, roots) {
  const normalized = trimSeparators(query);
  const sessions = [...roots.values()];
  const exact = sessions.filter((session) => session.cwd && projectPathKey(session.cwd) === projectPathKey(normalized));
  const matches = exact.length ? exact : sessions.filter((session) => session.cwd && projectNameMatches(normalized, session.cwd));
  if (!matches.length) return { roots: [], label: null, error: null, reason: null };
  const paths = new Map();
  for (const session of matches) {
    const cwd = trimSeparators(session.cwd);
    paths.set(projectPathKey(cwd), cwd);
  }
  if (paths.size > 1) return { roots: [], label: null, error: hostText("skillReportsKo.codexTokenUsageAnalyzer.ambiguousProject"), reason: "ambiguous_target" };
  return { roots: matches.map((session) => session.id).sort(), label: paths.values().next().value, error: null, reason: null };
}

export function resolveDetailed(query, index) {
  const cleaned = query.trim();
  const id = directId(cleaned);
  if (id) {
    if (index.has(id)) return { resolution: { roots: [id], kind: "thread", label: id }, error: null, reason: null, verdict: null };
    const indexMeta = index?.[INDEX_META];
    const inaccessible = Boolean(indexMeta && (indexMeta.inaccessibleThreads.has(id) || indexMeta.unidentifiedInaccessibleFiles > 0));
    return inaccessible
      ? { resolution: null, error: hostText("skillReportsKo.codexTokenUsageAnalyzer.targetInaccessible"), reason: "inaccessible_target", verdict: "BLOCKED" }
      : { resolution: null, error: hostText("skillReportsKo.codexTokenUsageAnalyzer.threadNotFound"), reason: "not_found", verdict: "NEEDS_INPUT" };
  }
  if (cleaned.startsWith("codex://threads/") || UUID_LIKE.test(cleaned)) {
    return { resolution: null, error: hostText("skillReportsKo.codexTokenUsageAnalyzer.invalidTargetFormat"), reason: "invalid_target_format", verdict: "NEEDS_INPUT" };
  }

  const roots = new Map([...index].filter(([, session]) => session.parent === null));
  const explicitProject = explicitProjectName(cleaned);
  if (explicitProject) {
    const project = matchProject(explicitProject, roots);
    if (project.error) return { resolution: null, error: project.error, reason: project.reason ?? "ambiguous_target", verdict: "NEEDS_INPUT" };
    return project.roots.length
      ? { resolution: { roots: project.roots, kind: "project", label: project.label }, error: null, reason: null, verdict: null }
      : { resolution: null, error: hostText("skillReportsKo.codexTokenUsageAnalyzer.projectNotFound"), reason: "not_found", verdict: "NEEDS_INPUT" };
  }

  const titled = [...roots.values()].filter((session) => session.title === cleaned).map((session) => session.id).sort();
  if (titled.length) return { resolution: { roots: titled, kind: "title", label: cleaned }, error: null, reason: null, verdict: null };
  const project = matchProject(cleaned, roots);
  if (project.error) return { resolution: null, error: project.error, reason: project.reason ?? "ambiguous_target", verdict: "NEEDS_INPUT" };
  return project.roots.length
    ? { resolution: { roots: project.roots, kind: "project", label: project.label }, error: null, reason: null, verdict: null }
    : { resolution: null, error: hostText("skillReportsKo.codexTokenUsageAnalyzer.titleOrProjectNotFound"), reason: "not_found", verdict: "NEEDS_INPUT" };
}

export function tree(root, index) {
  const children = new Map();
  for (const session of index.values()) {
    if (!index.has(session.parent)) continue;
    const values = children.get(session.parent) ?? [];
    values.push(session.id);
    children.set(session.parent, values);
  }
  const output = [];
  const queue = [root];
  const queued = new Set([root]);
  const visited = new Set();
  let cycle = false;
  while (queue.length) {
    const id = queue.shift();
    queued.delete(id);
    if (visited.has(id)) {
      cycle = true;
      continue;
    }
    visited.add(id);
    output.push(id);
    for (const child of (children.get(id) ?? []).sort()) {
      if (visited.has(child) || queued.has(child)) {
        cycle = true;
        continue;
      }
      queue.push(child);
      queued.add(child);
    }
  }
  return { ids: output, cycle };
}

function eventTime(value) {
  if (value === null || value === undefined) return null;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? new Date(parsed) : null;
}

export function validCounter(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

export function addUsage(target, delta) {
  for (const name of FIELDS) {
    const value = delta[name];
    if (value === null) target[name] = null;
    else if (target[name] !== null) target[name] += value;
  }
}

export function sumUsage(values) {
  const result = emptyUsage();
  for (const value of values) addUsage(result, value);
  return result;
}

function checkedUsage(raw, result, scope) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const values = {};
  for (const name of FIELDS) {
    values[name] = validCounter(source[name]) ? source[name] : null;
    if (values[name] === null) result.partialReasons.add(hostText("skillReportsKo.codexTokenUsageAnalyzer.scopedFieldInvalid", { scope, name }));
  }
  if (["input_tokens", "output_tokens", "total_tokens"].every((name) => values[name] !== null) && values.total_tokens !== values.input_tokens + values.output_tokens) {
    values.total_tokens = null;
    result.partialReasons.add(hostText("skillReportsKo.codexTokenUsageAnalyzer.scopedTotalMismatch", { scope }));
  }
  if (values.input_tokens !== null && values.cached_input_tokens !== null && values.cached_input_tokens > values.input_tokens) {
    values.cached_input_tokens = null;
    result.partialReasons.add(hostText("skillReportsKo.codexTokenUsageAnalyzer.scopedCacheExceedsInput", { scope }));
  }
  if (values.output_tokens !== null && values.reasoning_output_tokens !== null && values.reasoning_output_tokens > values.output_tokens) {
    values.reasoning_output_tokens = null;
    result.partialReasons.add(hostText("skillReportsKo.codexTokenUsageAnalyzer.scopedReasoningExceedsOutput", { scope }));
  }
  return values;
}

function newResult(session) {
  return { session, values: emptyUsage(), latest: emptyUsage(null), byModel: new Map(), times: [], models: new Set(), tokenCountEvents: 0, partialReasons: new Set() };
}

function modelKey(model, effort) {
  return `${model}\u0000${effort}`;
}

function splitModelKey(key) {
  return key.split("\u0000");
}

function compareEvent(left, right) {
  return left.key[0] - right.key[0] || left.key[1] - right.key[1] || left.key[2].localeCompare(right.key[2]) || left.key[3] - right.key[3];
}

function reconcileResult(result) {
  const modelValues = sumUsage(result.byModel.values());
  for (const name of FIELDS) {
    if (modelValues[name] !== result.values[name]) result.partialReasons.add(hostText("skillReportsKo.codexTokenUsageAnalyzer.threadModelSumMismatch", { name }));
    if (result.values[name] !== null && result.latest[name] !== null && result.values[name] !== result.latest[name]) result.partialReasons.add(hostText("skillReportsKo.codexTokenUsageAnalyzer.latestCumulativeMismatch", { name }));
  }
  if (result.values.input_tokens !== null && result.values.output_tokens !== null && result.values.total_tokens !== null && result.values.total_tokens !== result.values.input_tokens + result.values.output_tokens) result.partialReasons.add(hostText("skillReportsKo.codexTokenUsageAnalyzer.threadTotalMismatch"));
}

function validateTotalTokenUsage(source, result) {
  const invalid = new Set();
  for (const name of FIELDS) {
    if (!validCounter(source[name])) {
      invalid.add(name);
      result.partialReasons.add(hostText("skillReportsKo.codexTokenUsageAnalyzer.fieldInvalid", { name }));
    }
  }
  if (!["input_tokens", "output_tokens", "total_tokens"].some((name) => invalid.has(name)) && source.total_tokens !== source.input_tokens + source.output_tokens) {
    invalid.add("total_tokens");
    result.partialReasons.add(hostText("skillReportsKo.codexTokenUsageAnalyzer.totalMismatch"));
  }
  if (!["input_tokens", "cached_input_tokens"].some((name) => invalid.has(name)) && source.cached_input_tokens > source.input_tokens) {
    invalid.add("cached_input_tokens");
    result.partialReasons.add(hostText("skillReportsKo.codexTokenUsageAnalyzer.cacheExceedsInput"));
  }
  if (!["output_tokens", "reasoning_output_tokens"].some((name) => invalid.has(name)) && source.reasoning_output_tokens > source.output_tokens) {
    invalid.add("reasoning_output_tokens");
    result.partialReasons.add(hostText("skillReportsKo.codexTokenUsageAnalyzer.reasoningExceedsOutput"));
  }
  return invalid;
}

function analyzeModern(result, events) {
  const contexts = new Map();
  for (const event of events) {
    if (event.record.type !== "turn_context") continue;
    const turnId = pick(event.record.payload, "turn_id", "turnId");
    if (typeof turnId !== "string" || !turnId) continue;
    const values = contexts.get(turnId) ?? [];
    values.push({ key: event.key, model: pick(event.record.payload, "model"), effort: pick(event.record.payload, "effort") });
    contexts.set(turnId, values);
  }
  const seenResponses = new Map();
  const previousThread = emptyUsage();
  const turnTotals = new Map();
  let latestThread = null;
  let latestRecordUsage = null;
  let previousTokenCount = null;
  let currentModel = null;
  let currentEffort = null;

  for (const event of events) {
    const { record, when, key } = event;
    const payload = record.payload;
    if (record.type === "turn_context") {
      const rawModel = pick(payload, "model");
      const rawEffort = pick(payload, "effort");
      currentModel = rawModel === null ? null : String(rawModel);
      currentEffort = rawEffort === null ? null : String(rawEffort);
      continue;
    }
    if (record.type === "event_msg" && payload && typeof payload === "object" && payload.type === "token_count") {
      const total = payload.info && typeof payload.info === "object" && payload.info.total_token_usage && typeof payload.info.total_token_usage === "object" ? payload.info.total_token_usage : {};
      const last = payload.info && typeof payload.info === "object" && payload.info.last_token_usage && typeof payload.info.last_token_usage === "object" ? payload.info.last_token_usage : {};
      if (validateTotalTokenUsage(total, result).size > 0) continue;
      const current = Object.fromEntries(FIELDS.map((name) => [name, total[name]]));
      const unchanged = previousTokenCount && FIELDS.every((name) => previousTokenCount[name] === current[name]);
      previousTokenCount = current;
      if (unchanged) continue;
      if (!latestRecordUsage || FIELDS.some((name) => !validCounter(last[name]) || last[name] !== latestRecordUsage[name])) result.partialReasons.add(hostText("skillReportsKo.codexTokenUsageAnalyzer.lastUsageMismatch"));
      continue;
    }
    if (record.type !== "token_usage_record") continue;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      result.partialReasons.add(hostText("skillReportsKo.codexTokenUsageAnalyzer.usageRecordPayloadInvalid"));
      continue;
    }
    const owner = payload.thread_id;
    if (typeof owner !== "string" || owner.toLowerCase() !== result.session.id) {
      result.partialReasons.add(hostText("skillReportsKo.codexTokenUsageAnalyzer.usageRecordThreadMismatch"));
      continue;
    }
    const signature = canonicalJson({
      thread_id: owner,
      turn_id: payload.turn_id ?? null,
      usage: payload.usage ?? null,
      turn_token_usage: payload.turn_token_usage ?? null,
      thread_token_usage: payload.thread_token_usage ?? null
    });
    const responseId = payload.response_id;
    if (typeof responseId === "string" && responseId) {
      if (seenResponses.has(responseId)) {
        if (seenResponses.get(responseId) !== signature) result.partialReasons.add(hostText("skillReportsKo.codexTokenUsageAnalyzer.responseUsageMismatch"));
        continue;
      }
      seenResponses.set(responseId, signature);
    } else result.partialReasons.add(hostText("skillReportsKo.codexTokenUsageAnalyzer.usageRecordResponseIdInvalid"));

    result.tokenCountEvents += 1;
    if (when) result.times.push(when);
    const usage = checkedUsage(payload.usage, result, "usage");
    latestRecordUsage = usage;
    const turnUsage = checkedUsage(payload.turn_token_usage, result, "turn_token_usage");
    const threadUsage = checkedUsage(payload.thread_token_usage, result, "thread_token_usage");
    const turnId = typeof payload.turn_id === "string" && payload.turn_id ? payload.turn_id : null;
    let selected = null;
    for (const candidate of contexts.get(turnId ?? "") ?? []) {
      if (compareEvent({ key: candidate.key }, { key }) <= 0) selected = candidate;
      else if (selected === null) {
        selected = candidate;
        break;
      } else break;
    }
    const selectedModel = selected?.model === null || selected?.model === undefined ? (selected ? null : currentModel) : String(selected.model);
    const selectedEffort = selected?.effort === null || selected?.effort === undefined ? (selected ? null : currentEffort) : String(selected.effort);
    if (!selected && (selectedModel !== null || selectedEffort !== null)) result.partialReasons.add(hostText("skillReportsKo.codexTokenUsageAnalyzer.turnContextFallback"));
    const model = selectedModel ?? unknownModel();
    const effort = selectedEffort ?? unknownEffort();
    const bucketKey = modelKey(model, effort);
    result.models.add(bucketKey);
    if (selectedModel === null) result.partialReasons.add(hostText("skillReportsKo.codexTokenUsageAnalyzer.turnContextOrModelMissing"));
    if (selectedEffort === null) result.partialReasons.add(hostText("skillReportsKo.codexTokenUsageAnalyzer.effortMissing"));
    if (!result.byModel.has(bucketKey)) result.byModel.set(bucketKey, emptyUsage());
    addUsage(result.byModel.get(bucketKey), usage);

    if (turnId === null) result.partialReasons.add(hostText("skillReportsKo.codexTokenUsageAnalyzer.usageRecordTurnIdInvalid"));
    else {
      if (!turnTotals.has(turnId)) turnTotals.set(turnId, emptyUsage());
      const accumulated = turnTotals.get(turnId);
      addUsage(accumulated, usage);
      for (const name of FIELDS) if (accumulated[name] !== turnUsage[name]) result.partialReasons.add(hostText("skillReportsKo.codexTokenUsageAnalyzer.turnUsageSumMismatch", { name }));
    }
    for (const name of FIELDS) {
      const previous = previousThread[name];
      const increment = usage[name];
      const current = threadUsage[name];
      if (previous !== null && increment !== null && current !== null && current !== previous + increment) result.partialReasons.add(hostText("skillReportsKo.codexTokenUsageAnalyzer.threadUsageIncrementMismatch", { name }));
      previousThread[name] = current;
    }
    latestThread = threadUsage;
  }
  if (result.tokenCountEvents === 0 || latestThread === null) {
    result.values = emptyUsage(null);
    result.latest = emptyUsage(null);
    result.byModel.set(modelKey(unknownModel(), unknownEffort()), emptyUsage(null));
    result.models.add(modelKey(unknownModel(), unknownEffort()));
    result.partialReasons.add(hostText("skillReportsKo.codexTokenUsageAnalyzer.usageRecordNotObserved"));
  } else {
    result.values = { ...latestThread };
    result.latest = { ...latestThread };
  }
  reconcileResult(result);
  return result;
}

export async function analyze(session) {
  const result = newResult(session);
  const events = [];
  for (const file of session.files) {
    for await (const [lineNumber, record] of records(file)) {
      if (!record) {
        result.partialReasons.add(hostText("skillReportsKo.codexTokenUsageAnalyzer.corruptJsonlRow"));
        continue;
      }
      const payload = record.payload;
      const relevant = record.type === "turn_context" || record.type === "token_usage_record" || (record.type === "event_msg" && payload && typeof payload === "object" && payload.type === "token_count");
      if (!relevant) continue;
      const when = eventTime(record.timestamp);
      if (!when) result.partialReasons.add(hostText("skillReportsKo.codexTokenUsageAnalyzer.eventTimeInvalid"));
      const ordinal = Number.isInteger(record.ordinal) ? record.ordinal : 0;
      events.push({ key: [when?.getTime() ?? MIN_TIME, ordinal, file.toLowerCase(), lineNumber], record, when });
    }
  }
  if (session.metadataConflict) result.partialReasons.add(hostText("skillReportsKo.codexTokenUsageAnalyzer.rolloverParentMismatch"));
  events.sort(compareEvent);
  if (events.some((event) => event.record.type === "token_usage_record")) return analyzeModern(result, events);

  let model = null;
  let effort = null;
  const previous = emptyUsage(null);
  const reliable = Object.fromEntries(FIELDS.map((name) => [name, true]));
  for (const event of events) {
    const { record, when } = event;
    const payload = record.payload;
    if (record.type === "turn_context") {
      const rawModel = pick(payload, "model");
      const rawEffort = pick(payload, "effort");
      model = rawModel === null ? null : String(rawModel);
      effort = rawEffort === null ? null : String(rawEffort);
      continue;
    }
    if (!(record.type === "event_msg" && payload && typeof payload === "object" && payload.type === "token_count")) continue;
    result.tokenCountEvents += 1;
    if (when) result.times.push(when);
    const source = payload.info && typeof payload.info === "object" && payload.info.total_token_usage && typeof payload.info.total_token_usage === "object" ? payload.info.total_token_usage : {};
    const invalid = new Set(FIELDS.filter((name) => !validCounter(source[name])));
    if (!["input_tokens", "output_tokens", "total_tokens"].some((name) => invalid.has(name)) && source.total_tokens !== source.input_tokens + source.output_tokens) {
      invalid.add("total_tokens");
      result.partialReasons.add(hostText("skillReportsKo.codexTokenUsageAnalyzer.totalMismatch"));
    }
    if (!["input_tokens", "cached_input_tokens"].some((name) => invalid.has(name)) && source.cached_input_tokens > source.input_tokens) {
      invalid.add("cached_input_tokens");
      result.partialReasons.add(hostText("skillReportsKo.codexTokenUsageAnalyzer.cacheExceedsInput"));
    }
    if (!["output_tokens", "reasoning_output_tokens"].some((name) => invalid.has(name)) && source.reasoning_output_tokens > source.output_tokens) {
      invalid.add("reasoning_output_tokens");
      result.partialReasons.add(hostText("skillReportsKo.codexTokenUsageAnalyzer.reasoningExceedsOutput"));
    }
    const delta = {};
    for (const name of FIELDS) {
      const value = source[name];
      if (invalid.has(name)) {
        reliable[name] = false;
        result.latest[name] = null;
        delta[name] = null;
        result.partialReasons.add(hostText("skillReportsKo.codexTokenUsageAnalyzer.fieldInvalid", { name }));
      } else if (!reliable[name]) delta[name] = null;
      else if (previous[name] === null) {
        previous[name] = value;
        result.latest[name] = value;
        delta[name] = value;
      } else if (value < previous[name]) {
        reliable[name] = false;
        result.latest[name] = null;
        delta[name] = null;
        result.partialReasons.add(hostText("skillReportsKo.codexTokenUsageAnalyzer.cumulativeDecreased", { name }));
      } else {
        delta[name] = value - previous[name];
        previous[name] = value;
        result.latest[name] = value;
      }
    }
    const bucketKey = modelKey(model ?? unknownModel(), effort ?? unknownEffort());
    result.models.add(bucketKey);
    if (model === null) result.partialReasons.add(hostText("skillReportsKo.codexTokenUsageAnalyzer.tokenCountModelMissing"));
    if (effort === null) result.partialReasons.add(hostText("skillReportsKo.codexTokenUsageAnalyzer.tokenCountEffortMissing"));
    addUsage(result.values, delta);
    if (!result.byModel.has(bucketKey)) result.byModel.set(bucketKey, emptyUsage());
    addUsage(result.byModel.get(bucketKey), delta);
  }
  if (result.tokenCountEvents === 0) {
    result.values = emptyUsage(null);
    result.byModel.set(modelKey(unknownModel(), unknownEffort()), emptyUsage(null));
    result.models.add(modelKey(unknownModel(), unknownEffort()));
    result.partialReasons.add(hostText("skillReportsKo.codexTokenUsageAnalyzer.tokenCountNotObserved"));
  }
  reconcileResult(result);
  return result;
}

export function withDerived(values) {
  const input = values.input_tokens;
  const cache = values.cached_input_tokens;
  const output = values.output_tokens;
  return {
    ...Object.fromEntries(FIELDS.map((name) => [name, values[name]])),
    non_cached_input_tokens: input === null || cache === null ? null : input - cache,
    input_output_tokens: input === null || output === null ? null : input + output
  };
}

function observedRange(times) {
  const sorted = [...times].sort((left, right) => left - right);
  return { from: sorted.length ? sorted[0].toISOString() : null, to: sorted.length ? sorted.at(-1).toISOString() : null };
}

function reportShell(verdict, message, target = { kind: "unknown", label: "", rootThreadIds: [] }) {
  return {
    schemaVersion: "1.0.0",
    verdict,
    target,
    observedAt: { from: null, to: null },
    counts: { rootThreads: 0, totalThreads: 0, observedThreads: 0, observations: 0 },
    totals: withDerived(emptyUsage(null)),
    models: [],
    threads: [],
    partialReasons: [],
    message,
    markdownArtifact: null
  };
}

function withReportMeta(report, meta) {
  if (meta && typeof meta === "object") {
    Object.defineProperty(report, REPORT_META, { value: meta, enumerable: false, configurable: true });
  }
  return report;
}

export function getReportMeta(report) {
  return report?.[REPORT_META] ?? null;
}

export function needsInputReport(message, targetText = "", meta = null) {
  const reason = meta?.reason ?? (message === hostText("skillReportsKo.codexTokenUsageAnalyzer.invalidTargetFormat") ? "invalid_target_format" : message === hostText("skillReportsKo.codexTokenUsageAnalyzer.ambiguousProject") ? "ambiguous_target" : "not_found");
  const code = meta?.code ?? (reason === "not_found" ? "RUN_NOT_FOUND" : "INVALID_INPUT");
  return withReportMeta(
    reportShell("NEEDS_INPUT", message, { kind: "unknown", label: targetText, rootThreadIds: [] }),
    { ...meta, reason, code }
  );
}

export function blockedReport(message, targetText = "", meta = null) {
  return withReportMeta(
    reportShell("BLOCKED", message, { kind: "unknown", label: targetText, rootThreadIds: [] }),
    meta ? { ...meta } : null
  );
}

export function buildReport(resolution, results) {
  for (const result of results) reconcileResult(result);
  const totals = sumUsage(results.map((result) => result.values));
  const reasons = new Set(results.flatMap((result) => [...result.partialReasons]));
  const buckets = new Map();
  for (const result of results) {
    for (const [key, values] of result.byModel) {
      if (!buckets.has(key)) buckets.set(key, emptyUsage());
      addUsage(buckets.get(key), values);
    }
  }
  const modelTotal = sumUsage(buckets.values());
  for (const name of FIELDS) if (modelTotal[name] !== totals[name]) reasons.add(hostText("skillReportsKo.codexTokenUsageAnalyzer.overallModelSumMismatch", { name }));
  if (totals.input_tokens !== null && totals.output_tokens !== null && totals.total_tokens !== null && totals.total_tokens !== totals.input_tokens + totals.output_tokens) reasons.add(hostText("skillReportsKo.codexTokenUsageAnalyzer.overallTotalMismatch"));
  const rootSet = new Set(resolution.roots);
  let childIndex = 0;
  const threads = results.map((result, index) => {
    let role;
    if (resolution.kind === "project") {
      const rootIndex = resolution.roots.indexOf(result.session.id);
      role = rootIndex >= 0 ? `root-${rootIndex + 1}` : `child-${++childIndex}`;
    } else role = index === 0 ? "target" : `child-${index}`;
    return {
      role,
      threadId: result.session.id,
      title: result.session.title,
      status: result.partialReasons.size || FIELDS.some((name) => result.values[name] === null) ? "partial" : "complete",
      models: [...result.models].sort().map((key) => {
        const [model, effort] = splitModelKey(key);
        return { model, effort };
      }),
      observedAt: observedRange(result.times),
      values: withDerived(result.values)
    };
  });
  const allTimes = results.flatMap((result) => result.times);
  const partial = reasons.size > 0 || FIELDS.some((name) => totals[name] === null);
  return {
    schemaVersion: "1.0.0",
    verdict: partial ? "PARTIAL" : "PASS",
    target: { kind: resolution.kind, label: resolution.label, rootThreadIds: [...rootSet] },
    observedAt: observedRange(allTimes),
    counts: {
      rootThreads: resolution.roots.length,
      totalThreads: results.length,
      observedThreads: results.filter((result) => result.tokenCountEvents > 0).length,
      observations: results.reduce((count, result) => count + result.tokenCountEvents, 0)
    },
    totals: withDerived(totals),
    models: [...buckets].sort(([left], [right]) => left.localeCompare(right)).map(([key, values]) => {
      const [model, effort] = splitModelKey(key);
      return { model, effort, status: model === unknownModel() || effort === unknownEffort() || FIELDS.some((name) => values[name] === null) ? "partial" : "complete", values: withDerived(values) };
    }),
    threads,
    partialReasons: [...reasons].sort(),
    message: null,
    markdownArtifact: null
  };
}

export function codexPaths(environment = process.env) {
  const configured = typeof environment.CODEX_HOME === "string" && environment.CODEX_HOME.trim() ? environment.CODEX_HOME : path.join(os.homedir(), ".codex");
  const root = path.resolve(configured);
  return { root, sessionsRoot: path.join(root, "sessions"), indexFile: path.join(root, "session_index.jsonl") };
}

export async function analyzeRequest(request, options = {}) {
  const locations = options.locations ?? codexPaths(options.environment);
  try {
    const stats = await stat(locations.sessionsRoot);
    if (!stats.isDirectory()) {
      return blockedReport(hostText("skillReportsKo.codexTokenUsageAnalyzer.sessionsRootNotDirectory"), request.target, { causeCode: "ENOTDIR" });
    }
  } catch (error) {
    const causeCode = typeof error?.code === "string" && error.code ? error.code : null;
    const codePart = causeCode ? ` (${causeCode})` : "";
    return blockedReport(
      hostText("skillReportsKo.codexTokenUsageAnalyzer.sessionsRootInaccessible", { codePart, detail: error instanceof Error ? error.message : String(error) }),
      request.target,
      causeCode ? { causeCode } : null
    );
  }
  let index;
  try {
    index = await indexSessions(locations.sessionsRoot);
    for (const [id, title] of await loadTitles(locations.indexFile)) if (index.has(id)) index.get(id).title = title;
  } catch (error) {
    const causeCode = typeof error?.code === "string" && error.code ? error.code : null;
    return blockedReport(
      hostText("skillReportsKo.codexTokenUsageAnalyzer.sessionsReadFailed", { detail: error instanceof Error ? error.message : String(error) }),
      request.target,
      causeCode ? { causeCode } : null
    );
  }
  const { resolution, error, reason, verdict } = resolveDetailed(request.target, index);
  if (error) {
    return verdict === "BLOCKED"
      ? blockedReport(error, request.target, reason ? { reason } : null)
      : needsInputReport(error, request.target, reason ? { reason } : null);
  }
  const identifiers = [];
  const seen = new Set();
  const cycleRoots = new Set();
  for (const root of resolution.roots) {
    const branch = tree(root, index);
    if (branch.cycle) cycleRoots.add(root);
    for (const id of branch.ids) if (!seen.has(id)) {
      seen.add(id);
      identifiers.push(id);
    }
  }
  const results = [];
  try {
    for (const id of identifiers) results.push(await analyze(index.get(id)));
  } catch (error) {
    const causeCode = typeof error?.code === "string" && error.code ? error.code : null;
    return blockedReport(hostText("skillReportsKo.codexTokenUsageAnalyzer.targetInaccessible"), request.target, {
      reason: "inaccessible_target",
      ...(causeCode ? { causeCode } : {})
    });
  }
  const byId = new Map(results.map((result) => [result.session.id, result]));
  for (const id of cycleRoots) byId.get(id)?.partialReasons.add(hostText("skillReportsKo.codexTokenUsageAnalyzer.parentCycle"));
  return buildReport(resolution, results);
}

export function markdownText(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\\", "\\\\")
    .replaceAll("\r\n", " ")
    .replaceAll("\r", " ")
    .replaceAll("\n", " ")
    .replace(/([`*_\[\]{}#!|~])/g, "\\$1");
}

export function safeFilename(title) {
  let safe = String(title).replace(BAD_FILENAME, "_").replace(/^[ .]+|[ .]+$/g, "") || "untitled-session";
  if (WINDOWS_RESERVED.has(safe.split(".", 1)[0].toUpperCase())) safe = `_${safe}`;
  return safe.slice(0, 120);
}

function displayNumber(value) {
  return value === null ? hostText("skillReportsKo.codexTokenUsageAnalyzer.unknown") : value.toLocaleString("en-US");
}

function markdownCells(values) {
  return [values.input_tokens, values.cached_input_tokens, values.non_cached_input_tokens, values.cache_write_input_tokens, values.output_tokens, values.input_output_tokens].map(displayNumber);
}

export function makeMarkdown(report) {
  if (!["PASS", "PARTIAL"].includes(report.verdict)) throw new Error(hostText("skillReportsKo.codexTokenUsageAnalyzer.markdownRequiresResult"));
  const count = (value) => value.toLocaleString("en-US");
  const state = (partial) => (partial ? "partial" : "complete");
  const lines = [hostText("skillReportsKo.codexTokenUsageAnalyzer.markdownTitle"), ""];
  if (report.target.kind === "project") {
    lines.push(hostText("skillReportsKo.codexTokenUsageAnalyzer.markdownProjectTarget", { label: markdownText(report.target.label) }));
    lines.push(hostText("skillReportsKo.codexTokenUsageAnalyzer.markdownProjectScope", { rootThreads: count(report.counts.rootThreads), childThreads: count(report.counts.totalThreads - report.counts.rootThreads) }));
  } else {
    const target = report.threads[0];
    lines.push(hostText("skillReportsKo.codexTokenUsageAnalyzer.markdownThreadTarget", { title: markdownText(target?.title ?? "untitled-session"), threadId: target?.threadId ?? report.target.rootThreadIds[0] }));
    lines.push(hostText("skillReportsKo.codexTokenUsageAnalyzer.markdownThreadTree", { childThreads: count(Math.max(0, report.counts.totalThreads - 1)) }));
  }
  const observedRange = (observedAt) => (observedAt.from ? (observedAt.from === observedAt.to ? observedAt.from : `${observedAt.from} ~ ${observedAt.to}`) : hostText("skillReportsKo.codexTokenUsageAnalyzer.unknown"));
  lines.push(hostText("skillReportsKo.codexTokenUsageAnalyzer.markdownObservedAt", { kind: report.counts.observations === 1 ? "single" : "range", range: observedRange(report.observedAt) }));
  lines.push(hostText("skillReportsKo.codexTokenUsageAnalyzer.markdownAggregateStatus", { state: state(report.verdict === "PARTIAL"), total: count(report.counts.totalThreads), observed: count(report.counts.observedThreads) }));
  if (report.partialReasons.length) lines.push(hostText("skillReportsKo.codexTokenUsageAnalyzer.markdownPartialReasons", { reasons: markdownText(report.partialReasons.join("; ")) }));
  lines.push(hostText("skillReportsKo.codexTokenUsageAnalyzer.markdownDisclaimer"));
  lines.push("", hostText("skillReportsKo.codexTokenUsageAnalyzer.markdownTotalsHeader"), "| ----- | ----: | ----------: | -----------: | ----------: | -----: | ------------: |", `| ${hostText(report.target.kind === "project" ? "skillReportsKo.codexTokenUsageAnalyzer.markdownScopeProject" : "skillReportsKo.codexTokenUsageAnalyzer.markdownScopeThread")} | ${markdownCells(report.totals).join(" | ")} |`, "", hostText("skillReportsKo.codexTokenUsageAnalyzer.markdownReasoningNote", { value: displayNumber(report.totals.reasoning_output_tokens) }), "", hostText("skillReportsKo.codexTokenUsageAnalyzer.markdownModelsHeading"), "", hostText("skillReportsKo.codexTokenUsageAnalyzer.markdownModelsHeader"), "| ---- | --------- | ----: | ----------: | -----------: | ----------: | -----: | ------------: | --------- |");
  for (const model of report.models) lines.push(`| ${markdownText(model.model)} | ${markdownText(model.effort)} | ${markdownCells(model.values).join(" | ")} | ${hostText("skillReportsKo.codexTokenUsageAnalyzer.markdownAttributionState", { state: state(model.status === "partial") })} |`);
  lines.push("", hostText("skillReportsKo.codexTokenUsageAnalyzer.markdownThreadsHeading"), "", hostText("skillReportsKo.codexTokenUsageAnalyzer.markdownThreadsHeader"), "| ---- | --------- | --------- | --------------------- | ---------------------- | ----: | ----------: | -----------: | -----: | ------------: |");
  for (const thread of report.threads) {
    const models = thread.models.map(({ model, effort }) => `${markdownText(model)}/${markdownText(effort)}`).join(", ") || hostText("skillReportsKo.codexTokenUsageAnalyzer.unknown");
    const when = observedRange(thread.observedAt);
    const values = markdownCells(thread.values);
    lines.push(`| ${markdownText(thread.role)} | \`${thread.threadId}\` | ${hostText("skillReportsKo.codexTokenUsageAnalyzer.markdownAggregateState", { state: state(thread.status === "partial") })} | ${models} | ${when} | ${values[0]} | ${values[1]} | ${values[2]} | ${values[4]} | ${values[5]} |`);
  }
  lines.push("", hostText("skillReportsKo.codexTokenUsageAnalyzer.markdownNoteTotal"), hostText("skillReportsKo.codexTokenUsageAnalyzer.markdownNoteReasoning"), hostText("skillReportsKo.codexTokenUsageAnalyzer.markdownNoteRunning"), "");
  return lines.join("\n");
}

export function isPortableAbsolute(value) {
  return path.isAbsolute(value) || path.posix.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value);
}

function comparable(value, windows) {
  if (windows) return path.win32.resolve(value.replaceAll("/", "\\")).replaceAll("\\", "/").toLocaleLowerCase();
  if (path.posix.isAbsolute(value)) return path.posix.resolve(value);
  return path.resolve(value).replaceAll("\\", "/");
}

export function isWithin(root, candidate) {
  const windows = isWindowsPath(root);
  if (windows !== isWindowsPath(candidate)) return false;
  const base = `${comparable(root, windows).replace(/\/+$/, "")}/`;
  const target = comparable(candidate, windows).replace(/\/+$/, "");
  return `${target}/`.startsWith(base);
}

export async function validateMarkdownDirectory(directory, { sessionsRoot, pluginRoot }) {
  if (!isPortableAbsolute(directory)) throw new Error(hostText("skillReportsKo.codexTokenUsageAnalyzer.markdownDirectoryNotAbsolute"));
  const destination = path.resolve(directory);
  if (isWithin(sessionsRoot, destination)) throw new Error(hostText("skillReportsKo.codexTokenUsageAnalyzer.markdownUnderSessions"));
  if (isWithin(pluginRoot, destination)) throw new Error(hostText("skillReportsKo.codexTokenUsageAnalyzer.markdownUnderPlugin"));
  const [prospectiveDestination, realSessionsRoot, realPluginRoot] = await Promise.all([
    prospectiveRealPath(destination),
    canonicalExistingPath(sessionsRoot),
    canonicalExistingPath(pluginRoot)
  ]);
  if (isWithin(realSessionsRoot, prospectiveDestination)) throw new Error(hostText("skillReportsKo.codexTokenUsageAnalyzer.markdownUnderSessions"));
  if (isWithin(realPluginRoot, prospectiveDestination)) throw new Error(hostText("skillReportsKo.codexTokenUsageAnalyzer.markdownUnderPlugin"));
  return destination;
}

export async function writeNewMarkdown(report, directory, options = {}) {
  const destination = await validateMarkdownDirectory(directory, options);
  await mkdir(destination, { recursive: true });
  const [realDestination, realSessionsRoot, realPluginRoot] = await Promise.all([
    canonicalExistingPath(destination),
    canonicalExistingPath(options.sessionsRoot),
    canonicalExistingPath(options.pluginRoot)
  ]);
  if (isWithin(realSessionsRoot, realDestination)) throw new Error(hostText("skillReportsKo.codexTokenUsageAnalyzer.markdownUnderSessions"));
  if (isWithin(realPluginRoot, realDestination)) throw new Error(hostText("skillReportsKo.codexTokenUsageAnalyzer.markdownUnderPlugin"));
  const stamp = options.stamp ?? new Date().toISOString().replace(/[-:TZ]/g, "").slice(0, 17);
  const id = report.target.kind === "project" ? "project" : (report.target.rootThreadIds[0] ?? "00000000").replace(/[^0-9a-f]/gi, "").slice(0, 8) || "00000000";
  const title = report.target.kind === "project" ? hostText("skillReportsKo.codexTokenUsageAnalyzer.markdownProjectFileTitle", { name: pathLeaf(report.target.label) || report.target.label }) : report.threads[0]?.title ?? "untitled-session";
  const base = `${safeFilename(title)}_${id}_${stamp}`;
  const content = makeMarkdown(report);
  for (let suffix = 1; ; suffix += 1) {
    const candidate = path.join(destination, `${base}${suffix === 1 ? "" : `_${suffix}`}.md`);
    let handle;
    try {
      handle = await open(candidate, "wx");
    } catch (error) {
      if (error?.code === "EEXIST") continue;
      throw error;
    }
    try {
      await handle.writeFile(content, "utf8");
      await handle.close();
      return { path: candidate, digest: digest(content) };
    } catch (error) {
      const diagnostics = Array.isArray(error?.secondaryDiagnostics) ? [...error.secondaryDiagnostics] : [];
      const recordCleanupFailure = (step, cleanupError) => {
        diagnostics.push({
          step,
          code: typeof cleanupError?.code === "string" && cleanupError.code ? cleanupError.code : "UNKNOWN"
        });
      };
      try {
        await handle.close();
      } catch (closeError) {
        recordCleanupFailure("cleanup-close", closeError);
      }
      try {
        await rm(candidate, { force: true });
      } catch (cleanupError) {
        recordCleanupFailure("cleanup-rm", cleanupError);
      }
      // 최초 쓰기 실패가 주오류다. 정리 실패는 경로·메시지 없이 code만 보조 진단으로 분리한다.
      if (diagnostics.length > 0 && error !== null && typeof error === "object") {
        try {
          Object.defineProperty(error, "secondaryDiagnostics", {
            value: diagnostics,
            enumerable: false,
            configurable: true
          });
        } catch { /* Frozen errors keep the primary failure unchanged. */ }
      }
      throw error;
    }
  }
}

// Only an absent path may fall back (to its real existing ancestor). Any other realpath failure (EACCES, ELOOP, ...)
// propagates, so the storage-isolation check never compares an unresolved path (D-0223).
export async function canonicalExistingPath(value) {
  return prospectiveRealPath(value);
}

async function prospectiveRealPath(value) {
  let current = path.resolve(value);
  const missing = [];
  for (;;) {
    try {
      return path.join(await realpath(current), ...missing.reverse());
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}
