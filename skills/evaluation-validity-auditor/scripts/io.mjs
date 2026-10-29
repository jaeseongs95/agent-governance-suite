import { readFile } from "node:fs/promises";

export function argumentValue(args, name) {
  const index = args.indexOf(name);
  if (index < 0) return null;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
  return value;
}

export async function readJsonInput(args) {
  const file = argumentValue(args, "--input");
  if (file) return JSON.parse(await readFile(file, "utf8"));
  let raw = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) raw += chunk;
  if (!raw.trim()) throw new Error("Provide JSON through stdin or --input.");
  return JSON.parse(raw);
}

export async function readJsonFile(args, name) {
  const file = argumentValue(args, name);
  if (!file) throw new Error(`${name} is required.`);
  return JSON.parse(await readFile(file, "utf8"));
}

export function writeJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

// Render only a generated or revalidated report; never read source artifact prose.
const statuses = { PASS: "통과", FAIL: "실패", BLOCKED: "판정 보류" };
const checks = {
  ARTIFACT_INTEGRITY: "증거 파일과 동결 digest 일치",
  FRAME_FROZEN: "평가 조건의 사전 동결",
  CASE_MANIFEST_COMPLETE: "예정 사례 목록의 완전성",
  ROLE_INDEPENDENCE: "작성·실행·판정·감사 역할의 독립성",
  JUDGMENT_METHOD_VALID: "판정 방법의 적합성",
  AGGREGATION_RULE_VALID: "집계 규칙의 적합성",
  TIMING_PROVENANCE_VALID: "증거 관측 시점의 출처",
  NO_POSTHOC_INPUT: "평가 시작 뒤 입력 오염 여부",
  RUN_SET_COMPLETE: "예정 실행 목록의 완전성",
  RESULT_RECORDS_COMPLETE: "결과 레코드의 완전성",
  AGGREGATE_RECOMPUTED: "원래 분모를 유지한 집계 재계산",
  CLAIM_MATCHES: "공개 집계와 재계산 결과의 일치",
};
const reasons = {
  CHECK_PASSED: "필수 조건을 충족했습니다.",
  ARTIFACT_MISSING: "필수 증거 파일이 없거나 읽을 수 없습니다.",
  DIGEST_MISMATCH: "증거 파일이 동결한 내용과 다릅니다.",
  REQUIRED_ARTIFACT_ROLE_INVALID: "필수 증거의 역할 또는 개수가 올바르지 않습니다.",
  FRAME_FROZEN_AFTER_AUDIT: "평가 조건이 감사 이후에 동결됐습니다.",
  FRAME_FROZEN_AFTER_EXECUTION: "평가 조건이 실행 시작 이후에 동결됐습니다.",
  AUDIT_NOT_PRE_EXECUTION: "실행 전 감사의 시점 조건을 충족하지 못했습니다.",
  AUDIT_NOT_POST_EXECUTION: "실행 후 감사의 시점 조건을 충족하지 못했습니다.",
  RESULT_EVIDENCE_NOT_AVAILABLE_AT_AUDIT: "결과 증거가 감사 시점에 준비되지 않았습니다.",
  JSONL_PARSE_FAILED: "줄 단위 JSON 증거를 해석할 수 없습니다.",
  CASE_SCHEMA_INVALID: "사례 레코드가 정해진 형식과 다릅니다.",
  CASE_DUPLICATE: "사례가 중복됐습니다.",
  CASE_MISSING: "예정 사례가 누락됐습니다.",
  CASE_UNKNOWN: "예정 목록에 없는 사례가 있습니다.",
  CASE_ORDER_MISMATCH: "사례 순서가 동결 목록과 다릅니다.",
  ROLE_CONFLICT: "독립되어야 할 역할을 같은 사람이 맡았습니다.",
  SEMANTIC_LEXICAL_ONLY: "의미·품질 판단에 문자열 일치만 사용했습니다.",
  SELF_REPORT_ONLY: "자기보고만으로 판정했습니다.",
  JUDGMENT_METHOD_MISMATCH: "결과의 판정 방법·판정자·증거 연결이 동결 조건과 다릅니다.",
  ORACLE_BINDING_INVALID: "판정 기준과 oracle 증거의 연결이 올바르지 않습니다.",
  PROVENANCE_MISSING: "독립적으로 관측한 출처 또는 시점 증거가 부족합니다.",
  POSTHOC_INPUT: "평가 시작 뒤 관측된 통제 증거가 입력에 영향을 주었습니다.",
  RUN_DUPLICATE: "실행 레코드가 중복됐습니다.",
  RUN_MISSING: "예정 실행이 누락됐습니다.",
  RUN_UNKNOWN: "예정 목록에 없는 실행이 있습니다.",
  RESULT_SCHEMA_INVALID: "결과 레코드가 정해진 형식과 다릅니다.",
  RESULT_DUPLICATE: "같은 실행·사례·기준의 결과가 중복됐습니다.",
  RESULT_MISSING: "완료한 실행의 필수 결과가 누락됐습니다.",
  RESULT_UNKNOWN: "예정 목록에 없는 결과가 있습니다.",
  AGGREGATION_INVALID: "레코드 또는 집계 조건이 잘못되어 집계할 수 없습니다.",
  AGGREGATE_CLAIM_MISSING: "대조할 공개 집계가 없습니다.",
  AGGREGATE_CLAIM_INVALID: "공개 집계가 정해진 형식과 다릅니다.",
  AGGREGATE_MISMATCH: "공개 집계 또는 요청의 주장 값이 재계산 결과와 다릅니다.",
};
const limitations = {
  COOPERATIVE_PROVENANCE_ASSERTIONS: "역할 ID와 출처 표시는 호출자가 제공한 주장이며, 실제 신원을 인증하지 않았습니다.",
  JSON_JSONL_ONLY_V1: "이 검사는 정해진 JSON·JSONL 형식만 처리합니다.",
};

