import { createHash } from "node:crypto";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const ports = vi.hoisted(() => ({
  lstatSync: vi.fn(), mkdirSync: vi.fn(), mkdtempSync: vi.fn(),
  readdirSync: vi.fn(), renameSync: vi.fn(), rmdirSync: vi.fn(), delay: vi.fn(),
  processStartToken: vi.fn<(pid?: number) => string>(() => "synthetic-process-birth"),
}));
vi.mock("node:fs", () => ports);
vi.mock("node:timers/promises", () => ({ setTimeout: ports.delay }));
vi.mock("../../mcp-server/src/process-identity.js", () => ({ processStartToken: ports.processStartToken }));
import { acquireBrokerProcessLock, acquireBrokerProcessLockWhenReady, ownsBrokerProcessLock, releaseBrokerProcessLock } from "../../mcp-server/src/broker-process-lock.js";

type Kind = "directory" | "file" | "link";
type Op = "lstat" | "mkdir" | "mkdtemp" | "readdir" | "rename" | "rmdir";
const root = path.toNamespacedPath(path.resolve("synthetic-owned-broker-state"));
const lockPath = path.join(root, "broker.lock");
const deadPid = 999999;
const deadOwner = "owner-" + deadPid + "-" + "f".repeat(32);
const error = (code: string) => Object.assign(new Error("controlled " + code), { code });

class FsModel {
  nodes = new Map<string, Kind>([[root, "directory"]]);
  calls: Array<{ op: Op; target: string }> = [];
  before: ((op: Op, target: string) => void) | null = null;
  platform: "posix" | "windows" = "windows";
  serial = 0;
  visit(op: Op, target: string) { this.calls.push({ op, target }); this.before?.(op, target); }
  children(target: string) { return [...this.nodes.keys()].filter(key => key !== target && path.dirname(key) === target); }
  kind(target: string) { const kind = this.nodes.get(target); if (!kind) throw error("ENOENT"); return kind; }
  directory(target: string) { if (this.kind(target) !== "directory") throw error("ENOTDIR"); }
  lstat(target: string) {
    this.visit("lstat", target); const kind = this.kind(target);
    return { isDirectory: () => kind === "directory", isSymbolicLink: () => kind === "link" };
  }
  mkdir(target: string) {
    this.visit("mkdir", target);
    if (this.nodes.has(target)) throw error("EEXIST");
    this.directory(path.dirname(target)); this.nodes.set(target, "directory");
  }
  mkdtemp(prefix: string) {
    this.visit("mkdtemp", prefix);
    const result = prefix + ++this.serial; this.mkdir(result); return result;
  }
  readdir(target: string) {
    this.visit("readdir", target); this.directory(target);
    return this.children(target).map(key => ({
      name: path.basename(key), isDirectory: () => this.nodes.get(key) === "directory",
      isSymbolicLink: () => this.nodes.get(key) === "link",
    }));
  }
  rename(source: string, target: string) {
    this.visit("rename", target); this.directory(source);
    if (this.nodes.has(target)) {
      if (this.kind(target) !== "directory") throw error("ENOTDIR");
      if (this.children(target).length || this.platform === "windows") {
        throw error(this.platform === "windows" ? "EPERM" : "ENOTEMPTY");
      }
      this.nodes.delete(target);
    }
    this.directory(path.dirname(target));
    const moving = [...this.nodes].filter(([key]) => key === source || key.startsWith(source + path.sep));
    for (const [key] of moving) this.nodes.delete(key);
    for (const [key, kind] of moving) this.nodes.set(target + key.slice(source.length), kind);
  }
  rmdir(target: string) {
    this.visit("rmdir", target); this.directory(target);
    if (this.children(target).length) throw error("ENOTEMPTY");
    this.nodes.delete(target);
  }
  owner(name = deadOwner) {
    this.nodes.set(lockPath, "directory");
    this.nodes.set(path.join(lockPath, name), "directory");
  }
}
let fs: FsModel;
beforeEach(() => {
  fs = new FsModel();
  for (const port of Object.values(ports)) port.mockReset();
  ports.lstatSync.mockImplementation(target => fs.lstat(target));
  ports.mkdirSync.mockImplementation(target => fs.mkdir(target));
  ports.mkdtempSync.mockImplementation(prefix => fs.mkdtemp(prefix));
  ports.readdirSync.mockImplementation(target => fs.readdir(target));
  ports.renameSync.mockImplementation((source, target) => fs.rename(source, target));
  ports.rmdirSync.mockImplementation(target => fs.rmdir(target));
  ports.delay.mockResolvedValue(undefined);
  ports.processStartToken.mockReturnValue("synthetic-process-birth");
  vi.spyOn(process, "kill").mockImplementation(pid => {
    if (pid === deadPid) throw error("ESRCH");
    return true;
  });
});
afterEach(() => vi.restoreAllMocks());

