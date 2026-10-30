import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { cleanupSkillImport, commitSkillImport } from "../../scripts/skill-import-transaction.mjs";

const directories = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
async function exists(file) {
  try { await stat(file); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; }
}
async function fixture(destinationExists = true, testsExist = false) {
  const directory = await mkdtemp(path.join(tmpdir(), "ags-import-transaction-"));
  directories.push(directory);
  const transactionDirectory = path.join(directory, "transaction");
  const temporaryDirectory = path.join(directory, "download");
  const destination = path.join(directory, "suite", "skills", "fixture");
  const testsDirectory = path.join(directory, "suite", "tests", "fixture");
  const stagedSkill = path.join(transactionDirectory, "staged-skill");
  const stagedTests = path.join(transactionDirectory, "staged-tests");
  await Promise.all([mkdir(temporaryDirectory), mkdir(stagedSkill, { recursive: true }),
    mkdir(stagedTests, { recursive: true }), mkdir(path.dirname(destination), { recursive: true }),
    mkdir(path.dirname(testsDirectory), { recursive: true })]);
  if (destinationExists) {
    await mkdir(destination);
    await writeFile(path.join(destination, "payload"), "old-skill");
  }
  if (testsExist) {
    await mkdir(testsDirectory);
    await writeFile(path.join(testsDirectory, "existing.json"), "old-tests");
  }
  await writeFile(path.join(stagedSkill, "payload"), "new-skill");
  await writeFile(path.join(stagedTests, "cases.json"), "{}");
  const registryPath = path.join(path.dirname(destination), "registry.json");
  const lockPath = path.join(path.dirname(destination), "source-lock.json");
  const registryOriginal = Buffer.from('{\r\n  "skills": []\r\n}\r\n');
  const lockOriginal = Buffer.from('{ "sources": [] }\r\n');
  await writeFile(registryPath, registryOriginal);
  await writeFile(lockPath, lockOriginal);
  return { directory, transactionDirectory, temporaryDirectory, destination, destinationExists,
    stagedSkill, testsDirectory, testsExist, stagedTests, registryPath, lockPath,
    registryOriginal, lockOriginal, registryDocument: { skills: ["new"] }, lockDocument: { sources: ["new"] } };
}
async function perform(input, operations = {}) {
  let operationFailed = false;
  let failure;
  try { await commitSkillImport(input, operations); }
  catch (error) { operationFailed = true; failure = error; }
  try { await cleanupSkillImport({ ...input, operationFailed, failure }, operations); }
  catch (error) { return error; }
  return null;
}
function failingInstall(input, primary) {
  return { writeFile: async (file, data, ...options) => {
    if (file === input.lockPath && typeof data === "string") throw primary;
    return writeFile(file, data, ...options);
  } };
}
async function expectOriginalMetadata(input) {
  expect(await readFile(input.registryPath)).toEqual(input.registryOriginal);
  expect(await readFile(input.lockPath)).toEqual(input.lockOriginal);
}
async function expectRetainedOldSkill(input, failure) {
  expect(failure.recovery.preserveTransaction).toBe(true);
  expect(await readFile(path.join(input.transactionDirectory, "previous-skill", "payload"), "utf8")).toBe("old-skill");
  expect(await readFile(failure.recovery.metadataOriginals.registry)).toEqual(input.registryOriginal);
  expect(await readFile(failure.recovery.metadataOriginals.lock)).toEqual(input.lockOriginal);
}

it.each([false, true])("cleans a successful import without leaving backup state (replace=%s)", async (replace) => {
  const f = await fixture(replace);
  expect(await perform(f)).toBeNull();
  expect(await readFile(path.join(f.destination, "payload"), "utf8")).toBe("new-skill");
  expect(await exists(f.transactionDirectory)).toBe(false);
  expect(await exists(f.temporaryDirectory)).toBe(false);
});

