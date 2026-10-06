import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { afterEach, expect, test } from "vitest";
import { type StageResultV1, type TaskEnvelopeV1, type WorkflowReceiptV1, type ConvergenceFrameV1 } from "../../contracts/types.js";
import { convergenceDigest } from "../../mcp-server/src/convergence-logic.js";
import { FileSkillRegistry } from "../../mcp-server/src/registry.js";
import { ContractValidator } from "../../mcp-server/src/schema-validator.js";
import { SqliteWorkflowStore } from "../../mcp-server/src/sqlite-workflow-store.js";
import { WorkflowService } from "../../mcp-server/src/workflow-service.js";
import { InMemoryWorkflowStore } from "../../mcp-server/src/workflow-store.js";
import { createMcpServer } from "../../mcp-server/src/server.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { PluginUpdateService } from "../../mcp-server/src/plugin-update-service.js";
import { InMemoryPluginUpdateStore } from "../../mcp-server/src/plugin-update-store.js";
import { PLUGIN_INFO } from "../../mcp-server/src/plugin-info.js";

const repo = path.resolve(import.meta.dirname, "../..");
const roots: string[] = [];
const stores: SqliteWorkflowStore[] = [];
const read = (root: string, name: string) => JSON.parse(readFileSync(path.join(root, name), "utf8"));
const write = (root: string, name: string, value: unknown) => writeFileSync(path.join(root, name), JSON.stringify(value, null, 2) + "\n");
const digest = (root: string, name: string): `sha256:${string}` => `sha256:${createHash("sha256").update(readFileSync(path.join(root, name))).digest("hex")}`;

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, {recursive:true, force:true});
});

function fixture(tree = "") {
  const root = mkdtempSync(path.join(tmpdir(), "ags-cs-stage-")); roots.push(root);
  cpSync(path.join(repo, "skills/cs-engineering/assets/examples/sqlite-queue"), root, {recursive:true});
  const task = read(root, "task.json") as TaskEnvelopeV1;
  task.requiredCapabilities = ["cs-implementation-review"];
  task.orchestration = {requested:true, mcpAvailable:true};
  write(root, "task.json", task);
  const binding = read(root, "binding.json"); binding.taskDigest = convergenceDigest(task); write(root, "binding.json", binding);
  const sync = () => write(root, "stage-bundle.json", {schemaVersion:"1.0.0", ...Object.fromEntries(
    ["binding", "task", "policy", "review", "candidate"].map((name) => [name, {path:name + ".json", digest:digest(root, name + ".json")}]),
  )});
  sync();
  const validator = new ContractValidator();
  const registry = new FileSkillRegistry(path.join(repo, tree, "skills/registry.json"), validator);
  const service = new WorkflowService(registry, validator);
  const plan = service.planWorkflow(task);
  expect(plan.error).toBeNull(); expect(plan.data?.state).toBe("ready");
  const receipt = service.startWorkflow(plan.data!).data!;
  return {root, task, binding, sync, validator, registry, service, receipt, plan:plan.data!};
}

function result(f: ReturnType<typeof fixture>, receipt: WorkflowReceiptV1 = f.receipt): StageResultV1 {
  const review = read(f.root, "review.json");
  const code = review.verdict === "FAIL" ? "GATE_FAILED" : review.verdict === "BLOCKED" ? "MISSING_EVIDENCE" : null;
  const error = code ? {code, message:"Synthetic fixture result", details:null} as StageResultV1["error"] : null;
  return {
    schemaVersion:"1.0.0", runId:receipt.runId, stageId:receipt.plan.stages[0]!.stageId,
    expectedRevision:receipt.revision, state:code === "GATE_FAILED" ? "failed" : code ? "blocked" : "passed",
    executionContext:null,
    output:{schemaVersion:"1.0.0", kind:"output", output:review, error,
      artifacts:["stage-bundle", "review"].map((name) => ({
        artifactId:name === "review" ? "cs-review-report" : "cs-review-bundle", schemaId:"cs-fixture/v1",
        locator:path.join(f.root, name + ".json"), digest:digest(f.root, name + ".json"),
        targetDigest:review.candidateDigest, verified:true,
      }))},
    evidence:[{artifactId:"cs-review-report", kind:"file", locator:path.join(f.root,"review.json"), verified:true, note:"Synthetic isolated evidence"}],
    findings:[], blockers:[], error,
  };
}

