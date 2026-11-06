import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as diagnostics from "../../mcp-server/src/hook-error-diagnostics.js";
import { failureContext } from "../../mcp-server/src/failure-diagnostics.js";

type DiagnosticWriter = (component: string, event: string, details: Record<string, unknown>, writer?: (line: string) => void) => void;
function writer(): DiagnosticWriter {
  expect(diagnostics, "DG01 common product writer is present").toHaveProperty("writeDiagnostic", expect.any(Function));
  return (diagnostics as unknown as { writeDiagnostic: DiagnosticWriter }).writeDiagnostic;
}
afterEach(() => vi.restoreAllMocks());

describe("AGS3-D-0023 one stderr record contract", () => {
  it("DG01 emits one JSON record with the producer's distinct phase and reason", () => {
    const sink = vi.fn();
    writer()("fixture-hook", "fixture-failure", { phase: "input", reason: "EACCES", context: { type: "object" } }, sink);
    expect(sink).toHaveBeenCalledTimes(1);
    expect(JSON.parse(sink.mock.calls[0]![0])).toEqual({ component: "fixture-hook", event: "fixture-failure",
      phase: "input", reason: "EACCES", context: { type: "object" } });
  });

  it.each(["circular", "throwing-toJSON"])("DG02 preserves the producer reason after %s serialization fails", mode => {
    const sink = vi.fn();
    const context: Record<string, unknown> = mode === "circular" ? {} : { toJSON() { throw new Error("SENSITIVE_SERIALIZER_TEXT"); } };
    if (mode === "circular") context.self = context;
    writer()("fixture-hook", "fixture-failure", { phase: "storage", reason: "STORE_READONLY", context }, sink);
    expect(sink).toHaveBeenCalledTimes(1);
    expect(JSON.parse(sink.mock.calls[0]![0])).toEqual({ component: "fixture-hook", event: "fixture-failure",
      phase: "storage", reason: "STORE_READONLY", diagnosticReason: "DIAGNOSTIC_SERIALIZATION_FAILED" });
    expect(sink.mock.calls[0]![0]).not.toContain("SENSITIVE_SERIALIZER_TEXT");
  });

  it("DG03 contains a failed sink without replacing the caller's original failure", () => {
    const sink = vi.fn(() => { throw new Error("SENSITIVE_SINK_TEXT"); });
    expect(() => writer()("fixture-hook", "fixture-failure", { reason: "ORIGINAL_FAILURE" }, sink)).not.toThrow();
    expect(sink).toHaveBeenCalledTimes(1);
  });

  it("DG04 serializes the existing bounded error context without raw messages", () => {
    const error = Object.assign(new Error("SENSITIVE_MESSAGE /private/path token=secret"), { code: "EIO" });
    const sink = vi.fn();
    writer()("fixture-hook", "fixture-failure", { reason: "EIO", context: failureContext(error) }, sink);
    const line = sink.mock.calls[0]![0];
    expect(JSON.parse(line)).toMatchObject({ component: "fixture-hook", event: "fixture-failure", reason: "EIO" });
    expect(line).not.toMatch(/SENSITIVE_MESSAGE|private\/path|token=secret/u);
  });

  it("DG01 native host hook keeps stdout and exit behavior while emitting the shared record", () => {
    const cwd = fileURLToPath(new URL("../../", import.meta.url));
    const result = spawnSync(process.execPath, ["--import", "tsx", "mcp-server/src/host-attestation-hook.ts"], {
      cwd, encoding: "utf8", input: "{", env: process.env,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    const records = result.stderr.split(/\r?\n/u).filter(line => line.trim());
    expect(records).toHaveLength(1);
    expect(JSON.parse(records[0]!)).toMatchObject({ component: "host-attestation-hook", event: "observation-failure",
      phase: "input", reason: "INVALID_JSON" });
  });
});