it.each(["posix", "windows"] as const)("publishes one completed owner and releases only its own empty directories (%s model)", platform => {
  fs.platform = platform;
  fs.before = (op, target) => {
    if (op === "rename" && target === lockPath) {
      const source = [...fs.nodes.keys()].find(key => path.dirname(key) === root && key.includes(".stage-"))!;
      expect(fs.children(source)).toHaveLength(1);
      expect(fs.nodes.has(lockPath)).toBe(false);
    }
  };
  const lease = acquireBrokerProcessLock(lockPath)!;
  expect(lease.owner).toMatch(/^owner-[1-9][0-9]*-[a-f0-9]{32}-[a-f0-9]{64}$/u);
  expect(Object.isFrozen(lease)).toBe(true);
  expect(ownsBrokerProcessLock(lease)).toBe(true);
  fs.before = null;
  expect(acquireBrokerProcessLock(lockPath)).toBeNull();
  expect(ownsBrokerProcessLock(lease)).toBe(true);
  releaseBrokerProcessLock(lease);
  expect([...fs.nodes]).toEqual([[root, "directory"]]);
});

it("private marker preparation can pause while another contender wins; no public empty PID window exists", () => {
  let winner: ReturnType<typeof acquireBrokerProcessLock> = null;
  const witness: string[] = [];
  fs.before = (op, target) => {
    if (op === "mkdir" && path.basename(target).startsWith("owner-")) {
      fs.before = null;
      witness.push("A-private-marker-not-yet-created");
      expect(fs.nodes.has(lockPath)).toBe(false);
      winner = acquireBrokerProcessLock(lockPath);
      witness.push("B-published-complete-owner");
    }
  };
  const loser = acquireBrokerProcessLock(lockPath);
  expect(loser).toBeNull();
  expect(winner).not.toBeNull();
  expect(ownsBrokerProcessLock(winner!)).toBe(true);
  expect(fs.children(lockPath)).toEqual([path.join(lockPath, winner!.owner)]);
  expect(witness).toEqual(["A-private-marker-not-yet-created", "B-published-complete-owner"]);
  expect([...fs.nodes.keys()].filter(key => key.includes(".stage-"))).toEqual([]);
});

it("an owner release between stat and enumeration does not fail acquisition of a free lock", () => {
  const previous = acquireBrokerProcessLock(lockPath)!;
  let releasedDuringObservation = false;
  fs.before = (op, target) => {
    if (op === "readdir" && target === lockPath) {
      fs.before = null;
      releaseBrokerProcessLock(previous);
      releasedDuringObservation = true;
    }
  };
  const current = acquireBrokerProcessLock(lockPath);
  expect(releasedDuringObservation).toBe(true);
  expect(current).not.toBeNull();
  expect(ownsBrokerProcessLock(previous)).toBe(false);
  expect(ownsBrokerProcessLock(current!)).toBe(true);
  expect(fs.children(lockPath)).toEqual([path.join(lockPath, current!.owner)]);
  expect([...fs.nodes.keys()].filter(key => key.includes(".stage-"))).toEqual([]);
});

