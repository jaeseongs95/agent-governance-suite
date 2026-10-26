import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
const [inputPath, fixturePath] = process.argv.slice(2);
const inputs = JSON.parse(await readFile(inputPath));
const fixture = JSON.parse(await readFile(fixturePath));
assert.equal(inputs.old.commit, "b3285616c896afdcbb298e3a08dffd612ddfa7b8");
const serviceSource = await readFile(path.join(inputs.old.directory, "mcp-server/src/workflow-service.ts"));
assert.equal(createHash("sha256").update(serviceSource).digest("hex"), inputs.old.serviceSha256);
const load = relative => import(pathToFileURL(path.join(inputs.old.directory, relative)));
const [{ ContractValidator }, { FileSkillRegistry }, { SqliteWorkflowStore }, { WorkflowService }] = await Promise.all([load("mcp-server/src/schema-validator.ts"), load("mcp-server/src/registry.ts"), load("mcp-server/src/sqlite-workflow-store.ts"), load("mcp-server/src/workflow-service.ts")]);
const store = new SqliteWorkflowStore(fixture.databasePath);
const validator = new ContractValidator();
const service = new WorkflowService(new FileSkillRegistry(fixture.registryPath, validator), validator, store);
const save = (name, value) => writeFile(path.join(inputs.evidenceDirectory, name), JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
try {
  const planned = service.planWorkflow(fixture.task);
  assert.equal(planned.error, null);
  const plan = planned.data;
  assert.ok(plan.integrityToken);
  assert.equal(Object.hasOwn(plan.stages[0], "requiredAuditPhase"), false);
  await save("original-plan.json", plan); // Actual old public API output; never edited or re-signed.
  const opened = service.openConvergenceRoot({ schemaVersion: "1.0.0", parentRootId: null, taskEnvelope: fixture.task, frame: fixture.frame, userApprovalRefs: [] });
  assert.equal(opened.error, null);
  const claimed = service.claimWorkflowAttempt({ schemaVersion: "1.0.0", rootId: opened.data.rootId, expectedRevision: opened.data.revision, taskEnvelope: fixture.task, frame: fixture.frame, plan, actorId: "legacy-fixture-actor", outputTargets: ["candidate.txt"], priorFailure: null });
  assert.equal(claimed.error, null);
  const started = service.startGuardedWorkflow({ schemaVersion: "1.0.0", leaseId: claimed.data.leaseId, expectedRootRevision: claimed.data.rootRevision, plan });
  assert.equal(started.error, null);
  await save("original-receipt.json", store.getRun(started.data.runId));
  await save("original-history.json", store.getConvergenceSnapshot(opened.data.rootId));
  await save("producer-public-result.json", { sourceCommit: inputs.old.commit, sourceTree: inputs.old.tree, runId: started.data.runId, rootId: opened.data.rootId, revision: started.data.revision, originalMissingPhase: true, originalPublicPlanIssued: true, originalSigningKeyAccess: false, originalHmacRecalculation: false });
  console.log(JSON.stringify({ oldServiceIssuedOriginalPlan: true, guardedRunStarted: true, missingPhase: true }));
} finally { store.close(); }
