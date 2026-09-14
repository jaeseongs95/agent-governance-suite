import { readFileSync } from "node:fs";

import { Ajv2020 } from "../../../runtime/schema-validation.mjs";

const ajv = new Ajv2020({
  strict: true,
  allErrors: true,
  formats: {
    "date-time": { type: "string", validate: (value) => Number.isFinite(Date.parse(value)) },
    uuid: { type: "string", validate: (value) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) }
  }
});

function load(relative) {
  return JSON.parse(readFileSync(new URL(relative, import.meta.url), "utf8"));
}

export const validateRequest = ajv.compile(load("../contracts/token-usage-report-request.v1.schema.json"));
export const validateReport = ajv.compile(load("../contracts/token-usage-report.v1.schema.json"));
export const validateProviderResult = ajv.compile(load("../integration/provider-result.v1.schema.json"));

export function contractErrors(validate) {
  return (validate.errors ?? []).map((error) => `${error.instancePath || "/"} ${error.message}`);
}