test("registered CS providers are discoverable at bootstrap 25 and workflow 67", () => {
  const f = fixture();
  const run = spawnSync(process.execPath, [path.join(repo,"skills/orchestrator/scripts/query-registry.mjs"), "--capability", "cs-constraint-derivation,cs-implementation-review"], {encoding:"utf8"});
  expect(run.status).toBe(0);
  expect(f.registry.read().filter((p) => p.skillId === "cs-engineering").map((p) => p.phaseOrder)).toEqual([25,67]);
  expect(readFileSync(path.join(repo,"skills/cs-engineering/agents/openai.yaml"),"utf8")).toContain("allow_implicit_invocation: true");
  const bootstrap = {...f.task, requiredCapabilities:["cs-constraint-derivation"]};
  expect(f.service.planWorkflow(bootstrap).data?.state).toBe("blocked");
});

test("selected review runs actual packaged CLI and finalizes with matching files", () => {
  const f=fixture(); const recorded=f.service.recordStageResult(result(f));
  expect(recorded.error).toBeNull();
  expect(f.service.finalizeWorkflow(recorded.data!.runId,recorded.data!.revision).data?.state).toBe("passed");
  const handoff=spawnSync(process.execPath,[path.join(repo,"skills/cs-engineering/scripts/validate.mjs"),"handoff","--root",f.root,"--binding","binding.json","--task","task.json","--policy","policy.json"],{encoding:"utf8"});
  expect(handoff.status,handoff.stdout).toBe(0);
  expect(JSON.parse(handoff.stdout).requiredObligationIds).toEqual(["OB-CLAIM","OB-FENCE"]);
});

for (const mutation of ["missing-bundle", "stale-task", "raw-evidence", "provider-substitution", "NOT_RUN-as-PASS", "manifest-traversal", "candidate-target"]) {
  test("stage rejects " + mutation + " without consuming its revision", () => {
    const f=fixture(); const stage=result(f);
    if(mutation === "missing-bundle") stage.output.artifacts.shift();
    if(mutation === "stale-task") {const task=read(f.root,"task.json");task.objective+="changed";write(f.root,"task.json",task);f.sync();stage.output.artifacts[0]!.digest=digest(f.root,"stage-bundle.json");}
    if(mutation === "raw-evidence") writeFileSync(path.join(f.root,"evidence/queue-tests.json"),"changed");
    if(mutation === "provider-substitution") stage.output.output!.reviewerActorRef="substituted";
    if(mutation === "NOT_RUN-as-PASS") {const report=read(f.root,"review.json");report.verificationResults[0].executionStatus="NOT_RUN";write(f.root,"review.json",report);f.sync();Object.assign(stage,result(f));}
    if(mutation === "manifest-traversal") {const manifest=read(f.root,"stage-bundle.json");manifest.review.path="../secret";write(f.root,"stage-bundle.json",manifest);stage.output.artifacts[0]!.digest=digest(f.root,"stage-bundle.json");}
    if(mutation === "candidate-target") stage.output.artifacts[0]!.targetDigest="sha256:"+"0".repeat(64);
    expect(f.service.recordStageResult(stage).ok).toBe(false);
    expect(f.service.getWorkflowStatus(f.receipt.runId).data?.revision).toBe(0);
  });
}

test("proper unexecuted evidence records BLOCKED even with supplied observe policy", () => {
  const f=fixture();const review=read(f.root,"review.json");
  Object.assign(review.verificationResults[0],{executionStatus:"NOT_RUN",result:"UNKNOWN",evidenceRefs:[]});
  Object.assign(review.findings[0],{status:"UNVERIFIED",evidenceRefs:[]});
  review.verdict="BLOCKED";review.unverifiedRequiredObligationIds=["OB-CLAIM"];
  const policy=read(f.root,"policy.json");policy.mode="observe";f.binding.mode="observe";f.binding.policyDigest=convergenceDigest(policy);
  write(f.root,"policy.json",policy);write(f.root,"binding.json",f.binding);write(f.root,"review.json",review);f.sync();
  const recorded=f.service.recordStageResult(result(f));expect(recorded.error).toBeNull();expect(recorded.data?.state).toBe("blocked");
});

