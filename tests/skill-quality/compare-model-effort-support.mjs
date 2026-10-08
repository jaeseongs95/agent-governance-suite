import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { Ajv2020 } from "../../runtime/schema-validation.mjs";

const phase = process.argv[2];
if (!["baseline", "candidate"].includes(phase)) throw new Error("Use baseline or candidate");
const fixtureBytes = readFileSync(new URL("./model-effort-support-cases.json", import.meta.url));
const fixtureDigest = createHash("sha256").update(fixtureBytes).digest("hex");
if (fixtureDigest !== "8b9054c24b56a980126906b008c8da0f75be730f015c3791b6431a9b14098ceb") throw new Error("FIXTURE_CHANGED");
const schemaBytes = readFileSync(new URL("../../skills/model-effort-advisor/contracts/model-effort-advice.v1.schema.json", import.meta.url));
if (createHash("sha256").update(schemaBytes).digest("hex") !== "7150d4f934f9a9422c31fc9f94b7bd7d6b1ac1e6bd029233293c40c658c693fe") throw new Error("BASELINE_SCHEMA_CHANGED");
const validate = new Ajv2020({ allErrors: true, strict: false }).compile(JSON.parse(schemaBytes));
const guard = phase === "candidate"
  ? (await import("../../skills/model-effort-advisor/scripts/support-guard.mjs")).guardModelSupport : null;
const { cases } = JSON.parse(fixtureBytes);
const results = cases.map((item) => {
  const result = guard ? guard(item.advice, item.context) : { advice: item.advice };
  const advice = result.advice;
  const notice = advice.userNotice !== null;
  const oracleMatch = validate(advice) && advice.verdict === item.expected.verdict && notice === item.expected.notice
    && (!Object.hasOwn(item.expected, "exactModel") || advice.recommendation.exactModel === item.expected.exactModel);
  return { id: item.id, verdict: advice.verdict, notice, exactModel: advice.recommendation.exactModel,
    supportStatus: result.supportStatus ?? "BASELINE_HAS_NO_GUARD", oracleMatch };
});
console.log(JSON.stringify({ phase, fixtureDigest: "sha256:" + fixtureDigest,
  boundary: "Same accepted caller drafts, synthetic support context and semantic oracle; no native model or Cloud behavior inference",
  results, oracleFailures: results.filter((item) => !item.oracleMatch).map((item) => item.id) }, null, 2));
process.exitCode = results.every((item) => item.oracleMatch) ? 0 : 1;