it.each([false, true])("cleans a successful import preserving existing tests when testsExist=true (replace=%s)", async (replace) => {
  const f = await fixture(replace, true);
  expect(await perform(f)).toBeNull();
  expect(await readFile(path.join(f.destination, "payload"), "utf8")).toBe("new-skill");
  expect(await readFile(path.join(f.testsDirectory, "existing.json"), "utf8")).toBe("old-tests");
  expect(await exists(f.transactionDirectory)).toBe(false);
  expect(await exists(f.temporaryDirectory)).toBe(false);
});

it("restores exact old bytes and cleans a completed rollback while preserving the original error", async () => {
  const f = await fixture();
  const primary = new Error("synthetic-install-failure");
  const failure = await perform(f, failingInstall(f, primary));
  expect(failure.cause).toBe(primary);
  expect(failure.recovery).toMatchObject({ state: "completed", transactionState: "removed",
    transactionDirectory: null, previousSkill: { state: "restored", path: null }, metadataOriginals: null });
  expect(await readFile(path.join(f.destination, "payload"), "utf8")).toBe("old-skill");
  await expectOriginalMetadata(f);
  expect(await exists(f.transactionDirectory)).toBe(false);
  expect(await exists(f.testsDirectory)).toBe(false);
});

it("preserves existing tests untouched during rollback when testsExist=true", async () => {
  const f = await fixture(true, true);
  const primary = new Error("synthetic-install-failure");
  const failure = await perform(f, failingInstall(f, primary));
  expect(failure.cause).toBe(primary);
  expect(failure.recovery).toMatchObject({ state: "completed", transactionState: "removed",
    transactionDirectory: null, previousSkill: { state: "restored", path: null }, metadataOriginals: null });
  expect(await readFile(path.join(f.destination, "payload"), "utf8")).toBe("old-skill");
  expect(await readFile(path.join(f.testsDirectory, "existing.json"), "utf8")).toBe("old-tests");
  await expectOriginalMetadata(f);
  expect(await exists(f.transactionDirectory)).toBe(false);
});

it("preserves existing tests untouched even when rollback fails and backup is retained (testsExist=true)", async () => {
  const f = await fixture(true, true);
  const primary = new Error("synthetic-install-failure");
  const failure = await perform(f, { ...failingInstall(f, primary), rename: async (from, to) => {
    if (from === path.join(f.transactionDirectory, "previous-skill")) throw new Error("synthetic-restore-failure");
    return rename(from, to);
  } });
  expect(failure.recovery.failedStages).toContain("restore-previous-skill");
  expect(failure.recovery.previousSkill.state).toBe("retained");
  await expectRetainedOldSkill(f, failure);
  expect(await readFile(path.join(f.testsDirectory, "existing.json"), "utf8")).toBe("old-tests");
  expect(await exists(f.destination)).toBe(false);
});

it("rolls back a new skill import completely when destination did not exist (destinationExists=false)", async () => {
  const f = await fixture(false, false);
  const primary = new Error("synthetic-install-failure");
  const failure = await perform(f, failingInstall(f, primary));
  expect(failure.cause).toBe(primary);
  expect(failure.recovery).toMatchObject({ state: "completed", transactionState: "removed",
    transactionDirectory: null, previousSkill: { state: "not-created", path: null }, metadataOriginals: null });
  expect(await exists(f.destination)).toBe(false);
  expect(await exists(f.testsDirectory)).toBe(false);
  await expectOriginalMetadata(f);
  expect(await exists(f.transactionDirectory)).toBe(false);
});

