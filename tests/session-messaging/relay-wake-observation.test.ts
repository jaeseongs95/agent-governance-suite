import {mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {afterEach, expect, it, vi} from "vitest";

const fault = vi.hoisted(() => ({close: false}));
vi.mock("node:fs", async original => {
  const fs = await original<typeof import("node:fs")>();
  return {...fs, closeSync(fd: number) {
    fs.closeSync(fd);
    if (fault.close) throw new Error("synthetic close failure");
  }};
});
import {createRelayWakeObservation} from "../../mcp-server/src/relay-wake-observation.js";
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
