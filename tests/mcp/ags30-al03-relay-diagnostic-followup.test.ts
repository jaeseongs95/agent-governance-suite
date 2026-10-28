import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, writeFileSync: vi.fn(actual.writeFileSync), closeSync: vi.fn(actual.closeSync) };
});

import { failureContext, producerFailure, retainFailureSecondary } from "../../mcp-server/src/failure-diagnostics.js";
import { reportRelayFailure } from "../../mcp-server/src/session-message-relay.js";

const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
let root: string;
let directory: string;
const latest = () => path.join(directory, "relay-failure.latest.json");

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ags-al03-relay-diagnostic-"));
  directory = path.join(root, "state");
  vi.stubEnv("AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR", directory);
  vi.mocked(fs.writeFileSync).mockReset().mockImplementation(actualFs.writeFileSync);
  vi.mocked(fs.closeSync).mockReset().mockImplementation(actualFs.closeSync);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("AL03 D0011 detached relay diagnostics", () => {
  it("retains safe reason and secondary context even when the ignored stderr observer throws", () => {
    const primary = producerFailure("RELAY_FIXTURE_FAILURE", "PRIVATE_BODY /private/path RAW_TOKEN");
    retainFailureSecondary(primary, Object.assign(new Error("PRIVATE_SECONDARY"), { code: "RAW_TOKEN" }));
    const before = failureContext(primary);
    vi.mocked(console.error).mockImplementation(() => { throw new Error("broken stderr"); });

    expect(() => reportRelayFailure("tick", primary)).not.toThrow();
    const serialized = fs.readFileSync(latest(), "utf8");
    expect(JSON.parse(serialized)).toEqual({ phase: "tick", reason: "RELAY_FIXTURE_FAILURE", context: before });
    for (const secret of ["PRIVATE_BODY", "/private/path", "RAW_TOKEN", "PRIVATE_SECONDARY"]) {
      expect(serialized).not.toContain(secret);
    }
    expect(failureContext(primary)).toEqual(before);
    expect(fs.readdirSync(directory).sort()).toEqual(["relay-failure.latest.json", "relay-failures"]);
  });

  it("overwrites one bounded latest observation across every existing failure phase", () => {
    fs.mkdirSync(directory);
    actualFs.writeFileSync(latest(), "x".repeat(128 * 1024));
    for (const phase of ["acquire", "tick", "release", "run"] as const) {
      reportRelayFailure(phase, producerFailure("RELAY_FIXTURE_FAILURE", "PRIVATE_BODY"));
      expect(JSON.parse(fs.readFileSync(latest(), "utf8")).phase).toBe(phase);
      expect(fs.statSync(latest()).size).toBeLessThanOrEqual(64 * 1024 + 1);
    }
    expect(fs.readdirSync(directory).sort()).toEqual(["relay-failure.latest.json", "relay-failures"]);
    if (process.platform !== "win32") {
      expect(fs.statSync(directory).mode & 0o777).toBe(0o700);
      expect(fs.statSync(latest()).mode & 0o777).toBe(0o600);
    }
  });

  it("keeps the existing stderr diagnostic and closes the fd after a sink write failure", () => {
    const primary = producerFailure("PRIMARY_RELAY_FAILURE", "PRIVATE_PRIMARY");
    retainFailureSecondary(primary, new Error("PRIVATE_SECONDARY"));
    const before = failureContext(primary);
    vi.mocked(fs.writeFileSync).mockImplementationOnce(() => { throw new Error("sink failure"); });

    expect(() => reportRelayFailure("release", primary)).not.toThrow();
    const [descriptor] = vi.mocked(fs.closeSync).mock.calls.at(-1)!;
    expect(() => fs.fstatSync(descriptor)).toThrow();
    expect(console.error).toHaveBeenCalledWith("[agent-governance-suite] relay-failure "
      + JSON.stringify({ phase: "release", reason: "PRIMARY_RELAY_FAILURE", context: before }));
    expect(failureContext(primary)).toEqual(before);
  });

  it("absorbs a close failure without changing the primary diagnostic", () => {
    vi.mocked(fs.closeSync).mockImplementationOnce((descriptor) => {
      actualFs.closeSync(descriptor);
      throw new Error("close failure");
    });
    expect(() => reportRelayFailure("run", producerFailure("PRIMARY_RELAY_FAILURE", "PRIVATE_PRIMARY"))).not.toThrow();
    expect(JSON.parse(fs.readFileSync(latest(), "utf8")).reason).toBe("PRIMARY_RELAY_FAILURE");
    expect(console.error).toHaveBeenCalledOnce();
  });

  it("rejects a hard-linked destination without modifying its other name", () => {
    fs.mkdirSync(directory);
    const victim = path.join(root, "victim");
    actualFs.writeFileSync(victim, "PRIVATE_UNCHANGED");
    fs.linkSync(victim, latest());
    expect(() => reportRelayFailure("tick", new Error("PRIVATE_BODY"))).not.toThrow();
    expect(fs.readFileSync(victim, "utf8")).toBe("PRIVATE_UNCHANGED");
    expect(console.error).toHaveBeenCalledOnce();
  });

  it("rejects a directory destination and a redirected state root", () => {
    fs.mkdirSync(latest(), { recursive: true });
    expect(() => reportRelayFailure("tick", new Error("PRIVATE_BODY"))).not.toThrow();
    expect(fs.statSync(latest()).isDirectory()).toBe(true);
    fs.rmSync(directory, { recursive: true });
    const other = path.join(root, "other");
    fs.mkdirSync(other);
    fs.symlinkSync(other, directory, process.platform === "win32" ? "junction" : "dir");
    expect(() => reportRelayFailure("acquire", new Error("PRIVATE_BODY"))).not.toThrow();
    expect(fs.readdirSync(other)).toEqual([]);
  });

  it.skipIf(process.platform === "win32")("rejects a symlink destination without following it", () => {
    fs.mkdirSync(directory);
    const victim = path.join(root, "victim");
    actualFs.writeFileSync(victim, "PRIVATE_UNCHANGED");
    fs.symlinkSync(victim, latest());
    expect(() => reportRelayFailure("tick", new Error("PRIVATE_BODY"))).not.toThrow();
    expect(fs.readFileSync(victim, "utf8")).toBe("PRIVATE_UNCHANGED");
  });
});