it.each(["EACCES", "EIO"] as const)("an enumeration failure (%s) is preserved and cannot retire the current owner", failureCode => {
  const previous = acquireBrokerProcessLock(lockPath)!;
  const failure = Object.freeze(error(failureCode));
  fs.before = (op, target) => { if (op === "readdir" && target === lockPath) throw failure; };
  let caught: unknown;
  try { acquireBrokerProcessLock(lockPath); } catch (cause) { caught = cause; }
  expect(caught).toBe(failure);
  fs.before = null;
  expect(ownsBrokerProcessLock(previous)).toBe(true);
  expect(fs.children(lockPath)).toEqual([path.join(lockPath, previous.owner)]);
  expect([...fs.nodes.keys()].filter(key => key.includes(".stage-"))).toEqual([]);
});

it("a stale observer reobserves a freshly published generation without deleting it", async () => {
  fs.owner();
  let winner: ReturnType<typeof acquireBrokerProcessLock> = null;
  const witness: string[] = [];
  fs.before = (op, target) => {
    if (op === "rmdir" && target === path.join(lockPath, deadOwner)) {
      fs.before = null;
      witness.push("B-observed-old-generation");
      winner = acquireBrokerProcessLock(lockPath);
      witness.push("C-retired-old-and-published-new");
    }
  };
  expect(await acquireBrokerProcessLockWhenReady(lockPath)).toBeNull();
  expect(ports.delay.mock.calls).toEqual([[25]]);
  expect(winner).not.toBeNull();
  expect(ownsBrokerProcessLock(winner!)).toBe(true);
  expect(fs.children(lockPath)).toEqual([path.join(lockPath, winner!.owner)]);
  expect(witness).toHaveLength(2);
  expect(fs.calls.filter(call => call.op === "rmdir" && call.target === lockPath)).toHaveLength(1);
});

it("a delayed outer cleanup preserves a contender publishing over the empty old parent (POSIX model)", () => {
  fs.platform = "posix";
  let previous: ReturnType<typeof acquireBrokerProcessLock> = null;
  const witness: string[] = [];
  // B has already observed absence. Its rename is pending while A acquires and
  // starts release; complete that same B filesystem operation before A's rmdir.
  ports.renameSync.mockImplementationOnce((stage, target) => {
    witness.push("B-rename-pending-after-absent-observation");
    previous = acquireBrokerProcessLock(lockPath);
    expect(previous).not.toBeNull();
    fs.before = (op, observedTarget) => {
      if (op === "rmdir" && observedTarget === lockPath) {
        fs.before = null;
        witness.push("A-marker-removed-parent-delete-pending");
        expect(fs.children(lockPath)).toEqual([]);
        fs.rename(stage, target);
        witness.push("B-completed-nonempty-publication");
      }
    };
    releaseBrokerProcessLock(previous!);
    witness.push("A-late-parent-delete-returned");
  });
  const current = acquireBrokerProcessLock(lockPath)!;
  expect(witness).toEqual(["B-rename-pending-after-absent-observation",
    "A-marker-removed-parent-delete-pending", "B-completed-nonempty-publication", "A-late-parent-delete-returned"]);
  expect(ownsBrokerProcessLock(previous!)).toBe(false);
  expect(ownsBrokerProcessLock(current)).toBe(true);
  expect(fs.children(lockPath)).toEqual([path.join(lockPath, current.owner)]);
  expect([...fs.nodes.keys()].filter(key => key.includes(".stage-"))).toEqual([]);
});

it("a late old cleanup cannot remove a new owner or report ownership of its endpoint", () => {
  const old = acquireBrokerProcessLock(lockPath)!;
  releaseBrokerProcessLock(old);
  const current = acquireBrokerProcessLock(lockPath)!;
  const before = fs.calls.filter(call => call.op === "rmdir" && call.target === lockPath).length;
  expect(ownsBrokerProcessLock(old)).toBe(false);
  releaseBrokerProcessLock(old);
  expect(ownsBrokerProcessLock(current)).toBe(true);
  expect(fs.calls.filter(call => call.op === "rmdir" && call.target === lockPath)).toHaveLength(before);
});

