#!/usr/bin/env node
import { createHash } from "node:crypto";
import { access, lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Ajv2020 } from "../../../runtime/schema-validation.mjs";
import { hostText } from "../../../runtime/i18n.mjs";

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIRECTORY, "..");

export function isPathWithin(root, candidate, pathApi = path) {
  const caseInsensitive = pathApi === path.win32;
  const normalize = (value) => {
    const normalized = pathApi.resolve(value);
    return caseInsensitive ? normalized.toLowerCase() : normalized;
  };
  const normalizedRoot = normalize(root);
  const normalizedCandidate = normalize(candidate);
  const relative = pathApi.relative(normalizedRoot, normalizedCandidate);
  return relative === "" || (!relative.startsWith(`..${pathApi.sep}`) && relative !== ".." && !pathApi.isAbsolute(relative));
}

export function pathFlavor(value) {
  return /^[A-Za-z]:[\\/]/u.test(value) || /^\\\\/u.test(value) ? path.win32 : path;
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return false;
    throw error;
  }
}

async function loadSchema(name) {
  return JSON.parse(await readFile(path.join(ROOT, "contracts", name), "utf8"));
}

async function validators() {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const requestSchema = await loadSchema("instruction-scope-request.v1.schema.json");
  const outputSchema = await loadSchema("instruction-scope-resolution.v1.schema.json");
  return { request: ajv.compile(requestSchema), output: ajv.compile(outputSchema) };
}

function invalid(key, params = {}, details = null) {
  const error = new Error(hostText(key, params));
  error.code = "INVALID_INPUT";
  error.details = details;
  return error;
}

async function canonicalTarget(workspaceRoot, target) {
  const requestedAbsolute = path.resolve(workspaceRoot, target.path);
  let cursor = requestedAbsolute;
  const suffix = [];
  while (!(await exists(cursor))) {
    const parent = path.dirname(cursor);
    if (parent === cursor) throw invalid("skillTools.instructionScope.noExistingAncestor", {}, { target: target.path });
    suffix.unshift(path.basename(cursor));
    cursor = parent;
  }
  const existingStats = await lstat(cursor);
  const existingReal = await realpath(cursor);
  let resolvedPath = path.join(existingReal, ...suffix);
  const targetExists = suffix.length === 0;
  if (targetExists && !(await exists(requestedAbsolute))) throw invalid("skillTools.instructionScope.targetStateChanged");
  if (targetExists) resolvedPath = await realpath(requestedAbsolute);
  if (!targetExists && !target.mayNotExist) {
    throw invalid("skillTools.instructionScope.targetMissing", {}, { target: target.path });
  }
  const targetDirectory = targetExists && existingStats.isFile() ? path.dirname(resolvedPath) : resolvedPath;
  return { requestedPath: target.path, resolvedPath, exists: targetExists, targetDirectory };
}

function ancestors(root, targetDirectory) {
  if (!isPathWithin(root, targetDirectory)) return [];
  const relative = path.relative(root, targetDirectory);
  const segments = relative === "" ? [] : relative.split(path.sep);
  const result = [root];
  let cursor = root;
  for (const segment of segments) {
    cursor = path.join(cursor, segment);
    result.push(cursor);
  }
  return result;
}

const DEFAULT_INSTRUCTION_FILES = Object.freeze([
  Object.freeze({ name: "AGENTS.override.md", kind: "override" }),
  Object.freeze({ name: "AGENTS.md", kind: "agents" }),
]);

// Host adapters supply an explicit ordered descriptor. Requests cannot select a
// host policy; absent adapter configuration always keeps the common AGENTS rule.
function instructionFiles(options) {
  if (!options || typeof options !== "object" || Array.isArray(options)
    || Object.keys(options).some(key => key !== "instructionFiles")) throw invalid("skillTools.instructionScope.invalidAdapterOptions");
  const files = options.instructionFiles ?? DEFAULT_INSTRUCTION_FILES;
  if (!Array.isArray(files) || files.length === 0 || files.length > 8) throw invalid("skillTools.instructionScope.invalidFileDescriptor");
  const seen = new Set();
  return files.map(file => {
    if (!file || typeof file !== "object" || Array.isArray(file)
      || Object.keys(file).some(key => !["name", "kind"].includes(key))
      || typeof file.name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}\.md$/u.test(file.name)
      || !["agents", "override"].includes(file.kind) || seen.has(file.name.toLowerCase())) {
      throw invalid("skillTools.instructionScope.invalidFileDescriptor");
    }
    seen.add(file.name.toLowerCase());
    return { name: file.name, kind: file.kind };
  });
}

async function selectedInstruction(directory, authorizedRoots, files) {
  if (!(await exists(directory))) return null;
  const stats = await lstat(directory);
  if (!stats.isDirectory()) return null;
  for (const { name: filename, kind } of files) {
    const candidate = path.join(directory, filename);
    if (!(await exists(candidate))) continue;
    const actual = await realpath(candidate);
    if (!authorizedRoots.some((root) => isPathWithin(root, actual))) {
      throw invalid("skillTools.instructionScope.instructionOutsideRoots", {}, { path: candidate });
    }
    const data = await readFile(actual);
    if (data.toString("utf8").trim().length === 0) continue;
    return {
      path: actual,
      kind,
      replacesSiblingAgents: kind === "override",
      size: data.byteLength,
      sha256: sha256(data),
      precedence: 0,
    };
  }
  return null;
}

