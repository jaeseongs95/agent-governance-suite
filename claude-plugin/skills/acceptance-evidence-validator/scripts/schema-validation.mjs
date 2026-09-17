import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Ajv2020 } from "../../../runtime/schema-validation.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const load = (relative) => JSON.parse(readFileSync(path.join(root, relative), "utf8"));

const taskEnvelopeSchema = load("contracts/upstream/task-envelope.v1.schema.json");
const inputSchema = load("contracts/acceptance-evidence-input.v1.schema.json");
const reportSchema = load("contracts/acceptance-evidence-report.v1.schema.json");
const reportValidationSchema = load("contracts/acceptance-report-validation.v1.schema.json");
const providerResultSchema = load("integration/provider-result.v1.schema.json");

const ajv = new Ajv2020({ allErrors: true, strict: true });
const taskEnvelopeAlias = structuredClone(taskEnvelopeSchema);
taskEnvelopeAlias.$id = new URL("./upstream/task-envelope.v1.schema.json", inputSchema.$id).href;
ajv.addSchema(taskEnvelopeAlias);

export const validateInputSchema = ajv.compile(inputSchema);
export const validateReportSchema = ajv.compile(reportSchema);
export const validateReportValidationSchema = ajv.compile(reportValidationSchema);

export function compileAllSchemas() {
  const isolated = new Ajv2020({ allErrors: true, strict: true });
  isolated.addSchema(taskEnvelopeAlias);
  isolated.compile(inputSchema);
  isolated.compile(reportSchema);
  isolated.compile(reportValidationSchema);
  new Ajv2020({ allErrors: true, strict: true }).compile(taskEnvelopeSchema);
  new Ajv2020({ allErrors: true, strict: true }).compile(providerResultSchema);
}
