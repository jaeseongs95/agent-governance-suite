#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { contractErrors, validateWorkspaceRequest } from "./schema-validation.mjs";

const CONTRACT_VERSION = "1.0.0";
const DEFAULT_EXCLUDED = new Set([".git", "node_modules", ".venv", "venv", "vendor", "dist", "build", "coverage", ".cache", "__pycache__"]);
const SECRET_NAMES = /^(\.env(?:\..*)?|.*(?:secret|credential|token|private[-_.]?key).*)$/i;
const MANIFEST_NAMES = new Set(["package.json", "pnpm-workspace.yaml", "pnpm-lock.yaml", "package-lock.json", "yarn.lock", "bun.lockb", "pyproject.toml", "requirements.txt", "poetry.lock", "uv.lock", "Cargo.toml", "Cargo.lock", "go.mod", "go.sum", "Makefile", "justfile"]);
const STRUCTURE_ROLES = new Map([
  ["src", "implementation"], ["lib", "implementation"], ["app", "application"], ["apps", "applications"], ["packages", "packages"],
  ["tests", "tests"], ["test", "tests"], ["docs", "documentation"], ["scripts", "automation"], ["contracts", "contracts"],
]);

export function portablePath(value) {
  const normalized = String(value).replaceAll("\\", "/").replace(/\/+/g, "/");
  return normalized.replace(/^([A-Z]):/, (_, drive) => `${drive.toLowerCase()}:`);
}

export function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string" || typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function validateRequest(input) {
  if (!validateWorkspaceRequest(input)) throw new Error(`WorkspaceProfileRequest.v1 계약 위반: ${contractErrors(validateWorkspaceRequest).join("; ")}`);
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function excluded(relative, customPatterns) {
  const segments = portablePath(relative).split("/");
  if (segments.some((segment) => DEFAULT_EXCLUDED.has(segment))) return true;
  if (segments.some((segment) => SECRET_NAMES.test(segment))) return true;
  const portable = portablePath(relative);
  return customPatterns.some((pattern) => portable.includes(portablePath(pattern)));
}

async function collectCandidates(root, limits) {
  const files = [];
  const directories = [];
  const excludedDirectories = [];
  async function visit(directory) {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = portablePath(path.relative(root, absolute));
      if (excluded(relative, limits.excludedPatterns)) {
        if (entry.isDirectory()) excludedDirectories.push(relative);
        continue;
      }
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        directories.push(relative);
        await visit(absolute);
      } else if (entry.isFile()) {
        const isTopReadme = !relative.includes("/") && /^README(?:\.[^.]+)?$/i.test(entry.name);
        const isWorkflow = /^\.github\/workflows\/.*\.ya?ml$/i.test(relative);
        const isInstruction = /^AGENTS(?:\.override)?\.md$/i.test(entry.name);
        if (MANIFEST_NAMES.has(entry.name) || isTopReadme || isWorkflow || isInstruction) files.push({ absolute, relative });
      }
      if (files.length > limits.maxFiles) throw new Error(`근거 파일 수가 maxFiles(${limits.maxFiles})를 초과했습니다.`);
    }
  }
  await visit(root);
  return { files, directories, excludedDirectories };
}

async function evidenceFor(file, maxBytesPerFile) {
  const stat = await lstat(file.absolute);
  if (stat.size > maxBytesPerFile) return null;
  const content = await readFile(file.absolute);
  const digest = `sha256:${sha256(content)}`;
  return { locator: file.relative, digest, size: stat.size, kind: "file", content: content.toString("utf8"), ref: `${file.relative}#${digest}` };
}

function directoryEvidenceFor(directory, directories, fileLocators) {
  const locator = `${directory}/`;
  const observed = {
    locator,
    descendantDirectories: directories.filter((item) => item === directory || item.startsWith(`${directory}/`)).sort(),
    evidenceFiles: fileLocators.filter((item) => item.startsWith(`${directory}/`)).sort(),
  };
  const digest = `sha256:${sha256(canonicalJson(observed))}`;
  return { locator, digest, size: 0, kind: "directory", ref: `${locator}#${digest}` };
}

