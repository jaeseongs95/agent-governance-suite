import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const fault = vi.hoisted(() => ({
  active: false,
  closeCode: null,
  rmCode: "EACCES",
  freezePrimary: false,
  priorDiagnostics: null,
  lastPrimaryError: null
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal();
  const failure = (code) => Object.assign(new Error(`${code}: secret-path-detail`), { code });
  return {
    ...actual,
    open: async (...args) => {
      const handle = await actual.open(...args);
      if (!fault.active || args[1] !== "wx") return handle;
      return {
        writeFile: async () => {
          const primary = failure("ENOSPC");
          if (Array.isArray(fault.priorDiagnostics)) {
            Object.defineProperty(primary, "secondaryDiagnostics", {
              value: [...fault.priorDiagnostics],
              enumerable: false,
              configurable: true
            });
          }
          fault.lastPrimaryError = fault.freezePrimary ? Object.freeze(primary) : primary;
          throw fault.lastPrimaryError;
        },
        close: async () => {
          await handle.close();
          if (fault.closeCode) throw failure(fault.closeCode);
        }
      };
    },
    rm: async (...args) => {
      if (fault.active && fault.rmCode) throw failure(fault.rmCode);
      return actual.rm(...args);
    }
  };
});

const { analyzeRequest, writeNewMarkdown } = await import("../../skills/codex-token-usage-analyzer/scripts/core.mjs");

const threadId = "11111111-1111-1111-1111-111111111111";
const temporaryDirectories = [];

afterEach(async () => {
  fault.active = false;
  fault.closeCode = null;
  fault.rmCode = "EACCES";
  fault.freezePrimary = false;
  fault.priorDiagnostics = null;
  fault.lastPrimaryError = null;
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createSampleReport() {
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
  return { directory, sessionsRoot, pluginRoot, report };
}

describe("codex-token-usage-analyzer Markdown write failure", () => {
  it("keeps the original write error when cleanup also fails", async () => {
    const { directory, sessionsRoot, pluginRoot, report } = await createSampleReport();

    fault.active = true;
    const error = await writeNewMarkdown(report, path.join(directory, "out"), { sessionsRoot, pluginRoot, stamp: "20260101000000000" }).catch((caught) => caught);

    expect(error).toBe(fault.lastPrimaryError);
    expect(error.code).toBe("ENOSPC");
    expect(error.secondaryDiagnostics).toEqual([{ step: "cleanup-rm", code: "EACCES" }]);
    expect(JSON.stringify(error.secondaryDiagnostics)).not.toContain("secret-path-detail");
  });

  it("preserves primary error identity and appends both close and rm secondary diagnostics without overwriting existing diagnostics", async () => {
    const { directory, sessionsRoot, pluginRoot, report } = await createSampleReport();

    fault.active = true;
    fault.closeCode = "EIO";
    fault.rmCode = "EACCES";
    fault.priorDiagnostics = [{ step: "prior-step", code: "EAGAIN" }];
    const error = await writeNewMarkdown(report, path.join(directory, "out"), { sessionsRoot, pluginRoot, stamp: "20260101000000000" }).catch((caught) => caught);

    expect(error).toBe(fault.lastPrimaryError);
    expect(error.code).toBe("ENOSPC");
    expect(error.secondaryDiagnostics).toEqual([
      { step: "prior-step", code: "EAGAIN" },
      { step: "cleanup-close", code: "EIO" },
      { step: "cleanup-rm", code: "EACCES" }
    ]);
    expect(JSON.stringify(error.secondaryDiagnostics)).not.toContain("secret-path-detail");
  });

  it("keeps a frozen primary write error unchanged when close and rm cleanup both fail", async () => {
    const { directory, sessionsRoot, pluginRoot, report } = await createSampleReport();

    fault.active = true;
    fault.closeCode = "EIO";
    fault.rmCode = "EACCES";
    fault.freezePrimary = true;
    const error = await writeNewMarkdown(report, path.join(directory, "out"), { sessionsRoot, pluginRoot, stamp: "20260101000000000" }).catch((caught) => caught);

    expect(error).toBe(fault.lastPrimaryError);
    expect(Object.isFrozen(error)).toBe(true);
    expect(error.code).toBe("ENOSPC");
  });
});
