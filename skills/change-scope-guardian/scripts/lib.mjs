import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { assertSchema } from "./schema-validator.mjs";

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function toPosix(value) {
  return value.split(sep).join("/").replace(/^\.\//, "");
}

function runGit(root, args, encoding = "utf8") {
  try {
    return execFileSync("git", ["-C", root, ...args], {
      encoding,
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
  } catch (error) {
    const detail = error?.stderr ? String(error.stderr).trim() : error.message;
    throw new Error(`Git command failed: ${detail}`);
  }
}

export function resolveRepository(inputRoot) {
  if (typeof inputRoot !== "string" || inputRoot.trim() === "") throw new Error("repositoryRoot is required");
  const requested = realpathSync(resolve(inputRoot));
  if (runGit(requested, ["rev-parse", "--is-inside-work-tree"]).trim() !== "true") {
    throw new Error("repositoryRoot is not inside a Git worktree");
  }
  const root = realpathSync(runGit(requested, ["rev-parse", "--show-toplevel"]).trim());
  const identity = sha256(process.platform === "win32" ? root.toLowerCase() : root);
  return { root, identity };
}

function parsePorcelainV2(buffer) {
  const records = buffer.toString("utf8").split("\0");
  const statuses = new Map();
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record || record.startsWith("# ")) continue;
    if (record.startsWith("? ")) {
      statuses.set(record.slice(2), { status: "??", originalPath: null, kind: "file" });
      continue;
    }
    if (record.startsWith("1 ")) {
      const parts = record.split(" ");
      const path = parts.slice(8).join(" ");
      statuses.set(path, { status: parts[1], originalPath: null, kind: parts[2]?.startsWith("S") ? "gitlink" : "file" });
      continue;
    }
    if (record.startsWith("2 ")) {
      const parts = record.split(" ");
      const path = parts.slice(9).join(" ");
      const originalPath = records[index + 1] || null;
      index += 1;
      statuses.set(path, { status: parts[1], originalPath, kind: parts[2]?.startsWith("S") ? "gitlink" : "file" });
      continue;
    }
    if (record.startsWith("u ")) {
      const parts = record.split(" ");
      const path = parts.slice(10).join(" ");
      statuses.set(path, { status: "UU", originalPath: null, kind: "file" });
    }
  }
  return statuses;
}

function listRepositoryFiles(root, maxFiles, comparisonTarget, commit) {
  const args = comparisonTarget === "commit"
    ? ["ls-tree", "-r", "-z", "--name-only", commit]
    : comparisonTarget === "index"
      ? ["ls-files", "-z", "--cached"]
      : ["ls-files", "-z", "--cached", "--others", "--exclude-standard"];
  const raw = runGit(root, args, "buffer");
  const files = raw.toString("utf8").split("\0").filter(Boolean);
  if (files.length > maxFiles) throw new Error(`Repository file count ${files.length} exceeds maxFiles ${maxFiles}`);
  return files;
}

function inspectPath(root, path, statusInfo, comparisonTarget, commit) {
  if (comparisonTarget === "index" || comparisonTarget === "commit") {
    const spec = comparisonTarget === "index" ? `:${path}` : `${commit}:${path}`;
    try {
      const content = runGit(root, ["show", spec], "buffer");
      return { path, status: statusInfo?.status ?? "clean", sha256: sha256(content), size: content.length, kind: statusInfo?.kind ?? "file", originalPath: statusInfo?.originalPath ?? null };
    } catch {
      return { path, status: statusInfo?.status ?? "deleted", sha256: null, size: null, kind: "missing", originalPath: statusInfo?.originalPath ?? null };
    }
  }
  const absolute = resolve(root, ...path.split("/"));
  const rel = relative(root, absolute);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`Path escapes repository: ${path}`);
  try {
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) {
      const linkTarget = readlinkSync(absolute, "buffer");
      return { path, status: statusInfo?.status ?? "clean", sha256: sha256(linkTarget), size: stat.size, kind: "symlink", originalPath: statusInfo?.originalPath ?? null };
    }
    if (!stat.isFile()) {
      return { path, status: statusInfo?.status ?? "clean", sha256: null, size: stat.size, kind: statusInfo?.kind ?? "gitlink", originalPath: statusInfo?.originalPath ?? null };
    }
    return { path, status: statusInfo?.status ?? "clean", sha256: sha256(readFileSync(absolute)), size: stat.size, kind: statusInfo?.kind ?? "file", originalPath: statusInfo?.originalPath ?? null };
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return { path, status: statusInfo?.status ?? "deleted", sha256: null, size: null, kind: "missing", originalPath: statusInfo?.originalPath ?? null };
  }
}

