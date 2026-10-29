import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { afterEach, describe, expect, it } from "vitest";

import { execute, main } from "../../skills/codex-token-usage-analyzer/scripts/cli.mjs";
import { digest } from "../../skills/codex-token-usage-analyzer/scripts/core.mjs";
import { FileSkillRegistry } from "../../mcp-server/src/registry.js";
import { ContractValidator } from "../../mcp-server/src/schema-validator.js";
import { WorkflowService } from "../../mcp-server/src/workflow-service.js";

const root = path.resolve(import.meta.dirname, "../..");
const skillRoot = path.join(root, "skills", "codex-token-usage-analyzer");
const threadId = "11111111-1111-1111-1111-111111111111";
const temporaryDirectories = [];

function workflowTask(taskId) {
  return {
    schemaVersion: "1.0.0",
    taskId,
    objective: "Summarize observed local Codex token usage without inferring quality.",
    scope: { included: ["observed token usage"], excluded: ["quality inference"] },
    acceptanceCriteria: ["Return a schema-valid token usage report."],
    riskLevel: "low",
    workUnits: [],
    requiredCapabilities: ["local-codex-token-usage-analysis"],
    artifactContracts: [{
      capability: "local-codex-token-usage-analysis",
      produced: [{ artifactId: "token-usage-report", schemaId: "TokenUsageReport.v1", targetDigest: digest(threadId) }]
    }],
    constraints: ["Do not write Markdown unless requested."],
    authorization: { allowedActions: ["read"], prohibitedActions: ["write"], approvalRequired: [] },
    decision: { complexity: "simple", hasConflicts: false },
    orchestration: { requested: true, mcpAvailable: true }
  };
}

function stageResult(receipt, providerResult) {
  const stage = receipt.plan.stages[0];
  return {
    schemaVersion: "1.0.0",
    runId: receipt.runId,
    stageId: stage.stageId,
    expectedRevision: receipt.revision,
    state: "passed",
    output: providerResult,
    evidence: stage.requiredInputArtifacts.map((artifactId) => ({
      artifactId,
      kind: "document",
      locator: `artifact://token-usage/input/${artifactId}`,
      verified: true,
      note: ""
    })),
    findings: [],
    blockers: [],
    error: null
  };
}

