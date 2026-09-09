import { execFileSync } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NAME_PATTERN, ROOT, computeDirectoryChecksum, parseArguments, readFrontmatter, readJson } from "./lib.mjs";

const args = parseArguments(process.argv.slice(2));
if (!args.source || !args.ref || !args["skill-path"]) {
  throw new Error("Usage: pnpm import:skill --source <path-or-url> --ref <tag-or-sha> --skill-path <path> [--phase <phase> --capability <capability>]");
}

const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "agent-governance-import-"));
const transactionDirectory = await mkdtemp(path.join(ROOT, ".agent-governance-import-"));
let sourceRepository = path.resolve(args.source);
try {
  try {
    await stat(sourceRepository);
  } catch {
    sourceRepository = path.join(temporaryDirectory, "repository");
    execFileSync("git", ["clone", "--filter=blob:none", "--no-checkout", args.source, sourceRepository], { stdio: "inherit" });
  }

  const commit = execFileSync("git", ["-C", sourceRepository, "rev-parse", "--verify", `${args.ref}^{commit}`], { encoding: "utf8" }).trim();
  const archive = path.join(temporaryDirectory, "source.tar");
  execFileSync("git", ["-C", sourceRepository, "archive", "--format=tar", `--output=${archive}`, commit]);
  const extracted = path.join(temporaryDirectory, "extracted");
  await mkdir(extracted);
  execFileSync("tar", ["-xf", archive, "-C", extracted]);

  const sourceSkill = path.resolve(extracted, args["skill-path"]);
  if (!sourceSkill.startsWith(extracted + path.sep) && sourceSkill !== extracted) {
    throw new Error("skill-path escapes the source archive");
  }
  const skillMarkdown = await readFile(path.join(sourceSkill, "SKILL.md"), "utf8");
  const name = readFrontmatter(skillMarkdown).name;
  if (!NAME_PATTERN.test(name)) throw new Error(`invalid imported skill name: ${name}`);
  const metadataVersion = skillMarkdown.match(/\nmetadata:\s*\r?\n(?:[ \t]+.*\r?\n)*?[ \t]+version:\s*["']?([^\s"']+)/u)?.[1]
    ?? "0.1.0";

  const destination = path.join(ROOT, "skills", name);
  const registryPath = path.join(ROOT, "skills", "registry.json");
  const registryDocument = await readJson(registryPath);
  const skills = Array.isArray(registryDocument) ? registryDocument : registryDocument.skills;
  const existingDescriptor = skills.find((descriptor) => descriptor.id === name);
  if (!existingDescriptor && (!args.phase || !args.capability)) {
    throw new Error("A new imported skill requires --phase and --capability so routing is not guessed.");
  }
  const capabilityOwner = !existingDescriptor
    ? skills.find((descriptor) => descriptor.capabilities?.includes(args.capability))
    : undefined;
  if (capabilityOwner) {
    throw new Error(`capability ${args.capability} is already provided by ${capabilityOwner.id}; choose a more specific capability`);
  }

  let destinationExists = false;
  try {
    await stat(destination);
    destinationExists = true;
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
  if (destinationExists && args.replace !== "true") {
    throw new Error(`destination exists: pass --replace true to update skills/${name}`);
  }

  const allowedEntries = new Set([
    "SKILL.md", "agents", "references", "scripts", "assets", "contracts", "evals",
    "README.md", "LICENSE", "COMPATIBILITY.md", "CHANGELOG.md", "VERSION"
  ]);
  const sourceEntries = await readdir(sourceSkill, { withFileTypes: true });
  const stagedSkill = path.join(transactionDirectory, "staged-skill");
  await mkdir(stagedSkill);
  for (const entry of sourceEntries) {
    if (!allowedEntries.has(entry.name)) continue;
    await cp(path.join(sourceSkill, entry.name), path.join(stagedSkill, entry.name), {
      recursive: true,
      filter(source) {
        const relative = path.relative(sourceSkill, source).split(path.sep).join("/");
        return !relative.includes("__pycache__") && !relative.startsWith("evals/results") && !relative.startsWith("dist/");
      }
    });
  }

  const lockPath = path.join(ROOT, "skills", "source-lock.json");
  const registryOriginal = await readFile(registryPath, "utf8");
  const lockOriginal = await readFile(lockPath, "utf8");
  const lockDocument = await readJson(lockPath);
  const entries = Array.isArray(lockDocument) ? lockDocument : lockDocument.sources;
  const checksumValue = await computeDirectoryChecksum(stagedSkill);
  const lockEntry = {
    skillId: name,
    path: `skills/${name}`,
    source: args.source,
    ref: args.ref,
    commit,
    checksum: checksumValue,
    checksumScope: `relative paths and normalized text bytes under skills/${name}`
  };
  const existingLockIndex = entries.findIndex((entry) => entry.skillId === name);
  if (existingLockIndex >= 0) entries[existingLockIndex] = lockEntry;
  else entries.push(lockEntry);
  if (!existingDescriptor) {
    skills.push({
      schemaVersion: "1.0.0",
      id: name,
      version: metadataVersion,
      path: `./${name}`,
      phase: args.phase,
      capabilities: [args.capability],
      priority: 100,
      selectionCriteria: [`requires-${args.capability}`],
      preconditions: [],
      requiredArtifacts: [],
      producedArtifacts: [],
      riskGate: "none",
      enabled: true
    });
  } else {
    existingDescriptor.version = metadataVersion;
  }

  const testsDirectory = path.join(ROOT, "tests", name);
  let testsExist = false;
  try {
    await stat(testsDirectory);
    testsExist = true;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const stagedTests = path.join(transactionDirectory, "staged-tests");
  if (!testsExist) {
    await mkdir(stagedTests, { recursive: true });
    await writeFile(path.join(stagedTests, "cases.json"), `${JSON.stringify({
      normal: [{ id: "normal-01", expected: "the imported skill returns its documented output" }],
      boundary: [{ id: "boundary-01", expected: "the imported skill respects its exclusion conditions" }],
      failure: [{ id: "failure-01", expected: "the imported skill reports missing required input" }]
    }, null, 2)}\n`, "utf8");
  }

  const previousSkill = path.join(transactionDirectory, "previous-skill");
  let installedSkill = false;
  let installedTests = false;
  try {
    if (destinationExists) await rename(destination, previousSkill);
    await rename(stagedSkill, destination);
    installedSkill = true;
    if (!testsExist) {
      await rename(stagedTests, testsDirectory);
      installedTests = true;
    }
    await writeFile(lockPath, `${JSON.stringify(lockDocument, null, 2)}\n`, "utf8");
    await writeFile(registryPath, `${JSON.stringify(registryDocument, null, 2)}\n`, "utf8");
  } catch (error) {
    await writeFile(lockPath, lockOriginal, "utf8").catch(() => undefined);
    await writeFile(registryPath, registryOriginal, "utf8").catch(() => undefined);
    if (installedTests) await rm(testsDirectory, { recursive: true, force: true }).catch(() => undefined);
    if (installedSkill) await rm(destination, { recursive: true, force: true }).catch(() => undefined);
    if (destinationExists) await rename(previousSkill, destination).catch(() => undefined);
    throw error;
  }
  console.log(`imported ${name}@${commit}`);
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
  await rm(transactionDirectory, { recursive: true, force: true });
}
