import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { Ajv2020 } from "../../../runtime/schema-validation.mjs";

const classes = ["lightweight", "general", "deep", "frontier"];
const efforts = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
const schema = JSON.parse(readFileSync(new URL("../contracts/model-effort-advice.v1.schema.json", import.meta.url), "utf8"));
const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema);
const text = (value) => typeof value === "string" && value.trim().length > 0;
const within = (value, min, max, order) => order.indexOf(value) >= order.indexOf(min) && order.indexOf(value) <= order.indexOf(max);

// The caller verifies provenance; this guard cannot authenticate metadata or classify model names.
export function guardModelSupport(advice, context = {}) {
  if (!validate(advice)) throw new Error("INVALID_ADVICE");
  const result = structuredClone(advice);
  const current = context?.currentSelection;
  const evidence = context?.supportEvidence;
  let supportStatus = "SUPPORTED";
  if (!current || !["runtime", "user", "screenshot"].includes(current.source)
    || !text(current.provider) || !text(current.model) || !efforts.includes(current.reasoningEffort)) {
    supportStatus = "CURRENT_SELECTION_UNOBSERVED";
  } else if (!evidence || !["host-runtime", "provider-official"].includes(evidence.kind)
    || !text(evidence.provider) || !text(evidence.locator) || !Array.isArray(evidence.models)
    || evidence.models.length > 256) {
    supportStatus = "SUPPORT_EVIDENCE_UNAVAILABLE";
  } else if (evidence.provider !== current.provider) {
    supportStatus = "SUPPORT_PROVIDER_MISMATCH";
  }
  const models = supportStatus === "SUPPORTED" ? evidence.models : [];
  const matches = models.filter((model) => model?.id === current?.model);
  const model = matches.length === 1 ? matches[0] : null;
  if (supportStatus === "SUPPORTED"
    && (!model || !classes.includes(model.modelClass) || !Array.isArray(model.reasoningEfforts)
      || !model.reasoningEfforts.every((effort) => efforts.includes(effort))
      || !model.reasoningEfforts.includes(current.reasoningEffort))) {
    supportStatus = "CURRENT_COMBINATION_UNSUPPORTED";
  }
  if (supportStatus !== "SUPPORTED") {
    result.verdict = "UNOBSERVABLE";
    result.observation = { status: "unobservable", source: null, model: null, modelClass: null, reasoningEffort: null };
    result.recommendation.exactModel = null;
    result.rationaleCodes = [...new Set([...result.rationaleCodes, "CURRENT_SELECTION_NOT_OBSERVED"])];
    result.userNotice = context?.explicitFitRequest === true
      ? "현재 설정 또는 해당 공급자의 지원 근거를 충분히 확인할 수 없습니다. 설정을 바꾸지 않고 요청을 계속 진행합니다."
      : null;
  } else {
    result.observation = {
      status: "observed", source: current.source, model: current.model,
      modelClass: model.modelClass, reasoningEffort: current.reasoningEffort,
    };
    result.rationaleCodes = result.rationaleCodes.filter((code) => code !== "CURRENT_SELECTION_NOT_OBSERVED");
    if (result.rationaleCodes.length === 0) throw new Error("MISSING_DEMAND_RATIONALE");
    const rec = result.recommendation;
    const exact = models.filter((item) => item?.id === rec.exactModel);
    if (exact.length !== 1 || !classes.includes(exact[0].modelClass)
      || !within(exact[0].modelClass, rec.modelClassMin, rec.modelClassMax, classes)
      || !Array.isArray(exact[0].reasoningEfforts)
      || !exact[0].reasoningEfforts.some((effort) => efforts.includes(effort)
        && within(effort, rec.reasoningEffortMin, rec.reasoningEffortMax, efforts))) rec.exactModel = null;
    const classRank = classes.indexOf(model.modelClass);
    const effortRank = efforts.indexOf(current.reasoningEffort);
    const minClass = classes.indexOf(rec.modelClassMin), maxClass = classes.indexOf(rec.modelClassMax);
    const minEffort = efforts.indexOf(rec.reasoningEffortMin), maxEffort = efforts.indexOf(rec.reasoningEffortMax);
    result.verdict = classRank < minClass || effortRank < minEffort ? "UNDER_PROVISIONED"
      : (classRank > maxClass && effortRank > maxEffort) || classRank - maxClass >= 2 || effortRank - maxEffort >= 2
        ? "OVER_PROVISIONED" : "ADEQUATE";
    result.userNotice = result.verdict === "ADEQUATE" ? null
      : `설정 안내: 이 요청의 권장 범위는 ${rec.modelClassMin}~${rec.modelClassMax} / ${rec.reasoningEffortMin}~${rec.reasoningEffortMax}입니다. 현재 설정은 ${result.verdict === "UNDER_PROVISIONED" ? "부족할 수 있습니다" : "다소 과합니다"}. 설정은 자동으로 바꾸지 않고 요청은 계속 진행합니다.`;
  }
  if (!validate(result)) throw new Error("INVALID_GUARDED_ADVICE");
  return { advice: result, supportStatus };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    let input = "", bytes = 0;
    process.stdin.setEncoding("utf8");
    for await (const chunk of process.stdin) {
      bytes += Buffer.byteLength(chunk, "utf8");
      if (bytes > 1024 * 1024) throw new Error("INPUT_TOO_LARGE");
      input += chunk;
    }
    const request = JSON.parse(input);
    process.stdout.write(JSON.stringify(guardModelSupport(request.advice, request.context)) + "\n");
  } catch (error) {
    const code = error instanceof Error && error.message === "MISSING_DEMAND_RATIONALE"
      ? "MISSING_DEMAND_RATIONALE" : "INVALID_INPUT";
    process.stderr.write(code + "\n");
    process.exitCode = 2;
  }
}