test("guarded lease/start and SQLite restart retain recorded bundle pins; finalize rereads evidence", () => {
  const f=fixture();const db=path.join(f.root,"fixture.sqlite3");const store=new SqliteWorkflowStore(db);stores.push(store);
  const service=new WorkflowService(f.registry,f.validator,store);
  const frame:ConvergenceFrameV1={schemaVersion:"1.0.0",workspace:{workspaceId:"cs-fixture",locator:f.root},
    controlArtifacts:[{artifactId:"cs-conditions",role:"validator",locator:path.join(f.root,"constraints.json"),digest:digest(f.root,"constraints.json")}],
    targetArtifacts:[{artifactId:"candidate",role:"candidate",locator:path.join(f.root,"candidate.json"),digest:digest(f.root,"candidate.json")}],
    operationalSettings:{maxAttemptsPerEpoch:3,maxEpochs:2,leaseTtlSeconds:300}};
  const root=service.openConvergenceRoot({schemaVersion:"1.0.0",parentRootId:null,taskEnvelope:f.task,frame,userApprovalRefs:[]}).data!;
  const plan=service.planWorkflow(f.task).data!;
  const lease=service.claimWorkflowAttempt({schemaVersion:"1.0.0",rootId:root.rootId,expectedRevision:root.revision,taskEnvelope:f.task,frame,plan,actorId:"cs-fixture-actor",outputTargets:["candidate/queue.py"],priorFailure:null});
  expect(lease.error).toBeNull();
  const started=service.startGuardedWorkflow({schemaVersion:"1.0.0",leaseId:lease.data!.leaseId,expectedRootRevision:lease.data!.rootRevision,plan});
  expect(started.error).toBeNull();
  const recorded=service.recordStageResult(result(f,started.data!));expect(recorded.error).toBeNull();
  store.close();stores.splice(stores.indexOf(store),1);
  const reopened=new SqliteWorkflowStore(db);stores.push(reopened);const restarted=new WorkflowService(f.registry,f.validator,reopened);
  const resumed=restarted.getWorkflowStatus(recorded.data!.runId).data!;
  expect(resumed.stageResults[0]!.output.artifacts).toEqual(recorded.data!.stageResults[0]!.output.artifacts);
  writeFileSync(path.join(f.root,"candidate/queue.py"),"changed after recording");
  expect(restarted.finalizeWorkflow(resumed.runId,resumed.revision).ok).toBe(false);
});

test("existing non-CS plan stays unselected and rejects unknown CS wire fields", () => {
  const f=fixture();const task={...f.task,requiredCapabilities:["minimal-implementation"]};
  expect(f.service.planWorkflow(task).data?.selectedSkills).toEqual(["ponytail"]);
  expect(f.service.planWorkflow({...task,csEngineeringBinding:f.binding}).ok).toBe(false);
  expect(f.service.planWorkflow({schemaVersion:"1.1.0",taskEnvelope:task,csEngineeringBinding:f.binding}).ok).toBe(false);
});

