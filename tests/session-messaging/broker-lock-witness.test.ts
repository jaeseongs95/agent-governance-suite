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
