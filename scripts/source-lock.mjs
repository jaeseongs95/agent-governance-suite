import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ROOT, computeDirectoryChecksum, readJson, walkFiles } from "./lib.mjs";

const SEMVER = /^\d+\.\d+\.\d+$/u;
const STABLE_TAG = /^v(\d+)\.(\d+)\.(\d+)$/u;
const SHA = /^[a-f0-9]{40}$/u;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const IMPORT_ALLOWLIST = new Set([
  "SKILL.md", "agents", "references", "scripts", "assets", "contracts", "evals", "integration",
  "README.md", "LICENSE", "COMPATIBILITY.md", "CHANGELOG.md", "VERSION",
]);

export function compareVersions(left, right) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

export async function readSkillVersion(skillDirectory) {
  const markdown = await readFile(path.join(skillDirectory, "SKILL.md"), "utf8");
  const metadataVersion = markdown.match(/\nmetadata:\s*\r?\n(?:[ \t]+.*\r?\n)*?[ \t]+version:\s*["']?([^\s"']+)/u)?.[1];
  if (metadataVersion) return { version: metadataVersion, source: "skill-metadata" };
  try {
    return { version: (await readFile(path.join(skillDirectory, "VERSION"), "utf8")).trim(), source: "version-file" };
  } catch {
    throw new Error(`${path.relative(ROOT, skillDirectory)} has neither metadata.version nor VERSION`);
  }
}

export async function verifySourceLockOffline() {
  const [lock, registry] = await Promise.all([
    readJson(path.join(ROOT, "skills", "source-lock.json")),
    readJson(path.join(ROOT, "skills", "registry.json")),
  ]);
  const errors = [];
  if (lock.schemaVersion !== "2.0.0" || !Array.isArray(lock.sources)) {
    return ["skills/source-lock.json must be a v2 sources document"];
  }
  const registrySkills = Array.isArray(registry.skills) ? registry.skills : [];
  const registryById = new Map(registrySkills.map((skill) => [skill.skillId, skill]));
  const ids = new Set();
  for (const source of lock.sources) {
    const label = source.skillId ?? "<unknown>";
    if (ids.has(label)) errors.push(`duplicate source lock id: ${label}`);
    ids.add(label);
    const descriptor = registryById.get(label);
    if (!descriptor) errors.push(`source lock references unknown skill: ${label}`);
    if (source.path !== `skills/${label}`) errors.push(`invalid source lock path for ${label}`);
    if (!["auto-pr", "notify-only", "internal"].includes(source.updatePolicy)) errors.push(`invalid update policy for ${label}`);
    if (!SEMVER.test(source.version ?? "")) errors.push(`invalid source version for ${label}`);
    if (!SHA.test(source.ref?.commit ?? "")) errors.push(`invalid source commit for ${label}`);
    if (source.ref?.kind === "tag" && source.ref.value !== `v${source.version}`) errors.push(`tag/version mismatch for ${label}`);
    if (source.ref?.kind === "commit" && source.ref.value !== source.ref.commit) errors.push(`commit ref mismatch for ${label}`);
    if (!DIGEST.test(source.upstreamChecksum ?? "") || !DIGEST.test(source.integratedChecksum ?? "")) {
      errors.push(`invalid source checksum for ${label}`);
    }
    if (!Array.isArray(source.downstreamModifications)) errors.push(`downstream modifications must be an array for ${label}`);
    if ((source.downstreamModifications?.length ?? 0) === 0 && source.upstreamChecksum !== source.integratedChecksum) {
      errors.push(`unmodified source checksums differ for ${label}`);
    }
    if ((source.downstreamModifications?.length ?? 0) > 0 && source.updatePolicy === "auto-pr") {
      errors.push(`modified source cannot use auto-pr for ${label}`);
    }
    // A commit pin carries content no stable tag names, so the version no longer identifies what is integrated.
    if (source.updatePolicy === "auto-pr" && source.ref?.kind !== "tag") {
      errors.push(`auto-pr source must be pinned to a stable tag for ${label}`);
    }
    try {
      const version = await readSkillVersion(path.join(ROOT, source.path));
      if (version.version !== source.version || version.source !== source.versionSource) {
        errors.push(`skill/source version mismatch for ${label}`);
      }
      if (descriptor?.version !== source.version) errors.push(`registry/source version mismatch for ${label}`);
      const directPath = path.join(ROOT, source.path, "integration", "skill-descriptor.json");
      try {
        const direct = await readJson(directPath);
        const identities = direct.skillId
          ? [{ skillId: direct.skillId, version: direct.version }]
          : (direct.providers ?? []).map((provider) => ({ skillId: provider.skillId, version: provider.version }));
        if (identities.length === 0 || identities.some((identity) => identity.skillId !== label || identity.version !== source.version)) {
          errors.push(`direct descriptor/source mismatch for ${label}`);
        }
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      const checksum = await computeDirectoryChecksum(path.join(ROOT, source.path));
      if (checksum !== source.integratedChecksum) errors.push(`integrated checksum mismatch for ${label}`);
    } catch (error) {
      errors.push(`cannot verify source ${label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  for (const descriptor of registrySkills) {
    if (!ids.has(descriptor.skillId)) errors.push(`registry skill has no source lock entry: ${descriptor.skillId}`);
  }
  return errors;
}

function git(args, options = {}) {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options }).trim();
}

export function stableTagsFromLsRemote(output) {
  const commits = new Map();
  for (const line of output.split(/\r?\n/u)) {
    const [commit, ref] = line.trim().split(/\s+/u);
    const match = ref?.match(/^refs\/tags\/(v\d+\.\d+\.\d+)(\^\{\})?$/u);
    if (!match || !SHA.test(commit ?? "")) continue;
    const current = commits.get(match[1]) ?? {};
    if (match[2]) current.peeled = commit;
    else current.direct = commit;
    commits.set(match[1], current);
  }
  return [...commits.entries()].map(([tag, value]) => ({ tag, version: tag.slice(1), commit: value.peeled ?? value.direct }))
    .sort((left, right) => compareVersions(right.version, left.version));
}

export function latestStableTag(source) {
  return stableTagsFromLsRemote(git(["ls-remote", "--tags", source, "refs/tags/v*"]))[0] ?? null;
}

/**
 * A commit pin whose version equals the latest stable tag but whose commit
 * differs cannot be ordered from ls-remote output: the pin may be ahead of the
 * tag. It is reported for attention instead of being imported automatically.
 */
export function isSameVersionPinMismatch(source, latest) {
  return Boolean(latest)
    && compareVersions(latest.version, source.version) === 0
    && source.ref.kind === "commit"
    && source.ref.commit !== latest.commit;
}

export function isUpstreamUpdate(source, latest) {
  if (!latest) return false;
  const order = compareVersions(latest.version, source.version);
  if (order !== 0) return order > 0;
  if (source.ref.kind !== "tag") return source.ref.commit === latest.commit;
  return source.ref.value !== latest.tag || source.ref.commit !== latest.commit;
}

async function projectedUpstreamChecksum(sourceDirectory, projectionDirectory) {
  await mkdir(projectionDirectory);
  for (const entry of await readdir(sourceDirectory, { withFileTypes: true })) {
    if (!IMPORT_ALLOWLIST.has(entry.name)) continue;
    await cp(path.join(sourceDirectory, entry.name), path.join(projectionDirectory, entry.name), {
      recursive: true,
      filter(source) {
        const relative = path.relative(sourceDirectory, source).split(path.sep).join("/");
        return !relative.includes("__pycache__") && !relative.startsWith("evals/results") && !relative.startsWith("dist/");
      },
    });
  }
  return computeDirectoryChecksum(projectionDirectory);
}

export async function verifySourceLockRemote() {
  const lock = await readJson(path.join(ROOT, "skills", "source-lock.json"));
  const errors = [];
  for (const source of lock.sources ?? []) {
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "source-lock-verify-"));
    try {
      const repository = path.join(temporaryDirectory, "repository");
      git(["clone", "--quiet", "--no-checkout", source.source, repository]);
      const resolved = git(["-C", repository, "rev-parse", "--verify", `${source.ref.value}^{commit}`]);
      if (resolved !== source.ref.commit) errors.push(`remote ref/commit mismatch for ${source.skillId}`);
      git(["-C", repository, "checkout", "--quiet", "--detach", source.ref.commit]);
      const sourceDirectory = path.resolve(repository, source.sourcePath);
      if (sourceDirectory !== repository && !sourceDirectory.startsWith(`${repository}${path.sep}`)) {
        errors.push(`sourcePath escapes repository for ${source.skillId}`);
        continue;
      }
      const checksum = await projectedUpstreamChecksum(sourceDirectory, path.join(temporaryDirectory, "projected-skill"));
      if (checksum !== source.upstreamChecksum) {
        const suggestions = [];
        const skillFiles = (await walkFiles(repository)).filter((file) => path.basename(file) === "SKILL.md");
        for (const [index, skillFile] of skillFiles.entries()) {
          const candidateDirectory = path.dirname(skillFile);
          const candidateProjection = path.join(temporaryDirectory, `candidate-${index}`);
          const candidateChecksum = await projectedUpstreamChecksum(candidateDirectory, candidateProjection);
          if (candidateChecksum === source.upstreamChecksum) suggestions.push(path.relative(repository, candidateDirectory).split(path.sep).join("/") || ".");
        }
        errors.push(`upstream checksum mismatch for ${source.skillId}: expected ${source.upstreamChecksum}, actual ${checksum}, sourcePath ${source.sourcePath}, matching paths ${suggestions.join(", ") || "none"}`);
      }
      if (source.ref.kind === "tag") {
        const tag = STABLE_TAG.exec(source.ref.value);
        if (!tag || source.ref.value !== `v${source.version}`) errors.push(`remote tag/version mismatch for ${source.skillId}`);
      }
    } catch (error) {
      errors.push(`cannot verify remote source ${source.skillId}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }
  return errors;
}

export async function discoverUpstreamUpdates() {
  const lock = await readJson(path.join(ROOT, "skills", "source-lock.json"));
  const results = [];
  for (const source of lock.sources ?? []) {
    if (source.updatePolicy === "internal") continue;
    try {
      const latest = latestStableTag(source.source);
      results.push({
        skillId: source.skillId,
        policy: source.updatePolicy,
        currentVersion: source.version,
        latestVersion: latest?.version ?? null,
        latestTag: latest?.tag ?? null,
        latestCommit: latest?.commit ?? null,
        updateAvailable: isUpstreamUpdate(source, latest),
        pinMismatch: isSameVersionPinMismatch(source, latest),
        error: null,
      });
    } catch (error) {
      results.push({
        skillId: source.skillId,
        policy: source.updatePolicy,
        currentVersion: source.version,
        latestVersion: null,
        latestTag: null,
        latestCommit: null,
        updateAvailable: false,
        pinMismatch: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}
