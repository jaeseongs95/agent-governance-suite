import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { transformSync } from "esbuild";
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

const repository = fileURLToPath(new URL("../../", import.meta.url));
/** The one module allowed to touch stderr; every other product producer goes through it. */
const WRITER = "runtime/diagnostic-record.mjs";
/** Not diagnostics: a CLI's error report on its own stderr, parsed by stage-validator-process as `{code,message}`. */
const CLI_PROTOCOL = new Set(["runtime/engineering-practices/cli.mjs"]);
const STDERR = /process\.stderr|console\.(?:error|warn|trace)\s*\(|writeSync\(\s*2\s*,/gu;
/** A launcher's own fallback, used only when the shared writer cannot load, must spell the same record literally. */
const LITERAL_RECORD = /^writeSync\(\s*2\s*,\s*`\$\{JSON\.stringify\(\{\s*component:\s*\w+,\s*event:\s*"[a-z][a-z-]*",/u;

/** Hook, launcher, connector and server sources, derived from their directories; generated bundles are excluded. */
function productSources(): string[] {
  // Generated bundles are the outputs the bundle script declares; their sources are scanned instead.
  const generated = new Set([...readFileSync(path.join(repository, "scripts/runtime-bundles.mjs"), "utf8").matchAll(/output: "([^"]+)"/gu)].map(match => match[1]));
  const walk = (directory: string, keep: (file: string) => boolean) => readdirSync(path.join(repository, directory), { recursive: true, encoding: "utf8" })
    .map(file => `${directory}/${file.split(path.sep).join("/")}`).filter(keep);
  const code = (file: string) => /\.(?:ts|mjs|js)$/u.test(file) && !file.endsWith(".d.ts") && !/\.test\.(?:ts|mjs)$/u.test(file);
  return [
    ...walk("mcp-server/src", code),
    ...walk("runtime", file => code(file) && !generated.has(file) && !CLI_PROTOCOL.has(file)),
    ...walk("claude-overlay/hooks", code),
    ...walk("antigravity-connector", code),
  ];
}

describe("AGS3-D-0023 no other stderr format in product sources", () => {
  it("DG05 only the shared writer (or a literal common record fallback) writes to stderr", () => {
    const sources = productSources();
    for (const required of ["mcp-server/src/server.ts", "claude-overlay/hooks/skill-trigger-hook.mjs", "antigravity-connector/hooks/antigravity-hook-runner.mjs", WRITER]) {
      expect(sources, "sources are derived, not listed").toContain(required);
    }
    const offenders: string[] = [];
    for (const file of sources) {
      if (file === WRITER) continue;
      const code = transformSync(readFileSync(path.join(repository, file), "utf8"), { loader: file.endsWith(".ts") ? "ts" : "js", format: "esm" }).code;
      for (const match of code.matchAll(STDERR)) {
        if (!LITERAL_RECORD.test(code.slice(match.index))) offenders.push(`${file}: ${code.slice(match.index, match.index + 60).split("\n")[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("DG06 the synchronous sink passes only one common record and replaces any other text", () => {
    const sink = vi.fn();
    const record = JSON.stringify({ component: "fixture-hook", event: "fixture-failure", reason: "EIO" });
    diagnostics.writeFailureDiagnostic(`${record}\n`, sink);
    for (const other of ["[agent-governance-suite] launcher-failure {\"stage\":\"run\"}\n", "{\"agsAntigravityHookDiagnostic\":{}}\n",
      `${record}\n${record}\n`, "{\"component\":\"fixture-hook\"}\n"]) diagnostics.writeFailureDiagnostic(other, sink);
    expect(sink.mock.calls.map(([line]) => line)).toEqual([`${record}\n`,
      ...Array.from({ length: 4 }, () => `${JSON.stringify({ component: "diagnostics", event: "rejected-record", reason: "NOT_COMMON_FORMAT" })}\n`)]);
  });
});
