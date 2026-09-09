#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

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
  if (!report || !intent || Number.isNaN(now.getTime())) return invalid("INVALID_INPUT", "report, intent와 유효한 verificationTime이 필요합니다.", report);
  const reportValid = validateMutationReport(report);
  const intentValid = validateMutationIntent(intent);
  if (!reportValid || !intentValid) {
    const details = [...(!reportValid ? contractErrors(validateMutationReport).map((item) => `report${item}`) : []), ...(!intentValid ? contractErrors(validateMutationIntent).map((item) => `intent${item}`) : [])];
    return invalid("INVALID_INPUT", `계약 검증에 실패했습니다: ${details.join("; ")}`, report);
  }
  if (report.verdict !== "READY") return invalid("INVALID_TRANSITION", "READY receipt만 실행 직전 재검증할 수 있습니다.", report);
  const observedAt = new Date(report.observedAt);
  if (now.getTime() < observedAt.getTime()) return invalid("STALE_REVISION", "검증 시각이 receipt 관측 시각보다 빠릅니다.", report);
  const baseline = evaluatePreflight(intent, { now: report.observedAt });
  if (baseline.verdict !== "READY" || canonicalJson(baseline) !== canonicalJson(report)) {
    return invalid("STALE_REVISION", "receipt가 원 관측 시각의 intent, 증거 또는 고정 유효기간과 일치하지 않습니다.", report, baseline);
  }
  if (Date.parse(report.validUntil) <= now.getTime()) return invalid("STALE_REVISION", "preflight receipt가 만료됐습니다.", report, baseline);
  const current = evaluatePreflight(intent, { now });
  if (current.verdict !== "READY" || current.actionDigest !== report.actionDigest || current.targetDigest !== report.targetDigest) {
    return invalid("STALE_REVISION", "행동, 대상, 환경, 승인, fingerprint, 복구 계획 또는 영향 범위가 바뀌었습니다.", report, current);
  }
  return { schemaVersion: "1.0.0", valid: true, errorCode: null, reason: "receipt와 현재 mutation intent가 일치합니다. 이 결과는 실행 권한을 새로 부여하지 않습니다.", actionDigest: current.actionDigest, targetDigest: current.targetDigest };
}

async function readInput(argv) {
  const index = argv.indexOf("--input");
  if (index >= 0) return JSON.parse(await readFile(argv[index + 1], "utf8"));
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  return JSON.parse(raw);
}

async function main() {
  const output = verifyReceipt(await readInput(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(output)}\n`);
  process.exitCode = output.valid ? 0 : 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
