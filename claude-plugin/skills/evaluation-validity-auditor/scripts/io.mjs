import { readFile } from "node:fs/promises";

import { hostText } from "./core.mjs";

export function argumentValue(args, name) {
  const index = args.indexOf(name);
  if (index < 0) return null;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(hostText("skillReports.evaluationValidityAuditor.optionRequiresValue", { name }));
  return value;
}

export async function readJsonInput(args) {
  const file = argumentValue(args, "--input");
  if (file) return JSON.parse(await readFile(file, "utf8"));
  let raw = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) raw += chunk;
  if (!raw.trim()) throw new Error(hostText("skillReports.evaluationValidityAuditor.provideJson"));
  return JSON.parse(raw);
}

export async function readJsonFile(args, name) {
  const file = argumentValue(args, name);
  if (!file) throw new Error(hostText("skillReports.evaluationValidityAuditor.optionRequired", { name }));
  return JSON.parse(await readFile(file, "utf8"));
}

export function writeJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

// Render only a generated or revalidated report; never read source artifact prose.
const statuses = {
  PASS: "skillReportsKo.evaluationValidityAuditor.statusPass",
  FAIL: "skillReportsKo.evaluationValidityAuditor.statusFail",
  BLOCKED: "skillReportsKo.evaluationValidityAuditor.statusBlocked",
};
const checks = {
  ARTIFACT_INTEGRITY: "skillReportsKo.evaluationValidityAuditor.checkArtifactIntegrity",
  FRAME_FROZEN: "skillReportsKo.evaluationValidityAuditor.checkFrameFrozen",
  CASE_MANIFEST_COMPLETE: "skillReportsKo.evaluationValidityAuditor.checkCaseManifestComplete",
  ROLE_INDEPENDENCE: "skillReportsKo.evaluationValidityAuditor.checkRoleIndependence",
  JUDGMENT_METHOD_VALID: "skillReportsKo.evaluationValidityAuditor.checkJudgmentMethodValid",
  AGGREGATION_RULE_VALID: "skillReportsKo.evaluationValidityAuditor.checkAggregationRuleValid",
  TIMING_PROVENANCE_VALID: "skillReportsKo.evaluationValidityAuditor.checkTimingProvenanceValid",
  NO_POSTHOC_INPUT: "skillReportsKo.evaluationValidityAuditor.checkNoPosthocInput",
  RUN_SET_COMPLETE: "skillReportsKo.evaluationValidityAuditor.checkRunSetComplete",
  RESULT_RECORDS_COMPLETE: "skillReportsKo.evaluationValidityAuditor.checkResultRecordsComplete",
  AGGREGATE_RECOMPUTED: "skillReportsKo.evaluationValidityAuditor.checkAggregateRecomputed",
  CLAIM_MATCHES: "skillReportsKo.evaluationValidityAuditor.checkClaimMatches",
};
const reasons = {
  CHECK_PASSED: "skillReportsKo.evaluationValidityAuditor.reasonCheckPassed",
  ARTIFACT_MISSING: "skillReportsKo.evaluationValidityAuditor.reasonArtifactMissing",
  DIGEST_MISMATCH: "skillReportsKo.evaluationValidityAuditor.reasonDigestMismatch",
  REQUIRED_ARTIFACT_ROLE_INVALID: "skillReportsKo.evaluationValidityAuditor.reasonRequiredArtifactRoleInvalid",
  FRAME_FROZEN_AFTER_AUDIT: "skillReportsKo.evaluationValidityAuditor.reasonFrameFrozenAfterAudit",
  FRAME_FROZEN_AFTER_EXECUTION: "skillReportsKo.evaluationValidityAuditor.reasonFrameFrozenAfterExecution",
  AUDIT_NOT_PRE_EXECUTION: "skillReportsKo.evaluationValidityAuditor.reasonAuditNotPreExecution",
  AUDIT_NOT_POST_EXECUTION: "skillReportsKo.evaluationValidityAuditor.reasonAuditNotPostExecution",
  RESULT_EVIDENCE_NOT_AVAILABLE_AT_AUDIT: "skillReportsKo.evaluationValidityAuditor.reasonResultEvidenceNotAvailableAtAudit",
  JSONL_PARSE_FAILED: "skillReportsKo.evaluationValidityAuditor.reasonJsonlParseFailed",
  CASE_SCHEMA_INVALID: "skillReportsKo.evaluationValidityAuditor.reasonCaseSchemaInvalid",
  CASE_DUPLICATE: "skillReportsKo.evaluationValidityAuditor.reasonCaseDuplicate",
  CASE_MISSING: "skillReportsKo.evaluationValidityAuditor.reasonCaseMissing",
  CASE_UNKNOWN: "skillReportsKo.evaluationValidityAuditor.reasonCaseUnknown",
  CASE_ORDER_MISMATCH: "skillReportsKo.evaluationValidityAuditor.reasonCaseOrderMismatch",
  ROLE_CONFLICT: "skillReportsKo.evaluationValidityAuditor.reasonRoleConflict",
  SEMANTIC_LEXICAL_ONLY: "skillReportsKo.evaluationValidityAuditor.reasonSemanticLexicalOnly",
  SELF_REPORT_ONLY: "skillReportsKo.evaluationValidityAuditor.reasonSelfReportOnly",
  JUDGMENT_METHOD_MISMATCH: "skillReportsKo.evaluationValidityAuditor.reasonJudgmentMethodMismatch",
  ORACLE_BINDING_INVALID: "skillReportsKo.evaluationValidityAuditor.reasonOracleBindingInvalid",
  PROVENANCE_MISSING: "skillReportsKo.evaluationValidityAuditor.reasonProvenanceMissing",
  POSTHOC_INPUT: "skillReportsKo.evaluationValidityAuditor.reasonPosthocInput",
  RUN_DUPLICATE: "skillReportsKo.evaluationValidityAuditor.reasonRunDuplicate",
  RUN_MISSING: "skillReportsKo.evaluationValidityAuditor.reasonRunMissing",
  RUN_UNKNOWN: "skillReportsKo.evaluationValidityAuditor.reasonRunUnknown",
  RESULT_SCHEMA_INVALID: "skillReportsKo.evaluationValidityAuditor.reasonResultSchemaInvalid",
  RESULT_DUPLICATE: "skillReportsKo.evaluationValidityAuditor.reasonResultDuplicate",
  RESULT_MISSING: "skillReportsKo.evaluationValidityAuditor.reasonResultMissing",
  RESULT_UNKNOWN: "skillReportsKo.evaluationValidityAuditor.reasonResultUnknown",
  AGGREGATION_INVALID: "skillReportsKo.evaluationValidityAuditor.reasonAggregationInvalid",
  AGGREGATE_CLAIM_MISSING: "skillReportsKo.evaluationValidityAuditor.reasonAggregateClaimMissing",
  AGGREGATE_CLAIM_INVALID: "skillReportsKo.evaluationValidityAuditor.reasonAggregateClaimInvalid",
  AGGREGATE_MISMATCH: "skillReportsKo.evaluationValidityAuditor.reasonAggregateMismatch",
};
const limitations = {
  COOPERATIVE_PROVENANCE_ASSERTIONS: "skillReportsKo.evaluationValidityAuditor.limitationCooperativeProvenance",
  JSON_JSONL_ONLY_V1: "skillReportsKo.evaluationValidityAuditor.limitationJsonJsonlOnly",
};

