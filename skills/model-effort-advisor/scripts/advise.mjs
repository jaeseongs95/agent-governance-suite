import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { Ajv2020 } from "../../../runtime/schema-validation.mjs";
import { modelPolicySchema } from "../../../runtime/model-policy.mjs";
import { resolveModelSelection } from "../../coordinate-subagents/scripts/model-routing.mjs";

const requestSchema = JSON.parse(readFileSync(new URL("../contracts/subagent-model-request.v1.schema.json", import.meta.url), "utf8"));
const adviceSchema = JSON.parse(readFileSync(new URL("../contracts/subagent-model-advice.v1.schema.json", import.meta.url), "utf8"));
const ajv = new Ajv2020({ allErrors: true, strict: false }).addSchema(modelPolicySchema).addSchema(requestSchema);
const validateRequest = ajv.getSchema(requestSchema.$id);
const validateAdvice = ajv.compile(adviceSchema);

// The host supplies capabilities; the shared resolver owns every model/profile/floor decision.
// This boundary neither discovers the parent model nor dispatches or attests a worker.
export function adviseSubagentModel(input, customPresets) {
  if (!validateRequest(input)) throw new Error("INVALID_SUBAGENT_MODEL_REQUEST");
  if (customPresets !== undefined && (!customPresets || typeof customPresets !== "object" || Array.isArray(customPresets))) {
    throw new Error("INVALID_PRESETS");
  }
  const request = structuredClone(input);
  const { assignment, host, user } = request;
  const { id, capabilityReference, ...capabilities } = host;
  const profile = request.preference ?? "balanced";
  const routingOptions = {
    ...capabilities, role: assignment.role, profile,
    highRisk: ["high", "critical"].includes(assignment.riskLevel) || assignment.role === "independent-audit",
    ...(user ? { user } : {}),
  };
  let selectionPlan;
  try {
    selectionPlan = resolveModelSelection(routingOptions, customPresets);
  } catch (cause) {
    throw new Error("INVALID_ROUTING_DATA", { cause });
  }
  const advice = {
    schemaVersion: "1.0.0",
    status: selectionPlan.delivery === "blocked" ? "BLOCKED" : selectionPlan.selection ? "READY" : "INHERIT_UNVERIFIED",
    authorityEffect: "none", assignment, profile,
    capabilitySource: { hostId: id, reference: capabilityReference },
    routingOptions, selectionPlan,
  };
  if (!validateAdvice(advice)) throw new Error("INVALID_SUBAGENT_MODEL_ADVICE");
  return advice;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 0 && !(args.length === 2 && args[0] === "--presets" && args[1])) throw new Error("INVALID_ARGUMENTS");
    let input = "", bytes = 0;
    process.stdin.setEncoding("utf8");
    for await (const chunk of process.stdin) {
      bytes += Buffer.byteLength(chunk, "utf8");
      if (bytes > 1024 * 1024) throw new Error("INPUT_TOO_LARGE");
      input += chunk;
    }
    let presets;
    if (args.length) {
      try {
        presets = JSON.parse(readFileSync(args[1], "utf8"));
      } catch (cause) {
        throw new Error("INVALID_PRESETS", { cause });
      }
    }
    if (presets !== undefined && (!presets || typeof presets !== "object" || Array.isArray(presets))) throw new Error("INVALID_PRESETS");
    let request;
    try {
      request = JSON.parse(input);
    } catch (cause) {
      throw new Error("INVALID_JSON", { cause });
    }
    const advice = adviseSubagentModel(request, presets);
    process.stdout.write(JSON.stringify(advice) + "\n");
    if (advice.status === "BLOCKED") process.exitCode = 1;
  } catch (error) {
    // API errors retain the resolver's cause. The CLI exposes distinct fixed codes without input data.
    const publicCodes = ["INVALID_ARGUMENTS", "INPUT_TOO_LARGE", "INVALID_PRESETS", "INVALID_JSON",
      "INVALID_SUBAGENT_MODEL_REQUEST", "INVALID_ROUTING_DATA", "INVALID_SUBAGENT_MODEL_ADVICE"];
    const code = error instanceof Error && publicCodes.includes(error.message) ? error.message : "ADVISOR_FAILED";
    process.stderr.write(code + "\n");
    process.exitCode = 2;
  }
}
