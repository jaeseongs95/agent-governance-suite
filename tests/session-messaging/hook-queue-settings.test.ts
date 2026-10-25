import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import "../../mcp-server/src/builtin-hook-host-adapters.js";
import {hookFailureReason} from "../../mcp-server/src/hook-error-diagnostics.js";
import { hostDeliveryProfile } from "../../mcp-server/src/host-input-adapter.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

for (const { host, key, enabled } of [
  { host: "codex", key: "AGENT_GOVERNANCE_CODEX_QUEUE_WAKE", enabled: "codex-queue" },
  { host: "gemini", key: "AGENT_GOVERNANCE_GEMINI_QUEUE_WAKE", enabled: "gemini-queue" },
]) describe("L4 bounded queue settings: " + host, () => {
  async function fixture() {
    const directory = await mkdtemp(path.join(tmpdir(), "ags-queue-reader-"));
    directories.push(directory);
    const file = path.join(directory, "session-messaging.json");
    const environment: NodeJS.ProcessEnv = { PLUGIN_DATA: directory };
    return { directory, file, environment };
  }

  it("keeps explicit overrides ahead of malformed settings and rejects invalid overrides", async () => {
    const f = await fixture();
    await writeFile(f.file, "private-malformed-settings-marker", "utf8");
    const diagnose = vi.fn();
    expect(hostDeliveryProfile(host, { ...f.environment, [key]: "1" }, diagnose).transport).toBe(enabled);
    expect(hostDeliveryProfile(host, { ...f.environment, [key]: "0" }, diagnose).transport).toBe("codex-deferred");
    expect(diagnose).not.toHaveBeenCalled();
    expect(hostDeliveryProfile(host, { ...f.environment, [key]: "true" }, diagnose).transport).toBe("codex-deferred");
    expect(diagnose).toHaveBeenCalledExactlyOnceWith("invalid-environment");
  });

  it("reads only the selected host boolean without mutating the environment", async () => {
    const f = await fixture();
    const diagnose = vi.fn();
    for (const queueWake of [true, false]) {
      await writeFile(f.file, JSON.stringify({ schemaVersion: "1.0.0", [host]: { queueWake },
        [host === "codex" ? "gemini" : "codex"]: { queueWake: !queueWake } }), "utf8");
      expect(hostDeliveryProfile(host, f.environment, diagnose).transport).toBe(queueWake ? enabled : "codex-deferred");
    }
    expect(diagnose).not.toHaveBeenCalled();
    expect(f.environment).toEqual({ PLUGIN_DATA: f.directory });
  });

  it("treats absence as deferred and malformed or non-boolean settings as bounded failures", async () => {
    const f = await fixture();
    const diagnose = vi.fn();
    expect(hostDeliveryProfile(host, {}, diagnose).transport).toBe("codex-deferred");
    expect(hostDeliveryProfile(host, f.environment, diagnose).transport).toBe("codex-deferred");
    expect(diagnose).not.toHaveBeenCalled();
    for (const content of ["{", "[]", "null", Buffer.from([0xff]),
      JSON.stringify({ schemaVersion: "2.0.0", [host]: { queueWake: true } }),
      JSON.stringify({ schemaVersion: "1.0.0", [host]: { queueWake: "true" } })]) {
      diagnose.mockClear();
      await writeFile(f.file, content);
      expect(hostDeliveryProfile(host, f.environment, diagnose).transport).toBe("codex-deferred");
      expect(diagnose).toHaveBeenCalledExactlyOnceWith("invalid-settings");
    }
  });

  it("keeps the byte limit inclusive and does not expose settings contents in diagnostics", async () => {
    const f = await fixture();
    const diagnose = vi.fn();
    const content = JSON.stringify({ schemaVersion: "1.0.0", [host]: { queueWake: true } });
    await writeFile(f.file, content.padEnd(4096), "utf8");
    expect(hostDeliveryProfile(host, f.environment, diagnose).transport).toBe(enabled);
    expect(diagnose).not.toHaveBeenCalled();
    await writeFile(f.file, content.padEnd(4097), "utf8");
    expect(hostDeliveryProfile(host, f.environment, diagnose).transport).toBe("codex-deferred");
    expect(diagnose).toHaveBeenCalledExactlyOnceWith("too-large");
    diagnose.mockClear();
    await writeFile(f.file, JSON.stringify({ schemaVersion: "1.0.0", [host]: { queueWake: true }, private: "가".repeat(1400) }), "utf8");
    expect(hostDeliveryProfile(host, f.environment, diagnose).transport).toBe("codex-deferred");
    expect(diagnose).toHaveBeenCalledExactlyOnceWith("too-large");
  });

  it("rejects relative directories, non-file settings and read failures", async () => {
    const f = await fixture();
    const diagnose = vi.fn();
    expect(hostDeliveryProfile(host, { PLUGIN_DATA: "relative" }, diagnose).transport).toBe("codex-deferred");
    expect(diagnose).toHaveBeenCalledExactlyOnceWith("invalid-plugin-data");
    diagnose.mockClear();
    await mkdir(f.file);
    expect(hostDeliveryProfile(host, f.environment, diagnose).transport).toBe("codex-deferred");
    expect(diagnose).toHaveBeenCalledTimes(1);
    expect(["invalid-file-type", "read-failed"]).toContain(diagnose.mock.calls[0]![0]);
    diagnose.mockClear();
    expect(hostDeliveryProfile(host, { PLUGIN_DATA: f.directory + "\0" }, diagnose).transport).toBe("codex-deferred");
    expect(diagnose).toHaveBeenCalledTimes(1);
    expect(diagnose.mock.calls[0]![0]).toBe("read-failed");
    expect(diagnose.mock.calls[0]![1]).toMatchObject({phase: "directory-stat", cleanup: "not-acquired"});
    expect(hookFailureReason(diagnose.mock.calls[0]![1].failure)).toBe("QUEUE_SETTINGS_DIRECTORY_STAT_FAILED");
  });
});
