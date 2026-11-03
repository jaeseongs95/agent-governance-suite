import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { WorkflowContractError } from "../../contracts/types.js";
import { EvaluationPreflightError } from "../../mcp-server/src/evaluation-preflight.js";
import { contractFailure } from "../../mcp-server/src/failure-diagnostics.js";
import { msg, render } from "../../mcp-server/src/i18n.js";
import type { VerifiedCaller } from "../../mcp-server/src/caller-identity.js";
import { BrokerRequestRejected, closeSessionMessaging, runSessionMessageOperation } from "../../mcp-server/src/session-message-client.js";
import { formatSessionMessageCliFailure } from "../../mcp-server/src/session-message-cli.js";
import { SessionMessageService } from "../../mcp-server/src/session-message-service.js";
import { assertSupportedScopeEntry } from "../../mcp-server/src/workspace-identity.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    closeSessionMessaging(directory);
    await rm(directory, { recursive: true, force: true });
  }
});

const caller: VerifiedCaller = {
  host: "synthetic-host", sessionId: "synthetic-session", callId: null, actor: { id: "synthetic-root", role: "root" },
  parentChain: [], parentChainComplete: true, provenance: "host-observed", execution: { unavailable: "TEST" },
};

describe("services catalog messages (docs/i18n-design.md 3, 6)", () => {
  it("keeps the root-locale text of a server failure and renders its key in each locale", () => {
    const body = contractFailure(new Error("private")).toBody();
    expect(body).toMatchObject({ code: "MCP_UNAVAILABLE", message: "The server could not complete the request.",
      messageKey: "services.failure.serverUnavailable", params: {} });
    expect(render({ key: body.messageKey!, params: body.params ?? {} }, "ko")).toBe("서버가 요청을 끝내지 못했다.");
  });

  it("gives each fixed workspace cause its own sentence and keeps an OS code as it is", () => {
    let caught: unknown;
    try { assertSupportedScopeEntry("bad\u0001entry"); } catch (error) { caught = error; }
    expect((caught as WorkflowContractError).toBody()).toMatchObject({
      message: "Scope entries must be file system paths without control characters.", messageKey: "services.workspace.unsupportedScopeEntry",
    });
    expect(render(msg("services.workspace.unresolvedWalkLimit", { target: "/w" }), "en")).toBe("Workspace identity cannot be resolved for /w: walk limit reached.");
    expect(render(msg("services.workspace.unresolved", { target: "/w", cause: "EACCES" }), "ko")).toBe("/w의 작업 공간 식별 정보를 확인할 수 없다: EACCES.");
  });

  it("returns session message service rejections with their key, rendered per locale at the edge", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ags-i18n-services-"));
    directories.push(directory);
    const service = new SessionMessageService(directory);
    const result = await service.prepare({ schemaVersion: "1.0.0", targetHost: "h", targetSessionId: "s", body: "" }, caller);
    expect(result.error).toMatchObject({ code: "INVALID_INPUT", message: "body must contain 1-4096 UTF-8 bytes and no NUL characters.",
      messageKey: "services.sessionMessage.prepare.bodyInvalid", params: { maxBytes: 4096 } });
    expect(render({ key: result.error!.messageKey!, params: result.error!.params ?? {} }, "ko"))
      .toBe("body는 1-4096 UTF-8 바이트여야 하고 NUL 문자가 없어야 한다.");
  });

  it("carries a store rejection's key through the broker, and the CLI renders it in the host locale", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ags-i18n-services-"));
    directories.push(directory);
    let caught: unknown;
    try {
      runSessionMessageOperation("prepare", { sender: { host: "h", sessionId: "sender-1" }, target: { host: "h", sessionId: "target-1" }, body: "x", ttlSeconds: 1 }, directory);
    } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(BrokerRequestRejected);
    expect((caught as BrokerRequestRejected).message).toBe("ttlSeconds must be an integer from 30 to 86400.");
    expect((caught as BrokerRequestRejected).ref).toEqual({ key: "services.sessionMessage.message.ttlRange", params: { maxSeconds: 86400 } });
    expect(formatSessionMessageCliFailure(caught, "en")).toEqual({ protocolVersion: "1.0.0", ok: false,
      error: "ttlSeconds must be an integer from 30 to 86400.", messageKey: "services.sessionMessage.message.ttlRange", params: { maxSeconds: 86400 } });
    expect(formatSessionMessageCliFailure(caught, "ko")).toMatchObject({ error: "ttlSeconds는 30부터 86400까지의 정수여야 한다." });
  });

  it("keeps the capacity sentences byte-identical to the former concatenation", () => {
    const params = (scope: "sender" | "global", earliestReleaseAt: string | null) => ({
      scope, release: earliestReleaseAt === null ? "pending" : "scheduled", earliestReleaseAt: earliestReleaseAt ?? "" });
    expect(render(msg("services.sessionMessage.prepare.capacityRejected", params("sender", null)), "en")).toBe(
      "The bounded message receipt store is full for this sender; no draft was created. A new prepare_session_message may succeed after retained records expire.");
    expect(render(msg("services.sessionMessage.prepare.capacityRejected", params("global", "2026-11-03T00:00:00.000Z")), "en")).toBe(
      "The bounded message receipt store is full; no draft was created. The earliest retained record in this scope expires at 2026-11-03T00:00:00.000Z; after that a new prepare_session_message may succeed.");
    expect(render(msg("services.sessionMessage.send.capacityRejected", params("global", null)), "en")).toMatch(
      /^The bounded message receipt store is full\. This definite rejection had no effect: .* Never do both\. A new prepare_session_message may succeed after retained records expire\.$/u);
  });

  it("gives evaluation preflight errors their key while keeping the code-prefixed text", () => {
    const error = new EvaluationPreflightError("OUTPUT_EXISTS", msg("services.evaluationPreflight.evaluationOutputWouldBeOverwritten", {}));
    expect(error.message).toBe("OUTPUT_EXISTS: evaluation output would be overwritten");
    expect(render(error.ref!, "ko")).toBe("평가 출력을 덮어쓰게 된다");
  });
});
