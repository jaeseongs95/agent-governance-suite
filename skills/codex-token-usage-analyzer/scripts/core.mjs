import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readdir, realpath, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

export const FIELDS = Object.freeze([
  "input_tokens",
  "cached_input_tokens",
  "cache_write_input_tokens",
  "output_tokens",
  "reasoning_output_tokens",
  "total_tokens"
]);

const UNKNOWN_MODEL = "미확인 모델";
const UNKNOWN_EFFORT = "미확인";
const UUID_SOURCE = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const THREAD_ID = new RegExp(`^${UUID_SOURCE}$`);
const THREAD_LINK = new RegExp(`^codex://threads/(${UUID_SOURCE})$`);
const UUID_LIKE = /^[0-9a-fA-F-]{32,40}$/;
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
  for (const file of await jsonlFiles(root)) {
    const item = await metadata(file);
    if (!item) continue;
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
  if (!matches.length) return { roots: [], label: null, error: null };
  const paths = new Map();
  for (const session of matches) {
    const cwd = trimSeparators(session.cwd);
    paths.set(projectPathKey(cwd), cwd);
  }
  if (paths.size > 1) return { roots: [], label: null, error: "같은 마지막 폴더명을 가진 프로젝트가 여러 개입니다. 전체 경로를 입력하세요." };
  return { roots: matches.map((session) => session.id).sort(), label: paths.values().next().value, error: null };
}

