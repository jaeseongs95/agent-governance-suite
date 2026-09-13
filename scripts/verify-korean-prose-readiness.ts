import path from "node:path";
import process from "node:process";

import { evaluateKoreanProseReadiness } from "./korean-prose-readiness.js";

const args = process.argv.slice(2).filter((argument) => argument !== "--");
const requireQuality = args.includes("--require-quality");
const digestFlag = args.indexOf("--expected-frame-digest");
const expectedFrameDigest = digestFlag >= 0 ? args[digestFlag + 1] : null;
const validityDigestFlag = args.indexOf("--expected-validity-report-digest");
const expectedValidityReportDigest = validityDigestFlag >= 0 ? args[validityDigestFlag + 1] : null;
const qualityDigestFlag = args.indexOf("--expected-quality-report-digest");
const expectedQualityReportDigest = qualityDigestFlag >= 0 ? args[qualityDigestFlag + 1] : null;
const rootFlag = args.indexOf("--evaluation-root");
const evaluationRoot = rootFlag >= 0 ? args[rootFlag + 1] : null;
const omitted = new Set<number>();
if (digestFlag >= 0) { omitted.add(digestFlag); omitted.add(digestFlag + 1); }
if (validityDigestFlag >= 0) { omitted.add(validityDigestFlag); omitted.add(validityDigestFlag + 1); }
if (qualityDigestFlag >= 0) { omitted.add(qualityDigestFlag); omitted.add(qualityDigestFlag + 1); }
if (rootFlag >= 0) { omitted.add(rootFlag); omitted.add(rootFlag + 1); }
const positional = args.filter((argument, index) => argument !== "--require-quality" && !omitted.has(index));
const validDigest = (value: string | null): value is string => Boolean(value && /^sha256:[a-f0-9]{64}$/u.test(value));
if (positional.length !== 1 || !validDigest(expectedFrameDigest) || !validDigest(expectedValidityReportDigest)
  || (requireQuality && !validDigest(expectedQualityReportDigest))) {
  throw new Error("usage: <cycle-directory> --expected-frame-digest <sha256:digest> --expected-validity-report-digest <sha256:digest> [--evaluation-root <path>] [--require-quality --expected-quality-report-digest <sha256:digest>]");
}

try {
  const result = await evaluateKoreanProseReadiness(path.resolve(positional[0]!), {
    requireQuality,
    expectedFrameDigest,
    expectedValidityReportDigest,
    ...(expectedQualityReportDigest ? { expectedQualityReportDigest } : {}),
    ...(evaluationRoot ? { evaluationRoot: path.resolve(evaluationRoot) } : {}),
  });
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    status: "NOT_READY",
    reason: error instanceof Error ? error.message : String(error),
  }, null, 2));
  process.exitCode = 1;
}