it.each(["file", "link", "empty-directory", "malformed-owner", "partial-pid"] as const)(
  "unknown or legacy lock state is preserved without delete/rename (%s)", mode => {
    if (mode === "file" || mode === "link") fs.nodes.set(lockPath, mode);
    else {
      fs.nodes.set(lockPath, "directory");
      if (mode !== "empty-directory") fs.nodes.set(path.join(lockPath,
        mode === "malformed-owner" ? "unexpected" : "owner-1x-" + "f".repeat(32)), "directory");
    }
    const original = [...fs.nodes].filter(([key]) => key === lockPath || key.startsWith(lockPath + path.sep));
    const reason = mode === "file" || mode === "link" ? "UNSUPPORTED_PATH"
      : mode === "empty-directory" ? "EMPTY_DIRECTORY" : "UNRECOGNIZED_OWNER";
    expect(() => acquireBrokerProcessLock(lockPath)).toThrow(reason);
    expect([...fs.nodes].filter(([key]) => key === lockPath || key.startsWith(lockPath + path.sep))).toEqual(original);
    expect(fs.calls.some(call => call.op === "rename")).toBe(false);
    expect(fs.calls.some(call => call.op === "rmdir" && call.target === lockPath)).toBe(false);
  });

it.each(["EACCES", "UNKNOWN"] as const)("a failed owner probe (%s) is never death evidence", failure => {
  fs.owner();
  vi.mocked(process.kill).mockImplementation(() => { throw error(failure); });
  expect(() => acquireBrokerProcessLock(lockPath)).toThrow("OWNER_UNVERIFIED");
  expect(fs.children(lockPath)).toEqual([path.join(lockPath, deadOwner)]);
  expect(fs.calls.some(call => call.op === "rmdir" && call.target === path.join(lockPath, deadOwner))).toBe(false);
});

it("definite ESRCH can retire exactly the observed generation and publish a new owner", () => {
  fs.owner();
  const lease = acquireBrokerProcessLock(lockPath)!;
  expect(lease.owner).not.toBe(deadOwner);
  expect(fs.children(lockPath)).toEqual([path.join(lockPath, lease.owner)]);
  expect(ownsBrokerProcessLock(lease)).toBe(true);
});

it("owner marker preparation failure retains the exact cause and reclaims only its own stage", () => {
  const primary = Object.freeze(error("ENOSPC"));
  fs.before = (op, target) => { if (op === "mkdir" && path.basename(target).startsWith("owner-")) throw primary; };
  let caught: unknown;
  try { acquireBrokerProcessLock(lockPath); } catch (cause) { caught = cause; }
  expect(caught).toBe(primary);
  expect([...fs.nodes]).toEqual([[root, "directory"]]);
  expect(fs.calls.some(call => call.op === "rmdir" && call.target === lockPath)).toBe(false);
});

it("real cleanup failures retain the real preparation cause rather than replacing it or claiming no leak", () => {
  const primary = Object.freeze(error("EIO"));
  const cleanup = Object.freeze(error("EPERM"));
  fs.before = (op, target) => {
    if (op === "rename") throw primary;
    if (op === "rmdir" && path.basename(target).startsWith("owner-")) throw cleanup;
  };
  let caught: unknown;
  try { acquireBrokerProcessLock(lockPath); } catch (cause) { caught = cause; }
  expect(caught).toBeInstanceOf(AggregateError);
  const aggregate = caught as AggregateError;
  expect(aggregate.cause).toBe(primary);
  expect((aggregate as AggregateError & {code: string}).code).toBe("BROKER_LOCK_PREPARATION_CLEANUP_FAILED");
  expect(aggregate.errors[0]).toBe(primary);
  expect(aggregate.errors[1]).toBe(cleanup);
  expect(aggregate.errors).toHaveLength(3);
  expect(fs.nodes.has(lockPath)).toBe(false);
  expect([...fs.nodes.keys()].some(key => key.includes(".stage-"))).toBe(true);
});

it.each(["lstat", "readdir"] as const)("ownership inspection preserves a real %s failure instead of reporting not-owned", operation => {
  const lease = acquireBrokerProcessLock(lockPath)!;
  const failure = Object.freeze(error("EIO"));
  fs.before = (op, target) => { if (op === operation && target === lockPath) throw failure; };
  let caught: unknown;
  try { ownsBrokerProcessLock(lease); } catch (cause) { caught = cause; }
  expect(caught).toBe(failure);
  fs.before = null;
  expect(ownsBrokerProcessLock(lease)).toBe(true);
});

