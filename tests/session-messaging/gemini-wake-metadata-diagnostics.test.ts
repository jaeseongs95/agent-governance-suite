import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
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

  it("persists preflight, project-mismatch, and send failures to relay-failure.latest.json without leaking markers", async () => {
    const stateDir = mkdtempSync(path.join(os.tmpdir(), "ags-gemini-diag-"));
    try {
      vi.stubEnv("AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR", stateDir);

      vi.stubEnv("ANTIGRAVITY_PROJECT_ID", "");
      vi.stubEnv("ANTIGRAVITY_WAKE_ENV_DIAGNOSTIC", "PROJECT_ID_NOT_MATCHED,CSRF_TOKEN_NOT_FOUND");
      const missingProject = await diagnose();
      expect(missingProject.outcome).toBe("definite-failure");
      expect(missingProject.diagnostic).toMatchObject({
        phase: "gemini-preflight",
        reason: "GEMINI_PROJECT_ID_MISSING",
        detail: "missing-project-id;PROJECT_ID_NOT_MATCHED,CSRF_TOKEN_NOT_FOUND",
      });
      const persistedMissing = JSON.parse(readFileSync(path.join(stateDir, "relay-failure.latest.json"), "utf8")) as Diagnostic;
      expect(persistedMissing).toMatchObject({
        phase: "gemini-preflight",
        reason: "GEMINI_PROJECT_ID_MISSING",
        detail: "missing-project-id;PROJECT_ID_NOT_MATCHED,CSRF_TOKEN_NOT_FOUND",
      });

      vi.stubEnv("ANTIGRAVITY_PROJECT_ID", "fixture-project");
      vi.stubEnv("ANTIGRAVITY_AGENTAPI_EXE", "agentapi.bat");
      if (process.platform === "win32") {
        const missingExe = await diagnose();
        expect(missingExe.outcome).toBe("definite-failure");
        expect(missingExe.diagnostic).toMatchObject({
          phase: "gemini-preflight",
          reason: "GEMINI_AGENTAPI_UNAVAILABLE",
          detail: "missing-agentapi-exe:AGENTAPI_EXE_UNVERIFIED;PROJECT_ID_NOT_MATCHED,CSRF_TOKEN_NOT_FOUND",
        });
        const persistedExe = JSON.parse(readFileSync(path.join(stateDir, "relay-failure.latest.json"), "utf8")) as Diagnostic;
        expect(persistedExe).toMatchObject({
          phase: "gemini-preflight",
          reason: "GEMINI_AGENTAPI_UNAVAILABLE",
          detail: "missing-agentapi-exe:AGENTAPI_EXE_UNVERIFIED;PROJECT_ID_NOT_MATCHED,CSRF_TOKEN_NOT_FOUND",
        });
      }

      vi.stubEnv("ANTIGRAVITY_AGENTAPI_EXE", "C:/Program Files/Antigravity/language_server.exe");
      metadataCallback(null, JSON.stringify({ response: { conversationMetadata: { metadata: { projectId: "other-project" } } } }));
      const mismatch = await diagnose();
      expect(mismatch.outcome).toBe("definite-failure");
      expect(mismatch.diagnostic).toMatchObject({ phase: "gemini-metadata", reason: "GEMINI_PROJECT_MISMATCH" });
      const persistedMismatch = JSON.parse(readFileSync(path.join(stateDir, "relay-failure.latest.json"), "utf8")) as Diagnostic;
      expect(persistedMismatch).toMatchObject({ phase: "gemini-metadata", reason: "GEMINI_PROJECT_MISMATCH" });

      metadataCallback(null, JSON.stringify({ response: { conversationMetadata: { metadata: { projectId: "fixture-project" } } } }));
      execFileMock.mockImplementationOnce((_command: string, _args: string[], _options: unknown, callback: Callback) => {
        const child = new EventEmitter();
        queueMicrotask(() => {
          const err = Object.assign(new Error("private-send-error"), { code: "ECONNREFUSED" });
          child.emit("error", err);
          callback(err, "", "");
        });
        return child;
      });
      const sendFailed = await diagnose();
      expect(sendFailed.outcome).toBe("definite-failure");
      expect(sendFailed.diagnostic).toMatchObject({
        phase: "gemini-send",
        reason: "GEMINI_SEND_FAILED",
        context: { producerReason: "GEMINI_SEND_FAILED", producerCause: { type: "error", code: { prefixSha256: digest("ECONNREFUSED") } } },
      });
      const rawPersistedSend = readFileSync(path.join(stateDir, "relay-failure.latest.json"), "utf8");
      for (const marker of ["private-send-error", "private-session-marker", "private-body-marker"]) {
        expect(rawPersistedSend).not.toContain(marker);
      }
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
