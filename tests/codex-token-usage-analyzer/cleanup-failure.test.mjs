import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const fault = vi.hoisted(() => ({ active: false }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal();
  const failure = (code) => Object.assign(new Error(`${code}: secret-path-detail`), { code });
  return {
    ...actual,
    open: async (...args) => {
      const handle = await actual.open(...args);
      if (!fault.active || args[1] !== "wx") return handle;
      return {
        writeFile: async () => { throw failure("ENOSPC"); },
        close: () => handle.close()
      };
    },
    rm: async (...args) => {
      if (fault.active) throw failure("EACCES");
      return actual.rm(...args);
    }
  };
});

const { analyzeRequest, writeNewMarkdown } = await import("../../skills/codex-token-usage-analyzer/scripts/core.mjs");

const threadId = "11111111-1111-1111-1111-111111111111";
const temporaryDirectories = [];

afterEach(async () => {
  fault.active = false;
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("codex-token-usage-analyzer Markdown write failure", () => {
  it("keeps the original write error when cleanup also fails", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "suite-token-cleanup-"));
    temporaryDirectories.push(directory);
    const sessionsRoot = path.join(directory, "sessions");
    const pluginRoot = path.join(directory, "plugin");
    await mkdir(sessionsRoot);
    await mkdir(pluginRoot);
    const usage = { input_tokens: 10, cached_input_tokens: 3, cache_write_input_tokens: 0, output_tokens: 2, reasoning_output_tokens: 1, total_tokens: 12 };
    const rows = [
      { type: "session_meta", payload: { id: threadId, title: "정리 실패", cwd: "D:\\work\\suite" } },
      { timestamp: "2026-01-01T00:00:00Z", type: "turn_context", payload: { turn_id: "turn-1", model: "test-model", effort: "high" } },
      { timestamp: "2026-01-01T00:00:01Z", type: "token_usage_record", payload: { thread_id: threadId, turn_id: "turn-1", response_id: "response-1", usage, turn_token_usage: usage, thread_token_usage: usage } }
    ];
    await writeFile(path.join(sessionsRoot, "session.jsonl"), `${rows.map(JSON.stringify).join("\n")}\n`, "utf8");
    const locations = { root: directory, sessionsRoot, indexFile: path.join(directory, "missing") };
    const report = await analyzeRequest({ schemaVersion: "1.0.0", target: threadId }, { locations });

    fault.active = true;
    const error = await writeNewMarkdown(report, path.join(directory, "out"), { sessionsRoot, pluginRoot, stamp: "20260101000000000" }).catch((caught) => caught);

    expect(error.code).toBe("ENOSPC");
    expect(error.secondaryDiagnostics).toEqual([{ step: "cleanup-rm", code: "EACCES" }]);
    expect(JSON.stringify(error.secondaryDiagnostics)).not.toContain("secret-path-detail");
  });
});