export function renderReportKo(report) {
  const pre = report.auditStage === "pre-execution";
  const c = report.coverage;
  const lines = [
    `결론: ${statuses[report.verdict]} (${report.verdict}), ${pre ? "실행 전 설계 준비" : "실행 후 평가 유효성"} 감사입니다.`,
    report.qualifiesAsQualityOrReleaseEvidence
      ? "품질·릴리스 판단의 평가 근거로 사용할 수 있습니다. 이 감사 자체가 릴리스를 승인하지는 않습니다."
      : "품질·릴리스 판단의 결과 근거로 사용할 수 없습니다.",
    `이유: ${report.verdict === "PASS" ? `이 단계의 필수 검사 ${report.checks.length}개가 모두 통과했습니다.` : "아래 실패 또는 보류 항목 때문에 필수 조건을 충족하지 못했습니다."}`,
    ...report.checks.map((item) => `- ${checks[item.checkId]}: ${statuses[item.status]}. ${reasons[item.code]} (${item.checkId}/${item.code})${item.evidenceRefs.length ? ` 근거: ${item.evidenceRefs.join(", ")}` : ""}`),
    `검증 범위: 사례 관측 ${c.observedCases} / 예정 ${c.expectedCases}, 실행 관측 ${c.observedRuns} / 예정 ${c.expectedRuns}, 결과 레코드 관측 ${c.observedResults} / 예정 ${c.expectedResults}.`,
    pre ? "실행 결과와 집계는 이 단계에서 검사하지 않았습니다." : "실패·시간초과 실행도 원래 분모에 포함하므로 관측 레코드 수와 분모는 다를 수 있습니다.",
    ...report.recomputedMetrics.map((m) => `- 지표 ${m.metricId}: 분자 ${m.numerator}, 분모 ${m.denominator}, 값 ${m.value}; 기준 ${m.comparator} ${m.threshold}: ${m.thresholdPassed ? "통과" : "미달"}, 주장 값 ${m.claimedValue}: ${m.claimMatches ? "일치" : "불일치"}.`),
    ...(!pre && !report.recomputedMetrics.length ? ["집계 지표가 생성되지 않았습니다. 유효한 결과로 해석하지 마세요."] : []),
    "한계: 제공된 평가 증거의 정합성을 검사했습니다. 모델 품질을 새로 채점하거나 대상 소스를 별도로 검증하지 않았습니다.",
    ...report.limitations.map((item) => `- ${limitations[item] ?? "추가로 선언된 한계입니다. 원 선언은 별도 확인이 필요합니다."} (${item})`),
    `원자료 연결: 감사 ${report.auditId}, 평가 ${report.target.evaluationId}, 대상 ${report.target.identifier}, 대상 digest ${report.target.digest}.`,
    `요청 digest ${report.requestDigest}; 기계 보고서 digest ${report.reportDigest}.`,
  ];
  return `${lines.join("\n")}\n`;
}
