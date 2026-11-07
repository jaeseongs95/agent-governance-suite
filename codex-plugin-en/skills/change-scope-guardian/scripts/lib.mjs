import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { assertSchema } from "./schema-validator.mjs";
import { hostText } from "../../../runtime/i18n.mjs";

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

const maxGitOutputBytes = 64 * 1024 * 1024;

function runGit(root, args, encoding = "utf8", input) {
  try {
    return execFileSync("git", ["-C", root, ...args], {
      encoding,
      maxBuffer: maxGitOutputBytes,
      input,
      windowsHide: true,
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"]
    });
  } catch (error) {
    const detail = error?.stderr ? String(error.stderr).trim() : error.message;
    throw new Error(hostText("skillScripts.changeScope.gitFailed", { detail }));
  }
}

export function resolveRepository(inputRoot) {
  if (typeof inputRoot !== "string" || inputRoot.trim() === "") throw new Error(hostText("skillScripts.changeScope.repositoryRootRequired"));
  const requested = realpathSync(resolve(inputRoot));
  if (runGit(requested, ["rev-parse", "--is-inside-work-tree"]).trim() !== "true") {
    throw new Error(hostText("skillScripts.changeScope.notGitWorktree"));
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
    ? ["ls-tree", "-r", "-z", commit]
    : comparisonTarget === "index"
      ? ["ls-files", "-z", "--cached", "--stage"]
      : ["ls-files", "-z", "--cached", "--others", "--exclude-standard"];
  const raw = runGit(root, args, "buffer");
  const records = raw.toString("utf8").split("\0").filter(Boolean);
  const objects = new Map();
  const files = records.map((record) => {
    if (comparisonTarget === "working-tree") return record;
    const tab = record.indexOf("\t");
    const [mode, second, third] = record.slice(0, tab).split(" ");
    const path = record.slice(tab + 1);
    // Keep gitlink's git-show representation and unmerged-index failures unchanged.
    if (mode !== "160000" && (comparisonTarget === "commit" || third === "0")) {
      objects.set(path, comparisonTarget === "commit" ? third : second);
    }
    return path;
  });
  if (files.length > maxFiles) throw new Error(hostText("skillScripts.changeScope.fileCountExceeds", { count: files.length, maxFiles }));
  return { files, objects };
}

function hashGitObjects(root, objectIds) {
  const ids = [...new Set(objectIds)];
  const hashes = new Map();
  if (ids.length === 0) return hashes;
  const fail = (detail) => { throw new Error(hostText("skillScripts.changeScope.gitFailed", { detail })); };
  const metadata = runGit(root, ["cat-file", "--batch-check"], "utf8", `${ids.join("\n")}\n`).trimEnd().split("\n");
  if (metadata.length !== ids.length) fail("git cat-file returned an incomplete object list");
  let batch = [];
  let batchBytes = 0;
  const flush = () => {
    if (batch.length === 0) return;
    const output = runGit(root, ["cat-file", "--batch"], "buffer", `${batch.map((item) => item.id).join("\n")}\n`);
    let offset = 0;
    for (const { id, size } of batch) {
      const end = output.indexOf(10, offset);
      if (end < offset || output.toString("ascii", offset, end) !== `${id} blob ${size}`) fail(`git cat-file returned an invalid header for ${id}`);
      offset = end + 1;
      if (offset + size >= output.length || output[offset + size] !== 10) fail(`git cat-file returned incomplete content for ${id}`);
      hashes.set(id, { sha256: sha256(output.subarray(offset, offset + size)), size });
      offset += size + 1;
    }
    if (offset !== output.length) fail("git cat-file returned unexpected trailing content");
    batch = [];
    batchBytes = 0;
  };
  for (let index = 0; index < ids.length; index += 1) {
    const id = ids[index];
    const [actualId, type, rawSize] = metadata[index].split(" ");
    const size = Number(rawSize);
    if (actualId !== id || type !== "blob" || !Number.isSafeInteger(size) || size < 0) fail(`git cat-file could not read blob ${id}: ${metadata[index]}`);
    const responseBytes = id.length + " blob ".length + rawSize.length + 2 + size;
    // Bound aggregate blob buffers below the existing cap. Read large blobs raw
    // so batch framing does not lower the existing per-blob maxBuffer limit.
    if (responseBytes > maxGitOutputBytes / 2) {
      flush();
      const content = runGit(root, ["cat-file", "blob", id], "buffer");
      if (content.length !== size) fail(`git cat-file returned incomplete content for ${id}`);
      hashes.set(id, { sha256: sha256(content), size });
      continue;
    }
    if (batch.length > 0 && batchBytes + responseBytes > maxGitOutputBytes / 2) flush();
    batch.push({ id, size });
    batchBytes += responseBytes;
  }
  flush();
  return hashes;
}

function inspectPath(root, path, statusInfo, comparisonTarget, commit, inTarget, objectHash) {
  if (comparisonTarget === "index" || comparisonTarget === "commit") {
    // Only a successful target listing proves absence; a failed blob read does not.
    if (!inTarget) {
      return { path, status: statusInfo?.status ?? "deleted", sha256: null, size: null, kind: "missing", originalPath: statusInfo?.originalPath ?? null };
    }
    if (objectHash) {
      return { path, status: statusInfo?.status ?? "clean", ...objectHash, kind: statusInfo?.kind ?? "file", originalPath: statusInfo?.originalPath ?? null };
    }
    const spec = comparisonTarget === "index" ? `:${path}` : `${commit}:${path}`;
    const content = runGit(root, ["show", spec], "buffer");
    return { path, status: statusInfo?.status ?? "clean", sha256: sha256(content), size: content.length, kind: statusInfo?.kind ?? "file", originalPath: statusInfo?.originalPath ?? null };
  }
  const absolute = resolve(root, ...path.split("/"));
  const rel = relative(root, absolute);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(hostText("skillScripts.changeScope.pathEscapes", { path }));
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
  if (!new Set(["working-tree", "index", "commit"]).has(comparisonTarget)) throw new Error(hostText("skillScripts.changeScope.comparisonTargetInvalid"));
  if (request.baseline !== undefined) {
    // Scope update: re-bind the original pre-task state to the new task envelope.
    // A fresh capture here would absorb this task's own edits as preexisting changes.
    const original = request.baseline;
    if (original.repository.identity !== repository.identity) throw new Error(hostText("skillScripts.changeScope.baselineIdentityMismatch"));
    if (original.comparisonTarget !== comparisonTarget) throw new Error(hostText("skillScripts.changeScope.baselineTargetMismatch"));
    const { head, targetRef, entries, capturedAt } = original;
    const taskEnvelopeDigest = sha256(canonicalJson(request.taskEnvelope));
    const manifestSha256 = sha256(canonicalJson({ repositoryIdentity: original.repository.identity, head, comparisonTarget, targetRef, taskEnvelopeDigest, entries, capturedAt }));
    return { schemaVersion: "1.0.0", repository: original.repository, head, comparisonTarget, targetRef, taskEnvelopeDigest, entries, manifestSha256, capturedAt };
  }
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
  const listed = listRepositoryFiles(repository.root, maxFiles, comparisonTarget, targetCommit);
  const listedFiles = new Set(listed.files);
  const objectHashes = hashGitObjects(repository.root, listed.objects.values());
  const files = new Set(listedFiles);
  for (const [path, info] of statuses) {
    files.add(path);
    if (info.originalPath) files.add(info.originalPath);
  }
  const entries = [...files].sort((a, b) => a.localeCompare(b)).map((path) => inspectPath(repository.root, path, statuses.get(path), comparisonTarget, targetCommit, listedFiles.has(path), objectHashes.get(listed.objects.get(path))));
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
  if (typeof rule !== "string") throw new Error(hostText("skillScripts.changeScope.ruleNotString"));
  let normalized = rule.trim().replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
  if (!normalized || normalized === "." || isAbsolute(normalized) || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(normalized) || /^~/.test(normalized) || normalized === ".." || normalized.startsWith("../") || /(^|\/)\.\.?($|\/)/.test(normalized) || /\/\//.test(normalized) || /[\u0000-\u001f\u007f]/.test(normalized) || /[$%]?[A-Za-z_][A-Za-z0-9_]*%?/.test(normalized) && /[$%]/.test(normalized)) throw new Error(hostText("skillScripts.changeScope.ruleUnsafe", { rule }));
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
  const { baseline, baselineArtifactDigest: _frozenDigest, ...snapshotRequest } = request;
  const current = captureBaseline({ ...snapshotRequest, mode: "capture" }, now);
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
  if (request.baselineArtifactDigest !== baseline.manifestSha256) throw new Error(hostText("skillScripts.changeScope.baselineDigestMismatch"));
  if (baseline.repository?.identity !== current.repository.identity) throw new Error(hostText("skillScripts.changeScope.baselineIdentityMismatch"));
  if (baseline.comparisonTarget !== current.comparisonTarget) throw new Error(hostText("skillScripts.changeScope.baselineTargetMismatch"));
  if (baseline.taskEnvelopeDigest !== sha256(canonicalJson(request.taskEnvelope))) throw new Error(hostText("skillScripts.changeScope.baselineTaskEnvelopeMismatch"));

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
  else if (summary["preexisting-overlap"] > 0 || summary.unplanned > 0) verdict = "NEEDS_REVIEW";

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
  if (!value.repository?.identity || !/^[a-f0-9]{64}$/.test(value.repository.identity)) throw new Error(hostText("skillScripts.changeScope.identityInvalid"));
  const paths = value.entries.map((entry) => entry.path);
  if (new Set(paths).size !== paths.length || paths.some((path) => !path || path.includes("\\") || path.startsWith("../") || isAbsolute(path))) throw new Error(hostText("skillScripts.changeScope.baselinePaths"));
  const expected = sha256(canonicalJson({
    repositoryIdentity: value.repository.identity,
    head: value.head,
    comparisonTarget: value.comparisonTarget,
    targetRef: value.targetRef,
    taskEnvelopeDigest: value.taskEnvelopeDigest,
    entries: value.entries,
    capturedAt: value.capturedAt
  }));
  if (value.manifestSha256 !== expected) throw new Error(hostText("skillScripts.changeScope.baselineChecksum"));
  return value;
}

export function validateTaskEnvelope(value) {
  assertSchema("taskEnvelope", value);
  const exactKeys = (object, keys, label) => {
    if (!object || typeof object !== "object" || Array.isArray(object) || Object.keys(object).some((key) => !keys.includes(key)) || keys.some((key) => !(key in object))) throw new Error(hostText("skillScripts.changeScope.fieldsInvalid", { label }));
  };
  const stringArray = (array, label, allowEmpty = true) => {
    if (!Array.isArray(array) || (!allowEmpty && array.length === 0) || array.some((item) => typeof item !== "string" || item.length === 0) || new Set(array).size !== array.length) throw new Error(hostText("skillScripts.changeScope.labelInvalid", { label }));
  };
  // The shared schema above owns root fields, including optional extensions.
  if (value.schemaVersion !== "1.0.0" || typeof value.taskId !== "string" || !value.taskId || typeof value.objective !== "string" || !value.objective) throw new Error(hostText("skillScripts.changeScope.envelopeIdentity"));
  exactKeys(value.scope, ["included", "excluded"], "TaskEnvelope.v1 scope");
  stringArray(value.scope.included, "TaskEnvelope.v1 scope.included");
  stringArray(value.scope.excluded, "TaskEnvelope.v1 scope.excluded");
  for (const rule of [...value.scope.included, ...value.scope.excluded]) normalizeRule(rule);
  stringArray(value.acceptanceCriteria, "TaskEnvelope.v1 acceptanceCriteria", false);
  if (!["low", "medium", "high", "critical"].includes(value.riskLevel)) throw new Error(hostText("skillScripts.changeScope.envelopeRiskLevel"));
  if (!Array.isArray(value.workUnits)) throw new Error(hostText("skillScripts.changeScope.envelopeWorkUnits"));
  for (const unit of value.workUnits) {
    exactKeys(unit, ["id", "objective", "dependencies", "writeTargets"], "TaskEnvelope.v1 work unit");
    if (typeof unit.id !== "string" || !unit.id || typeof unit.objective !== "string" || !unit.objective) throw new Error(hostText("skillScripts.changeScope.envelopeWorkUnitIdentity"));
    stringArray(unit.dependencies, "TaskEnvelope.v1 work unit dependencies");
    stringArray(unit.writeTargets, "TaskEnvelope.v1 work unit writeTargets");
    for (const rule of unit.writeTargets) normalizeRule(rule);
  }
  if (new Set(value.workUnits.map((unit) => unit.id)).size !== value.workUnits.length) throw new Error(hostText("skillScripts.changeScope.envelopeWorkUnitIds"));
  stringArray(value.requiredCapabilities, "TaskEnvelope.v1 requiredCapabilities");
  stringArray(value.constraints, "TaskEnvelope.v1 constraints");
  exactKeys(value.authorization, ["allowedActions", "prohibitedActions", "approvalRequired"], "TaskEnvelope.v1 authorization");
  stringArray(value.authorization.allowedActions, "TaskEnvelope.v1 allowedActions");
  stringArray(value.authorization.prohibitedActions, "TaskEnvelope.v1 prohibitedActions");
  stringArray(value.authorization.approvalRequired, "TaskEnvelope.v1 approvalRequired");
  exactKeys(value.decision, ["complexity", "hasConflicts"], "TaskEnvelope.v1 decision");
  if (!["simple", "complex"].includes(value.decision.complexity) || typeof value.decision.hasConflicts !== "boolean") throw new Error(hostText("skillScripts.changeScope.envelopeDecision"));
  exactKeys(value.orchestration, ["requested", "mcpAvailable"], "TaskEnvelope.v1 orchestration");
  if (typeof value.orchestration.requested !== "boolean" || typeof value.orchestration.mcpAvailable !== "boolean") throw new Error(hostText("skillScripts.changeScope.envelopeOrchestration"));
  return value;
}

export function validateRequest(value, expectedMode) {
  assertSchema("request", value);
  if (!value || value.schemaVersion !== "1.0.0" || value.mode !== expectedMode) throw new Error(hostText("skillScripts.changeScope.requestMode", { mode: expectedMode }));
  if (typeof value.repositoryRoot !== "string" || !value.repositoryRoot) throw new Error(hostText("skillScripts.changeScope.repositoryRootRequired"));
  if (!["working-tree", "index", "commit"].includes(value.comparisonTarget)) throw new Error(hostText("skillScripts.changeScope.comparisonTargetInvalid"));
  if (value.comparisonTarget === "commit" && (typeof value.commit !== "string" || !value.commit)) throw new Error(hostText("skillScripts.changeScope.commitRequired"));
  if (value.maxFiles !== undefined && (!Number.isInteger(value.maxFiles) || value.maxFiles < 1 || value.maxFiles > 200000)) throw new Error(hostText("skillScripts.changeScope.maxFilesInvalid"));
  validateTaskEnvelope(value.taskEnvelope);
  if (value.baseline !== undefined) {
    validateBaseline(value.baseline);
    if (value.baselineArtifactDigest !== value.baseline.manifestSha256) throw new Error(hostText("skillScripts.changeScope.baselineDigestMismatch"));
  }
  return value;
}

export function validateReport(value, expectedArtifactDigest) {
  assertSchema("report", value);
  if (!/^[a-f0-9]{64}$/.test(expectedArtifactDigest ?? "") || value.reportSha256 !== expectedArtifactDigest) throw new Error(hostText("skillScripts.changeScope.reportDigestMismatch"));
  const classes = ["in-scope", "excluded", "unplanned", "preexisting-untouched", "preexisting-overlap", "ownership-unknown"];
  for (const classification of classes) {
    const actual = value.changes.filter((item) => item.classification === classification).length;
    if (value.summary[classification] !== actual) throw new Error(hostText("skillScripts.changeScope.summaryCount", { classification }));
  }
  if (value.changes.some((item) => !item || typeof item.path !== "string" || (item.matchedRule !== null && typeof item.matchedRule !== "string"))) throw new Error(hostText("skillScripts.changeScope.changeInvalid"));
  if (new Set(value.changes.map((item) => item.path)).size !== value.changes.length) throw new Error(hostText("skillScripts.changeScope.changePathsUnique"));
  if (value.baselineDigest === "0".repeat(64) && value.changes.some((item) => item.classification !== "ownership-unknown")) throw new Error(hostText("skillScripts.changeScope.missingBaseline"));
  let expected = "PASS";
  if (value.baselineDigest === "0".repeat(64) || value.summary["ownership-unknown"] > 0) expected = "INCONCLUSIVE";
  else if (value.summary.excluded > 0) expected = "BLOCKED";
  else if (value.summary["preexisting-overlap"] > 0 || value.summary.unplanned > 0) expected = "NEEDS_REVIEW";
  if (value.verdict !== expected) throw new Error(hostText("skillScripts.changeScope.verdictMismatch", { verdict: value.verdict, expected }));
  if (!/^[a-f0-9]{64}$/.test(value.baselineDigest) || !/^[a-f0-9]{64}$/.test(value.currentDigest)) throw new Error(hostText("skillScripts.changeScope.reportDigestInvalid"));
  const expectedFindings = value.changes
    .filter((item) => !new Set(["in-scope", "preexisting-untouched"]).has(item.classification))
    .map((item) => `${item.classification}:${item.path}`);
  if (canonicalJson([...new Set(value.findings)].sort()) !== canonicalJson([...new Set(expectedFindings)].sort())) throw new Error(hostText("skillScripts.changeScope.findingsMismatch"));
  const { reportSha256, ...unsigned } = value;
  if (reportSha256 !== sha256(canonicalJson(unsigned))) throw new Error(hostText("skillScripts.changeScope.reportChecksum"));
  return value;
}

export async function readJsonInput(argument) {
  if (argument) return JSON.parse(readFileSync(resolve(argument), "utf8"));
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) throw new Error(hostText("skillScripts.changeScope.jsonInputRequired"));
  return JSON.parse(raw);
}

export function writeJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
