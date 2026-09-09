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
try {
  let repositorySource = args.source;
  try {
    const localSource = path.resolve(args.source);
    await stat(localSource);
    repositorySource = localSource;
  } catch {
    repositorySource = args.source;
  }

  const extracted = path.join(temporaryDirectory, "extracted");
  execFileSync("git", ["clone", "--no-checkout", repositorySource, extracted], { stdio: "inherit" });
  const commit = execFileSync("git", ["-C", extracted, "rev-parse", "--verify", `${args.ref}^{commit}`], { encoding: "utf8" }).trim();
  execFileSync("git", ["-C", extracted, "checkout", "--detach", commit], { stdio: "inherit" });

  const sourceSkill = path.resolve(extracted, args["skill-path"]);
  if (!sourceSkill.startsWith(extracted + path.sep) && sourceSkill !== extracted) {
    throw new Error("skill-path escapes the source archive");
  }
  const skillMarkdown = await readFile(path.join(sourceSkill, "SKILL.md"), "utf8");
  const name = readFrontmatter(skillMarkdown).name;
  if (!NAME_PATTERN.test(name)) throw new Error(`invalid imported skill name: ${name}`);
  let metadataVersion = skillMarkdown.match(/\nmetadata:\s*\r?\n(?:[ \t]+.*\r?\n)*?[ \t]+version:\s*["']?([^\s"']+)/u)?.[1];
  if (!metadataVersion) {
    try {
      metadataVersion = (await readFile(path.join(sourceSkill, "VERSION"), "utf8")).trim();
    } catch {
      metadataVersion = undefined;
    }
  }

  const destination = path.join(ROOT, "skills", name);
  const registryPath = path.join(ROOT, "skills", "registry.json");
  const registryDocument = await readJson(registryPath);
  const skills = Array.isArray(registryDocument) ? registryDocument : registryDocument.skills;
  if (registryDocument.schemaVersion !== "2.0.0") throw new Error("skills/registry.json must use schemaVersion 2.0.0");
  const existingDescriptor = skills.find((descriptor) => descriptor.skillId === name);

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
    "SKILL.md", "agents", "references", "scripts", "assets", "contracts", "evals", "integration",
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
  let sourceDescriptor;
  try {
    sourceDescriptor = await readJson(path.join(stagedSkill, "integration", "skill-descriptor.json"));
  } catch {
    if (!args.phase || !args.capability) {
      throw new Error("A new imported skill needs integration/skill-descriptor.json or --phase and --capability.");
    }
  }
  const inherited = sourceDescriptor ?? {};
  const sourceProviders = Array.isArray(inherited.providers) ? inherited.providers : [];
  metadataVersion ??= inherited.version ?? sourceProviders[0]?.version ?? "0.1.0";
  const providers = sourceProviders.length > 0
    ? sourceProviders.map((provider) => {
        const skillId = provider.skillId ?? inherited.skillId;
        const version = provider.version ?? inherited.version ?? metadataVersion;
        if (skillId !== name || version !== metadataVersion) {
          throw new Error(`integration descriptor identity must match ${name}@${metadataVersion}`);
        }
        const providerFields = { ...provider };
        delete providerFields.skillId;
        delete providerFields.version;
        delete providerFields.enabled;
        delete providerFields.priority;
        return {
          ...providerFields,
          outputSchema: `skills/${name}/${provider.outputSchema}`,
          resultSchema: `skills/${name}/${provider.resultSchema}`,
          gate: provider.gate?.validator?.endsWith(".schema.json")
            ? { ...provider.gate, validator: `skills/${name}/${provider.gate.validator}` }
            : provider.gate,
        };
      })
    : [{
        capabilities: [args.capability],
        executionClass: "workflow",
        phase: args.phase,
        phaseOrder: 50,
        requiredInputArtifacts: [],
        inputBindings: [],
        producedArtifacts: [],
        outputSchema: "contracts/freeform-output.v1.schema.json",
        resultSchema: "contracts/provider-result.v1.schema.json",
        stateMapping: {
          default: { state: "passed", errorRequired: false },
          adapterErrors: ["INVALID_INPUT", "MISSING_EVIDENCE"],
        },
        selectionCriteria: [`requires-${args.capability}`],
        preconditions: [],
        failureHandling: "Return a structured provider result.",
        gate: { kind: "none", policy: "none", validator: null },
      }];
  const importedDescriptor = {
    schemaVersion: "2.0.0",
    skillId: name,
    version: metadataVersion,
    path: `./${name}`,
    enabled: inherited.enabled ?? sourceProviders[0]?.enabled ?? true,
    priority: inherited.priority ?? sourceProviders[0]?.priority ?? 50,
    providers,
  };
  for (const provider of providers) {
    for (const capability of provider.capabilities ?? []) {
      const owner = skills.find((descriptor) => descriptor.skillId !== name
        && descriptor.providers?.some((candidate) => candidate.capabilities?.includes(capability)));
      if (owner) throw new Error(`capability ${capability} is already provided by ${owner.skillId}`);
    }
  }
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
  if (!existingDescriptor) skills.push(importedDescriptor);
  else skills[skills.indexOf(existingDescriptor)] = importedDescriptor;

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
