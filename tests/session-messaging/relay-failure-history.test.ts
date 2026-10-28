import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { persistRelayFailure } from "../../mcp-server/src/session-message-wake-port.js";

let root: string;
let state: string;
const history = () => path.join(state, "relay-failures");
const records = () => fs.readdirSync(history()).map(name => JSON.parse(fs.readFileSync(path.join(history(), name), "utf8")) as Record<string, unknown>);
const persist = (phase: string, reason: string, detail?: string) => persistRelayFailure(JSON.stringify({ phase, reason, ...(detail ? { detail } : {}) }), {
  AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR: state,
});

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ags-relay-failure-history-"));
  state = path.join(root, "state");
});
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });

describe("D0349 bounded relay failure history", () => {
  it("keeps wake failures after repeated tick failures while preserving latest-file compatibility", () => {
    persist("gemini-preflight", "GEMINI_PROJECT_ID_MISSING");
    for (let index = 0; index < 100; index++) persist("tick", "BROKER_DEADLINE_EXPIRED", `attempt-${index}`);
    expect(records()).toHaveLength(2);
    expect(records()).toContainEqual({ phase: "gemini-preflight", reason: "GEMINI_PROJECT_ID_MISSING" });
    expect(records()).toContainEqual({ phase: "tick", reason: "BROKER_DEADLINE_EXPIRED", detail: "attempt-99" });
    expect(JSON.parse(fs.readFileSync(path.join(state, "relay-failure.latest.json"), "utf8"))).toEqual({
      phase: "tick", reason: "BROKER_DEADLINE_EXPIRED", detail: "attempt-99",
    });
  });

  it("keeps the same failure kind from separate writer processes", () => {
    const moduleUrl = pathToFileURL(path.resolve("mcp-server/src/session-message-wake-port.ts")).href;
    for (const detail of ["first-writer", "second-writer"]) {
      const source = `import { persistRelayFailure } from ${JSON.stringify(moduleUrl)}; persistRelayFailure(${JSON.stringify(JSON.stringify({ phase: "tick", reason: "BROKER_DEADLINE_EXPIRED", detail }))}, ${JSON.stringify({ AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR: state })});`;
      execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], { windowsHide: true, timeout: 15_000, stdio: "pipe" });
    }
    expect(records().map(record => record.detail).sort()).toEqual(["first-writer", "second-writer"]);
  }, 35_000);

  it("keeps another kind's last cause across many newer relay writer generations", () => {
    persist("gemini-preflight", "GEMINI_PROJECT_ID_MISSING");
    persist("tick", "BROKER_DEADLINE_EXPIRED");
    const tick = fs.readdirSync(history()).find(name =>
      JSON.parse(fs.readFileSync(path.join(history(), name), "utf8")).phase === "tick")!;
    // Seed valid observations from newer writers without launching 65 unnecessary processes.
    for (let index = 0; index < 65; index++) {
      const writer = `${Date.now() + index}-${index + 1}-${randomUUID()}`;
      fs.writeFileSync(path.join(history(), writer + tick.slice(-22)), JSON.stringify({
        phase: "tick", reason: "BROKER_DEADLINE_EXPIRED", detail: `writer-${index}`,
      }));
    }
    persist("tick", "BROKER_DEADLINE_EXPIRED");
    expect(records()).toContainEqual({ phase: "gemini-preflight", reason: "GEMINI_PROJECT_ID_MISSING" });
    expect(records().filter(record => record.phase === "tick")).toHaveLength(4);
    expect(records()).toHaveLength(5);
  });

  it("bounds the settled record count and refuses oversized records", () => {
    for (let index = 0; index < 80; index++) persist("tick", `OWNED_REASON_${index}`);
    const before = fs.readdirSync(history());
    expect(before).toHaveLength(64);
    for (const name of before) expect(fs.statSync(path.join(history(), name)).size).toBeLessThanOrEqual(64 * 1024 + 1);
    persistRelayFailure("x".repeat(64 * 1024 + 1), { AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR: state });
    expect(fs.readdirSync(history())).toEqual(before);
  });

  it("does not follow a redirected history directory or overwrite a hard-linked history file", () => {
    fs.mkdirSync(state);
    const victimDirectory = path.join(root, "other");
    fs.mkdirSync(victimDirectory);
    fs.symlinkSync(victimDirectory, history(), process.platform === "win32" ? "junction" : "dir");
    persist("tick", "OWNED_HISTORY_FAILURE");
    expect(fs.readdirSync(victimDirectory)).toEqual([]);
    fs.rmSync(history());
    persist("tick", "OWNED_HISTORY_FAILURE");
    const target = path.join(history(), fs.readdirSync(history())[0]!);
    const victim = path.join(root, "victim");
    fs.writeFileSync(victim, "PRIVATE_UNCHANGED", "utf8");
    fs.unlinkSync(target);
    fs.linkSync(victim, target);
    persist("tick", "OWNED_HISTORY_FAILURE");
    expect(fs.readFileSync(victim, "utf8")).toBe("PRIVATE_UNCHANGED");
  });

  it("reports a bounded history I/O error while still writing the latest diagnostic", () => {
    const observe = vi.spyOn(console, "error").mockImplementation(() => {});
    fs.mkdirSync(state);
    fs.writeFileSync(history(), "PRIVATE_HISTORY_SINK", "utf8");
    expect(() => persist("tick", "OWNED_HISTORY_FAILURE")).not.toThrow();
    expect(observe).toHaveBeenCalledOnce();
    expect(JSON.stringify(observe.mock.calls)).not.toContain("PRIVATE_HISTORY_SINK");
    expect(JSON.parse(fs.readFileSync(path.join(state, "relay-failure.latest.json"), "utf8"))).toEqual({ phase: "tick", reason: "OWNED_HISTORY_FAILURE" });
  });
});
