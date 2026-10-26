import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const ports = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("../../mcp-server/src/process-identity.js", () => ({ processStartToken: ports.read }));
const owned: string[] = [];
let now = 0;
beforeEach(() => { vi.resetModules(); ports.read.mockReset(); now = 0; vi.spyOn(performance, "now").mockImplementation(() => now); });
afterEach(() => { vi.restoreAllMocks(); for (const root of owned.splice(0)) rmSync(root, { recursive: true, force: true }); });
const state = () => { const root = mkdtempSync(path.join(tmpdir(), "ags-d254-lock-")); owned.push(root); return root; };

it("passes one shared remaining startup budget to own birth and contender verification, preserving an unknown owner", async () => {
  const root = state(), lock = path.join(root, "broker.lock");
  const marker = "owner-" + process.pid + "-" + "a".repeat(32) + "-" + createHash("sha256").update("previous-birth").digest("hex");
  mkdirSync(lock); mkdirSync(path.join(lock, marker));
  const native = Object.assign(new Error("PRIVATE_NATIVE"), { code: "ETIMEDOUT" });
  ports.read.mockImplementationOnce(() => { now += 40; return "own-birth"; })
    .mockImplementationOnce((_pid, _platform, _timeout, failure) => { failure?.(native); now += 30; return null; });
  const { acquireBrokerProcessLockWhenReady } = await import("../../mcp-server/src/broker-process-lock.js");
  await expect(acquireBrokerProcessLockWhenReady(lock, () => 100 - now)).rejects.toMatchObject({ code: "BROKER_LOCK_OWNER_UNVERIFIED", cause: native });
  expect(ports.read.mock.calls.map(call => call[2])).toEqual([100, 60]);
  expect(readdirSync(lock)).toEqual([marker]);
  expect(readdirSync(root)).toEqual(["broker.lock"]);
});

it("a birth returned after the startup budget expires cannot publish a lock", async () => {
  const root = state(), lock = path.join(root, "broker.lock");
  ports.read.mockImplementation(() => { now = 101; return "late-birth"; });
  const { acquireBrokerProcessLockWhenReady } = await import("../../mcp-server/src/broker-process-lock.js");
  await expect(acquireBrokerProcessLockWhenReady(lock, () => 100 - now)).rejects.toMatchObject({ code: "BROKER_LOCK_BUDGET_EXPIRED" });
  expect(ports.read).toHaveBeenCalledTimes(1);
  expect(readdirSync(root)).toEqual([]);
});

it("an already exhausted startup budget starts no OS identity query and creates no stage", async () => {
  const root = state(), lock = path.join(root, "broker.lock");
  ports.read.mockReturnValue("birth");
  const { acquireBrokerProcessLockWhenReady } = await import("../../mcp-server/src/broker-process-lock.js");
  await expect(acquireBrokerProcessLockWhenReady(lock, () => 0)).rejects.toMatchObject({ code: "BROKER_LOCK_BUDGET_EXPIRED" });
  expect(ports.read).not.toHaveBeenCalled();
  expect(readdirSync(root)).toEqual([]);
});
