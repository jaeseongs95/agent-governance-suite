import { Ajv2020 } from "../../../runtime/schema-validation.mjs";
import taskEnvelopeSchema from "../../../contracts/task-envelope.v1.schema.json" with { type: "json" };
import inputSchema from "../contracts/acceptance-evidence-input.v1.schema.json" with { type: "json" };
import reportSchema from "../contracts/acceptance-evidence-report.v1.schema.json" with { type: "json" };
import reportValidationSchema from "../contracts/acceptance-report-validation.v1.schema.json" with { type: "json" };
import providerResultSchema from "../integration/provider-result.v1.schema.json" with { type: "json" };

const ajv = new Ajv2020({ allErrors: true, strict: true });
const taskEnvelopeAlias = structuredClone(taskEnvelopeSchema);
taskEnvelopeAlias.$id = new URL("./upstream/task-envelope.v1.schema.json", inputSchema.$id).href;
ajv.addSchema(taskEnvelopeAlias);

export const validateTaskEnvelopeSchema = ajv.compile(taskEnvelopeSchema);
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
