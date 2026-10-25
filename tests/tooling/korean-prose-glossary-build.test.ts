import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildGlossaryWithRecovery } from "../../scripts/korean-prose-glossary-build.js";

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true }); });
async function fixture(existing = true) {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "glossary-publication-"));
  directories.push(directory);
  const target = path.join(directory, "glossary.sqlite3");
  if (existing) await fs.writeFile(target, Buffer.from([0, 255, 13, 10, 9]));
  return { directory, target };
}
async function staged(pathname: string) { await fs.writeFile(pathname, "validated-new-bytes"); }
type RecoveryError = AggregateError & { code: string; recovery: {
  transactionPath: string | null; stagedPath: string | null; backupPath: string | null;
  lockPath: string; validated: boolean; previousMoved: boolean; published: boolean; restored: boolean;
} };
async function rejected(operation: Promise<unknown>): Promise<RecoveryError> {
  let failure: unknown;
  try { await operation; } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(AggregateError);
  return failure as RecoveryError;
}
async function expectNoOwnedStages(directory: string) {
  expect((await fs.readdir(directory)).filter(name => name.includes(".build-"))).toEqual([]);
}

describe("offline glossary file publication ownership and recovery", () => {
  for (const existing of [false, true]) {
    it("publishes validated bytes with no retained owned staging: existing=" + existing, async () => {
      const f = await fixture(existing);
      const result = await buildGlossaryWithRecovery(f.target, async stage => { await staged(stage); return { entries: 17 }; });
      expect(result).toEqual({ entries: 17 });
      expect(await fs.readFile(f.target, "utf8")).toBe("validated-new-bytes");
      await expectNoOwnedStages(f.directory);
    });
  }
  it("keeps original bytes and cleans only its own unvalidated stage when validation fails", async () => {
    const f = await fixture();
    const original = await fs.readFile(f.target);
    const primary = new Error("fixed-validation-fault");
    const error = await rejected(buildGlossaryWithRecovery(f.target, async stage => { await staged(stage); throw primary; }));
    expect(error.cause).toBe(primary);
    expect(error.errors[0]).toBe(primary);
    expect(error.recovery.validated).toBe(false);
    expect(await fs.readFile(f.target)).toEqual(original);
    await expectNoOwnedStages(f.directory);
  });
  it("retains the validated stage when moving the original fails", async () => {
    const f = await fixture();
    const original = await fs.readFile(f.target);
    const primary = Object.assign(new Error("fixed-old-move-fault"), { code: "EACCES" });
    const error = await rejected(buildGlossaryWithRecovery(f.target, staged, {
      ...fs, rename: async (from, to) => { if (String(from) === f.target) throw primary; await fs.rename(from, to); },
    }));
    expect(error.errors[0]).toBe(primary);
    expect(error.recovery).toMatchObject({ validated: true, previousMoved: false, published: false });
    expect(await fs.readFile(f.target)).toEqual(original);
    expect(await fs.readFile(error.recovery.stagedPath!, "utf8")).toBe("validated-new-bytes");
    await expect(fs.stat(error.recovery.lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("restores without overwriting and retains old backup plus validated stage on publish failure", async () => {
    const f = await fixture();
    const original = await fs.readFile(f.target);
    const primary = new Error("fixed-publish-fault");
    const error = await rejected(buildGlossaryWithRecovery(f.target, staged, {
      ...fs, rename: async (from, to) => { if (String(from).endsWith("validated.sqlite3")) throw primary; await fs.rename(from, to); },
    }));
    expect(error.errors[0]).toBe(primary);
    expect(error.code).toBe("GLOSSARY_BUILD_FAILED");
    expect(error.message).toContain("build failed");
    expect(error.recovery).toMatchObject({ previousMoved: true, published: false, restored: true });
    expect(await fs.readFile(f.target)).toEqual(original);
    expect(await fs.readFile(error.recovery.backupPath!)).toEqual(original);
    expect(await fs.readFile(error.recovery.stagedPath!, "utf8")).toBe("validated-new-bytes");
  });
  it("keeps a competing destination and both recovery inputs when exclusive restore is refused", async () => {
    const f = await fixture();
    const original = await fs.readFile(f.target);
    const primary = new Error("fixed-publish-with-competitor");
    const error = await rejected(buildGlossaryWithRecovery(f.target, staged, {
      ...fs, rename: async (from, to) => {
        if (String(from).endsWith("validated.sqlite3")) { await fs.writeFile(f.target, "competing-destination", { flag: "wx" }); throw primary; }
        await fs.rename(from, to);
      },
    }));
    expect(error.errors[0]).toBe(primary);
    expect(error.errors[1]).toMatchObject({ code: "EEXIST" });
    expect(error.recovery.restored).toBe(false);
    expect(await fs.readFile(f.target, "utf8")).toBe("competing-destination");
    expect(await fs.readFile(error.recovery.backupPath!)).toEqual(original);
    expect(await fs.readFile(error.recovery.stagedPath!, "utf8")).toBe("validated-new-bytes");
  });
  it("never removes a legacy fixed .building artifact", async () => {
    const f = await fixture();
    await fs.writeFile(f.target + ".building", "other-invocation");
    await buildGlossaryWithRecovery(f.target, staged);
    expect(await fs.readFile(f.target + ".building", "utf8")).toBe("other-invocation");
  });
  it("does not acquire or remove an existing builder's lock", async () => {
    const f = await fixture();
    const lock = f.target + ".build-lock";
    await fs.mkdir(lock);
    await fs.writeFile(path.join(lock, "owner-marker"), "another-builder");
    let buildCalled = false;
    await expect(buildGlossaryWithRecovery(f.target, async () => { buildCalled = true; })).rejects.toMatchObject({ code: "EEXIST" });
    expect(buildCalled).toBe(false);
    expect(await fs.readFile(path.join(lock, "owner-marker"), "utf8")).toBe("another-builder");
  });
  it("uses an explicit barrier to exclude an overlapping builder without touching the first stage", async () => {
    const f = await fixture();
    let release!: () => void;
    let announce!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const reached = new Promise<void>(resolve => { announce = resolve; });
    let firstStage = "";
    const first = buildGlossaryWithRecovery(f.target, async stage => { firstStage = stage; await staged(stage); announce(); await gate; });
    try {
      await Promise.race([reached, first.then(() => { throw new Error("Builder completed before the explicit barrier."); })]);
      let secondBuilt = false;
      await expect(buildGlossaryWithRecovery(f.target, async () => { secondBuilt = true; })).rejects.toMatchObject({ code: "EEXIST" });
      expect(secondBuilt).toBe(false);
      expect(await fs.readFile(firstStage, "utf8")).toBe("validated-new-bytes");
    } finally { release(); await first; }
    expect(await fs.readFile(f.target, "utf8")).toBe("validated-new-bytes");
    await expectNoOwnedStages(f.directory);
  });
  it("rejects a directory destination without moving or deleting its contents", async () => {
    const f = await fixture(false);
    await fs.mkdir(f.target);
    await fs.writeFile(path.join(f.target, "keep"), "user-data");
    const error = await rejected(buildGlossaryWithRecovery(f.target, staged));
    expect(error.recovery.previousMoved).toBe(false);
    expect(await fs.readFile(path.join(f.target, "keep"), "utf8")).toBe("user-data");
    expect(await fs.readFile(error.recovery.stagedPath!, "utf8")).toBe("validated-new-bytes");
  });
  it("preserves a changed-type backup captured between lstat and rename", async () => {
    const f = await fixture();
    const error = await rejected(buildGlossaryWithRecovery(f.target, staged, {
      ...fs, rename: async (from, to) => {
        if (String(from) === f.target) {
          await fs.unlink(f.target); await fs.mkdir(f.target); await fs.writeFile(path.join(f.target, "keep"), "changed-type-data");
        }
        await fs.rename(from, to);
      },
    }));
    expect(error.recovery).toMatchObject({ previousMoved: true, published: false, restored: false });
    expect(await fs.readFile(path.join(error.recovery.backupPath!, "keep"), "utf8")).toBe("changed-type-data");
    expect(await fs.readFile(error.recovery.stagedPath!, "utf8")).toBe("validated-new-bytes");
  });
  for (const cleanup of ["transaction", "lock"] as const) {
    it("reports published database separately from incomplete " + cleanup + " cleanup", async () => {
      const f = await fixture();
      const primary = new Error("fixed-" + cleanup + "-cleanup-fault");
      const ops = cleanup === "transaction"
        ? { ...fs, rm: async () => { throw primary; } }
        : { ...fs, rmdir: async () => { throw primary; } };
      const error = await rejected(buildGlossaryWithRecovery(f.target, staged, ops));
      expect(error.errors[0]).toBe(primary);
      expect(error.cause).toBe(primary);
      expect(error.code).toBe("GLOSSARY_CLEANUP_INCOMPLETE");
      expect(error.message).toContain("database published; cleanup incomplete");
      expect(error.message).not.toContain("build failed");
      expect(error.recovery.published).toBe(true);
      expect(await fs.readFile(f.target, "utf8")).toBe("validated-new-bytes");
      if (cleanup === "transaction") {
        expect(await fs.readFile(error.recovery.backupPath!)).toEqual(Buffer.from([0, 255, 13, 10, 9]));
        await expect(fs.stat(error.recovery.lockPath)).rejects.toMatchObject({ code: "ENOENT" });
      } else {
        expect(error.recovery.transactionPath).toBeNull();
        expect(error.recovery.backupPath).toBeNull();
        expect((await fs.stat(error.recovery.lockPath)).isDirectory()).toBe(true);
      }
    });
  }
  it("does not treat a missing backup inspection after moving the original as initial absence", async () => {
    const f = await fixture();
    const original = await fs.readFile(f.target);
    const primary = Object.assign(new Error("fixed-backup-inspection-fault"), { code: "ENOENT" });
    const error = await rejected(buildGlossaryWithRecovery(f.target, staged, {
      ...fs, lstat: async pathname => {
        if (pathname.endsWith("previous.sqlite3")) throw primary;
        return fs.lstat(pathname);
      },
    }));
    expect(error.errors[0]).toBe(primary);
    expect(error.recovery).toMatchObject({ previousMoved: true, published: false, restored: true });
    expect(await fs.readFile(f.target)).toEqual(original);
    expect(await fs.readFile(error.recovery.backupPath!)).toEqual(original);
    expect(await fs.readFile(error.recovery.stagedPath!, "utf8")).toBe("validated-new-bytes");
  });

});