it("an owner-marker removal failure retains its cause and never removes the parent", () => {
  const lease = acquireBrokerProcessLock(lockPath)!;
  const failure = Object.freeze(error("EPERM"));
  fs.before = (op, target) => {
    if (op === "rmdir" && target === path.join(lockPath, lease.owner)) throw failure;
  };
  let caught: unknown;
  try { releaseBrokerProcessLock(lease); } catch (cause) { caught = cause; }
  expect(caught).toBe(failure);
  expect(fs.calls.some(call => call.op === "rmdir" && call.target === lockPath)).toBe(false);
  fs.before = null;
  expect(ownsBrokerProcessLock(lease)).toBe(true);
});

it("a permission-denied owner probe preserves the contender without claiming death or service readiness", async () => {
  fs.owner();
  vi.mocked(process.kill).mockImplementation(() => { throw error("EPERM"); });
  expect(await acquireBrokerProcessLockWhenReady(lockPath)).toBeNull();
  expect(fs.children(lockPath)).toEqual([path.join(lockPath, deadOwner)]);
  expect(fs.calls.some(call => call.op === "rmdir" && call.target === path.join(lockPath, deadOwner))).toBe(false);
  expect(ports.delay).not.toHaveBeenCalled();
  expect([...fs.nodes.keys()].some(key => key.includes(".stage-"))).toBe(false);
});

it("waits through an empty release gap then acquires without deleting unknown public state", async () => {
  fs.nodes.set(lockPath, "directory");
  ports.delay.mockImplementationOnce(async () => {
    expect(fs.children(lockPath)).toEqual([]);
    expect(fs.calls.some(call => call.op === "rmdir" && call.target === lockPath)).toBe(false);
    fs.nodes.delete(lockPath); // The previous owner finishes its pending release.
  });
  const lease = await acquireBrokerProcessLockWhenReady(lockPath);
  expect(lease).not.toBeNull();
  expect(ownsBrokerProcessLock(lease!)).toBe(true);
  expect(ports.delay.mock.calls).toEqual([[25]]);
  expect([...fs.nodes.keys()].some(key => key.includes(".stage-"))).toBe(false);
});

it("bounds reobservation and diagnoses a persistent empty directory without removing it", async () => {
  fs.nodes.set(lockPath, "directory");
  await expect(acquireBrokerProcessLockWhenReady(lockPath)).rejects.toMatchObject({code: "BROKER_LOCK_EMPTY_DIRECTORY"});
  expect(ports.delay).toHaveBeenCalledTimes(19);
  expect(ports.delay.mock.calls.every(([milliseconds]) => milliseconds === 25)).toBe(true);
  expect(fs.calls.filter(call => call.op === "lstat" && call.target === lockPath)).toHaveLength(20);
  expect([...fs.nodes]).toEqual([[root, "directory"], [lockPath, "directory"]]);
  expect(fs.calls.some(call => call.op === "rmdir" && call.target === lockPath)).toBe(false);
});

it.each(["EACCES", "UNKNOWN"] as const)("does not retry a non-transient owner probe failure (%s)", async failure => {
  fs.owner();
  vi.mocked(process.kill).mockImplementation(() => { throw error(failure); });
  await expect(acquireBrokerProcessLockWhenReady(lockPath)).rejects.toMatchObject({code: "BROKER_LOCK_OWNER_UNVERIFIED"});
  expect(ports.delay).not.toHaveBeenCalled();
  expect(fs.children(lockPath)).toEqual([path.join(lockPath, deadOwner)]);
});

it("does not retry a compound preparation and cleanup failure even if the primary state was transient", async () => {
  fs.nodes.set(lockPath, "directory");
  const cleanup = Object.freeze(error("EIO"));
  fs.before = (op, target) => {
    if (op === "rmdir" && path.basename(target).startsWith("owner-")) throw cleanup;
  };
  let caught: unknown;
  try { await acquireBrokerProcessLockWhenReady(lockPath); } catch (failure) { caught = failure; }
  expect(caught).toMatchObject({code: "BROKER_LOCK_PREPARATION_CLEANUP_FAILED",
    cause: {code: "BROKER_LOCK_EMPTY_DIRECTORY"}});
  expect((caught as AggregateError).errors[1]).toBe(cleanup);
  expect(ports.delay).not.toHaveBeenCalled();
  expect(fs.nodes.has(lockPath)).toBe(true);
});

