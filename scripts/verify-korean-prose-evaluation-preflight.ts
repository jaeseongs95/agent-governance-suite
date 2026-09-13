import path from "node:path";
import process from "node:process";

import {
  preflightKoreanProseEvaluation,
  preflightStructuredKoreanProseEvaluation,
  type KoreanProseEvaluationPhase,
} from "./korean-prose-evaluation-preflight.js";
import { EvaluationPreflightError } from "../mcp-server/src/evaluation-preflight.js";

const args = process.argv.slice(2).filter((argument) => argument !== "--");
const cycleFlag = args.indexOf("--cycle-dir");
const cycleDirectory = cycleFlag >= 0 ? args[cycleFlag + 1] : null;
if (cycleFlag >= 0 && (!cycleDirectory || cycleDirectory.startsWith("--"))) throw new Error("--cycle-dir requires a path");
const digestFlag = args.indexOf("--expected-frame-digest");
const expectedFrameDigest = digestFlag >= 0 ? args[digestFlag + 1] : null;
if (digestFlag >= 0 && (!expectedFrameDigest || !/^sha256:[a-f0-9]{64}$/u.test(expectedFrameDigest))) {
  throw new Error("--expected-frame-digest requires a sha256 digest");
}
const validityDigestFlag = args.indexOf("--expected-validity-report-digest");
const expectedValidityReportDigest = validityDigestFlag >= 0 ? args[validityDigestFlag + 1] : null;
if (validityDigestFlag >= 0 && (!expectedValidityReportDigest || !/^sha256:[a-f0-9]{64}$/u.test(expectedValidityReportDigest))) {
  throw new Error("--expected-validity-report-digest requires a sha256 digest");
}
const omittedIndexes = new Set<number>();
if (cycleFlag >= 0) { omittedIndexes.add(cycleFlag); omittedIndexes.add(cycleFlag + 1); }
if (digestFlag >= 0) { omittedIndexes.add(digestFlag); omittedIndexes.add(digestFlag + 1); }
if (validityDigestFlag >= 0) { omittedIndexes.add(validityDigestFlag); omittedIndexes.add(validityDigestFlag + 1); }
const positional = args.filter((_, index) => !omittedIndexes.has(index));
const phase = positional[0] as KoreanProseEvaluationPhase | undefined;
const run = Number(positional[1]);
const evaluationRoot = positional[2] ? path.resolve(positional[2]) : null;
if (!phase || !["selection", "editing", "verification", "record"].includes(phase) || !Number.isInteger(run) || !evaluationRoot || positional.length !== 3) {
  throw new Error("usage: <selection|editing|verification|record> <run> <evaluation-root> [--cycle-dir <cycle-path> --expected-frame-digest <sha256:digest> --expected-validity-report-digest <sha256:digest>]");
}
if (cycleDirectory && (!expectedFrameDigest || !expectedValidityReportDigest)) {
  throw new Error("--expected-frame-digest and --expected-validity-report-digest are required with --cycle-dir");
}

try {
  const result = cycleDirectory
    ? await preflightStructuredKoreanProseEvaluation(phase, run, path.isAbsolute(cycleDirectory)
      ? cycleDirectory
      : path.resolve(evaluationRoot, cycleDirectory), expectedFrameDigest!, expectedValidityReportDigest!, evaluationRoot)
    : await preflightKoreanProseEvaluation(phase, run, evaluationRoot);
  console.log(JSON.stringify({
    status: "passed",
    phase,
    run,
    caseCount: "ids" in result ? result.ids.length : result.caseCount,
    ...("digests" in result ? { digests: result.digests } : { frameId: result.frameId, frameDigest: result.frameDigest }),
  }, null, 2));
} catch (error) {
  const isPreflightError = error instanceof EvaluationPreflightError;
  console.error(JSON.stringify({
    status: "failed",
    code: isPreflightError ? error.code : "READINESS_GATE_FAILED",
    message: error instanceof Error ? error.message : String(error),
    details: isPreflightError ? error.details : null,
  }, null, 2));
  process.exitCode = 1;
}
