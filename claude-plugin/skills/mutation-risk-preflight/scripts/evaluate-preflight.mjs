#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { contractErrors, validateMutationIntent } from "./schema-validation.mjs";

const VERSION = "1.0.0";
export const PREFLIGHT_VALIDITY_MINUTES = 15;
const APPROVAL_ACTIONS = new Set(["delete", "deploy", "publish", "migrate", "permission-change", "billing", "global-config"]);
const RECOVERY_ACTIONS = new Set(["delete", "overwrite", "deploy", "publish", "migrate", "permission-change", "billing", "global-config"]);
const DATA_LOSS_ACTIONS = new Set(["delete", "overwrite", "migrate"]);

export function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string" || typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function digest(value) {
  return `sha256:${createHash("sha256").update(typeof value === "string" ? value : canonicalJson(value)).digest("hex")}`;
}

export function canonicalLocator(value) {
  const uriInput = String(value).trim().replaceAll("\\", "/");
  const uri = uriInput.match(/^([a-z][a-z0-9+.-]*:\/\/)(.*)$/i);
  if (uri) return uri[1].toLowerCase() + uri[2].replace(/\/+/g, "/").replace(/\/$/, "");
  const raw = String(value).trim().replaceAll("\\", "/");
  const text = raw.startsWith("//") ? `//${raw.slice(2).replace(/\/+/g, "/")}` : raw.replace(/\/+/g, "/");
  return text.replace(/^([A-Z]):/, (_, drive) => `${drive.toLowerCase()}:`).replace(/\/$/, "") || "/";
}

export function unsafeTarget(target) {
  const locator = canonicalLocator(target.locator);
  if (["/", ".", "..", "~"].includes(locator)) return "filesystem, home 또는 현재 디렉터리 루트는 허용되지 않습니다.";
  if (/^[a-z]:$/i.test(locator)) return "drive root는 허용되지 않습니다.";
  if (/^\/\/[^/]+\/[^/]+$/.test(locator)) return "UNC share root는 허용되지 않습니다.";
  if (/[*?\[\]]/.test(locator)) return "해석되지 않은 glob이 있습니다.";
  if (/\$\{|\$[A-Za-z_]|%[^%]+%/.test(locator)) return "해석되지 않은 환경변수가 있습니다.";
  if (/^(home|filesystem-root|drive-root|repository-root)$/i.test(target.targetType)) return `${target.targetType} 전체는 허용되지 않습니다.`;
  return null;
}

function targetDigestFor(input) {
  return digest(input.targets.map((target) => ({ ...target, locator: canonicalLocator(target.locator) })).sort((a, b) => a.locator.localeCompare(b.locator)));
}

function sortedCanonical(items) {
  return [...items].sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)));
}

function canonicalIntentForDigest(input, targetDigest) {
  return {
    operationId: input.operationId,
    actionClass: input.actionClass,
    plannedCommandOrTool: input.plannedCommandOrTool,
    targetDigest,
    scopeRef: {
      ...input.scopeRef,
      locator: canonicalLocator(input.scopeRef.locator),
      includedTargets: input.scopeRef.includedTargets.map(canonicalLocator).sort(),
      excludedTargets: input.scopeRef.excludedTargets.map(canonicalLocator).sort(),
    },
    authorizationRef: {
      ...input.authorizationRef,
      locator: canonicalLocator(input.authorizationRef.locator),
      allowedActions: [...input.authorizationRef.allowedActions].sort(),
      allowedTargets: input.authorizationRef.allowedTargets.map(canonicalLocator).sort(),
      environments: [...input.authorizationRef.environments].sort(),
    },
    approvalEvidenceRefs: sortedCanonical(input.approvalEvidenceRefs.map((approval) => ({
      ...approval,
      locator: canonicalLocator(approval.locator),
      targetLocators: approval.targetLocators.map(canonicalLocator).sort(),
      environments: [...approval.environments].sort(),
    }))),
    currentStateEvidenceRefs: sortedCanonical(input.currentStateEvidenceRefs.map((evidence) => ({
      ...evidence,
      locator: canonicalLocator(evidence.locator),
      targetLocator: canonicalLocator(evidence.targetLocator),
    }))),
    recoveryPlan: input.recoveryPlan,
    expectedBlastRadius: input.expectedBlastRadius,
  };
}

