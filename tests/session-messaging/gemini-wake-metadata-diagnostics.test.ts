import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  execFile: execFileMock,
}));

import { transportWakePort } from "../../mcp-server/src/session-message-wake-port.js";

type Callback = (error: Error | null, stdout: string, stderr: string) => void;
type Diagnostic = { phase: string; reason: string; context: Record<string, unknown> };
const digest = (value: string): string => createHash("sha256").update(Buffer.from(value, "utf16le")).digest("hex");
const target = { host: "gemini", sessionId: "private-session-marker" };
const dispatch = () => transportWakePort("gemini-queue").dispatch(target, "private-body-marker");

function metadataCallback(error: Error | null, stdout: string): void {
  execFileMock.mockImplementationOnce((_command: string, _args: string[], _options: unknown, callback: Callback) => {
    queueMicrotask(() => callback(error, stdout, ""));
    return new EventEmitter();
  });
}

async function diagnose(): Promise<{ outcome: string; diagnostic: Diagnostic; line: string }> {
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const outcome = await dispatch();
    expect(spy).toHaveBeenCalledTimes(1);
    const line = String(spy.mock.calls[0]![0]);
    const diagnostic = JSON.parse(line.slice(line.indexOf("{"))) as Diagnostic;
    return { outcome, diagnostic, line };
  } finally { spy.mockRestore(); }
}

beforeEach(() => {
  execFileMock.mockReset();
  vi.stubEnv("ANTIGRAVITY_AGENTAPI_EXE", "C:/Program Files/Antigravity/language_server.exe");
  vi.stubEnv("ANTIGRAVITY_PROJECT_ID", "fixture-project");
});
afterEach(() => vi.unstubAllEnvs());

describe("Gemini metadata failure keeps its cause", () => {
  it("records an execution error code fingerprint without sending or leaking text", async () => {
    metadataCallback(Object.assign(new Error("private-exec-message"), { code: "ENOENT" }), "");
    const { outcome, diagnostic, line } = await diagnose();
    expect(outcome).toBe("definite-failure");
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(diagnostic).toMatchObject({ phase: "gemini-metadata", reason: "GEMINI_METADATA_FAILED",
      context: { producerReason: "GEMINI_METADATA_FAILED", producerCause: { type: "error", code: { prefixSha256: digest("ENOENT") } } } });
    for (const marker of ["private-exec-message", "private-session-marker", "private-body-marker"]) expect(line).not.toContain(marker);
  });

  it("records a JSON parse failure as a syntax error cause", async () => {
    metadataCallback(null, "{");
    const { outcome, diagnostic } = await diagnose();
    expect(outcome).toBe("definite-failure");
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(diagnostic).toMatchObject({ reason: "GEMINI_METADATA_FAILED", context: { producerCause: { type: "syntax-error" } } });
  });

  it("records a synchronous launch failure", async () => {
    execFileMock.mockImplementationOnce(() => { throw new Error("private-spawn-message"); });
    const { outcome, diagnostic, line } = await diagnose();
    expect(outcome).toBe("definite-failure");
    expect(diagnostic).toMatchObject({ reason: "GEMINI_METADATA_FAILED", context: { producerCause: { type: "error" } } });
    expect(line).not.toContain("private-spawn-message");
  });

  it("distinguishes metadata without a project identity", async () => {
    metadataCallback(null, "{}");
    const { outcome, diagnostic } = await diagnose();
    expect(outcome).toBe("definite-failure");
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(diagnostic).toMatchObject({ phase: "gemini-metadata", reason: "GEMINI_METADATA_PROJECT_MISSING" });
  });
});
