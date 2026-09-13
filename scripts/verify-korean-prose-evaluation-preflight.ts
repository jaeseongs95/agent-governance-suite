import path from "node:path";
import process from "node:process";

import {
  preflightKoreanProseEvaluation,
  type KoreanProseEvaluationPhase,
} from "./korean-prose-evaluation-preflight.js";
import { EvaluationPreflightError } from "../mcp-server/src/evaluation-preflight.js";

const args = process.argv.slice(2).filter((argument) => argument !== "--");
const phase = args[0] as KoreanProseEvaluationPhase | undefined;
const run = Number(args[1]);
const evaluationRoot = args[2] ? path.resolve(args[2]) : null;
if (!phase || !["selection", "editing", "verification", "record"].includes(phase) || !Number.isInteger(run) || !evaluationRoot) {
  throw new Error("usage: <selection|editing|verification|record> <run> <evaluation-root>");
}

try {
  const result = await preflightKoreanProseEvaluation(phase, run, evaluationRoot);
  console.log(JSON.stringify({
    status: "passed",
    phase,
    run,
    caseCount: result.ids.length,
    digests: result.digests,
  }, null, 2));
} catch (error) {
  if (!(error instanceof EvaluationPreflightError)) throw error;
  console.error(JSON.stringify({
    status: "failed",
    code: error.code,
    message: error.message,
    details: error.details,
  }, null, 2));
  process.exitCode = 1;
}
