#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { hostText } from "../../../runtime/i18n.mjs";
import { canonicalJson, evaluatePreflight } from "./evaluate-preflight.mjs";
import { contractErrors, validateMutationIntent, validateMutationReport } from "./schema-validation.mjs";

function invalid(errorCode, reason, report = null, fresh = null) {
  return {
    schemaVersion: "1.0.0",
    valid: false,
    errorCode,
    reason,
    actionDigest: fresh?.actionDigest ?? report?.actionDigest ?? null,
    targetDigest: fresh?.targetDigest ?? report?.targetDigest ?? null,
  };
}

export function verifyReceipt(input) {
  const report = input?.report;
  const intent = input?.intent;
  const now = new Date(input?.verificationTime ?? Date.now());
  if (!report || !intent || Number.isNaN(now.getTime())) return invalid("INVALID_INPUT", hostText("skillChecksKo.mutationRiskPreflightVerify.inputsRequired"), report);
  const reportValid = validateMutationReport(report);
  const intentValid = validateMutationIntent(intent);
  if (!reportValid || !intentValid) {
    const details = [...(!reportValid ? contractErrors(validateMutationReport).map((item) => `report${item}`) : []), ...(!intentValid ? contractErrors(validateMutationIntent).map((item) => `intent${item}`) : [])];
    return invalid("INVALID_INPUT", hostText("skillChecksKo.mutationRiskPreflightVerify.contractViolation", { details: details.join("; ") }), report);
  }
  if (report.verdict !== "READY") return invalid("INVALID_TRANSITION", hostText("skillChecksKo.mutationRiskPreflightVerify.onlyReadyReceipt"), report);
  const observedAt = new Date(report.observedAt);
  if (now.getTime() < observedAt.getTime()) return invalid("STALE_REVISION", hostText("skillChecksKo.mutationRiskPreflightVerify.verificationBeforeObservation"), report);
  const baseline = evaluatePreflight(intent, { now: report.observedAt });
  if (baseline.verdict !== "READY" || canonicalJson(baseline) !== canonicalJson(report)) {
    return invalid("STALE_REVISION", hostText("skillChecksKo.mutationRiskPreflightVerify.receiptMismatchAtObservation"), report, baseline);
  }
  const current = evaluatePreflight(intent, { now });
  if (current.verdict !== "READY" || current.actionDigest !== report.actionDigest || current.targetDigest !== report.targetDigest) {
    return invalid("STALE_REVISION", hostText("skillChecksKo.mutationRiskPreflightVerify.intentChangedSinceReceipt"), report, current);
  }
  return { schemaVersion: "1.0.0", valid: true, errorCode: null, reason: hostText("skillChecksKo.mutationRiskPreflightVerify.receiptMatches"), actionDigest: current.actionDigest, targetDigest: current.targetDigest };
}

async function readInput(argv) {
  const index = argv.indexOf("--input");
  if (index >= 0) return JSON.parse(await readFile(argv[index + 1], "utf8"));
  let raw = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) raw += chunk;
  return JSON.parse(raw);
}

async function main() {
  const output = verifyReceipt(await readInput(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(output)}\n`);
  process.exitCode = output.valid ? 0 : 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