export function captureBaseline(request, now = new Date()) {
  validateRequest(request, "capture");
  const repository = resolveRepository(request.repositoryRoot);
  const comparisonTarget = request.comparisonTarget ?? "working-tree";
  if (!new Set(["working-tree", "index", "commit"]).has(comparisonTarget)) throw new Error("comparisonTarget is invalid");
  const maxFiles = request.maxFiles ?? 50000;
  let targetCommit = null;
  if (comparisonTarget === "commit") targetCommit = runGit(repository.root, ["rev-parse", "--verify", `${request.commit}^{commit}`]).trim();
  const statuses = comparisonTarget === "commit"
    ? new Map()
    : parsePorcelainV2(runGit(repository.root, ["status", "--porcelain=v2", "-z", "--untracked-files=all"], "buffer"));
  if (comparisonTarget === "index") {
    for (const [path, info] of [...statuses]) {
      if (info.status === "??" || info.status[0] === ".") statuses.delete(path);
      else statuses.set(path, { ...info, status: info.status[0] });
    }
  }
  const files = new Set(listRepositoryFiles(repository.root, maxFiles, comparisonTarget, targetCommit));
  for (const [path, info] of statuses) {
    files.add(path);
    if (info.originalPath) files.add(info.originalPath);
  }
  const entries = [...files].sort((a, b) => a.localeCompare(b)).map((path) => inspectPath(repository.root, path, statuses.get(path), comparisonTarget, targetCommit));
  let head = null;
  try {
    head = runGit(repository.root, ["rev-parse", "--verify", "HEAD"]).trim() || null;
  } catch {
    head = null;
  }
  const targetRef = comparisonTarget === "commit" ? targetCommit : comparisonTarget === "index" ? "INDEX" : "WORKTREE";
  const taskEnvelopeDigest = sha256(canonicalJson(request.taskEnvelope));
  const capturedAt = now.toISOString();
  const manifestSha256 = sha256(canonicalJson({ repositoryIdentity: repository.identity, head, comparisonTarget, targetRef, taskEnvelopeDigest, entries, capturedAt }));
  return {
    schemaVersion: "1.0.0",
    repository,
    head,
    comparisonTarget,
    targetRef,
    taskEnvelopeDigest,
    entries,
    manifestSha256,
    capturedAt
  };
}