export function resolveDetailed(query, index) {
  const cleaned = query.trim();
  const id = directId(cleaned);
  if (id) return index.has(id) ? { resolution: { roots: [id], kind: "thread", label: id }, error: null } : { resolution: null, error: "대상 thread의 session metadata 또는 로그에 접근할 수 없습니다." };
  if (cleaned.startsWith("codex://threads/") || UUID_LIKE.test(cleaned)) return { resolution: null, error: "thread ID 또는 codex://threads 딥링크 형식이 올바르지 않습니다." };

  const roots = new Map([...index].filter(([, session]) => session.parent === null));
  const explicitProject = explicitProjectName(cleaned);
  if (explicitProject) {
    const project = matchProject(explicitProject, roots);
    if (project.error) return { resolution: null, error: project.error };
    return project.roots.length ? { resolution: { roots: project.roots, kind: "project", label: project.label }, error: null } : { resolution: null, error: "입력한 프로젝트명과 일치하는 최상위 thread를 찾지 못했습니다." };
  }

  const titled = [...roots.values()].filter((session) => session.title === cleaned).map((session) => session.id).sort();
  if (titled.length) return { resolution: { roots: titled, kind: "title", label: cleaned }, error: null };
  const project = matchProject(cleaned, roots);
  if (project.error) return { resolution: null, error: project.error };
  return project.roots.length ? { resolution: { roots: project.roots, kind: "project", label: project.label }, error: null } : { resolution: null, error: "입력한 세션 제목 또는 프로젝트명과 일치하는 최상위 thread를 찾지 못했습니다." };
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
    if (values[name] === null) result.partialReasons.add(`${scope}의 ${name} 누락 또는 잘못된 값`);
  }
  if (["input_tokens", "output_tokens", "total_tokens"].every((name) => values[name] !== null) && values.total_tokens !== values.input_tokens + values.output_tokens) {
    values.total_tokens = null;
    result.partialReasons.add(`${scope}의 total_tokens와 Input + Output 불일치`);
  }
  if (values.input_tokens !== null && values.cached_input_tokens !== null && values.cached_input_tokens > values.input_tokens) {
    values.cached_input_tokens = null;
    result.partialReasons.add(`${scope}의 Cache input이 Input보다 큼`);
  }
  if (values.output_tokens !== null && values.reasoning_output_tokens !== null && values.reasoning_output_tokens > values.output_tokens) {
    values.reasoning_output_tokens = null;
    result.partialReasons.add(`${scope}의 Reasoning output이 Output보다 큼`);
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
    if (modelValues[name] !== result.values[name]) result.partialReasons.add(`thread 모델 합계와 ${name} 합계 불일치`);
    if (result.values[name] !== null && result.latest[name] !== null && result.values[name] !== result.latest[name]) result.partialReasons.add(`최신 누적값과 ${name} 합계 불일치`);
  }
  if (result.values.input_tokens !== null && result.values.output_tokens !== null && result.values.total_tokens !== null && result.values.total_tokens !== result.values.input_tokens + result.values.output_tokens) result.partialReasons.add("thread total_tokens와 Input + Output 불일치");
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
      if (!FIELDS.every((name) => validCounter(total[name]))) continue;
      const current = Object.fromEntries(FIELDS.map((name) => [name, total[name]]));
      const unchanged = previousTokenCount && FIELDS.every((name) => previousTokenCount[name] === current[name]);
      previousTokenCount = current;
      if (unchanged) continue;
      if (!latestRecordUsage || FIELDS.some((name) => !validCounter(last[name]) || last[name] !== latestRecordUsage[name])) result.partialReasons.add("token_count last usage와 최신 token_usage_record usage 불일치");
      continue;
    }
    if (record.type !== "token_usage_record") continue;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      result.partialReasons.add("token_usage_record payload 누락 또는 오류");
      continue;
    }
    const owner = payload.thread_id;
    if (typeof owner !== "string" || owner.toLowerCase() !== result.session.id) {
      result.partialReasons.add("token_usage_record의 thread ID 불일치");
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
        if (seenResponses.get(responseId) !== signature) result.partialReasons.add("같은 response_id의 token 사용량 불일치");
        continue;
      }
      seenResponses.set(responseId, signature);
    } else result.partialReasons.add("token_usage_record의 response_id 누락 또는 오류");

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
    if (!selected && (selectedModel !== null || selectedEffort !== null)) result.partialReasons.add("동일 turn_id의 turn_context 부재로 직전 문맥 사용");
    const model = selectedModel ?? UNKNOWN_MODEL;
    const effort = selectedEffort ?? UNKNOWN_EFFORT;
    const bucketKey = modelKey(model, effort);
    result.models.add(bucketKey);
    if (selectedModel === null) result.partialReasons.add("token_usage_record와 일치하는 turn_context 또는 model 부재");
    if (selectedEffort === null) result.partialReasons.add("token_usage_record와 일치하는 effort 부재");
    if (!result.byModel.has(bucketKey)) result.byModel.set(bucketKey, emptyUsage());
    addUsage(result.byModel.get(bucketKey), usage);

    if (turnId === null) result.partialReasons.add("token_usage_record의 turn_id 누락 또는 오류");
    else {
      if (!turnTotals.has(turnId)) turnTotals.set(turnId, emptyUsage());
      const accumulated = turnTotals.get(turnId);
      addUsage(accumulated, usage);
      for (const name of FIELDS) if (accumulated[name] !== turnUsage[name]) result.partialReasons.add(`turn usage 합계와 ${name} 누적값 불일치`);
    }
    for (const name of FIELDS) {
      const previous = previousThread[name];
      const increment = usage[name];
      const current = threadUsage[name];
      if (previous !== null && increment !== null && current !== null && current !== previous + increment) result.partialReasons.add(`thread usage 증분과 ${name} 누적값 불일치`);
      previousThread[name] = current;
    }
    latestThread = threadUsage;
  }
  if (result.tokenCountEvents === 0 || latestThread === null) {
    result.values = emptyUsage(null);
    result.latest = emptyUsage(null);
    result.byModel.set(modelKey(UNKNOWN_MODEL, UNKNOWN_EFFORT), emptyUsage(null));
    result.models.add(modelKey(UNKNOWN_MODEL, UNKNOWN_EFFORT));
    result.partialReasons.add("token_usage_record 미관측");
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
        result.partialReasons.add("손상되거나 객체가 아닌 JSONL 행");
        continue;
      }
      const payload = record.payload;
      const relevant = record.type === "turn_context" || record.type === "token_usage_record" || (record.type === "event_msg" && payload && typeof payload === "object" && payload.type === "token_count");
      if (!relevant) continue;
      const when = eventTime(record.timestamp);
      if (!when) result.partialReasons.add("관련 이벤트의 시각 누락 또는 오류");
      const ordinal = Number.isInteger(record.ordinal) ? record.ordinal : 0;
      events.push({ key: [when?.getTime() ?? MIN_TIME, ordinal, file.toLowerCase(), lineNumber], record, when });
    }
  }
  if (session.metadataConflict) result.partialReasons.add("rollover 메타데이터의 parent 불일치");
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
      result.partialReasons.add("total_tokens와 Input + Output 불일치");
    }
    if (!["input_tokens", "cached_input_tokens"].some((name) => invalid.has(name)) && source.cached_input_tokens > source.input_tokens) {
      invalid.add("cached_input_tokens");
      result.partialReasons.add("Cache input이 Input보다 큼");
    }
    if (!["output_tokens", "reasoning_output_tokens"].some((name) => invalid.has(name)) && source.reasoning_output_tokens > source.output_tokens) {
      invalid.add("reasoning_output_tokens");
      result.partialReasons.add("Reasoning output이 Output보다 큼");
    }
    const delta = {};
    for (const name of FIELDS) {
      const value = source[name];
      if (invalid.has(name)) {
        reliable[name] = false;
        result.latest[name] = null;
        delta[name] = null;
        result.partialReasons.add(`${name} 누락 또는 잘못된 값`);
      } else if (!reliable[name]) delta[name] = null;
      else if (previous[name] === null) {
        previous[name] = value;
        result.latest[name] = value;
        delta[name] = value;
      } else if (value < previous[name]) {
        reliable[name] = false;
        result.latest[name] = null;
        delta[name] = null;
        result.partialReasons.add(`${name} 누적값 감소`);
      } else {
        delta[name] = value - previous[name];
        previous[name] = value;
        result.latest[name] = value;
      }
    }
    const bucketKey = modelKey(model ?? UNKNOWN_MODEL, effort ?? UNKNOWN_EFFORT);
    result.models.add(bucketKey);
    if (model === null) result.partialReasons.add("token_count 앞 turn_context 또는 model 부재");
    if (effort === null) result.partialReasons.add("token_count 앞 effort 부재");
    addUsage(result.values, delta);
    if (!result.byModel.has(bucketKey)) result.byModel.set(bucketKey, emptyUsage());
    addUsage(result.byModel.get(bucketKey), delta);
  }
  if (result.tokenCountEvents === 0) {
    result.values = emptyUsage(null);
    result.byModel.set(modelKey(UNKNOWN_MODEL, UNKNOWN_EFFORT), emptyUsage(null));
    result.models.add(modelKey(UNKNOWN_MODEL, UNKNOWN_EFFORT));
    result.partialReasons.add("token_count 미관측");
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

export function needsInputReport(message, targetText = "") {
  return reportShell("NEEDS_INPUT", message, { kind: "unknown", label: targetText, rootThreadIds: [] });
}

export function blockedReport(message, targetText = "") {
  return reportShell("BLOCKED", message, { kind: "unknown", label: targetText, rootThreadIds: [] });
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
  for (const name of FIELDS) if (modelTotal[name] !== totals[name]) reasons.add(`전체 모델 합계와 전체 thread ${name} 합계 불일치`);
  if (totals.input_tokens !== null && totals.output_tokens !== null && totals.total_tokens !== null && totals.total_tokens !== totals.input_tokens + totals.output_tokens) reasons.add("전체 total_tokens와 Input + Output 불일치");
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
      return { model, effort, status: model === UNKNOWN_MODEL || effort === UNKNOWN_EFFORT || FIELDS.some((name) => values[name] === null) ? "partial" : "complete", values: withDerived(values) };
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
    if (!(await stat(locations.sessionsRoot)).isDirectory()) return blockedReport("세션 로그 경로에 접근할 수 없습니다.", request.target);
  } catch {
    return blockedReport("세션 로그 경로에 접근할 수 없습니다.", request.target);
  }
  let index;
  try {
    index = await indexSessions(locations.sessionsRoot);
    for (const [id, title] of await loadTitles(locations.indexFile)) if (index.has(id)) index.get(id).title = title;
  } catch (error) {
    return blockedReport(`세션 로그를 읽을 수 없습니다: ${error instanceof Error ? error.message : String(error)}`, request.target);
  }
  const { resolution, error } = resolveDetailed(request.target, index);
  if (error) return needsInputReport(error, request.target);
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
  for (const id of identifiers) results.push(await analyze(index.get(id)));
  const byId = new Map(results.map((result) => [result.session.id, result]));
  for (const id of cycleRoots) byId.get(id)?.partialReasons.add("parent thread 관계 순환");
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
  return value === null ? "미확인" : value.toLocaleString("en-US");
}

