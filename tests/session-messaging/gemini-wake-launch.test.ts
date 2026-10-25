import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  execFile: execFileMock,
}));

import { resolveGeminiAgentApi, transportWakePort } from "../../mcp-server/src/session-message-wake-port.js";

type Callback = (error: Error | null, stdout: string, stderr: string) => void;
type ExecOptions = { env: NodeJS.ProcessEnv; shell: boolean; windowsVerbatimArguments: boolean };
const command = "C:/Program Files/Antigravity/language_server.exe";
const target = { host: "gemini", sessionId: 'session "quoted" & %SESSION%' };
const message = '한글 "quoted" & %PATH% !X!\n끝\\';
const metadata = JSON.stringify({ response: { conversationMetadata: { metadata: { projectId: "fixture-project" } } } });
const dispatch = () => transportWakePort("gemini-queue").dispatch(target, message);

function metadataReply(value = metadata) {
  execFileMock.mockImplementationOnce((_command: string, _args: string[], _options: ExecOptions, callback: Callback) => {
    queueMicrotask(() => callback(null, value, ""));
    return new EventEmitter();
  });
}

beforeEach(() => {
  execFileMock.mockReset();
  vi.stubEnv("ANTIGRAVITY_AGENTAPI_EXE", command);
  vi.stubEnv("ANTIGRAVITY_PROJECT_ID", "fixture-project");
  vi.stubEnv("ANTIGRAVITY_CONVERSATION_ID", "source-conversation");
  vi.stubEnv("ANTIGRAVITY_SOURCE_METADATA", "source-fixture");
});
afterEach(() => vi.unstubAllEnvs());

describe("Gemini native launch boundary", () => {
  it("requires an explicit absolute native executable on Windows", () => {
    expect(resolveGeminiAgentApi({ ANTIGRAVITY_AGENTAPI_EXE: command }, "win32"))
      .toEqual({ command, argsPrefix: ["agentapi"] });
    for (const configured of [undefined, "agentapi.bat", "C:/bin/agentapi.cmd", "C:relative.exe", "\\rooted.exe"]) {
      expect(resolveGeminiAgentApi({ ANTIGRAVITY_AGENTAPI_EXE: configured }, "win32")).toBeNull();
    }
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("keeps exact argv and sender environment within the same project without a shell", async () => {
    metadataReply();
    execFileMock.mockImplementationOnce((_command: string, _args: string[], _options: ExecOptions, callback: Callback) => {
      const child = new EventEmitter();
      queueMicrotask(() => { child.emit("spawn"); callback(null, "", ""); });
      return child;
    });
    expect(await dispatch()).toBe("submitted");
    expect(execFileMock.mock.calls[0]!.slice(0, 2)).toEqual([command, ["agentapi", "get-conversation-metadata", target.sessionId]]);
    expect(execFileMock.mock.calls[1]!.slice(0, 2)).toEqual([command, ["agentapi", "send-message", target.sessionId, message]]);
    for (const call of execFileMock.mock.calls) {
      expect(call[2]).toMatchObject({ shell: false, windowsVerbatimArguments: false });
    }
    const options = execFileMock.mock.calls[1]![2] as ExecOptions;
    expect(options.env.ANTIGRAVITY_PROJECT_ID).toBe("fixture-project");
    expect(options.env.ANTIGRAVITY_SOURCE_METADATA).toBe("source-fixture");
    expect(options.env.ANTIGRAVITY_CONVERSATION_ID).toBe("source-conversation");
    expect(process.env.ANTIGRAVITY_PROJECT_ID).toBe("fixture-project");
    expect(process.env.ANTIGRAVITY_SOURCE_METADATA).toBe("source-fixture");
  });

  it.each([undefined, "", "  "])("does not start metadata or send without source project (%s)", async (sourceProject) => {
    vi.stubEnv("ANTIGRAVITY_PROJECT_ID", sourceProject);
    expect(await dispatch()).toBe("definite-failure");
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it.each(["other-project", " fixture-project", "fixture-project "])("does not send across distinct project identities (%s)", async (sourceProject) => {
    vi.stubEnv("ANTIGRAVITY_PROJECT_ID", sourceProject);
    metadataReply();
    expect(await dispatch()).toBe("definite-failure");
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(process.env.ANTIGRAVITY_PROJECT_ID).toBe(sourceProject);
    expect(process.env.ANTIGRAVITY_SOURCE_METADATA).toBe("source-fixture");
  });

  it.each(["throw", "error", "timeout", "invalid-json", "missing-project", "empty-project"])(
    "does not send after metadata %s", async (failure) => {
      if (failure === "throw") execFileMock.mockImplementationOnce(() => { throw new Error("spawn failed"); });
      else if (failure === "error" || failure === "timeout") {
        execFileMock.mockImplementationOnce((_command: string, _args: string[], _options: ExecOptions, callback: Callback) => {
          queueMicrotask(() => callback(new Error(failure), "", ""));
          return new EventEmitter();
        });
      } else metadataReply(failure === "invalid-json" ? "{" : failure === "missing-project" ? "{}"
        : JSON.stringify({ response: { conversationMetadata: { metadata: { projectId: "  " } } } }));
      expect(await dispatch()).toBe("definite-failure");
      expect(execFileMock).toHaveBeenCalledTimes(1);
    },
  );

  it("classifies a synchronous send launch failure as definite", async () => {
    metadataReply();
    execFileMock.mockImplementationOnce(() => { throw new Error("spawn failed"); });
    expect(await dispatch()).toBe("definite-failure");
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])("uses the send spawn boundary for errors (spawned=%s)", async (spawned) => {
    metadataReply();
    execFileMock.mockImplementationOnce((_command: string, _args: string[], _options: ExecOptions, callback: Callback) => {
      const child = new EventEmitter();
      queueMicrotask(() => {
        if (spawned) child.emit("spawn");
        const error = new Error(spawned ? "timeout after spawn" : "spawn failed");
        child.emit("error", error);
        callback(error, "", "");
      });
      return child;
    });
    expect(await dispatch()).toBe(spawned ? "accepted-or-unknown" : "definite-failure");
  });
});
