import { readFileSync } from "node:fs";

import { Ajv2020 } from "../../../runtime/schema-validation.mjs";

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

export const validateWorkspaceRequest = ajv.compile(load("../contracts/workspace-profile-request.v1.schema.json"));
export const validateWorkspaceProfile = ajv.compile(load("../contracts/workspace-convention-profile.v1.schema.json"));

export function contractErrors(validate) {
  return (validate.errors ?? []).map((error) => `${error.instancePath || "/"} ${error.message}`);
}
