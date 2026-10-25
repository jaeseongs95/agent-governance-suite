import { rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const defaults = { rename, rm, stat, writeFile };

/** Internal file-operation seam for isolated fault tests; never supplied by CLI input. */
export async function commitSkillImport(input, overrides = {}) {
  const ops = { ...defaults, ...overrides };
  const { transactionDirectory, destination, destinationExists, stagedSkill,
    testsDirectory, testsExist, stagedTests, registryPath, lockPath,
    registryOriginal, lockOriginal, registryDocument, lockDocument } = input;
  const previousSkill = path.join(transactionDirectory, "previous-skill");
  const originals = {
    registry: path.join(transactionDirectory, "registry.original"),
    lock: path.join(transactionDirectory, "source-lock.original"),
  };
  // Save exact bytes before changing any destination or metadata file.
  await ops.writeFile(originals.registry, registryOriginal, { flag: "wx" });
  await ops.writeFile(originals.lock, lockOriginal, { flag: "wx" });
  let previousSkillMoved = false;
  let installedSkill = false;
  let installedTests = false;
  try {
    if (destinationExists) {
      await ops.rename(destination, previousSkill);
      previousSkillMoved = true;
    }
    await ops.rename(stagedSkill, destination);
    installedSkill = true;
    if (!testsExist) {
      await ops.rename(stagedTests, testsDirectory);
      installedTests = true;
    }
    await ops.writeFile(lockPath, JSON.stringify(lockDocument, null, 2) + "\n", "utf8");
    await ops.writeFile(registryPath, JSON.stringify(registryDocument, null, 2) + "\n", "utf8");
  } catch (primary) {
    const failures = [];
    const failedStages = [];
    const attempt = async (stage, operation) => {
      try { await operation(); return true; }
      catch (cause) {
        failures.push(new Error("Skill import recovery failed: " + stage, { cause }));
        failedStages.push(stage);
        return false;
      }
    };
    await attempt("restore-lock", () => ops.writeFile(lockPath, lockOriginal));
    await attempt("restore-registry", () => ops.writeFile(registryPath, registryOriginal));
    if (installedTests) await attempt("remove-imported-tests", () => ops.rm(testsDirectory, { recursive: true, force: true }));
    const removedNewSkill = !installedSkill
      || await attempt("remove-imported-skill", () => ops.rm(destination, { recursive: true, force: true }));
    let previousStatus = previousSkillMoved ? "unverified" : "not-created";
    if (previousSkillMoved && removedNewSkill) {
      if (await attempt("restore-previous-skill", () => ops.rename(previousSkill, destination))) previousStatus = "restored";
    }
    if (previousSkillMoved && previousStatus !== "restored") {
      try { if ((await ops.stat(previousSkill)).isDirectory()) previousStatus = "retained"; }
      catch { /* Keep unverified and preserve the transaction instead of claiming recovery. */ }
    }
    const incomplete = failures.length > 0;
    const failure = new AggregateError([primary, ...failures],
      incomplete ? "Skill import failed; recovery incomplete; backup: " + transactionDirectory
        : "Skill import failed; rollback completed", { cause: primary });
    failure.recovery = {
      state: incomplete ? "incomplete" : "completed",
      preserveTransaction: incomplete,
      transactionDirectory,
      previousSkill: { path: previousSkill, state: previousStatus },
      metadataOriginals: originals,
      failedStages,
    };
    throw failure;
  }
}

/** Cleanup must preserve incomplete recovery and cannot hide the primary failure. */
export async function cleanupSkillImport(input, overrides = {}) {
  const ops = { ...defaults, ...overrides };
  const { temporaryDirectory, transactionDirectory, operationFailed, failure } = input;
  const errors = [];
  try { await ops.rm(temporaryDirectory, { recursive: true, force: true }); }
  catch (cause) { errors.push(new Error("Skill import temporary cleanup failed", { cause })); }
  if (failure?.recovery?.preserveTransaction !== true) {
    try {
      await ops.rm(transactionDirectory, { recursive: true, force: true });
      if (failure?.recovery) {
        failure.recovery = {
          ...failure.recovery, transactionState: "removed", transactionDirectory: null,
          previousSkill: { ...failure.recovery.previousSkill, path: null },
          metadataOriginals: null,
        };
      }
    }
    catch (cause) { errors.push(new Error("Skill import transaction cleanup failed", { cause })); }
  }
  if (errors.length) {
    const combined = new AggregateError(operationFailed ? [failure, ...errors] : errors,
      "Skill import cleanup incomplete", operationFailed ? { cause: failure } : undefined);
    if (failure?.recovery) combined.recovery = failure.recovery;
    throw combined;
  }
  if (operationFailed) throw failure;
}