function markdownCells(values) {
  return [values.input_tokens, values.cached_input_tokens, values.non_cached_input_tokens, values.cache_write_input_tokens, values.output_tokens, values.input_output_tokens].map(displayNumber);
}

export function makeMarkdown(report) {
  if (!["PASS", "PARTIAL"].includes(report.verdict)) throw new Error("Markdown은 PASS 또는 PARTIAL 결과에만 생성할 수 있습니다.");
  const lines = ["## Token 사용량 스냅샷", ""];
  if (report.target.kind === "project") {
    lines.push(`- 대상 프로젝트: ${markdownText(report.target.label)}`);
    lines.push(`- 대상 범위: 최상위 작업 \`${report.counts.rootThreads.toLocaleString("en-US")}\`개, 하위 작업 \`${(report.counts.totalThreads - report.counts.rootThreads).toLocaleString("en-US")}\`개`);
  } else {
    const target = report.threads[0];
    lines.push(`- 대상 작업: ${markdownText(target?.title ?? "untitled-session")} — \`${target?.threadId ?? report.target.rootThreadIds[0]}\``);
    lines.push(`- 대상 트리: 대상 1개, 하위 작업 \`${Math.max(0, report.counts.totalThreads - 1).toLocaleString("en-US")}\`개`);
  }
  const range = report.observedAt.from ? (report.observedAt.from === report.observedAt.to ? report.observedAt.from : `${report.observedAt.from} ~ ${report.observedAt.to}`) : "미확인";
  const observedLabel = report.counts.observations === 1 ? "관측 시각" : "관측 시각 범위";
  lines.push(`- ${observedLabel}: ${range}`);
  lines.push(`- 집계 상태: ${report.verdict === "PARTIAL" ? "부분 집계" : "완전 집계"} — 발견된 ${report.counts.totalThreads.toLocaleString("en-US")}개 thread 중 ${report.counts.observedThreads.toLocaleString("en-US")}개 token 사용량 관측 완료`);
  if (report.partialReasons.length) lines.push(`- 부분 집계 사유: ${markdownText(report.partialReasons.join("; "))}`);
  lines.push("- 이 값은 로컬 로그의 관측값이며 API 청구액이나 Codex 계정 한도를 뜻하지 않습니다.");
  lines.push("", "| 범위 | Input | Cache input | 비캐시 input | Cache write | Output | 입출력 합계 |", "| ----- | ----: | ----------: | -----------: | ----------: | -----: | ------------: |", `| ${report.target.kind === "project" ? "프로젝트 전체" : "대상 + 하위 작업 전체"} | ${markdownCells(report.totals).join(" | ")} |`, "", `Output 중 reasoning: ${displayNumber(report.totals.reasoning_output_tokens)}. Reasoning output은 Output에 포함되어 입출력 합계에 더하지 않습니다.`, "", "## 모델별 Token 내역", "", "| 모델 | 추론 수준 | Input | Cache input | 비캐시 input | Cache write | Output | 입출력 합계 | 귀속 상태 |", "| ---- | --------- | ----: | ----------: | -----------: | ----------: | -----: | ------------: | --------- |");
  for (const model of report.models) lines.push(`| ${markdownText(model.model)} | ${markdownText(model.effort)} | ${markdownCells(model.values).join(" | ")} | ${model.status === "partial" ? "부분" : "완전"} |`);
  lines.push("", "## Thread별 내역", "", "| 역할 | Thread ID | 집계 상태 | 관측된 모델·추론 수준 | token 사용량 관측 시각 | Input | Cache input | 비캐시 input | Output | 입출력 합계 |", "| ---- | --------- | --------- | --------------------- | ---------------------- | ----: | ----------: | -----------: | -----: | ------------: |");
  for (const thread of report.threads) {
    const models = thread.models.map(({ model, effort }) => `${markdownText(model)}/${markdownText(effort)}`).join(", ") || "미확인";
    const when = thread.observedAt.from ? (thread.observedAt.from === thread.observedAt.to ? thread.observedAt.from : `${thread.observedAt.from} ~ ${thread.observedAt.to}`) : "미확인";
    const values = markdownCells(thread.values);
    lines.push(`| ${markdownText(thread.role)} | \`${thread.threadId}\` | ${thread.status === "partial" ? "부분 집계" : "완전 집계"} | ${models} | ${when} | ${values[0]} | ${values[1]} | ${values[2]} | ${values[4]} | ${values[5]} |`);
  }
  lines.push("", "- 입출력 합계는 Input + Output이며, Cache input은 Input에 포함됩니다.", "- Reasoning output은 Output에 포함된 세부값이므로 입출력 합계에 다시 더하지 않습니다.", "- 작업이 계속 실행 중이면 이후 token 값은 증가할 수 있습니다.", "");
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
  if (!isPortableAbsolute(directory)) throw new Error("Markdown 저장 디렉터리는 절대 경로여야 합니다.");
  const destination = path.resolve(directory);
  if (isWithin(sessionsRoot, destination)) throw new Error("세션 로그 경로 아래에는 Markdown을 저장할 수 없습니다.");
  if (isWithin(pluginRoot, destination)) throw new Error("플러그인 설치 경로 아래에는 Markdown을 저장할 수 없습니다.");
  const [prospectiveDestination, realSessionsRoot, realPluginRoot] = await Promise.all([
    prospectiveRealPath(destination),
    canonicalExistingPath(sessionsRoot),
    canonicalExistingPath(pluginRoot)
  ]);
  if (isWithin(realSessionsRoot, prospectiveDestination)) throw new Error("세션 로그 경로 아래에는 Markdown을 저장할 수 없습니다.");
  if (isWithin(realPluginRoot, prospectiveDestination)) throw new Error("플러그인 설치 경로 아래에는 Markdown을 저장할 수 없습니다.");
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
  if (isWithin(realSessionsRoot, realDestination)) throw new Error("세션 로그 경로 아래에는 Markdown을 저장할 수 없습니다.");
  if (isWithin(realPluginRoot, realDestination)) throw new Error("플러그인 설치 경로 아래에는 Markdown을 저장할 수 없습니다.");
  const stamp = options.stamp ?? new Date().toISOString().replace(/[-:TZ]/g, "").slice(0, 17);
  const id = report.target.kind === "project" ? "project" : (report.target.rootThreadIds[0] ?? "00000000").replace(/[^0-9a-f]/gi, "").slice(0, 8) || "00000000";
  const title = report.target.kind === "project" ? `${pathLeaf(report.target.label) || report.target.label} 프로젝트 전체` : report.threads[0]?.title ?? "untitled-session";
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
      try { await handle.close(); } catch { /* Best-effort close after a failed write. */ }
      await rm(candidate, { force: true });
      throw error;
    }
  }
}

export async function canonicalExistingPath(value) {
  try { return await realpath(value); } catch { return path.resolve(value); }
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