function actionDigestFor(input, targetDigest) {
  return digest(canonicalIntentForDigest(input, targetDigest));
}

function refLocators(refs) {
  return refs.map((item) => item.locator).filter(Boolean);
}

function approvalStatus(input, now, required) {
  if (!required) return { status: "not-required", refs: [] };
  if (input.approvalEvidenceRefs.length === 0) return { status: "missing", refs: [] };
  const targetLocators = input.targets.map((target) => canonicalLocator(target.locator));
  let sawMatchingExpired = false;
  for (const approval of input.approvalEvidenceRefs) {
    const matches = approval.operationId === input.operationId
      && approval.actionClass === input.actionClass
      && targetLocators.every((target) => approval.targetLocators.map(canonicalLocator).includes(target))
      && input.targets.every((target) => approval.environments.includes(target.environment));
    if (!matches) continue;
    if (Date.parse(approval.expiresAt) <= now.getTime()) sawMatchingExpired = true;
    else return { status: "observed", refs: [approval.locator] };
  }
  return { status: sawMatchingExpired ? "stale" : "mismatched", refs: refLocators(input.approvalEvidenceRefs) };
}

function blockedReport(input, reasons, now) {
  const safeInput = input && typeof input === "object" ? input : {};
  const suppliedBlastRadius = safeInput.expectedBlastRadius;
  const blastRadius = suppliedBlastRadius
    && Number.isInteger(suppliedBlastRadius.affectedTargets)
    && suppliedBlastRadius.affectedTargets >= 1
    && Number.isInteger(suppliedBlastRadius.affectedUsers)
    && suppliedBlastRadius.affectedUsers >= 0
    && typeof suppliedBlastRadius.external === "boolean"
    && typeof suppliedBlastRadius.description === "string"
    && suppliedBlastRadius.description.length > 0
    ? {
      affectedTargets: suppliedBlastRadius.affectedTargets,
      affectedUsers: suppliedBlastRadius.affectedUsers,
      external: suppliedBlastRadius.external,
      description: suppliedBlastRadius.description,
    }
    : { affectedTargets: 1, affectedUsers: 0, external: false, description: "확인되지 않음" };
  const safeTargets = Array.isArray(safeInput.targets) ? safeInput.targets : [];
  const targetDigest = digest(safeTargets.map((target) => ({ locator: canonicalLocator(target?.locator ?? "unknown") })));
  const actionClass = APPROVAL_ACTIONS.has(safeInput.actionClass) || ["overwrite", "move", "other"].includes(safeInput.actionClass) ? safeInput.actionClass : "other";
  return {
    schemaVersion: VERSION, operationId: typeof safeInput.operationId === "string" && safeInput.operationId ? safeInput.operationId : "unknown", actionDigest: digest({ invalid: true, operationId: safeInput.operationId ?? null }), targetDigest,
    classification: { actionClass, reversibility: "conditional", externalImpact: false, dataLossPotential: false, permissionImpact: false },
    checks: [{ checkId: "input-validity", state: "failed", evidenceRefs: [], message: reasons.join(" ") }],
    approval: { required: false, status: "not-required", evidenceRefs: [] }, recovery: { available: false, restoreTested: false, irreversibilityAccepted: false, evidenceRefs: [] },
    blastRadius, unresolved: reasons,
    invalidationTriggers: ["입력 변경", "대상 변경"], validUntil: now.toISOString(), observedAt: now.toISOString(), verdict: "BLOCKED",
  };
}

