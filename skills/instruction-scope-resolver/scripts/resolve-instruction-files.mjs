#!/usr/bin/env node
import { createHash } from "node:crypto";
import { access, lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Ajv2020 } from "../../../runtime/schema-validation.mjs";

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIRECTORY, "..");

export function isPathWithin(root, candidate, pathApi = path) {
  const caseInsensitive = pathApi === path.win32;
  const normalize = (value) => {
    const normalized = pathApi.resolve(value).replace(/[\\/]+$/, "");
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
  } catch {
    return false;
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

function invalid(message, details = null) {
  const error = new Error(message);
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
    if (parent === cursor) throw invalid("No existing ancestor was found for the target.", { target: target.path });
    suffix.unshift(path.basename(cursor));
    cursor = parent;
  }
  const existingStats = await lstat(cursor);
  const existingReal = await realpath(cursor);
  let resolvedPath = path.join(existingReal, ...suffix);
  const targetExists = suffix.length === 0;
  if (targetExists && !(await exists(requestedAbsolute))) throw invalid("Target state changed during resolution.");
  if (targetExists) resolvedPath = await realpath(requestedAbsolute);
  if (!targetExists && !target.mayNotExist) {
    throw invalid("Target does not exist and mayNotExist is false.", { target: target.path });
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

async function selectedInstruction(directory, authorizedRoots) {
  if (!(await exists(directory))) return null;
  const stats = await lstat(directory);
  if (!stats.isDirectory()) return null;
  for (const [filename, kind] of [["AGENTS.override.md", "override"], ["AGENTS.md", "agents"]]) {
    const candidate = path.join(directory, filename);
    if (!(await exists(candidate))) continue;
    const actual = await realpath(candidate);
    if (!authorizedRoots.some((root) => isPathWithin(root, actual))) {
      throw invalid("An instruction file resolves outside authorized instruction roots.", { path: candidate });
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

export async function resolveInstructionFiles(request) {
  const check = await validators();
  if (!check.request(request)) {
    throw invalid("InstructionScopeRequest.v1 validation failed.", { errors: check.request.errors });
  }

  const workspaceRoot = await realpath(path.resolve(request.workspaceRoot));
  const workspaceStats = await lstat(workspaceRoot);
  if (!workspaceStats.isDirectory()) throw invalid("workspaceRoot must be a directory.");

  const authorizedRootRecords = [];
  const findings = [];
  for (const root of [...request.instructionRoots].sort((a, b) => a.precedence - b.precedence || a.path.localeCompare(b.path))) {
    if (!root.authorized) {
      findings.push(`Skipped unauthorized instruction root: ${root.path}`);
      continue;
    }
    const actual = await realpath(path.resolve(workspaceRoot, root.path));
    if (!(await lstat(actual)).isDirectory()) throw invalid("instructionRoot must be a directory.", { path: root.path });
    authorizedRootRecords.push({ path: actual, precedence: root.precedence });
  }
  if (authorizedRootRecords.length === 0) throw invalid("At least one authorized instruction root is required.");

  const authorizedRoots = authorizedRootRecords.map((root) => root.path);
  const targetResults = [];
  const manifest = new Map();
  for (const target of request.targets) {
    const requestedAbsolute = path.resolve(workspaceRoot, target.path);
    if (!isPathWithin(workspaceRoot, requestedAbsolute)) {
      throw invalid("Target path is outside workspaceRoot.", { target: target.path, requestedAbsolute });
    }
    const resolved = await canonicalTarget(workspaceRoot, target);
    if (!isPathWithin(workspaceRoot, resolved.resolvedPath)) {
      throw invalid("Target resolves outside workspaceRoot.", { target: target.path, resolvedPath: resolved.resolvedPath });
    }
    const applicableRoots = authorizedRootRecords.filter((root) => isPathWithin(root.path, resolved.targetDirectory));
    if (applicableRoots.length === 0) {
      throw invalid("Target is not covered by an authorized instruction root.", { target: target.path });
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
      const instruction = await selectedInstruction(directory, authorizedRoots);
      if (!instruction || chain.some((item) => item.path === instruction.path)) continue;
      instruction.precedence = chain.length + 1;
      chain.push(instruction);
      manifest.set(instruction.path, instruction);
    }
    if (!resolved.exists) findings.push(`Target does not exist; future nested instructions cannot be observed: ${target.path}`);
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
  if (!check.output(output)) throw invalid("Generated output failed its schema.", { errors: check.output.errors });
  return output;
}

async function readInput(argv) {
  const inputIndex = argv.indexOf("--input");
  if (inputIndex >= 0) {
    const filename = argv[inputIndex + 1];
    if (!filename) throw invalid("--input requires a file path.");
    return JSON.parse(await readFile(filename, "utf8"));
  }
  let body = "";
  for await (const chunk of process.stdin) body += chunk;
  if (!body.trim()) throw invalid("Expected JSON on stdin or --input <file>.");
  return JSON.parse(body);
}

export async function runCli(argv = process.argv.slice(2)) {
  try {
    const output = await resolveInstructionFiles(await readInput(argv));
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