export async function resolveInstructionFiles(request, adapterOptions = {}) {
  const files = instructionFiles(adapterOptions);
  const check = await validators();
  if (!check.request(request)) {
    throw invalid("skillTools.instructionScope.requestValidationFailed", {}, { errors: check.request.errors });
  }

  const workspaceRoot = await realpath(path.resolve(request.workspaceRoot));
  const workspaceStats = await lstat(workspaceRoot);
  if (!workspaceStats.isDirectory()) throw invalid("skillTools.instructionScope.workspaceRootNotDirectory");

  const authorizedRootRecords = [];
  const findings = [];
  for (const root of [...request.instructionRoots].sort((a, b) => a.precedence - b.precedence || a.path.localeCompare(b.path))) {
    if (!root.authorized) {
      findings.push(hostText("skillTools.instructionScope.skippedUnauthorizedRoot", { path: root.path }));
      continue;
    }
    const actual = await realpath(path.resolve(workspaceRoot, root.path));
    if (!(await lstat(actual)).isDirectory()) throw invalid("skillTools.instructionScope.instructionRootNotDirectory", {}, { path: root.path });
    authorizedRootRecords.push({ path: actual, precedence: root.precedence });
  }
  if (authorizedRootRecords.length === 0) throw invalid("skillTools.instructionScope.noAuthorizedRoot");

  const authorizedRoots = authorizedRootRecords.map((root) => root.path);
  const targetResults = [];
  const manifest = new Map();
  for (const target of request.targets) {
    const requestedAbsolute = path.resolve(workspaceRoot, target.path);
    if (!isPathWithin(workspaceRoot, requestedAbsolute)) {
      throw invalid("skillTools.instructionScope.targetOutsideWorkspace", {}, { target: target.path, requestedAbsolute });
    }
    const resolved = await canonicalTarget(workspaceRoot, target);
    if (!isPathWithin(workspaceRoot, resolved.resolvedPath)) {
      throw invalid("skillTools.instructionScope.targetResolvesOutside", {}, { target: target.path, resolvedPath: resolved.resolvedPath });
    }
    const applicableRoots = authorizedRootRecords.filter((root) => isPathWithin(root.path, resolved.targetDirectory));
    if (applicableRoots.length === 0) {
      throw invalid("skillTools.instructionScope.targetNotCovered", {}, { target: target.path });
    }

    const directories = new Map();
    for (const root of applicableRoots) {
      for (const directory of ancestors(root.path, resolved.targetDirectory)) {
        const prior = directories.get(directory);
        directories.set(directory, prior === undefined ? root.precedence : Math.min(prior, root.precedence));
      }
    }
    const orderedDirectories = [...directories.entries()].sort((a, b) => {
      const depth = a[0].split(path.sep).length - b[0].split(path.sep).length;
      return depth || a[1] - b[1] || a[0].localeCompare(b[0]);
    });
    const chain = [];
    for (const [directory] of orderedDirectories) {
      const instruction = await selectedInstruction(directory, authorizedRoots, files);
      if (!instruction || chain.some((item) => item.path === instruction.path)) continue;
      instruction.precedence = chain.length + 1;
      chain.push(instruction);
      manifest.set(instruction.path, instruction);
    }
    if (!resolved.exists) findings.push(hostText("skillTools.instructionScope.futureNestedUnobservable", { path: target.path }));
    targetResults.push({
      requestedPath: resolved.requestedPath,
      resolvedPath: resolved.resolvedPath,
      exists: resolved.exists,
      instructionChain: chain,
      activeRules: [],
      overriddenRules: [],
      unresolvedConflicts: [],
    });
  }

  const output = {
    schemaVersion: "1.0.0",
    workspaceRoot,
    instructionFileManifest: [...manifest.values()].sort((a, b) => a.path.localeCompare(b.path)),
    targets: targetResults,
    findings,
    analysisStatus: "required",
    verdict: "ANALYSIS_REQUIRED",
  };
  if (!check.output(output)) throw invalid("skillTools.instructionScope.outputSchemaFailed", {}, { errors: check.output.errors });
  return output;
}

async function readInput(argv) {
  const inputIndex = argv.indexOf("--input");
  if (inputIndex >= 0) {
    const filename = argv[inputIndex + 1];
    if (!filename) throw invalid("skillTools.instructionScope.inputNeedsPath");
    return JSON.parse(await readFile(filename, "utf8"));
  }
  let body = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) body += chunk;
  if (!body.trim()) throw invalid("skillTools.instructionScope.inputExpected");
  return JSON.parse(body);
}

export async function runCli(argv = process.argv.slice(2), adapterOptions = {}) {
  try {
    const output = await resolveInstructionFiles(await readInput(argv), adapterOptions);
    process.stdout.write(`${JSON.stringify({ schemaVersion: "1.0.0", ok: true, output, error: null })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      schemaVersion: "1.0.0",
      ok: false,
      output: null,
      error: {
        code: error.code ?? "INVALID_INPUT",
        message: error instanceof Error ? error.message : String(error),
        details: error.details ?? null,
      },
    })}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runCli();
