import {mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {spawn} from "node:child_process";
import {once} from "node:events";
import {afterEach, expect, it, vi} from "vitest";

const fault = vi.hoisted(() => ({close: false}));
vi.mock("node:fs", async original => {
  const fs = await original<typeof import("node:fs")>();
  return {...fs, closeSync(fd: number) {
    fs.closeSync(fd);
    if (fault.close) throw new Error("synthetic close failure");
  }};
});
import {createRelaySpawnObservation, createRelayWakeObservation} from "../../mcp-server/src/relay-wake-observation.js";
import {transportWakePort} from "../../mcp-server/src/session-message-wake-port.js";

const roots: string[] = [];
function setup(transport = "codex-deferred") {
  const root = mkdtempSync(path.join(tmpdir(), "ags-relay-observation-"));
  roots.push(root);
  const environment = {AGENT_GOVERNANCE_LOG_CONFIG: JSON.stringify({level: "OFF", destination: "file",
    file: path.join(root, "owned"), categories: {transport: "DEBUG"}})};
  const port = transportWakePort(transport);
  const observation = createRelayWakeObservation(transport, port, environment)!;
  const files = () => readdirSync(root).filter(file => file.endsWith(".json"));
  const snapshot = () => JSON.parse(readFileSync(path.join(root, files()[0]!), "utf8"));
  return {root, environment, port, observation, files, snapshot};
}
afterEach(() => {
  fault.close = false;
  for (const root of roots.splice(0)) rmSync(root, {recursive: true, force: true});
});

it("is opt-in and rejects a substituted port or unregistered transport", () => {
  const {root, port, environment} = setup();
  expect(createRelayWakeObservation("codex-deferred", port, {})).toBeUndefined();
  expect(createRelayWakeObservation("codex-deferred", {...port}, environment)).toBeUndefined();
  expect(createRelayWakeObservation("secret-canary", port, environment)).toBeUndefined();
  expect(readdirSync(root)).toHaveLength(1);
});

it("publishes begin, the first none branch and end with cumulative counters in one generation", () => {
  const {observation, snapshot, root} = setup();
  observation.record("none-skip"); observation.record("none-skip"); observation.end(true);
  const result = snapshot();
  expect(result.events).toEqual([{seq: 1, event: "begin"}, {seq: 2, event: "none-skip"}, {seq: 3, event: "end"}]);
  expect(result).toMatchObject({pid: process.pid, idleWake: "none", ended: true, normalEnd: true,
    hostAcceptance: "UNKNOWN", sinkErrors: 0, droppedEvents: 0,
    counters: {noneSkips: 2, dispatchAttempts: 0, nativeLaunchAttempts: 0, nativeSpawns: 0}});
  expect(readdirSync(root)).toHaveLength(1);
});

it("never upgrades uninstrumented adapter launch counts to zero", () => {
  const {observation, snapshot} = setup("claude-inbox");
  observation.end(true);
  expect(snapshot().counters).toMatchObject({nativeLaunchAttempts: "UNKNOWN", nativeSpawns: "UNKNOWN"});
});

it("preserves sink failure after later publication recovers", () => {
  const {observation, snapshot, root, files} = setup();
  const temporary = path.join(root, files()[0]! + ".tmp");
  mkdirSync(temporary);
  observation.record("none-skip");
  expect(snapshot().events).toHaveLength(1);
  rmSync(temporary, {recursive: true});
  observation.end(true);
  expect(snapshot()).toMatchObject({ended: true, sinkErrors: 1, counters: {noneSkips: 1}});
});

it("does not publish end when closing its temporary snapshot fails", () => {
  const {observation, snapshot, root} = setup();
  fault.close = true;
  observation.end(true);
  expect(snapshot()).toMatchObject({ended: false, normalEnd: false});
  expect(snapshot().events).toEqual([{seq: 1, event: "begin"}]);
  expect(readdirSync(root).some(file => file.endsWith(".tmp"))).toBe(true);
});

it("caps event history without dropping actual attempt counts or erasing loss at end", () => {
  const {observation, snapshot} = setup("codex-queue");
  for (let index = 0; index < 80; index++) observation.record("dispatch-attempt");
  observation.end(true);
  const result = snapshot();
  expect(result.events).toHaveLength(32);
  expect(result.events.at(-1)).toEqual({seq: 32, event: "end"});
  expect(result).toMatchObject({droppedEvents: 50, ended: true, counters: {dispatchAttempts: 80}});
});

it("keeps an abnormal end distinct and admits no arbitrary event contents", () => {
  const {observation, snapshot} = setup();
  observation.record("secret-canary" as "none-skip");
  observation.end(false);
  expect(snapshot()).toMatchObject({ended: true, normalEnd: false, droppedEvents: 1});
  expect(JSON.stringify(snapshot())).not.toContain("secret-canary");
});

it("spawn 호출 직전에 관측을 시작하고 두 자식의 부모 관측을 구분한다", async () => {
  const {root, environment} = setup();
  const receipts = [];
  for (let index = 0; index < 2; index++) {
    const observation = createRelaySpawnObservation("codex-deferred", environment)!;
    const child = spawn(process.execPath, ["-e", "process.stdin.resume()"], {windowsHide: true, stdio: ["pipe", "ignore", "ignore"]});
    const closed = once(child, "close");
    try {
      observation.returned(child.pid);
      await once(child, "spawn"); observation.spawned();
      const files = readdirSync(root).filter(file => file.includes("-relay-spawn-") && file.endsWith(".json"));
      const receipt = files.map(file => JSON.parse(readFileSync(path.join(root, file), "utf8")))
        .find(value => value.childPid === child.pid);
      expect(receipt).toMatchObject({kind: "relay-spawn-observation", writerPid: process.pid,
        childPid: child.pid, sinkErrors: 0, droppedEvents: 0});
      expect(receipt.events.map((value: {event: string}) => value.event)).toEqual(["begin", "returned", "spawn"]);
      if (process.platform === "linux") expect(receipt.childProcessStart).toMatch(/^\d+$/);
      receipts.push(receipt);
    } finally {child.stdin.end(); await closed;}
  }
  expect(receipts[0].generation).not.toBe(receipts[1].generation);
});

it("does not infer a child or successful creation from a failed launch expectation", () => {
  const {root, environment} = setup();
  const observation = createRelaySpawnObservation("codex-deferred", environment)!;
  observation.returned(); observation.failed();
  const file = readdirSync(root).find(value => value.includes("-relay-spawn-") && value.endsWith(".json"))!;
  const receipt = JSON.parse(readFileSync(path.join(root, file), "utf8"));
  expect(receipt).toMatchObject({childPid: "UNKNOWN", childProcessStart: "UNKNOWN"});
  expect(receipt.events.map((value: {event: string}) => value.event)).toEqual(["begin", "returned", "error"]);
});

it("keeps a late error together with the successful spawn observation", () => {
  const {root, environment} = setup();
  const observation = createRelaySpawnObservation("codex-deferred", environment)!;
  observation.spawned(); observation.failed();
  const file = readdirSync(root).find(value => value.includes("-relay-spawn-") && value.endsWith(".json"))!;
  const receipt = JSON.parse(readFileSync(path.join(root, file), "utf8"));
  expect(receipt.events.map((value: {event: string}) => value.event)).toEqual(["begin", "spawn", "error"]);
  expect(receipt.childPid).toBe("UNKNOWN");
});

it("부모 진단 게시 실패가 호출자를 막지 않으며 복구 뒤에도 손실을 보존한다", () => {
  const {root, environment} = setup();
  expect(createRelaySpawnObservation("codex-deferred", {})).toBeUndefined();
  expect(createRelaySpawnObservation("unregistered", environment)).toBeUndefined();
  fault.close = true;
  const observation = createRelaySpawnObservation("codex-deferred", environment)!;
  expect(() => observation.returned()).not.toThrow();
  expect(() => observation.failed()).not.toThrow();
  fault.close = false;
  observation.spawned();
  const file = readdirSync(root).find(value => value.includes("-relay-spawn-") && value.endsWith(".json"))!;
  const receipt = JSON.parse(readFileSync(path.join(root, file), "utf8"));
  expect(receipt).toMatchObject({childPid: "UNKNOWN", childProcessStart: "UNKNOWN", sinkErrors: 3});
  expect(receipt.events.map((value: {event: string}) => value.event)).toEqual(["begin", "returned", "error", "spawn"]);
});

it("예산 경로 관측은 flush 전까지 파일을 쓰지 않고 신원 조회 없이 한 번 게시한다", () => {
  const {root, environment} = setup();
  const before = readdirSync(root).length;
  expect(createRelaySpawnObservation("codex-deferred", {}, true)).toBeUndefined();
  const observation = createRelaySpawnObservation("codex-deferred", environment, true)!;
  observation.returned(4242); observation.spawned(); observation.failed();
  expect(readdirSync(root)).toHaveLength(before);
  observation.flush();
  const file = readdirSync(root).find(value => value.includes("-relay-spawn-") && value.endsWith(".json"))!;
  const receipt = JSON.parse(readFileSync(path.join(root, file), "utf8"));
  expect(receipt).toMatchObject({writerPid: process.pid, writerProcessStart: "UNKNOWN", childPid: 4242,
    childProcessStart: "UNKNOWN", sinkErrors: 0, droppedEvents: 0});
  // 부모·자식 대조는 childPid와 [startedAt, publishedAt] 시간창으로 한다.
  expect(Date.parse(receipt.publishedAt)).toBeGreaterThanOrEqual(Date.parse(receipt.startedAt));
  expect(receipt.events.map((value: {event: string}) => value.event)).toEqual(["begin", "returned", "spawn", "error"]);
});

it.each([true, false])("소유 디렉터리를 확인하지 못한 관측은 게시하지 않고 실패를 한 번 보고한다: 지연=%s", deferred => {
  const {root} = setup();
  const environment = {AGENT_GOVERNANCE_LOG_CONFIG: JSON.stringify({level: "OFF", destination: "file",
    file: path.join(root, "missing", "owned"), categories: {transport: "DEBUG"}})};
  const failures: unknown[] = [];
  const observation = createRelaySpawnObservation("codex-deferred", environment, deferred, error => failures.push(error));
  if (deferred) {
    observation!.returned(4242);
    expect(failures).toHaveLength(0);
    expect(() => observation!.flush()).not.toThrow();
  } else expect(observation).toBeUndefined();
  expect(failures).toEqual([expect.objectContaining({code: "ENOENT"})]);
  expect(readdirSync(root).some(value => value.includes("-relay-spawn-"))).toBe(false);
});

it("관측 꺼짐(설정 없음·미설치 transport)은 실패로 보고하지 않고 잘못된 설정은 보고한다", () => {
  const {environment} = setup();
  const failures: unknown[] = [];
  for (const deferred of [false, true]) {
    expect(createRelaySpawnObservation("codex-deferred", {}, deferred, error => failures.push(error))).toBeUndefined();
    expect(createRelaySpawnObservation("unregistered", environment, deferred, error => failures.push(error))).toBeUndefined();
  }
  expect(failures).toHaveLength(0);
  expect(createRelaySpawnObservation("codex-deferred", {AGENT_GOVERNANCE_LOG_CONFIG: "{"}, true,
    error => failures.push(error))).toBeUndefined();
  expect(failures).toHaveLength(1);
});

it.each([true, false])("소유 디렉터리가 아니거나 게시가 실패하면 침묵하지 않고 보고한다: 지연=%s", deferred => {
  const {root, environment} = setup();
  writeFileSync(path.join(root, "plain"), "");
  const notOwned = {AGENT_GOVERNANCE_LOG_CONFIG: JSON.stringify({level: "OFF", destination: "file",
    file: path.join(root, "plain", "owned"), categories: {transport: "DEBUG"}})};
  const failures: unknown[] = [];
  const rejected = createRelaySpawnObservation("codex-deferred", notOwned, deferred, error => failures.push(error));
  rejected?.flush();
  expect(failures).toEqual([expect.objectContaining({message: "DIAGNOSTIC_DIRECTORY_NOT_OWNED"})]);
  failures.length = 0;
  const observation = createRelaySpawnObservation("codex-deferred", environment, deferred, error => failures.push(error))!;
  fault.close = true;
  observation.returned(4242);
  observation.flush();
  expect(failures).toHaveLength(1);
  expect(readdirSync(root).some(value => value.includes("-relay-spawn-") && value.endsWith(".json"))).toBe(!deferred);
});
