import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Ajv2020 } from "../../../runtime/schema-validation.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const load = (relative) => JSON.parse(readFileSync(path.join(root, relative), "utf8"));
const requestSchema = load("contracts/recovery-strategy-selection-request.v1.schema.json");
const handoffSchema = load("contracts/recovery-handoff.v1.schema.json");
const bindingReportSchema = load("contracts/recovery-task-binding-report.v1.schema.json");
const providerResultSchema = load("integration/provider-result.v1.schema.json");
const failureEpisodeSetSchema = load("../blocker-diagnostician/contracts/failure-episode-set.v1.schema.json");
const diagnosisReportSchema = load("../blocker-diagnostician/contracts/diagnosis-report.v1.schema.json");
const taskEnvelopeSchema = load("../../contracts/task-envelope.v1.schema.json");
const workflowPlanSchema = load("../../contracts/workflow-plan.v1.schema.json");
const stageResultSchema = load("../../contracts/stage-result.v1.schema.json");
const workflowReceiptSchema = load("../../contracts/workflow-receipt.v1.schema.json");

const ajv = new Ajv2020({ allErrors: true, strict: true });
ajv.addSchema(failureEpisodeSetSchema);
export const validateRequestSchema = ajv.compile(requestSchema);
export const validateHandoffSchema = ajv.compile(handoffSchema);
export const validateBindingReportSchema = ajv.compile(bindingReportSchema);
export const validateDiagnosisReportSchema = ajv.compile(diagnosisReportSchema);
export const validateTaskEnvelopeSchema = ajv.compile(taskEnvelopeSchema);
const workflowAjv = new Ajv2020({ allErrors: true, strict: false });
for (const schema of [workflowPlanSchema, stageResultSchema, workflowReceiptSchema]) workflowAjv.addSchema(schema);
export const validateWorkflowReceiptSchema = workflowAjv.getSchema(workflowReceiptSchema.$id);

export function compileAllSchemas() {
  const isolated = new Ajv2020({ allErrors: true, strict: true });
  isolated.addSchema(failureEpisodeSetSchema);
  isolated.compile(requestSchema);
  isolated.compile(handoffSchema);
  isolated.compile(bindingReportSchema);
  isolated.compile(providerResultSchema);
  isolated.compile(diagnosisReportSchema);
  isolated.compile(taskEnvelopeSchema);
  const isolatedWorkflow = new Ajv2020({ allErrors: true, strict: false });
  for (const schema of [workflowPlanSchema, stageResultSchema, workflowReceiptSchema]) isolatedWorkflow.addSchema(schema);
}

export function schemaErrors(validate) {
  return (validate.errors ?? []).map((error) => `${error.instancePath || "/"} ${error.message}`);
}