async function json(relative) {
  return JSON.parse(await readFile(path.join(skillRoot, relative), "utf8"));
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("codex-token-usage-analyzer integration", () => {
  it("pins the explicit-only provider in the suite-managed source lock", async () => {
    const [registry, sourceLock, directDescriptor, openai] = await Promise.all([
      readFile(path.join(root, "skills", "registry.json"), "utf8").then(JSON.parse),
      readFile(path.join(root, "skills", "source-lock.json"), "utf8").then(JSON.parse),
      json("integration/skill-descriptor.json"),
      readFile(path.join(skillRoot, "agents", "openai.yaml"), "utf8")
    ]);
    const descriptor = registry.skills.find((entry) => entry.skillId === "codex-token-usage-analyzer");
    const source = sourceLock.sources.find((entry) => entry.skillId === "codex-token-usage-analyzer");
    expect(descriptor.version).toBe("0.1.0");
    expect(descriptor.providers[0]).toMatchObject({ capabilities: ["local-codex-token-usage-analysis"], executionClass: "workflow", phase: "usage-analysis" });
    expect(directDescriptor.providers[0].selectionCriteria).toEqual(["explicit-codex-token-usage-analysis-request"]);
    expect(openai).toMatch(/^\s*allow_implicit_invocation:\s*false\s*$/mu);
    expect(source).toMatchObject({ version: "0.1.0", updatePolicy: "internal" });
    expect(source).not.toHaveProperty("source");
    expect(source).not.toHaveProperty("ref");
    expect(source).not.toHaveProperty("upstreamChecksum");
    expect(source.integratedChecksum).toMatch(/^sha256:[a-f0-9]{64}$/u);
  });

  it("compiles every public contract with strict Ajv", async () => {
    const schemas = await Promise.all([
      "contracts/token-usage-report-request.v1.schema.json",
      "contracts/token-usage-report.v1.schema.json",
      "integration/provider-result.v1.schema.json"
    ].map(json));
    const ajv = new Ajv2020({ strict: true, allErrors: true });
    addFormats(ajv, ["date-time", "uuid"]);
    for (const schema of schemas) expect(() => ajv.addSchema(schema)).not.toThrow();
  });

  it("returns a validated local report without exposing ignored conversation records", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "suite-token-usage-"));
    temporaryDirectories.push(directory);
    const sessionsRoot = path.join(directory, "sessions");
    await mkdir(sessionsRoot);
    const usage = { input_tokens: 10, cached_input_tokens: 3, cache_write_input_tokens: 0, output_tokens: 2, reasoning_output_tokens: 1, total_tokens: 12 };
    const rows = [
      { type: "session_meta", payload: { id: threadId, title: "통합 테스트", cwd: "D:\\work\\suite" } },
      { type: "response_item", payload: { content: "RAW-CONVERSATION-MUST-NOT-LEAK" } },
      { timestamp: "2026-01-01T00:00:00Z", type: "turn_context", payload: { turn_id: "turn-1", model: "gpt-test", effort: "high" } },
      { timestamp: "2026-01-01T00:00:01Z", type: "token_usage_record", payload: { thread_id: threadId, turn_id: "turn-1", response_id: "response-1", usage, turn_token_usage: usage, thread_token_usage: usage } }
    ];
    await writeFile(path.join(sessionsRoot, "session.jsonl"), `${rows.map(JSON.stringify).join("\n")}\n`, "utf8");
    const { result, exitCode } = await execute({ schemaVersion: "1.0.0", target: threadId }, { locations: { root: directory, sessionsRoot, indexFile: path.join(directory, "missing") } });
    expect(exitCode).toBe(0);
    expect(result.output).toMatchObject({ verdict: "PASS", totals: { input_tokens: 10, non_cached_input_tokens: 7, input_output_tokens: 12 } });
    expect(JSON.stringify(result)).not.toContain("RAW-CONVERSATION-MUST-NOT-LEAK");
  });

  it.each(["PASS", "PARTIAL"])("records and finalizes a no-Markdown %s workflow", async (verdict) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "suite-token-workflow-"));
    temporaryDirectories.push(directory);
    const sessionsRoot = path.join(directory, "sessions");
    await mkdir(sessionsRoot);
    const usage = { input_tokens: 10, cached_input_tokens: 3, cache_write_input_tokens: 0, output_tokens: 2, reasoning_output_tokens: 1, total_tokens: 12 };
    const rows = [
      { type: "session_meta", payload: { id: threadId, title: "통합 테스트", cwd: "D:\\work\\suite" } },
      { timestamp: "2026-01-01T00:00:00Z", type: "turn_context", payload: { turn_id: "turn-1", model: "gpt-test", effort: "high" } },
      { timestamp: "2026-01-01T00:00:01Z", type: "token_usage_record", payload: { thread_id: threadId, turn_id: "turn-1", response_id: "response-1", usage, turn_token_usage: usage, thread_token_usage: usage } }
    ];
    await writeFile(path.join(sessionsRoot, "session.jsonl"), `${rows.map(JSON.stringify).join("\n")}\n`, "utf8");
    const execution = await execute(
      { schemaVersion: "1.0.0", target: threadId },
      { locations: { root: directory, sessionsRoot, indexFile: path.join(directory, "missing") } }
    );
    const providerResult = structuredClone(execution.result);
    providerResult.output.verdict = verdict;
    providerResult.artifacts[0].digest = digest(providerResult.output);
    expect(providerResult.artifacts.map((artifact) => artifact.artifactId)).toEqual(["token-usage-report"]);

    const service = new WorkflowService(new FileSkillRegistry(path.join(root, "skills", "registry.json"), new ContractValidator()));
    const plan = service.planWorkflow(workflowTask(`token-workflow-${verdict.toLowerCase()}`));
    expect(plan.ok, plan.error?.message).toBe(true);
    expect(plan.data.stages[0].requiredArtifacts).toEqual(["token-usage-report"]);
    const receipt = service.startWorkflow(plan.data);
    expect(receipt.ok, receipt.error?.message).toBe(true);
    const recorded = service.recordStageResult(stageResult(receipt.data, providerResult));
    expect(recorded.ok, recorded.error?.message).toBe(true);
    expect(service.finalizeWorkflow(receipt.data.runId, recorded.data.revision)).toMatchObject({
      ok: true,
      data: { state: "passed" }
    });
  });

  it("is selected only by its registered capability", () => {
    const query = path.join(root, "skills", "orchestrator", "scripts", "query-registry.mjs");
    const selected = spawnSync(process.execPath, [query, "--capability", "local-codex-token-usage-analysis"], { cwd: root, encoding: "utf8", windowsHide: true });
    expect(selected.status).toBe(0);
    expect(selected.stderr).toBe("");
    expect(JSON.parse(selected.stdout).providers).toEqual([expect.objectContaining({ skillId: "codex-token-usage-analyzer", capabilities: ["local-codex-token-usage-analysis"] })]);
  });

  it("distinguishes stdin operational I/O errors from INVALID_INPUT in main()", async () => {
    const previousExitCode = process.exitCode;
    try {
      const failingStream = new Readable({
        read() {
          this.destroy(Object.assign(new Error("input/output error"), { code: "EIO" }));
        },
      });
      const ioOutcome = await main(failingStream, ["node", "cli.mjs"]);
      expect(ioOutcome.exitCode).toBe(2);
      expect(ioOutcome.result).toMatchObject({
        schemaVersion: "1.0.0",
        kind: "adapter-error",
        error: {
          code: "MISSING_EVIDENCE",
          details: { causeCategory: "io", causeCode: "EIO" },
        },
      });

      const syntaxStream = Readable.from(["{not-json"]);
      const syntaxOutcome = await main(syntaxStream, ["node", "cli.mjs"]);
      expect(syntaxOutcome.exitCode).toBe(2);
      expect(syntaxOutcome.result).toMatchObject({
        schemaVersion: "1.0.0",
        kind: "adapter-error",
        error: {
          code: "INVALID_INPUT",
          details: null,
        },
      });
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it("distinguishes ambiguous project targets, invalid thread formats, missing targets, and inaccessible target metadata (AGS-D-0221)", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "suite-token-d0221-"));
    temporaryDirectories.push(directory);
    const sessionsRoot = path.join(directory, "sessions");
    await mkdir(sessionsRoot);
    const secondThreadId = "22222222-2222-2222-2222-222222222222";
    const brokenThreadId = "33333333-3333-3333-3333-333333333333";
    const missingThreadId = "99999999-9999-9999-9999-999999999999";
    const usage = { input_tokens: 10, cached_input_tokens: 3, cache_write_input_tokens: 0, output_tokens: 2, reasoning_output_tokens: 1, total_tokens: 12 };

    await writeFile(
      path.join(sessionsRoot, `rollout-${threadId}.jsonl`),
      `${[
        { type: "session_meta", payload: { id: threadId, title: "첫 세션", cwd: "D:\\work\\alpha\\app" } },
        { timestamp: "2026-01-01T00:00:00Z", type: "turn_context", payload: { turn_id: "turn-1", model: "gpt-test", effort: "high" } },
        { timestamp: "2026-01-01T00:00:01Z", type: "token_usage_record", payload: { thread_id: threadId, turn_id: "turn-1", response_id: "resp-1", usage, turn_token_usage: usage, thread_token_usage: usage } }
      ].map(JSON.stringify).join("\n")}\n`,
      "utf8"
    );
    await writeFile(
      path.join(sessionsRoot, `rollout-${secondThreadId}.jsonl`),
      `${[
        { type: "session_meta", payload: { id: secondThreadId, title: "둘째 세션", cwd: "D:\\work\\beta\\app" } },
        { timestamp: "2026-01-01T00:00:00Z", type: "turn_context", payload: { turn_id: "turn-2", model: "gpt-test", effort: "high" } },
        { timestamp: "2026-01-01T00:00:01Z", type: "token_usage_record", payload: { thread_id: secondThreadId, turn_id: "turn-2", response_id: "resp-2", usage, turn_token_usage: usage, thread_token_usage: usage } }
      ].map(JSON.stringify).join("\n")}\n`,
      "utf8"
    );
    await writeFile(
      path.join(sessionsRoot, `rollout-${brokenThreadId}.jsonl`),
      `${JSON.stringify({ type: "response_item", payload: { content: "missing session_meta" } })}\n`,
      "utf8"
    );

    const locations = { root: directory, sessionsRoot, indexFile: path.join(directory, "missing") };

    const ambiguous = await execute({ schemaVersion: "1.0.0", target: "app" }, { locations });
    expect(ambiguous.exitCode).toBe(1);
    expect(ambiguous.result.output.verdict).toBe("NEEDS_INPUT");
    expect(ambiguous.result.error).toEqual({
      code: "INVALID_INPUT",
      message: "같은 마지막 폴더명을 가진 프로젝트가 여러 개입니다. 전체 경로를 입력하세요.",
      details: { target: "app", reason: "ambiguous_target" }
    });

    const invalidFormat = await execute({ schemaVersion: "1.0.0", target: "codex://threads/not-a-valid-uuid" }, { locations });
    expect(invalidFormat.exitCode).toBe(1);
    expect(invalidFormat.result.output.verdict).toBe("NEEDS_INPUT");
    expect(invalidFormat.result.error).toEqual({
      code: "INVALID_INPUT",
      message: "thread ID 또는 codex://threads 딥링크 형식이 올바르지 않습니다.",
      details: { target: "codex://threads/not-a-valid-uuid", reason: "invalid_target_format" }
    });

    const missingThread = await execute({ schemaVersion: "1.0.0", target: missingThreadId }, { locations });
    expect(missingThread.exitCode).toBe(1);
    expect(missingThread.result.output.verdict).toBe("NEEDS_INPUT");
    expect(missingThread.result.error).toEqual({
      code: "RUN_NOT_FOUND",
      message: "입력한 thread ID와 일치하는 세션을 찾지 못했습니다.",
      details: { target: missingThreadId, reason: "not_found" }
    });

    const missingTitle = await execute({ schemaVersion: "1.0.0", target: "존재하지 않는 세션" }, { locations });
    expect(missingTitle.exitCode).toBe(1);
    expect(missingTitle.result.output.verdict).toBe("NEEDS_INPUT");
    expect(missingTitle.result.error).toEqual({
      code: "RUN_NOT_FOUND",
      message: "입력한 세션 제목 또는 프로젝트명과 일치하는 최상위 thread를 찾지 못했습니다.",
      details: { target: "존재하지 않는 세션", reason: "not_found" }
    });

    const inaccessible = await execute({ schemaVersion: "1.0.0", target: brokenThreadId }, { locations });
    expect(inaccessible.exitCode).toBe(1);
    expect(inaccessible.result.output.verdict).toBe("BLOCKED");
    expect(inaccessible.result.error).toEqual({
      code: "MISSING_EVIDENCE",
      message: "대상 thread의 session metadata 또는 로그에 접근할 수 없습니다.",
      details: { target: brokenThreadId, reason: "inaccessible_target" }
    });
  });

  it("preserves stat error code and message when sessionsRoot is missing or not a directory (AGS-D-0222)", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "suite-token-d0222-"));
    temporaryDirectories.push(directory);
    const missingRoot = path.join(directory, "no-such-sessions");
    const missingOutcome = await execute(
      { schemaVersion: "1.0.0", target: threadId },
      { locations: { root: directory, sessionsRoot: missingRoot, indexFile: path.join(directory, "missing") } }
    );
    expect(missingOutcome.exitCode).toBe(1);
    expect(missingOutcome.result.output.verdict).toBe("BLOCKED");
    expect(missingOutcome.result.output.message).toMatch(/^세션 로그 경로에 접근할 수 없습니다 \(ENOENT\): .+/u);
    expect(missingOutcome.result.error).toEqual({
      code: "MISSING_EVIDENCE",
      message: missingOutcome.result.output.message,
      details: { target: threadId, causeCode: "ENOENT" }
    });

    const fileRoot = path.join(directory, "sessions-file");
    await writeFile(fileRoot, "not a directory\n", "utf8");
    const notDirOutcome = await execute(
      { schemaVersion: "1.0.0", target: threadId },
      { locations: { root: directory, sessionsRoot: fileRoot, indexFile: path.join(directory, "missing") } }
    );
    expect(notDirOutcome.exitCode).toBe(1);
    expect(notDirOutcome.result.output.verdict).toBe("BLOCKED");
    expect(notDirOutcome.result.output.message).toBe("세션 로그 경로에 접근할 수 없습니다 (ENOTDIR): 디렉터리가 아닙니다.");
    expect(notDirOutcome.result.error).toEqual({
      code: "MISSING_EVIDENCE",
      message: "세션 로그 경로에 접근할 수 없습니다 (ENOTDIR): 디렉터리가 아닙니다.",
      details: { target: threadId, causeCode: "ENOTDIR" }
    });
  });

  it("records partialReasons when modern token_count events have invalid or inconsistent total_token_usage (AGS-D-0224)", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "suite-token-d0224-"));
    temporaryDirectories.push(directory);
    const sessionsRoot = path.join(directory, "sessions");
    await mkdir(sessionsRoot);
    const usage = { input_tokens: 10, cached_input_tokens: 3, cache_write_input_tokens: 0, output_tokens: 4, reasoning_output_tokens: 1, total_tokens: 14 };
    const rows = [
      { type: "session_meta", payload: { id: threadId, title: "Modern token_count 검증", cwd: "D:\\work\\suite" } },
      { timestamp: "2026-01-01T00:00:00Z", type: "turn_context", payload: { turn_id: "turn-1", model: "gpt-test", effort: "high" } },
      { timestamp: "2026-01-01T00:00:01Z", type: "token_usage_record", payload: { thread_id: threadId, turn_id: "turn-1", response_id: "response-1", usage, turn_token_usage: usage, thread_token_usage: usage } },
      {
        timestamp: "2026-01-01T00:00:02Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 10,
              cached_input_tokens: 12,
              cache_write_input_tokens: -1,
              output_tokens: 4,
              reasoning_output_tokens: 6,
              total_tokens: 99
            },
            last_token_usage: usage
          }
        }
      }
    ];
    await writeFile(path.join(sessionsRoot, "session.jsonl"), `${rows.map(JSON.stringify).join("\n")}\n`, "utf8");
    const { result, exitCode } = await execute(
      { schemaVersion: "1.0.0", target: threadId },
      { locations: { root: directory, sessionsRoot, indexFile: path.join(directory, "missing") } }
    );
    expect(exitCode).toBe(0);
    expect(result.output.verdict).toBe("PARTIAL");
    expect(result.output.partialReasons).toEqual(expect.arrayContaining([
      "cache_write_input_tokens 누락 또는 잘못된 값",
      "total_tokens와 Input + Output 불일치",
      "Cache input이 Input보다 큼",
      "Reasoning output이 Output보다 큼"
    ]));
  });
});