test("actual MCP tools validate a selected CS stage with synthetic server observations", async () => {
  const f=fixture();let sequence=0;
  const service=new WorkflowService(f.registry,f.validator,new InMemoryWorkflowStore(),null,{
    observe(binding) {
      const now=new Date();return {schemaVersion:"1.0.0",model:"synthetic-cs-mcp",modelClass:"deep",reasoningEffort:"high",source:"runtime",
        observedAt:now.toISOString(),observationId:`cs-synthetic-${String(++sequence).padStart(8,"0")}`,taskId:binding.taskId,runId:binding.runId,
        stageId:binding.stageId,revision:binding.revision,actorId:"cs-synthetic-actor",expiresAt:new Date(now.getTime()+60000).toISOString()};
    },
  });
  const updates=new InMemoryPluginUpdateStore();
  updates.putPluginUpdateState({targetId:"agent-governance-suite",currentVersion:PLUGIN_INFO.version,latestVersion:PLUGIN_INFO.version,
    latestTag:`v${PLUGIN_INFO.version}`,latestCommit:"c".repeat(40),etag:"cs-synthetic",comparison:"up-to-date",lastAttemptAt:"2026-10-06T00:00:00.000Z",
    lastSuccessfulCheckAt:"2026-10-06T00:00:00.000Z",nextCheckAt:"2099-01-01T00:00:00.000Z",lastNotifiedVersion:null,lastNotifiedAt:null,lastErrorCode:null});
  const server=createMcpServer(service,new PluginUpdateService(updates),undefined,undefined,undefined,f.validator);
  const client=new Client({name:"cs-synthetic-fixture",version:"1.0.0"});
  const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(b);await client.connect(a);
  const call=async (name:string,args:Record<string,unknown>) => {
    const response=await client.callTool({name,arguments:args});const text=response.content as Array<{type:string;text?:string}>;
    return JSON.parse(text.find((c)=>c.type==="text")!.text!);
  };
  try {
    const planned=await call("plan_workflow",{schemaVersion:"1.0.0",taskEnvelope:f.task});expect(planned.ok,JSON.stringify(planned.error)).toBe(true);
    const frame:ConvergenceFrameV1={schemaVersion:"1.0.0",workspace:{workspaceId:"cs-mcp",locator:f.root},
      controlArtifacts:[{artifactId:"conditions",role:"validator",locator:path.join(f.root,"constraints.json"),digest:digest(f.root,"constraints.json")}],
      targetArtifacts:[{artifactId:"candidate",role:"candidate",locator:path.join(f.root,"candidate.json"),digest:digest(f.root,"candidate.json")}],
      operationalSettings:{maxAttemptsPerEpoch:3,maxEpochs:2,leaseTtlSeconds:300}};
    const opened=await call("open_convergence_root",{schemaVersion:"1.0.0",parentRootId:null,taskEnvelope:f.task,frame,userApprovalRefs:[]});expect(opened.ok).toBe(true);
    const claimed=await call("claim_workflow_attempt",{schemaVersion:"1.0.0",rootId:opened.data.rootId,expectedRevision:opened.data.revision,taskEnvelope:f.task,frame,plan:planned.data,actorId:"cs-synthetic-actor",outputTargets:["candidate/queue.py"],priorFailure:null});expect(claimed.ok).toBe(true);
    const started=await call("start_guarded_workflow",{schemaVersion:"1.0.0",leaseId:claimed.data.leaseId,expectedRootRevision:claimed.data.rootRevision,plan:planned.data});expect(started.ok).toBe(true);
    const stage=result(f,started.data);const args=JSON.parse(JSON.stringify(stage));delete args.executionContext;
    const recorded=await call("record_stage_result",args);expect(recorded.ok,JSON.stringify(recorded.error)).toBe(true);
    expect(recorded.data.stageResults[0].executionContext.actorId).toBe("cs-synthetic-actor");
    const finalized=await call("finalize_workflow",{runId:recorded.data.runId,expectedRevision:recorded.data.revision});expect(finalized.ok).toBe(true);
  } finally {await client.close();await server.close();}
});

test("file-backed CS output follows the same record and finalize validation", () => {
  const f=fixture();const stage=result(f);stage.outputFile={locator:path.join(f.root,"review.json"),digest:digest(f.root,"review.json")};stage.output.output=null;
  const recorded=f.service.recordStageResult(stage);expect(recorded.error).toBeNull();
  expect(f.service.finalizeWorkflow(recorded.data!.runId,recorded.data!.revision).data?.state).toBe("passed");
});

test("generated Claude review and copied deployment CLI validate without node_modules", () => {
  const f=fixture("claude-plugin");
  const recorded=f.service.recordStageResult(result(f));expect(recorded.error).toBeNull();
  expect(f.service.finalizeWorkflow(recorded.data!.runId,recorded.data!.revision).data?.state).toBe("passed");
  const installed=mkdtempSync(path.join(tmpdir(),"ags-cs-deployment-"));roots.push(installed);
  cpSync(path.join(repo,"claude-plugin/skills/cs-engineering"),path.join(installed,"skills/cs-engineering"),{recursive:true});
  cpSync(path.join(repo,"claude-plugin/runtime"),path.join(installed,"runtime"),{recursive:true});
  const checked=spawnSync(process.execPath,[path.join(installed,"skills/cs-engineering/scripts/validate.mjs"),"check-stage-bundle",
    "--root",f.root,"--input","stage-bundle.json","--bundle-digest",digest(f.root,"stage-bundle.json"),"--task-digest",convergenceDigest(f.task)],{encoding:"utf8",cwd:installed});
  expect(checked.status,checked.stdout+checked.stderr).toBe(0);
  expect(JSON.parse(checked.stdout).verdict).toBe("PASS");
});
