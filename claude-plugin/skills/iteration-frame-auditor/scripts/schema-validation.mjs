import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { addFormats, Ajv2020 } from "../../../runtime/schema-validation.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const load = (relative) => JSON.parse(readFileSync(path.join(root, relative), "utf8"));
const loadSuiteContract = (filename) => JSON.parse(readFileSync(path.resolve(root, "..", "..", "contracts", filename), "utf8"));

const requestSchema = load("contracts/iteration-frame-audit-request.v1.schema.json");
const comparisonSchema = load("contracts/iteration-frame-comparison.v1.schema.json");
const convergenceFrameSchema = loadSuiteContract("convergence-frame.v1.schema.json");
const reviewSchema = loadSuiteContract("convergence-review.v1.schema.json");

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
ajv.addSchema(convergenceFrameSchema);
export const validateRequestSchema = ajv.compile(requestSchema);
export const validateComparisonSchema = ajv.compile(comparisonSchema);
export const validateReviewSchema = ajv.compile(reviewSchema);

export function compileAllSchemas() {
  const isolated = new Ajv2020({ allErrors: true, strict: true });
  addFormats(isolated);
  isolated.addSchema(convergenceFrameSchema);
  isolated.compile(requestSchema);
  isolated.compile(comparisonSchema);
  isolated.compile(reviewSchema);
}