it("reobserves a live winner after two successive publication collisions", async () => {
  let publications = 0;
  let winnerOwner = "";
  ports.renameSync.mockImplementation(() => {
    publications++;
    winnerOwner = "owner-" + process.pid + "-" + String(publications).padStart(32, "0");
    fs.owner(winnerOwner);
    if (publications === 1) fs.before = (op, target) => {
      if (op === "readdir" && target === lockPath) {
        fs.before = null;
        fs.nodes.delete(path.join(lockPath, winnerOwner));
        fs.nodes.delete(lockPath);
      }
    };
    throw error("EEXIST");
  });
  expect(await acquireBrokerProcessLockWhenReady(lockPath)).toBeNull();
  expect(publications).toBe(2);
  expect(ports.delay.mock.calls).toEqual([[25]]);
  expect(fs.children(lockPath)).toEqual([path.join(lockPath, winnerOwner)]);
  expect([...fs.nodes.keys()].some(key => key.includes(".stage-"))).toBe(false);
});

it("bounds repeated publication failure and retains the final syscall cause", async () => {
  const failure = Object.freeze(error("EACCES"));
  ports.renameSync.mockImplementation(() => { throw failure; });
  let caught: unknown;
  try { await acquireBrokerProcessLockWhenReady(lockPath); } catch (cause) { caught = cause; }
  expect(caught).toMatchObject({code: "BROKER_LOCK_PUBLISH_EACCES", cause: failure});
  expect(ports.renameSync).toHaveBeenCalledTimes(40);
  expect(ports.delay).toHaveBeenCalledTimes(19);
  expect([...fs.nodes]).toEqual([[root, "directory"]]);
});

it("AGS-D-0298: skips opening live contender stages and caches verified owner birth hashes", () => {
  const livePid = 424242;
  const liveBirth = "live-contender-birth";
  const liveHash = createHash("sha256").update(liveBirth).digest("hex");
  const liveOwner = `owner-${livePid}-${"a".repeat(32)}-${liveHash}`;
  const liveStage = `${lockPath}.stage-${liveOwner}-abc123`;
  fs.nodes.set(liveStage, "directory");
  fs.nodes.set(path.join(liveStage, liveOwner), "directory");
  fs.owner(liveOwner);
  ports.processStartToken.mockImplementation((pid?: number) =>
    pid === livePid ? liveBirth : "synthetic-process-birth",
  );

  expect(acquireBrokerProcessLock(lockPath)).toBeNull();
  expect(fs.calls.some(call => call.op === "readdir" && call.target === liveStage)).toBe(false);
  expect(ports.processStartToken.mock.calls.filter(call => call[0] === livePid)).toHaveLength(1);
});

it("AGS-D-0298: ignores transient EPERM/EACCES/EBUSY/ENOTDIR during abandoned stage retirement", () => {
  const staleOwnerA = `owner-${deadPid}-${"a".repeat(32)}-${"0".repeat(64)}`;
  const staleOwnerB = `owner-${deadPid}-${"b".repeat(32)}-${"0".repeat(64)}`;
  const staleStageA = `${lockPath}.stage-${staleOwnerA}-abc123`;
  const staleStageB = `${lockPath}.stage-${staleOwnerB}-def456`;
  fs.nodes.set(staleStageA, "directory");
  fs.nodes.set(staleStageB, "directory");
  fs.before = (op, target) => {
    if (op === "readdir" && target === staleStageA) throw error("EPERM");
    if (op === "rmdir" && target === staleStageB) throw error("EBUSY");
  };

  const lease = acquireBrokerProcessLock(lockPath);
  expect(lease).not.toBeNull();
  expect(ownsBrokerProcessLock(lease!)).toBe(true);
});
