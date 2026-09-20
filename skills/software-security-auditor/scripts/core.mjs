import { createHash } from "node:crypto";

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
export const digestBytes = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
export const digest = (value) => digestBytes(canonical(value));
export const targetDigest = (request) => digest(request.target);

export function safeRelative(value) {
  return typeof value === "string" && value.length > 0 && !/[\\:\x00-\x1f]/u.test(value)
    && !value.startsWith("/") && value.split("/").every((part) => part && part !== "." && part !== "..");
}

// Schema validation precedes this pure structural/relational check in both adapters.
export function validateSemantics(report) {
  const errors = [];
  const request = report.request;
  if (report.requestDigest !== digest(request)) errors.push("REQUEST_DIGEST_MISMATCH");
  if (report.targetDigest !== targetDigest(request)) errors.push("TARGET_DIGEST_MISMATCH");
  const unique = (items, key, label) => {
    const values = items.map((item) => item[key]);
    if (new Set(values).size !== values.length) errors.push(`DUPLICATE_${label}`);
    return new Set(values);
  };
  const paths = unique(request.target.files, "path", "TARGET_PATH");
  unique(request.providedEvidence, "path", "PROVIDED_EVIDENCE");
  const expected = unique(request.checks, "id", "REQUEST_CHECK");
  const checks = unique(report.checks, "id", "CHECK");
  const evidence = unique(report.evidence, "id", "EVIDENCE");
  unique(report.findings, "id", "FINDING");
  if (expected.size !== checks.size || [...expected].some((id) => !checks.has(id))) errors.push("CHECK_INVENTORY_MISMATCH");
  for (const item of [...request.target.files, ...request.providedEvidence, ...report.evidence]) {
    if (!safeRelative(item.path)) errors.push("UNSAFE_PATH");
  }
  for (const item of report.evidence) {
    if (item.targetDigest !== report.targetDigest) errors.push("STALE_EVIDENCE");
  }
  const checkMap = new Map(report.checks.map((item) => [item.id, item]));
  for (const item of [...report.checks, ...report.findings]) {
    if (item.evidenceRefs.some((ref) => !evidence.has(ref))) errors.push("UNKNOWN_EVIDENCE");
  }
  for (const item of report.checks) {
    if (item.status === "checked" && (item.evidenceRefs.length === 0 || item.method === "not-executed")) errors.push("CHECK_WITHOUT_EVIDENCE");
    if (item.status !== "checked" && item.method !== "not-executed") errors.push("UNEXECUTED_CHECK_METHOD");
  }
  for (const item of report.findings) {
    if (item.locations.some((location) => !paths.has(location.path))) errors.push("UNKNOWN_FINDING_LOCATION");
    if (item.checkIds.some((id) => !expected.has(id) || checkMap.get(id)?.status !== "checked")) errors.push("UNVERIFIED_FINDING_CHECK");
    if (item.status === "confirmed" && item.proof === "unverified") errors.push("UNVERIFIED_CONFIRMED_FINDING");
    if (item.proof === "local-reproduction") {
      if (!request.authorization.localReproduction || !item.checkIds.some((id) => checkMap.get(id)?.method === "local-reproduction")) errors.push("UNSUPPORTED_REPRODUCTION");
    }
  }
  if (!request.authorization.localReproduction && report.checks.some((item) => item.method === "local-reproduction")) errors.push("UNAUTHORIZED_REPRODUCTION");
  const missing = report.checks.filter((item) => item.status === "not-checked").length;
  const checked = report.checks.filter((item) => item.status === "checked").length;
  const expectedStatus = missing === 0 ? "complete" : checked > 0 ? "partial" : "blocked";
  if (report.status !== expectedStatus) errors.push("STATUS_COVERAGE_MISMATCH");
  if (missing > 0 && report.limitations.length === 0) errors.push("MISSING_LIMITATIONS");
  return [...new Set(errors)];
}
