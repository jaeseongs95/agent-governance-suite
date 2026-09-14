import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { afterEach, describe, expect, it } from "vitest";

import { execute } from "../../skills/codex-token-usage-analyzer/scripts/cli.mjs";
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
  it("pins the explicit-only provider and source tag in every integration surface", async () => {
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
    expect(source).toMatchObject({ source: "https://github.com/jaeseongs95/codex-token-usage-analyzer.git", sourcePath: "skills/codex-token-usage-analyzer", version: "0.1.0", updatePolicy: "notify-only" });
    expect(source.ref).toEqual({ kind: "tag", value: "v0.1.0", commit: "68843ce943e87767ed9605cb19f3074452cabf89" });
    expect(source.upstreamChecksum).toBe("sha256:e88e4c76c30b53e5a536a7a82280f9b8124768a37c16ea7f13cbfa7f282d9bfe");
    expect(source.integratedChecksum).toBe("sha256:c314d497e7ef63e314ee44827bf41b0a20a05eb5b22f37f640538bfe4c071fd8");
    expect(source.downstreamModifications).toEqual([
      "Treat the optional Markdown export as a provider result artifact rather than a mandatory workflow completion artifact."
    ]);
  });

  it("compiles every public contract with strict Ajv", async () => {
    const schemas = await Promise.all([
      "contracts/token-usage-report-request.v1.schema.json",
      "contracts/token-usage-report.v1.schema.json",
      "integration/provider-result.v1.schema.json"
    ].map(json));
    const ajv = new Ajv2020({ strict: true, allErrors: true, formats: { "date-time": true, uuid: true } });
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
});