export function renderReportKo(report) {
  const pre = report.auditStage === "pre-execution";
  const c = report.coverage;
  const lines = [
    hostText("skillReportsKo.evaluationValidityAuditor.reportConclusion", { status: hostText(statuses[report.verdict]), verdict: report.verdict, stage: pre ? "pre" : "post" }),
    report.qualifiesAsQualityOrReleaseEvidence
      ? hostText("skillReportsKo.evaluationValidityAuditor.reportQualifies")
      : hostText("skillReportsKo.evaluationValidityAuditor.reportNotQualified"),
    report.verdict === "PASS"
      ? hostText("skillReportsKo.evaluationValidityAuditor.reportReasonAllPassed", { count: report.checks.length })
      : hostText("skillReportsKo.evaluationValidityAuditor.reportReasonNotPassed"),
    ...report.checks.map((item) => {
      const params = { check: hostText(checks[item.checkId]), status: hostText(statuses[item.status]), reason: hostText(reasons[item.code]), checkId: item.checkId, code: item.code };
      return item.evidenceRefs.length
        ? hostText("skillReportsKo.evaluationValidityAuditor.reportCheckLineWithEvidence", { ...params, refs: item.evidenceRefs.join(", ") })
        : hostText("skillReportsKo.evaluationValidityAuditor.reportCheckLine", params);
    }),
    hostText("skillReportsKo.evaluationValidityAuditor.reportCoverage", {
      observedCases: c.observedCases, expectedCases: c.expectedCases,
      observedRuns: c.observedRuns, expectedRuns: c.expectedRuns,
      observedResults: c.observedResults, expectedResults: c.expectedResults,
    }),
    pre ? hostText("skillReportsKo.evaluationValidityAuditor.reportPreExecutionNotChecked") : hostText("skillReportsKo.evaluationValidityAuditor.reportDenominatorNote"),
    ...report.recomputedMetrics.map((m) => hostText("skillReportsKo.evaluationValidityAuditor.reportMetricLine", {
      metricId: m.metricId, numerator: m.numerator, denominator: m.denominator, value: m.value,
      comparator: m.comparator, threshold: m.threshold, thresholdPassed: String(m.thresholdPassed),
      claimedValue: m.claimedValue, claimMatches: String(m.claimMatches),
    })),
    ...(!pre && !report.recomputedMetrics.length ? [hostText("skillReportsKo.evaluationValidityAuditor.reportNoMetrics")] : []),
    hostText("skillReportsKo.evaluationValidityAuditor.reportLimitationsIntro"),
    ...report.limitations.map((item) => hostText("skillReportsKo.evaluationValidityAuditor.reportLimitationLine", {
      text: hostText(Object.hasOwn(limitations, item) ? limitations[item] : "skillReportsKo.evaluationValidityAuditor.limitationUnknown"), code: item,
    })),
    hostText("skillReportsKo.evaluationValidityAuditor.reportBindings", { auditId: report.auditId, evaluationId: report.target.evaluationId, identifier: report.target.identifier, digest: report.target.digest }),
    hostText("skillReportsKo.evaluationValidityAuditor.reportDigests", { requestDigest: report.requestDigest, reportDigest: report.reportDigest }),
  ];
  return `${lines.join("\n")}\n`;
}
