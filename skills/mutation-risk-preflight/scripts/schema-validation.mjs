import { readFileSync } from "node:fs";

import Ajv2020 from "ajv/dist/2020.js";

const ajv = new Ajv2020({
  strict: true,
  allErrors: true,
  formats: {
    "date-time": { type: "string", validate: (value) => Number.isFinite(Date.parse(value)) },
  },
});

function load(relative) {
  return JSON.parse(readFileSync(new URL(relative, import.meta.url), "utf8"));
}

export const validateMutationIntent = ajv.compile(load("../contracts/mutation-intent.v1.schema.json"));
export const validateMutationReport = ajv.compile(load("../contracts/mutation-preflight-report.v1.schema.json"));

export function contractErrors(validate) {
  return (validate.errors ?? []).map((error) => `${error.instancePath || "/"} ${error.message}`);
}
