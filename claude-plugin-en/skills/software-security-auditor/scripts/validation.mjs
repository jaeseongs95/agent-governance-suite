import { readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { Ajv2020, addFormats } from "../../../runtime/schema-validation.mjs";
import { digest, digestBytes, safeRelative, targetDigest, validateSemantics } from "./core.mjs";

const load = (file) => JSON.parse(readFileSync(new URL(file, import.meta.url), "utf8"));
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const requestSchema = load("../contracts/security-audit-request.v1.schema.json");
const reportSchema = load("../contracts/security-audit-report.v1.schema.json");
ajv.addSchema(requestSchema);
export const validateRequest = ajv.getSchema(requestSchema.$id);
export const validateReportSchema = ajv.compile(reportSchema);

function readContained(root, relative) {
  if (!safeRelative(relative)) throw new Error("UNSAFE_PATH");
  const base = realpathSync(root);
  const actual = realpathSync(path.resolve(base, relative));
  const within = path.relative(base, actual);
  if (within === ".." || within.startsWith(`..${path.sep}`) || path.isAbsolute(within)) throw new Error("PATH_ESCAPE");
  if (!statSync(actual).isFile()) throw new Error("NOT_A_FILE");
  return readFileSync(actual);
}

export function snapshot(input, targetRoot) {
  const request = structuredClone(input);
  // Check shape and path inventory before touching any target file.
  if (!validateRequest(request)) throw new Error(`INVALID_INPUT: ${ajv.errorsText(validateRequest.errors)}`);
  if (new Set(request.target.files.map((item) => item.path)).size !== request.target.files.length) throw new Error("DUPLICATE_TARGET_PATH");
  request.target.files = request.target.files.map((item) => ({ path: item.path, digest: digestBytes(readContained(targetRoot, item.path)) }));
  return { request, requestDigest: digest(request), targetDigest: targetDigest(request) };
}

export function validateReport(request, report, { targetRoot, evidenceRoot }) {
  if (!validateRequest(request)) return ["INVALID_REQUEST_SCHEMA"];
  if (!validateReportSchema(report)) return ["INVALID_REPORT_SCHEMA"];
  const errors = validateSemantics(report);
  if (digest(request) !== report.requestDigest) errors.push("REQUEST_BINDING_MISMATCH");
  const verify = (root, item, label) => {
    try {
      if (digestBytes(readContained(root, item.path)) !== item.digest) errors.push(`STALE_${label}`);
    } catch (error) { errors.push(`${label}: ${error.message}`); }
  };
  for (const item of request.target.files) verify(targetRoot, item, "TARGET");
  for (const item of request.providedEvidence) verify(evidenceRoot, item, "PROVIDED_EVIDENCE");
  for (const item of report.evidence) verify(evidenceRoot, item, "EVIDENCE");
  return [...new Set(errors)];
}