it("retains new skill rollback failure and preserves transaction when removing new skill fails (destinationExists=false)", async () => {
  const f = await fixture(false, false);
  const primary = new Error("synthetic-install-failure");
  const failure = await perform(f, { ...failingInstall(f, primary),
    rm: async (file, options) => {
      if (file === f.destination) throw new Error("synthetic-new-skill-remove-failure");
      return rm(file, options);
    }
  });
  expect(failure.cause).toBe(primary);
  expect(failure.recovery.state).toBe("incomplete");
  expect(failure.recovery.preserveTransaction).toBe(true);
  expect(failure.recovery.failedStages).toContain("remove-imported-skill");
  expect(failure.recovery.previousSkill.state).toBe("not-created");
  expect(await exists(f.destination)).toBe(true);
  expect(await exists(f.transactionDirectory)).toBe(true);
  expect(await readFile(failure.recovery.metadataOriginals.registry)).toEqual(f.registryOriginal);
  expect(await readFile(failure.recovery.metadataOriginals.lock)).toEqual(f.lockOriginal);
});

it("retains previous skill bytes when removing the newly installed skill fails", async () => {
  const f = await fixture();
  const primary = new Error("synthetic-install-failure");
  let attemptedRestore = false;
  const failure = await perform(f, { ...failingInstall(f, primary),
    rm: async (file, options) => { if (file === f.destination) throw new Error("synthetic-remove-failure"); return rm(file, options); },
    rename: async (from, to) => {
      if (from === path.join(f.transactionDirectory, "previous-skill")) attemptedRestore = true;
      return rename(from, to);
    },
  });
  expect(failure.cause).toBe(primary);
  expect(failure.recovery.failedStages).toContain("remove-imported-skill");
  expect(attemptedRestore).toBe(false);
  await expectRetainedOldSkill(f, failure);
  await expectOriginalMetadata(f);
});

it("retains a readable previous skill after a failed rollback rename", async () => {
  const f = await fixture();
  const primary = new Error("synthetic-install-failure");
  const failure = await perform(f, { ...failingInstall(f, primary), rename: async (from, to) => {
    if (from === path.join(f.transactionDirectory, "previous-skill")) throw new Error("synthetic-restore-failure");
    return rename(from, to);
  } });
  expect(failure.recovery.failedStages).toContain("restore-previous-skill");
  expect(failure.recovery.previousSkill.state).toBe("retained");
  await expectRetainedOldSkill(f, failure);
  expect(await exists(f.destination)).toBe(false);
});

it("keeps original metadata snapshots when restoring metadata fails", async () => {
  const f = await fixture();
  const primary = new Error("synthetic-registry-write-failure");
  const failure = await perform(f, { writeFile: async (file, data, ...options) => {
    if (file === f.registryPath && typeof data === "string") throw primary;
    if (file === f.lockPath && Buffer.isBuffer(data)) throw new Error("synthetic-metadata-restore-failure");
    return writeFile(file, data, ...options);
  } });
  expect(failure.cause).toBe(primary);
  expect(failure.recovery.failedStages).toContain("restore-lock");
  expect(failure.recovery.previousSkill.state).toBe("restored");
  expect(await readFile(path.join(f.destination, "payload"), "utf8")).toBe("old-skill");
  expect(await readFile(failure.recovery.metadataOriginals.lock)).toEqual(f.lockOriginal);
  expect(await readFile(failure.recovery.metadataOriginals.registry)).toEqual(f.registryOriginal);
});

it("does not claim or restore a backup whose initial rename never succeeded", async () => {
  const f = await fixture();
  const primary = new Error("synthetic-initial-rename-failure");
  let attemptedRestore = false;
  const failure = await perform(f, { rename: async (from, to) => {
    if (from === f.destination) throw primary;
    if (from === path.join(f.transactionDirectory, "previous-skill")) attemptedRestore = true;
    return rename(from, to);
  } });
  expect(failure.cause).toBe(primary);
  expect(failure.recovery.previousSkill.state).toBe("not-created");
  expect(attemptedRestore).toBe(false);
  expect(await readFile(path.join(f.destination, "payload"), "utf8")).toBe("old-skill");
  await expectOriginalMetadata(f);
});

