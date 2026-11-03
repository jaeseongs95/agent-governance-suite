import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020, addFormats } from "../../../runtime/schema-validation.mjs";
import { hostText } from "../../../runtime/i18n.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const files = {
  request: "contracts/change-scope-request.v1.schema.json",
  baseline: "contracts/workspace-baseline.v1.schema.json",
  report: "contracts/change-scope-report.v1.schema.json",
  taskEnvelope: "../../contracts/task-envelope.v1.schema.json"
};
const schemas = Object.fromEntries(Object.entries(files).map(([name, file]) => [name, JSON.parse(readFileSync(join(root, file), "utf8"))]));
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
for (const schema of Object.values(schemas)) ajv.addSchema(schema);
const validators = Object.fromEntries(Object.entries(schemas).map(([name, schema]) => [name, ajv.getSchema(schema.$id)]));

export function assertSchema(name, value) {
  const validate = validators[name];
  if (!validate(value)) {
    const detail = validate.errors?.map((error) => `${error.instancePath || "/"} ${error.message}`).join("; ") ?? hostText("skillScripts.changeScope.unknownSchemaError");
    throw new Error(hostText("skillScripts.changeScope.schemaFailed", { name, detail }));
  }
  return value;
}
