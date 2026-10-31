import { spawn } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { acquireBrokerProcessLock, ownsBrokerProcessLock, releaseBrokerProcessLock } from "../../mcp-server/src/broker-process-lock.js";

const owned: string[] = [];
afterEach(() => {
  for (const root of owned.splice(0)) {
    expect(path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep)).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
function state() {
  const root = fs.mkdtempSync(path.join(tmpdir(), "ags-d254-stage-")); owned.push(root);
  // Keep this long parent in both counterfactuals; shortening TEMP would hide the defect.
  // Windows owner는 64자 hash 대신 "pipe"이므로 부모를 60자 늘려 같은 260자 초과 경계를 유지한다.
  const directory = path.join(root, "p".repeat(160), "q".repeat(20));
  fs.mkdirSync(directory, { recursive: true });
  const lock = path.join(directory, "broker.lock");
  expect((lock + ".stage-owner-" + process.pid + "-" + "a".repeat(32) + "-pipe-").length).toBeGreaterThan(260);
  return { directory, lock };
}
const test = it.runIf(process.platform === "win32");
test("a real long-path stage publishes a complete owner, preserves live contention and releases exactly its generation", () => {
  const { directory, lock } = state();
  const lease = acquireBrokerProcessLock(lock)!;
  expect(lease.owner).toMatch(/^owner-[1-9][0-9]*-[a-f0-9]{32}-pipe$/u);
  expect(ownsBrokerProcessLock(lease)).toBe(true);
  expect(fs.readdirSync(lock)).toEqual([lease.owner]);
  expect(acquireBrokerProcessLock(lock)).toBeNull();
  expect(ownsBrokerProcessLock(lease)).toBe(true);
  expect(fs.readdirSync(directory)).toEqual(["broker.lock"]);
  releaseBrokerProcessLock(lease);
  expect(fs.readdirSync(directory)).toEqual([]);
});
test.each(["before-marker", "after-marker", "published"])("long-path %s crash leaves a full owner witness that a later actual process can safely reclaim", async mode => {
  const { directory, lock } = state();
  const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./fixtures/d0254-lockstage-crash.mjs", import.meta.url))], {
    windowsHide: true, stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, AGENT_GOVERNANCE_D254_LOCK_ROOT: directory, AGENT_GOVERNANCE_D254_LOCK_CRASH: mode },
  });
  let stderr = ""; child.stderr!.on("data", chunk => { stderr = (stderr + String(chunk)).slice(-4096); });
  const [status] = await once(child, "close");
  expect(status, stderr).toBe(mode === "before-marker" ? 42 : mode === "after-marker" ? 43 : 44);
  const names = fs.readdirSync(directory);
  expect(names).toHaveLength(1);
  if (mode === "published") expect(names).toEqual(["broker.lock"]);
  else {
    expect(names[0]).toMatch(new RegExp("^broker\\.lock\\.stage-owner-" + child.pid + "-[a-f0-9]{32}-pipe-[A-Za-z0-9]{6}$", "u"));
    const stage = path.join(directory, names[0]!);
    expect(fs.readdirSync(stage)).toHaveLength(mode === "before-marker" ? 0 : 1);
  }
  const lease = acquireBrokerProcessLock(lock)!;
  expect(ownsBrokerProcessLock(lease)).toBe(true);
  expect(fs.readdirSync(directory)).toEqual(["broker.lock"]);
  releaseBrokerProcessLock(lease);
  expect(fs.readdirSync(directory)).toEqual([]);
});
test("long-path publication failure retains its original error and removes only the owned stage and marker", async () => {
  const { directory, lock } = state();
  const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./fixtures/d0254-lockstage-crash.mjs", import.meta.url))], {
    windowsHide: true, stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, AGENT_GOVERNANCE_D254_LOCK_ROOT: directory, AGENT_GOVERNANCE_D254_LOCK_CRASH: "publish-failure" },
  });
  child.stderr!.resume();
  const [status] = await once(child, "close");
  expect(status).toBe(45);
  expect(fs.existsSync(lock)).toBe(false);
  expect(fs.readdirSync(directory)).toEqual([]);
});
test("unknown abandoned stages, unverified public state and live stage witnesses remain untouched on long paths", () => {
  const { directory, lock } = state();
  const lease = acquireBrokerProcessLock(lock)!;
  const unknown = path.join(directory, "broker.lock.stage-opaque"); fs.mkdirSync(unknown);
  const live = path.join(directory, "broker.lock.stage-" + lease.owner + "-ABC123"); fs.mkdirSync(live);
  expect(acquireBrokerProcessLock(lock)).toBeNull();
  expect(fs.readdirSync(live)).toEqual([]);
  releaseBrokerProcessLock(lease);
  fs.mkdirSync(lock); fs.mkdirSync(path.join(lock, "opaque-owner"));
  expect(() => acquireBrokerProcessLock(lock)).toThrow("UNRECOGNIZED_OWNER");
  expect(fs.readdirSync(lock)).toEqual(["opaque-owner"]);
  expect(fs.readdirSync(directory).sort()).toEqual(["broker.lock", path.basename(unknown), path.basename(live)].sort());
});