it("preserves original and recovery failures when temporary cleanup fails too", async () => {
  const f = await fixture();
  const primary = new Error("synthetic-install-failure");
  const failure = await perform(f, { ...failingInstall(f, primary), rm: async (file, options) => {
    if (file === f.destination) throw new Error("synthetic-remove-failure");
    if (file === f.temporaryDirectory) throw new Error("synthetic-temp-cleanup-failure");
    return rm(file, options);
  } });
  expect(failure.cause.cause).toBe(primary);
  expect(failure.errors).toHaveLength(2);
  expect(failure.recovery.failedStages).toContain("remove-imported-skill");
  await expectRetainedOldSkill(f, failure);
});

it("D0108: chains all error causes across primary install failure, recovery stage failure, and cleanup failure", async () => {
  const f = await fixture(true, false);
  const primary = new Error("primary-install-failure");
  const stageFailure = new Error("secondary-recovery-failure");
  const tempCleanupFailure = new Error("tertiary-temp-cleanup-failure");
  const failure = await perform(f, {
    writeFile: async (file, data, ...options) => {
      if (file === f.lockPath && typeof data === "string") throw primary;
      return writeFile(file, data, ...options);
    },
    rm: async (file, options) => {
      if (file === f.destination) throw stageFailure;
      if (file === f.temporaryDirectory) throw tempCleanupFailure;
      return rm(file, options);
    }
  });
  expect(failure).toBeInstanceOf(AggregateError);
  expect(failure.message).toBe("Skill import cleanup incomplete");
  expect(failure.cause).toBeInstanceOf(AggregateError);
  expect(failure.cause.message).toContain("Skill import failed; recovery incomplete; backup:");
  expect(failure.cause.cause).toBe(primary);
  expect(failure.errors[0]).toBe(failure.cause);
  expect(failure.errors[0].errors[0]).toBe(primary);
  expect(failure.errors[0].errors[1].message).toBe("Skill import recovery failed: remove-imported-skill");
  expect(failure.errors[0].errors[1].cause).toBe(stageFailure);
  expect(failure.errors[1].message).toBe("Skill import temporary cleanup failed");
  expect(failure.errors[1].cause).toBe(tempCleanupFailure);
  expect(failure.recovery.preserveTransaction).toBe(true);
  expect(failure.recovery.failedStages).toEqual(["remove-imported-skill"]);
  await expectRetainedOldSkill(f, failure);
});

it("D0107(P1): guarantees finally block does not delete previous skill backup or original metadata when recovery fails", async () => {
  const f = await fixture(true, false);
  const primary = new Error("primary-metadata-failure");
  const stageFailure = new Error("rename-restore-failure");
  const failure = await perform(f, {
    writeFile: async (file, data, ...options) => {
      if (file === f.lockPath && typeof data === "string") throw primary;
      return writeFile(file, data, ...options);
    },
    rename: async (from, to) => {
      if (from === path.join(f.transactionDirectory, "previous-skill")) throw stageFailure;
      return rename(from, to);
    }
  });
  expect(failure.recovery.preserveTransaction).toBe(true);
  expect(failure.recovery.state).toBe("incomplete");
  expect(await exists(f.transactionDirectory)).toBe(true);
  expect(await readFile(path.join(f.transactionDirectory, "previous-skill", "payload"), "utf8")).toBe("old-skill");
  expect(await readFile(failure.recovery.metadataOriginals.registry)).toEqual(f.registryOriginal);
  expect(await readFile(failure.recovery.metadataOriginals.lock)).toEqual(f.lockOriginal);
});

it("does not mutate live destinations if saving original metadata bytes fails", async () => {
  const f = await fixture();
  const primary = new Error("synthetic-snapshot-failure");
  let renames = 0;
  const failure = await perform(f, {
    writeFile: async (file, data, ...options) => {
      if (file === path.join(f.transactionDirectory, "source-lock.original")) throw primary;
      return writeFile(file, data, ...options);
    },
    rename: async (...args) => { renames++; return rename(...args); },
  });
  expect(failure).toBe(primary);
  expect(renames).toBe(0);
  expect(await readFile(path.join(f.destination, "payload"), "utf8")).toBe("old-skill");
  await expectOriginalMetadata(f);
});