export function evaluatePreflight(input, options = {}) {
  const now = options.now ? new Date(options.now) : new Date();
  const validationErrors = validateMutationIntent(input) ? [] : contractErrors(validateMutationIntent);
  if (Number.isNaN(now.getTime())) return blockedReport(input, ["평가 시각이 유효하지 않습니다."], new Date(0));
  if (validationErrors.length) return blockedReport(input, validationErrors, now);

  const targets = input.targets.map((target) => ({ ...target, locator: canonicalLocator(target.locator) }));
  const unsafe = targets.map((target) => unsafeTarget(target)).filter(Boolean);
  const targetDigest = targetDigestFor({ ...input, targets });
  const actionDigest = actionDigestFor(input, targetDigest);
  const externalImpact = Boolean(input.expectedBlastRadius.external || targets.some((target) => /^(production|prod|shared|external)$/i.test(target.environment)));
  const dataLossPotential = DATA_LOSS_ACTIONS.has(input.actionClass);
  const permissionImpact = input.actionClass === "permission-change";
  const approvalRequired = APPROVAL_ACTIONS.has(input.actionClass) || externalImpact;
  const approval = approvalStatus(input, now, approvalRequired);

  const targetLocators = targets.map((target) => target.locator);
  const scopeIncluded = targetLocators.every((target) => input.scopeRef.includedTargets.map(canonicalLocator).includes(target));
  const scopeExcluded = targetLocators.some((target) => input.scopeRef.excludedTargets.map(canonicalLocator).includes(target));
  const authorizationMatched = input.authorizationRef.allowedActions.includes(input.actionClass)
    && targetLocators.every((target) => input.authorizationRef.allowedTargets.map(canonicalLocator).includes(target))
    && targets.every((target) => input.authorizationRef.environments.includes(target.environment));
  const currentStateMatched = targets.every((target) => input.currentStateEvidenceRefs.some((evidence) => canonicalLocator(evidence.targetLocator) === target.locator && evidence.fingerprint === target.expectedFingerprint));
  const recoveryRequired = RECOVERY_ACTIONS.has(input.actionClass) || externalImpact;
  const recoverySufficient = !recoveryRequired || (input.recoveryPlan.available
    && Boolean(input.recoveryPlan.method && input.recoveryPlan.backupRef && input.recoveryPlan.restoreProcedureRef)
    && (Boolean(input.recoveryPlan.restoreTestEvidenceRef) || input.recoveryPlan.irreversibilityAccepted));
  const blastRadiusMatched = input.expectedBlastRadius.affectedTargets >= targets.length;

  const checks = [
    { checkId: "target-specificity", state: unsafe.length ? "failed" : "passed", evidenceRefs: [], message: unsafe.join(" ") || "모든 대상이 구체적으로 식별됐습니다." },
    { checkId: "scope-match", state: scopeIncluded && !scopeExcluded ? "passed" : "failed", evidenceRefs: [input.scopeRef.locator], message: scopeIncluded && !scopeExcluded ? "대상이 작업 범위 안에 있습니다." : "대상이 포함 범위에 없거나 제외 범위와 겹칩니다." },
    { checkId: "authorization-match", state: authorizationMatched ? "passed" : "failed", evidenceRefs: [input.authorizationRef.locator], message: authorizationMatched ? "행동, 대상과 환경이 허용 범위에 있습니다." : "권한 범위가 행동, 대상 또는 환경과 일치하지 않습니다." },
    { checkId: "current-state", state: currentStateMatched ? "passed" : "unknown", evidenceRefs: refLocators(input.currentStateEvidenceRefs), message: currentStateMatched ? "현재 fingerprint가 예상값과 일치합니다." : "모든 대상의 현재 fingerprint를 확인하지 못했습니다." },
    { checkId: "approval", state: approval.status === "observed" || approval.status === "not-required" ? "passed" : "unknown", evidenceRefs: approval.refs, message: `승인 상태: ${approval.status}` },
    { checkId: "recovery", state: recoverySufficient ? "passed" : "failed", evidenceRefs: [input.recoveryPlan.backupRef, input.recoveryPlan.restoreProcedureRef, input.recoveryPlan.restoreTestEvidenceRef].filter(Boolean), message: recoverySufficient ? "복구 또는 명시적 비가역성 수용 근거가 있습니다." : "복구 설계를 보완해야 합니다." },
    { checkId: "blast-radius", state: blastRadiusMatched ? "passed" : "failed", evidenceRefs: [], message: blastRadiusMatched ? "예상 영향 범위가 모든 대상을 포함합니다." : "예상 영향 범위가 대상 수보다 작습니다." },
  ];
  const unresolved = [];
  let verdict = "READY";
  if (unsafe.length || !scopeIncluded || scopeExcluded || !authorizationMatched) {
    verdict = "BLOCKED";
    unresolved.push(...unsafe, ...(!scopeIncluded || scopeExcluded ? ["작업 범위와 대상이 일치하지 않습니다."] : []), ...(!authorizationMatched ? ["권한 범위와 행동·대상·환경이 일치하지 않습니다."] : []));
  } else if (!currentStateMatched) {
    verdict = "NEEDS_INPUT";
    unresolved.push("모든 대상의 현재 fingerprint 근거가 필요합니다.");
  } else if (!["observed", "not-required"].includes(approval.status)) {
    verdict = "NEEDS_APPROVAL";
    unresolved.push(`현재 작업에 맞는 승인이 필요합니다: ${approval.status}`);
  } else if (!recoverySufficient || !blastRadiusMatched) {
    verdict = "NEEDS_REDESIGN";
    if (!recoverySufficient) unresolved.push("복구 계획이나 복구 검증 근거가 부족합니다.");
    if (!blastRadiusMatched) unresolved.push("영향 범위를 다시 계산해야 합니다.");
  }

  const recoveryRefs = [input.recoveryPlan.backupRef, input.recoveryPlan.restoreProcedureRef, input.recoveryPlan.restoreTestEvidenceRef].filter(Boolean);
  return {
    schemaVersion: VERSION, operationId: input.operationId, actionDigest, targetDigest,
    classification: { actionClass: input.actionClass, reversibility: input.recoveryPlan.irreversibilityAccepted ? "irreversible" : (recoverySufficient ? "reversible" : "conditional"), externalImpact, dataLossPotential, permissionImpact },
    checks,
    approval: { required: approvalRequired, status: approval.status, evidenceRefs: approval.refs },
    recovery: { available: input.recoveryPlan.available, restoreTested: Boolean(input.recoveryPlan.restoreTestEvidenceRef), irreversibilityAccepted: input.recoveryPlan.irreversibilityAccepted, evidenceRefs: recoveryRefs },
    blastRadius: input.expectedBlastRadius, unresolved: [...new Set(unresolved)],
    invalidationTriggers: ["action 또는 planned tool 변경", "target 또는 environment 변경", "current-state evidence 또는 fingerprint 변경", "scope 또는 authorization 변경", "승인 evidence의 만료 또는 범위 변경", "복구 계획 변경", "예상 blast radius 변경"],
    validUntil: new Date(now.getTime() + PREFLIGHT_VALIDITY_MINUTES * 60_000).toISOString(), observedAt: now.toISOString(), verdict,
  };
}

async function readInput(argv) {
  const index = argv.indexOf("--input");
  if (index >= 0) return JSON.parse(await readFile(argv[index + 1], "utf8"));
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  if (!raw.trim()) throw new Error("stdin 또는 --input으로 JSON 입력이 필요합니다.");
  return JSON.parse(raw);
}

async function main() {
  let output;
  try { output = evaluatePreflight(await readInput(process.argv.slice(2))); }
  catch (error) { output = blockedReport({}, [error instanceof Error ? error.message : String(error)], new Date()); }
  process.stdout.write(`${JSON.stringify(output)}\n`);
  process.exitCode = output.verdict === "READY" ? 0 : 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