function gitInfo(root) {
  const probe = spawnSync("git", ["-C", root, "rev-parse", "--is-inside-work-tree"], { encoding: "utf8", windowsHide: true });
  if (probe.status !== 0 || probe.stdout.trim() !== "true") return { vcsType: "none", currentRef: null, dirtyState: "unknown", status: [] };
  const ref = spawnSync("git", ["-C", root, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8", windowsHide: true });
  const revision = spawnSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8", windowsHide: true });
  const status = spawnSync("git", ["-C", root, "status", "--porcelain=v1", "--untracked-files=all"], { encoding: "utf8", windowsHide: true });
  const lines = status.status === 0 ? status.stdout.replaceAll("\r\n", "\n").split("\n").filter(Boolean).sort() : [];
  return { vcsType: "git", currentRef: ref.status === 0 ? ref.stdout.trim() : null, currentRevision: revision.status === 0 ? revision.stdout.trim() : null, dirtyState: status.status === 0 ? (lines.length ? "dirty" : "clean") : "unknown", status: lines };
}

function inferPackageManager(relativeFiles, packageJson) {
  const near = (name) => relativeFiles.some((item) => path.posix.dirname(item) === path.posix.dirname(packageJson) && path.posix.basename(item) === name);
  if (near("pnpm-lock.yaml")) return "pnpm";
  if (near("package-lock.json")) return "npm";
  if (near("yarn.lock")) return "yarn";
  if (near("bun.lockb")) return "bun";
  return null;
}

function purposeFor(name) {
  const key = name.toLowerCase();
  if (key === "build" || key.startsWith("build:")) return "build";
  if (key === "test" || key.startsWith("test:")) return "test";
  if (key === "lint" || key.startsWith("lint:")) return "lint";
  if (key === "dev" || key.startsWith("dev:")) return "dev";
  if (key === "validate" || key.startsWith("validate:")) return "validate";
  return "other";
}

function commandPurpose(command) {
  const value = command.toLowerCase();
  if (/\b(test|vitest|jest|pytest)\b/.test(value)) return "test";
  if (/\b(lint|eslint|ruff)\b/.test(value)) return "lint";
  if (/\b(build|tsc|cargo build)\b/.test(value)) return "build";
  if (/\b(dev|serve|watch)\b/.test(value)) return "dev";
  if (/\b(validate|check)\b/.test(value)) return "validate";
  return "other";
}

function blockedReport(root, reason) {
  return {
    schemaVersion: CONTRACT_VERSION,
    workspace: { root: portablePath(root || "unknown"), vcsType: "none", currentRef: null, dirtyState: "unknown" },
    ecosystems: [], structure: [], conventions: [], commands: [], changeHotspots: [], generatedOrVendoredPaths: [], openQuestions: [],
    limitations: [reason], evidenceIndex: [], profileFingerprint: `sha256:${sha256(reason)}`, observedAt: new Date().toISOString(), verdict: "BLOCKED",
  };
}

export async function profileWorkspace(input) {
  try {
    validateRequest(input);
    const root = path.resolve(input.workspaceRoot);
    const rootStat = await lstat(root);
    if (!rootStat.isDirectory()) throw new Error("workspaceRoot는 디렉터리여야 합니다.");
    const rootReal = await realpath(root);
    for (const target of [...input.targetPaths, ...input.resolvedInstructionRefs]) {
      const resolved = path.resolve(root, target);
      if (!isWithin(root, resolved)) throw new Error(`workspace 밖의 경로는 조사할 수 없습니다: ${target}`);
      try {
        const targetReal = await realpath(resolved);
        if (!isWithin(rootReal, targetReal)) throw new Error(`workspace 밖을 가리키는 경로는 조사할 수 없습니다: ${target}`);
      } catch (error) {
        if (input.resolvedInstructionRefs.includes(target) || error?.code !== "ENOENT") throw error;
      }
    }

    const { files, directories, excludedDirectories } = await collectCandidates(root, input.evidenceLimits);
    const evidence = (await Promise.all(files.map((file) => evidenceFor(file, input.evidenceLimits.maxBytesPerFile)))).filter(Boolean);
    const relativeFiles = evidence.map((item) => item.locator);
    const ecosystems = [];
    const commands = [];

    for (const item of evidence) {
      const base = path.posix.basename(item.locator);
      if (base === "package.json") {
        let manifest;
        try { manifest = JSON.parse(item.content); } catch { continue; }
        ecosystems.push({ language: "JavaScript/TypeScript", packageManager: inferPackageManager(relativeFiles, item.locator), manifestRefs: [item.ref] });
        for (const [name, command] of Object.entries(manifest.scripts ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
          if (typeof command === "string") commands.push({ purpose: purposeFor(name), command: `${inferPackageManager(relativeFiles, item.locator) ?? "npm"} ${inferPackageManager(relativeFiles, item.locator) === "npm" ? "run " : ""}${name}`, workingDirectory: path.posix.dirname(item.locator) === "." ? "." : path.posix.dirname(item.locator), sourceRef: item.ref });
        }
      } else if (base === "pyproject.toml" || base === "requirements.txt") {
        ecosystems.push({ language: "Python", packageManager: base === "pyproject.toml" && item.content.includes("[tool.poetry]") ? "poetry" : null, manifestRefs: [item.ref] });
      } else if (base === "Cargo.toml") ecosystems.push({ language: "Rust", packageManager: "cargo", manifestRefs: [item.ref] });
      else if (base === "go.mod") ecosystems.push({ language: "Go", packageManager: "go", manifestRefs: [item.ref] });

      if (/^\.github\/workflows\/.*\.ya?ml$/i.test(item.locator)) {
        for (const match of item.content.matchAll(/^\s*-?\s*run:\s*(.+?)\s*$/gm)) {
          const command = match[1].replace(/^['"]|['"]$/g, "");
          commands.push({ purpose: commandPurpose(command), command, workingDirectory: ".", sourceRef: item.ref });
        }
      }
    }

    const uniqueEcosystems = [...new Map(ecosystems.map((item) => [`${item.language}:${item.manifestRefs[0]}`, item])).values()].sort((a, b) => a.manifestRefs[0].localeCompare(b.manifestRefs[0]));
    commands.sort((a, b) => a.purpose.localeCompare(b.purpose) || a.command.localeCompare(b.command) || a.sourceRef.localeCompare(b.sourceRef));
    const structure = [];
    const structureDirectories = [];
    for (const [name, role] of STRUCTURE_ROLES) {
      const matches = directories.filter((directory) => path.posix.basename(directory) === name).sort();
      structureDirectories.push(...matches);
      if (matches.length) structure.push({ role, paths: matches, evidenceRefs: [] });
    }
    const directoryEvidence = [...new Set(structureDirectories)].sort().map((directory) => directoryEvidenceFor(directory, directories, relativeFiles));
    const directoryRefs = new Map(directoryEvidence.map((item) => [item.locator.slice(0, -1), item.ref]));
    for (const item of structure) item.evidenceRefs = item.paths.map((directory) => directoryRefs.get(directory));
    structure.sort((a, b) => a.role.localeCompare(b.role));
    const conventions = structure.map((item) => ({ subject: `${item.role}-layout`, observedPattern: `${item.paths.join(", ")} 경로에서 ${item.role} 구조를 확인했습니다.`, confidence: "confirmed", evidenceRefs: item.evidenceRefs }));
    const openQuestions = [];
    for (const purpose of ["build", "test", "lint", "dev", "validate"]) {
      const variants = [...new Set(commands.filter((item) => item.purpose === purpose).map((item) => item.command))];
      if (variants.length > 1) openQuestions.push(`${purpose} 목적의 명령이 여러 출처에서 다릅니다: ${variants.join(" | ")}`);
    }
    if (input.resolvedInstructionRefs.length === 0) openQuestions.push("적용 지침 범위가 확인되지 않았습니다.");
    const changeHotspots = input.targetPaths.map((target) => {
      const portable = portablePath(target);
      const parent = path.posix.dirname(portable);
      return {
        taskArea: portable,
        implementationPaths: directories.filter((item) => (item === parent || item.startsWith(`${parent}/`)) && ["src", "lib", "app", "apps", "packages"].includes(path.posix.basename(item))).slice(0, 20),
        testPaths: directories.filter((item) => ["tests", "test"].includes(path.posix.basename(item))).filter((item) => parent === "." || item.startsWith(parent)).slice(0, 20),
        relatedConfigPaths: relativeFiles.filter((item) => path.posix.dirname(item) === parent || path.posix.dirname(item) === ".").slice(0, 20),
        scopeAuthority: "candidate-only",
      };
    });
    const generatedOrVendoredPaths = [...new Set(excludedDirectories)].sort();
    const git = gitInfo(root);
    const workspace = { root: portablePath(root), vcsType: git.vcsType, currentRef: git.currentRef, dirtyState: git.dirtyState };
    const evidenceIndex = [...evidence, ...directoryEvidence].map(({ locator, digest, size, kind }) => ({ locator, digest, size, kind })).sort((a, b) => a.locator.localeCompare(b.locator));
    const output = {
      schemaVersion: CONTRACT_VERSION,
      workspace,
      ecosystems: uniqueEcosystems, structure, conventions, commands, changeHotspots, generatedOrVendoredPaths,
      openQuestions: [...new Set(openQuestions)].sort(), limitations: [],
      evidenceIndex,
      observedAt: new Date().toISOString(), verdict: "PASS",
    };
    const { observedAt: _observedAt, ...fingerprintOutput } = output;
    const fingerprintInput = {
      request: {
        workspaceRoot: workspace.root,
        taskObjective: input.taskObjective,
        targetPaths: input.targetPaths.map(portablePath),
        resolvedInstructionRefs: input.resolvedInstructionRefs.map(portablePath),
        knownConstraints: input.knownConstraints,
        evidenceLimits: input.evidenceLimits,
      },
      git: { currentRef: git.currentRef, currentRevision: git.currentRevision ?? null, status: git.status },
      observedDirectories: [...directories].sort(),
      output: fingerprintOutput,
    };
    return { ...output, profileFingerprint: `sha256:${sha256(canonicalJson(fingerprintInput))}` };
  } catch (error) {
    return blockedReport(input?.workspaceRoot, error instanceof Error ? error.message : String(error));
  }
}

async function readInput(argv) {
  const fileIndex = argv.indexOf("--input");
  if (fileIndex >= 0) return JSON.parse(await readFile(argv[fileIndex + 1], "utf8"));
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  if (!raw.trim()) throw new Error("stdin 또는 --input으로 JSON 입력이 필요합니다.");
  return JSON.parse(raw);
}

async function main() {
  let output;
  try { output = await profileWorkspace(await readInput(process.argv.slice(2))); }
  catch (error) { output = blockedReport("unknown", error instanceof Error ? error.message : String(error)); }
  process.stdout.write(`${JSON.stringify(output)}\n`);
  process.exitCode = output.verdict === "PASS" ? 0 : 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