it("cleans a pre-commit failure without inventing retained recovery metadata", async () => {
  const f = await fixture();
  const primary = new Error("synthetic-pre-commit-failure");
  await expect(cleanupSkillImport({ ...f, operationFailed: true, failure: primary })).rejects.toBe(primary);
  expect(primary.recovery).toBeUndefined();
  expect(await exists(f.transactionDirectory)).toBe(false);
  expect(await exists(f.temporaryDirectory)).toBe(false);
  expect(await readFile(path.join(f.destination, "payload"), "utf8")).toBe("old-skill");
  await expectOriginalMetadata(f);
});

it("preserves metadata backups when removing imported tests during rollback fails", async () => {
  const f = await fixture();
  const primary = new Error("synthetic-install-failure");
  const failure = await perform(f, { ...failingInstall(f, primary), rm: async (file, options) => {
    if (file === f.testsDirectory) throw new Error("synthetic-tests-remove-failure");
    return rm(file, options);
  } });
  expect(failure.cause).toBe(primary);
  expect(failure.recovery).toMatchObject({ state: "incomplete", preserveTransaction: true });
  expect(failure.recovery.failedStages).toContain("remove-imported-tests");
  expect(await readFile(path.join(f.destination, "payload"), "utf8")).toBe("old-skill");
  expect(await exists(f.testsDirectory)).toBe(true);
  expect(await readFile(failure.recovery.metadataOriginals.registry)).toEqual(f.registryOriginal);
  expect(await readFile(failure.recovery.metadataOriginals.lock)).toEqual(f.lockOriginal);
});

it("preserves exact registry original when its rollback write fails", async () => {
  const f = await fixture();
  const primary = new Error("synthetic-registry-write-after-commit-failure");
  const failure = await perform(f, { ...failingInstall(f, primary), writeFile: async (file, data, ...options) => {
    if (file === f.registryPath && typeof data === "string") { await writeFile(file, data, ...options); throw primary; }
    if (file === f.registryPath && Buffer.isBuffer(data)) throw new Error("synthetic-registry-restore-failure");
    return writeFile(file, data, ...options);
  } });
  expect(failure.cause).toBe(primary);
  expect(failure.recovery).toMatchObject({ state: "incomplete", preserveTransaction: true });
  expect(failure.recovery.failedStages).toContain("restore-registry");
  expect(await readFile(f.registryPath, "utf8")).toBe(JSON.stringify(f.registryDocument, null, 2) + "\n");
  expect(await readFile(f.registryPath)).not.toEqual(f.registryOriginal);
  expect(await readFile(failure.recovery.metadataOriginals.registry)).toEqual(f.registryOriginal);
  expect(await readFile(failure.recovery.metadataOriginals.lock)).toEqual(f.lockOriginal);
  expect(await readFile(path.join(f.destination, "payload"), "utf8")).toBe("old-skill");
});

it("retains recovery paths if a completed rollback transaction cannot be cleaned", async () => {
  const f = await fixture();
  const primary = new Error("synthetic-install-failure");
  const cleanup = new Error("synthetic-transaction-cleanup-failure");
  const failure = await perform(f, { ...failingInstall(f, primary), rm: async (file, options) => {
    if (file === f.transactionDirectory) throw cleanup;
    return rm(file, options);
  } });
  expect(failure.cause.cause).toBe(primary);
  expect(failure.errors[1].cause).toBe(cleanup);
  expect(failure.recovery.state).toBe("completed");
  expect(failure.recovery.transactionState).not.toBe("removed");
  expect(failure.recovery.transactionDirectory).toBe(f.transactionDirectory);
  expect(await exists(f.transactionDirectory)).toBe(true);
  expect(await readFile(failure.recovery.metadataOriginals.registry)).toEqual(f.registryOriginal);
  expect(await readFile(failure.recovery.metadataOriginals.lock)).toEqual(f.lockOriginal);
  await expectOriginalMetadata(f);
});