function normalizeRule(rule) {
  if (typeof rule !== "string") throw new Error("scope rule must be a string");
  let normalized = rule.trim().replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
  if (!normalized || normalized === "." || isAbsolute(normalized) || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(normalized) || /^~/.test(normalized) || normalized === ".." || normalized.startsWith("../") || /(^|\/)\.\.?($|\/)/.test(normalized) || /\/\//.test(normalized) || /[\u0000-\u001f\u007f]/.test(normalized) || /[$%]?[A-Za-z_][A-Za-z0-9_]*%?/.test(normalized) && /[$%]/.test(normalized)) throw new Error(`scope rule is unsafe: ${rule}`);
  return normalized;
}

function globToRegex(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("**", "\u0000").replaceAll("*", "[^/]*").replaceAll("\u0000", ".*");
  return new RegExp(`^${escaped}(?:/.*)?$`, process.platform === "win32" ? "i" : "");
}

function matches(path, rules) {
  for (const raw of rules) {
    const rule = normalizeRule(raw);
    if (globToRegex(rule).test(path)) return rule;
  }
  return null;
}

function changedFromBaseline(before, current) {
  if (!before) return true;
  if (before.kind === "gitlink" && before.status !== "clean" && current.kind === "gitlink" && current.status !== "clean") return true;
  return before.status !== current.status || before.sha256 !== current.sha256 || before.size !== current.size || before.originalPath !== current.originalPath || before.kind !== current.kind;
}

export function compareScope(request, now = new Date()) {
  validateRequest(request, "verify");
  const current = captureBaseline({ ...request, mode: "capture" }, now);
  const baseline = request.baseline;
  if (!baseline) {
    const changes = current.entries.filter((entry) => entry.status !== "clean").map((entry) => ({
      path: entry.path,
      originalPath: entry.originalPath,
      status: entry.status,
      classification: "ownership-unknown",
      baselineSha256: null,
      currentSha256: entry.sha256,
      matchedRule: null
    }));
    const summary = { "in-scope": 0, excluded: 0, unplanned: 0, "preexisting-untouched": 0, "preexisting-overlap": 0, "ownership-unknown": changes.length };
    return finalizeReport({
      schemaVersion: "1.0.0",
      repositoryIdentity: current.repository.identity,
      baselineDigest: "0".repeat(64),
      currentDigest: current.manifestSha256,
      taskEnvelopeDigest: current.taskEnvelopeDigest,
      changes,
      summary,
      findings: changes.map((item) => `ownership-unknown:${item.path}`),
      verdict: "INCONCLUSIVE",
      observedAt: now.toISOString()
    });
  }
  validateBaseline(baseline);
  if (request.baselineArtifactDigest !== baseline.manifestSha256) throw new Error("baseline artifact digest does not match the frozen digest");
  if (baseline.repository?.identity !== current.repository.identity) throw new Error("baseline repository identity does not match");
  if (baseline.comparisonTarget !== current.comparisonTarget) throw new Error("baseline comparisonTarget does not match");
  if (baseline.taskEnvelopeDigest !== sha256(canonicalJson(request.taskEnvelope))) throw new Error("baseline taskEnvelope digest does not match");

  const included = [...(request.taskEnvelope.scope?.included ?? []), ...(request.taskEnvelope.workUnits ?? []).flatMap((unit) => unit.writeTargets ?? [])];
  const excluded = request.taskEnvelope.scope?.excluded ?? [];
  const baselineByPath = new Map((baseline.entries ?? []).map((entry) => [entry.path, entry]));
  const currentByPath = new Map(current.entries.map((entry) => [entry.path, entry]));
  const changed = [...new Set([...baselineByPath.keys(), ...currentByPath.keys()])].sort((a, b) => a.localeCompare(b)).map((path) => currentByPath.get(path) ?? {
    path,
    status: "deleted",
    sha256: null,
    size: null,
    kind: "missing",
    originalPath: null
  }).filter((entry) => entry.status !== "clean" || changedFromBaseline(baselineByPath.get(entry.path), entry));
  const changes = [];

  for (const entry of changed) {
    const before = baselineByPath.get(entry.path);
    const excludedRule = matches(entry.path, excluded) || (entry.originalPath ? matches(entry.originalPath, excluded) : null);
    const currentRule = matches(entry.path, included);
    const originalRule = entry.originalPath ? matches(entry.originalPath, included) : currentRule;
    const includedRule = currentRule && originalRule ? currentRule : null;
    let classification;
    let matchedRule = excludedRule || includedRule || null;
    if (excludedRule) classification = "excluded";
    else if (before && before.status !== "clean" && !changedFromBaseline(before, entry)) classification = "preexisting-untouched";
    else if (before && before.status !== "clean") classification = "preexisting-overlap";
    else if (includedRule) classification = "in-scope";
    else classification = "unplanned";
    changes.push({ path: entry.path, originalPath: entry.originalPath, status: entry.status, classification, baselineSha256: before?.sha256 ?? null, currentSha256: entry.sha256, matchedRule });
  }

  const classes = ["in-scope", "excluded", "unplanned", "preexisting-untouched", "preexisting-overlap", "ownership-unknown"];
  const summary = Object.fromEntries(classes.map((name) => [name, changes.filter((item) => item.classification === name).length]));
  const findings = changes.filter((item) => !new Set(["in-scope", "preexisting-untouched"]).has(item.classification)).map((item) => `${item.classification}:${item.path}`);
  let verdict = "PASS";
  if (summary.excluded > 0) verdict = "BLOCKED";
  else if (summary["preexisting-overlap"] > 0 || summary.unplanned > 0) verdict = "NEEDS_APPROVAL";

  return finalizeReport({
    schemaVersion: "1.0.0",
    repositoryIdentity: current.repository.identity,
    baselineDigest: baseline.manifestSha256,
    currentDigest: current.manifestSha256,
    taskEnvelopeDigest: current.taskEnvelopeDigest,
    changes,
    summary,
    findings: [...new Set(findings)],
    verdict,
    observedAt: now.toISOString()
  });
}

function finalizeReport(report) {
  return { ...report, reportSha256: sha256(canonicalJson(report)) };
}

export function validateBaseline(value) {
  assertSchema("baseline", value);
  if (!value.repository?.identity || !/^[a-f0-9]{64}$/.test(value.repository.identity)) throw new Error("repository identity is invalid");
  const paths = value.entries.map((entry) => entry.path);
  if (new Set(paths).size !== paths.length || paths.some((path) => !path || path.includes("\\") || path.startsWith("../") || isAbsolute(path))) throw new Error("baseline paths must be unique repository-relative POSIX paths");
  const expected = sha256(canonicalJson({
    repositoryIdentity: value.repository.identity,
    head: value.head,
    comparisonTarget: value.comparisonTarget,
    targetRef: value.targetRef,
    taskEnvelopeDigest: value.taskEnvelopeDigest,
    entries: value.entries,
    capturedAt: value.capturedAt
  }));
  if (value.manifestSha256 !== expected) throw new Error("baseline manifest checksum is invalid");
  return value;
}

export function validateTaskEnvelope(value) {
  assertSchema("taskEnvelope", value);
  const exactKeys = (object, keys, label) => {
    if (!object || typeof object !== "object" || Array.isArray(object) || Object.keys(object).some((key) => !keys.includes(key)) || keys.some((key) => !(key in object))) throw new Error(`${label} fields are invalid`);
  };
  const stringArray = (array, label, allowEmpty = true) => {
    if (!Array.isArray(array) || (!allowEmpty && array.length === 0) || array.some((item) => typeof item !== "string" || item.length === 0) || new Set(array).size !== array.length) throw new Error(`${label} is invalid`);
  };
  exactKeys(value, ["schemaVersion", "taskId", "objective", "scope", "acceptanceCriteria", "riskLevel", "workUnits", "requiredCapabilities", "constraints", "authorization", "decision", "orchestration"], "TaskEnvelope.v1");
  if (value.schemaVersion !== "1.0.0" || typeof value.taskId !== "string" || !value.taskId || typeof value.objective !== "string" || !value.objective) throw new Error("TaskEnvelope.v1 identity fields are invalid");
  exactKeys(value.scope, ["included", "excluded"], "TaskEnvelope.v1 scope");
  stringArray(value.scope.included, "TaskEnvelope.v1 scope.included");
  stringArray(value.scope.excluded, "TaskEnvelope.v1 scope.excluded");
  for (const rule of [...value.scope.included, ...value.scope.excluded]) normalizeRule(rule);
  stringArray(value.acceptanceCriteria, "TaskEnvelope.v1 acceptanceCriteria", false);
  if (!["low", "medium", "high", "critical"].includes(value.riskLevel)) throw new Error("TaskEnvelope.v1 riskLevel is invalid");
  if (!Array.isArray(value.workUnits)) throw new Error("TaskEnvelope.v1 workUnits are invalid");
  for (const unit of value.workUnits) {
    exactKeys(unit, ["id", "objective", "dependencies", "writeTargets"], "TaskEnvelope.v1 work unit");
    if (typeof unit.id !== "string" || !unit.id || typeof unit.objective !== "string" || !unit.objective) throw new Error("TaskEnvelope.v1 work unit identity is invalid");
    stringArray(unit.dependencies, "TaskEnvelope.v1 work unit dependencies");
    stringArray(unit.writeTargets, "TaskEnvelope.v1 work unit writeTargets");
    for (const rule of unit.writeTargets) normalizeRule(rule);
  }
  if (new Set(value.workUnits.map((unit) => unit.id)).size !== value.workUnits.length) throw new Error("TaskEnvelope.v1 work unit IDs are not unique");
  stringArray(value.requiredCapabilities, "TaskEnvelope.v1 requiredCapabilities");
  stringArray(value.constraints, "TaskEnvelope.v1 constraints");
  exactKeys(value.authorization, ["allowedActions", "prohibitedActions", "approvalRequired"], "TaskEnvelope.v1 authorization");
  stringArray(value.authorization.allowedActions, "TaskEnvelope.v1 allowedActions");
  stringArray(value.authorization.prohibitedActions, "TaskEnvelope.v1 prohibitedActions");
  stringArray(value.authorization.approvalRequired, "TaskEnvelope.v1 approvalRequired");
  exactKeys(value.decision, ["complexity", "hasConflicts"], "TaskEnvelope.v1 decision");
  if (!["simple", "complex"].includes(value.decision.complexity) || typeof value.decision.hasConflicts !== "boolean") throw new Error("TaskEnvelope.v1 decision is invalid");
  exactKeys(value.orchestration, ["requested", "mcpAvailable"], "TaskEnvelope.v1 orchestration");
  if (typeof value.orchestration.requested !== "boolean" || typeof value.orchestration.mcpAvailable !== "boolean") throw new Error("TaskEnvelope.v1 orchestration is invalid");
  return value;
}

export function validateRequest(value, expectedMode) {
  assertSchema("request", value);
  if (!value || value.schemaVersion !== "1.0.0" || value.mode !== expectedMode) throw new Error(`ChangeScopeRequest.v1 mode must be ${expectedMode}`);
  if (typeof value.repositoryRoot !== "string" || !value.repositoryRoot) throw new Error("repositoryRoot is required");
  if (!["working-tree", "index", "commit"].includes(value.comparisonTarget)) throw new Error("comparisonTarget is invalid");
  if (value.comparisonTarget === "commit" && (typeof value.commit !== "string" || !value.commit)) throw new Error("commit is required for commit comparison");
  if (value.maxFiles !== undefined && (!Number.isInteger(value.maxFiles) || value.maxFiles < 1 || value.maxFiles > 200000)) throw new Error("maxFiles is invalid");
  validateTaskEnvelope(value.taskEnvelope);
  if (expectedMode === "verify" && value.baseline !== undefined) {
    validateBaseline(value.baseline);
    if (value.baselineArtifactDigest !== value.baseline.manifestSha256) throw new Error("baseline artifact digest does not match the frozen digest");
  }
  return value;
}

export function validateReport(value, expectedArtifactDigest) {
  assertSchema("report", value);
  if (!/^[a-f0-9]{64}$/.test(expectedArtifactDigest ?? "") || value.reportSha256 !== expectedArtifactDigest) throw new Error("report artifact digest does not match the frozen digest");
  const classes = ["in-scope", "excluded", "unplanned", "preexisting-untouched", "preexisting-overlap", "ownership-unknown"];
  for (const classification of classes) {
    const actual = value.changes.filter((item) => item.classification === classification).length;
    if (value.summary[classification] !== actual) throw new Error(`summary count is invalid for ${classification}`);
  }
  if (value.changes.some((item) => !item || typeof item.path !== "string" || (item.matchedRule !== null && typeof item.matchedRule !== "string"))) throw new Error("change path or matchedRule is invalid");
  if (new Set(value.changes.map((item) => item.path)).size !== value.changes.length) throw new Error("change paths must be unique");
  let expected = "PASS";
  if (value.summary["ownership-unknown"] > 0) expected = "INCONCLUSIVE";
  else if (value.summary.excluded > 0) expected = "BLOCKED";
  else if (value.summary["preexisting-overlap"] > 0 || value.summary.unplanned > 0) expected = "NEEDS_APPROVAL";
  if (value.verdict !== expected) throw new Error(`verdict ${value.verdict} does not match ${expected}`);
  if (!/^[a-f0-9]{64}$/.test(value.baselineDigest) || !/^[a-f0-9]{64}$/.test(value.currentDigest)) throw new Error("report digest is invalid");
  const expectedFindings = value.changes
    .filter((item) => !new Set(["in-scope", "preexisting-untouched"]).has(item.classification))
    .map((item) => `${item.classification}:${item.path}`);
  if (canonicalJson([...new Set(value.findings)].sort()) !== canonicalJson([...new Set(expectedFindings)].sort())) throw new Error("report findings do not match changes");
  const { reportSha256, ...unsigned } = value;
  if (reportSha256 !== sha256(canonicalJson(unsigned))) throw new Error("report checksum is invalid");
  return value;
}

export async function readJsonInput(argument) {
  if (argument) return JSON.parse(readFileSync(resolve(argument), "utf8"));
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) throw new Error("JSON input is required via a file argument or stdin");
  return JSON.parse(raw);
}

export function writeJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
