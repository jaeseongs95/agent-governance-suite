import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const load = (relative) => JSON.parse(readFileSync(path.join(root, relative), "utf8"));

const inputSchema = load("contracts/failure-episode-set.v1.schema.json");
const reportSchema = load("contracts/diagnosis-report.v1.schema.json");
const providerResultSchema = load("integration/provider-result.v1.schema.json");

const ajv = new Ajv2020({ allErrors: true, strict: true });
ajv.addSchema(inputSchema);
export const validateInputSchema = ajv.getSchema(inputSchema.$id);
export const validateReportSchema = ajv.compile(reportSchema);

export function compileAllSchemas() {
  const isolated = new Ajv2020({ allErrors: true, strict: true });
  isolated.addSchema(inputSchema);
  isolated.compile(reportSchema);
  new Ajv2020({ allErrors: true, strict: true }).compile(providerResultSchema);
}
