import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import * as fs from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { createLockWitness, lockWitnessState } from "../../mcp-server/src/broker-lock-witness.js";
import { acquireBrokerProcessLock, ownsBrokerProcessLock, releaseBrokerProcessLock } from "../../mcp-server/src/broker-process-lock.js";

// 실제 Windows named pipe 성질을 CI Windows job에서 확인한다(합성 목 없음).
const test = it.runIf(process.platform === "win32");
const owned: string[] = [];
afterEach(() => { for (const root of owned.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const generation = () => randomBytes(16).toString("hex");

test("바인드는 listen 호출 안에서 동기로 끝나고 같은 세대 이름은 두 번 만들 수 없다", () => {
  const name = generation();
  expect(lockWitnessState(name)).toBe("absent");
  const first = createLockWitness(name)!;
  try {
    expect(first.listening).toBe(true);
    expect(lockWitnessState(name)).toBe("present");
    expect(createLockWitness(name)).toBeNull();
  } finally { first.close(); }
  expect(lockWitnessState(name)).toBe("absent");
});

test("연결이 몰려 인스턴스가 모두 사용 중이어도 존재로 판정하고 증인을 유지한다", async () => {
  const name = generation();
  const witness = createLockWitness(name)!;
  try {
    const states = Array.from({ length: 64 }, () => lockWitnessState(name));
    expect(states.every(state => state === "present")).toBe(true);
    const sockets = Array.from({ length: 32 }, () => net.connect("\\\\.\\pipe\\agent-governance-broker-lock-" + name).on("error", () => undefined));
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(lockWitnessState(name)).toBe("present");
    expect(witness.listening).toBe(true);
    for (const socket of sockets) socket.destroy();
  } finally { witness.close(); }
});

test("소유 프로세스가 강제 종료되면 세대 pipe가 사라진다", async () => {
  const name = generation();
  const holder = "const w = await import(process.argv[1]); w.createLockWitness(process.argv[2]); process.stdout.write('ready'); setInterval(() => {}, 1000);";
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", holder,
    new URL("../../mcp-server/src/broker-lock-witness.ts", import.meta.url).href, name], { stdio: ["ignore", "pipe", "inherit"], windowsHide: true });
  await once(child.stdout!, "data");
  expect(lockWitnessState(name)).toBe("present");
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
  const started = performance.now();
  while (lockWitnessState(name) === "present" && performance.now() - started < 5000) await new Promise(resolve => setTimeout(resolve, 10));
  expect(lockWitnessState(name)).toBe("absent");
});

test("실제 잠금은 pipe marker로 게시되고, 살아 있는 PID의 죽은 세대는 회수하며 살아 있는 세대는 보존한다", () => {
  const root = fs.mkdtempSync(path.join(tmpdir(), "ags-witness-")); owned.push(root);
  const lock = path.join(root, "broker.lock");
  const lease = acquireBrokerProcessLock(lock)!;
  expect(lease.owner).toMatch(new RegExp(`^owner-${process.pid}-[a-f0-9]{32}-pipe$`, "u"));
  expect(lockWitnessState(lease.owner.split("-")[2]!)).toBe("present");
  expect(acquireBrokerProcessLock(lock)).toBeNull();
  releaseBrokerProcessLock(lease);
  expect(lockWitnessState(lease.owner.split("-")[2]!)).toBe("absent");
  // PID 재사용 모사: 살아 있는 이 PID로 남은, 증인이 없는 세대는 회수된다.
  const stale = `owner-${process.pid}-${generation()}-pipe`;
  fs.mkdirSync(path.join(lock, stale), { recursive: true });
  const next = acquireBrokerProcessLock(lock)!;
  expect(ownsBrokerProcessLock(next)).toBe(true);
  expect(fs.readdirSync(lock)).toEqual([next.owner]);
  releaseBrokerProcessLock(next);
});

const lockModule = new URL("../../mcp-server/src/broker-process-lock.ts", import.meta.url).href;
const runChild = (code: string, args: string[]) => spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code, lockModule, ...args],
  { stdio: ["ignore", "pipe", "inherit"], windowsHide: true });

test("여러 프로세스가 반복 경합해도 동시에 두 소유자가 생기지 않는다", async () => {
  const root = fs.mkdtempSync(path.join(tmpdir(), "ags-witness-mutex-")); owned.push(root);
  const code = `const m = await import(process.argv[1]); const fs = await import("node:fs"); const path = await import("node:path");
    const lock = path.join(process.argv[2], "broker.lock"), inside = path.join(process.argv[2], "inside");
    let held = 0, overlaps = 0;
    for (let i = 0; i < 40; i++) { let lease = null; try { lease = m.acquireBrokerProcessLock(lock); } catch {}
      if (!lease) continue; held++;
      try { fs.mkdirSync(inside); } catch { overlaps++; continue; }
      fs.rmdirSync(inside); m.releaseBrokerProcessLock(lease); }
    process.stdout.write(JSON.stringify({ held, overlaps }));`;
  const children = Array.from({ length: 6 }, () => runChild(code, [root]));
  const results = await Promise.all(children.map(async child => {
    let out = ""; child.stdout!.on("data", chunk => { out += String(chunk); });
    const [status] = await once(child, "close");
    return { status, ...JSON.parse(out) as { held: number; overlaps: number } };
  }));
  expect(results.every(result => result.status === 0)).toBe(true);
  expect(results.reduce((sum, result) => sum + result.overlaps, 0)).toBe(0);
  expect(results.reduce((sum, result) => sum + result.held, 0)).toBeGreaterThan(0);
}, 120_000);

test("소유자가 강제 종료되면 다음 획득이 사람 개입 없이 바로 성공한다", async () => {
  const root = fs.mkdtempSync(path.join(tmpdir(), "ags-witness-crash-")); owned.push(root);
  const lock = path.join(root, "broker.lock");
  const code = "const m = await import(process.argv[1]); const l = m.acquireBrokerProcessLock(process.argv[2]); process.stdout.write(l ? 'held' : 'none'); setInterval(() => {}, 1000);";
  const child = runChild(code, [lock]);
  const [first] = await once(child.stdout!, "data");
  expect(String(first)).toBe("held");
  expect(acquireBrokerProcessLock(lock)).toBeNull();
  const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
  const started = performance.now();
  let lease = null;
  while (!lease && performance.now() - started < 5000) {
    lease = acquireBrokerProcessLock(lock);
    if (!lease) await new Promise(resolve => setTimeout(resolve, 10));
  }
  expect(lease).not.toBeNull();
  releaseBrokerProcessLock(lease!);
}, 60_000);

test("무관한 pipe가 대량으로 생성·삭제되는 중에도 살아 있는 세대를 부재로 보지 않는다", async () => {
  const name = generation();
  const witness = createLockWitness(name)!;
  try {
    let absent = 0;
    for (let round = 0; round < 20; round++) {
      const churn = Array.from({ length: 50 }, () => createLockWitness(generation())).filter(Boolean);
      for (let i = 0; i < 200; i++) if (lockWitnessState(name) === "absent") absent++;
      for (const server of churn) server!.close();
      await new Promise(resolve => setImmediate(resolve));
    }
    expect(absent).toBe(0);
  } finally { witness.close(); }
}, 60_000);
