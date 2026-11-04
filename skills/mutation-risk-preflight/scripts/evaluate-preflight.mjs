#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { failureCode } from "../../../runtime/failure-diagnostics.mjs";
import { hostText } from "../../../runtime/i18n.mjs";
import { contractErrors, validateMutationIntent } from "./schema-validation.mjs";

const VERSION = "1.0.0";
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
  if (uri && !/^[a-z]:/i.test(uriInput)) return uri[1].toLowerCase() + uri[2].replace(/\/+/g, "/").replace(/\/$/, "");
  const raw = String(value).trim().replaceAll("\\", "/");
  const text = raw.startsWith("//") ? `//${raw.slice(2).replace(/\/+/g, "/")}` : raw.replace(/\/+/g, "/");
  // Lexical only: filesystem evidence must establish any symlink/realpath identity.
  const normalized = /^[a-z]:$/i.test(text) ? text : (/^[a-z]:/i.test(text) || text.startsWith("//") ? path.win32 : path.posix).normalize(text).replaceAll("\\", "/");
  return normalized.replace(/^([A-Z]):/, (_, drive) => `${drive.toLowerCase()}:`).replace(/\/$/, "") || "/";
}

export function unsafeTarget(target) {
  const locator = canonicalLocator(target.locator);
  if (["/", ".", "..", "~"].includes(locator)) return hostText("skillChecksKo.mutationRiskPreflight.unsafeRootTarget");
  if (/^[a-z]:(?:\.)?$/i.test(locator)) return hostText("skillChecksKo.mutationRiskPreflight.unsafeDriveRoot");
  if (/^\/\/[^/]+\/[^/]+$/.test(locator)) return hostText("skillChecksKo.mutationRiskPreflight.unsafeUncShareRoot");
  if (/[*?\[\]]/.test(target.locator)) return hostText("skillChecksKo.mutationRiskPreflight.unsafeUnresolvedGlob");
  if (/\$\{|\$[A-Za-z_]|%[^%]+%/.test(target.locator)) return hostText("skillChecksKo.mutationRiskPreflight.unsafeUnresolvedEnvironmentVariable");
  if (/^(home|filesystem-root|drive-root|repository-root)$/i.test(target.targetType)) return hostText("skillChecksKo.mutationRiskPreflight.unsafeWholeTargetType", { targetType: target.targetType });
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

// Report evidence lists are unique by contract; one evidence file may cover several targets.
function uniqueRefs(refs) {
  return [...new Set(refs.filter(Boolean))];
}

function refLocators(refs) {
  return uniqueRefs(refs.map((item) => item.locator));
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
    // A user approval carries no expiry unless its evidence states one; a stated expiry still applies.
    if (approval.expiresAt === undefined) return { status: "observed", refs: [approval.locator] };
    const expiresAt = Date.parse(approval.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= now.getTime()) sawMatchingExpired = true;
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
    : { affectedTargets: 1, affectedUsers: 0, external: false, description: hostText("skillChecksKo.mutationRiskPreflight.blastRadiusUnconfirmed") };
  const safeTargets = Array.isArray(safeInput.targets) ? safeInput.targets : [];
  const targetDigest = digest(safeTargets.map((target) => ({ locator: canonicalLocator(target?.locator ?? "unknown") })));
  const actionClass = APPROVAL_ACTIONS.has(safeInput.actionClass) || ["overwrite", "move", "other"].includes(safeInput.actionClass) ? safeInput.actionClass : "other";
  return {
    schemaVersion: VERSION, operationId: typeof safeInput.operationId === "string" && safeInput.operationId ? safeInput.operationId : "unknown", actionDigest: digest({ invalid: true, operationId: safeInput.operationId ?? null }), targetDigest,
    classification: { actionClass, reversibility: "conditional", externalImpact: false, dataLossPotential: false, permissionImpact: false },
    checks: [{ checkId: "input-validity", state: "failed", evidenceRefs: [], message: reasons.join(" ") }],
    approval: { required: false, status: "not-required", evidenceRefs: [] }, recovery: { available: false, restoreTested: false, irreversibilityAccepted: false, evidenceRefs: [] },
    blastRadius, unresolved: reasons,
    invalidationTriggers: [hostText("skillChecksKo.mutationRiskPreflight.invalidationInputChanged"), hostText("skillChecksKo.mutationRiskPreflight.invalidationTargetChanged")], observedAt: now.toISOString(), verdict: "BLOCKED",
  };
}

export function evaluatePreflight(input, options = {}) {
  const now = options.now ? new Date(options.now) : new Date();
  const validationErrors = validateMutationIntent(input) ? [] : contractErrors(validateMutationIntent);
  if (Number.isNaN(now.getTime())) return blockedReport(input, [hostText("skillChecksKo.mutationRiskPreflight.evaluationTimeInvalid")], new Date(0));
  if (validationErrors.length) return blockedReport(input, validationErrors, now);

  const targets = input.targets.map((target) => ({ ...target, locator: canonicalLocator(target.locator) }));
  const unsafe = input.targets.map((target) => unsafeTarget(target)).filter(Boolean);
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
  const containment = input.recoveryPlan.freshResourceContainment;
  const preparation = containment?.externalPreparation;
  const privateExternalPreparation = Boolean(preparation
    && externalImpact && ["deploy", "other"].includes(input.actionClass)
    && !targets.some((target) => /^(production|prod|shared)$/i.test(target.environment))
    && !input.recoveryPlan.backupRef && !input.recoveryPlan.restoreTestEvidenceRef);
  const containmentSufficient = Boolean(containment
    && ["permission-change", "deploy", "other"].includes(input.actionClass)
    && ((!externalImpact && !preparation) || privateExternalPreparation) && !dataLossPotential
    && input.recoveryPlan.available && !input.recoveryPlan.irreversibilityAccepted
    && input.recoveryPlan.method?.trim() && input.recoveryPlan.restoreProcedureRef?.trim()
    && containment.commandDigest === digest(input.plannedCommandOrTool)
    && containment.targetDigest === targetDigest
    && targets.every((target) => {
      const observations = input.currentStateEvidenceRefs.filter((evidence) => canonicalLocator(evidence.targetLocator) === target.locator);
      return observations.length > 0 && observations.every((evidence) => evidence.existence === "absent" && evidence.fingerprint === target.expectedFingerprint);
    }));
  const recoverySufficient = containment ? containmentSufficient : !recoveryRequired || (input.recoveryPlan.available
    && Boolean(input.recoveryPlan.method && input.recoveryPlan.backupRef && input.recoveryPlan.restoreProcedureRef)
    && (Boolean(input.recoveryPlan.restoreTestEvidenceRef) || input.recoveryPlan.irreversibilityAccepted))
    || (!input.recoveryPlan.available && input.recoveryPlan.irreversibilityAccepted);
  const blastRadiusMatched = input.expectedBlastRadius.affectedTargets >= targets.length;
  const containmentRefs = [containment?.guardEvidenceRef.locator, preparation?.effectsEvidenceRef.locator];
  const recoveryMessage = containmentSufficient
    ? (preparation
      ? "비공개 외부 신규 자원의 중단·보존 조건과 효과 근거가 제출됐습니다. 원격 상태·근거 진위·복원 시험의 자동 검증은 아닙니다."
      : "새 자원만 추가하고 실패 시 중단·보존하는 containment 근거가 있습니다. 복원 검증 완료를 뜻하지 않습니다.")
    : recoverySufficient ? "복구 또는 명시적 비가역성 수용 근거가 있습니다. 근거 참조의 진위나 실제 시험 실행을 자동 검증하지 않습니다."
      : containment && externalImpact
        ? hostText("skillChecksKo.mutationRiskPreflight.recoveryExternalPreparationEvidenceNeeded")
        : hostText("skillChecksKo.mutationRiskPreflight.recoveryDesignNeedsWork");

  // Sentences that a READY report can contain (passed checks, invalidationTriggers) stay fixed Korean: verify-preflight-receipt.mjs
  // recomputes the whole report and compares canonical JSON, so a host-locale sentence would make a receipt stale in another locale.
  const approvalPassed = approval.status === "observed" || approval.status === "not-required";
  const checks = [
    { checkId: "target-specificity", state: unsafe.length ? "failed" : "passed", evidenceRefs: [], message: unsafe.join(" ") || "모든 대상이 구체적으로 식별됐습니다." },
    { checkId: "scope-match", state: scopeIncluded && !scopeExcluded ? "passed" : "failed", evidenceRefs: [input.scopeRef.locator], message: scopeIncluded && !scopeExcluded ? "대상이 작업 범위 안에 있습니다." : hostText("skillChecksKo.mutationRiskPreflight.scopeMismatchCheck") },
    { checkId: "authorization-match", state: authorizationMatched ? "passed" : "failed", evidenceRefs: [input.authorizationRef.locator], message: authorizationMatched ? "행동, 대상과 환경이 허용 범위에 있습니다." : hostText("skillChecksKo.mutationRiskPreflight.authorizationMismatchCheck") },
    { checkId: "current-state", state: currentStateMatched ? "passed" : "unknown", evidenceRefs: refLocators(input.currentStateEvidenceRefs), message: currentStateMatched ? "현재 fingerprint가 예상값과 일치합니다." : hostText("skillChecksKo.mutationRiskPreflight.currentStateUnconfirmedCheck") },
    { checkId: "approval", state: approvalPassed ? "passed" : "unknown", evidenceRefs: approval.refs, message: approvalPassed ? `승인 상태: ${approval.status}` : hostText("skillChecksKo.mutationRiskPreflight.approvalStatusCheck", { status: approval.status }) },
    { checkId: "recovery", state: recoverySufficient ? "passed" : "failed", evidenceRefs: uniqueRefs([input.recoveryPlan.backupRef, input.recoveryPlan.restoreProcedureRef, input.recoveryPlan.restoreTestEvidenceRef, ...containmentRefs]), message: recoveryMessage },
    { checkId: "blast-radius", state: blastRadiusMatched ? "passed" : "failed", evidenceRefs: [], message: blastRadiusMatched ? "예상 영향 범위가 모든 대상을 포함합니다." : hostText("skillChecksKo.mutationRiskPreflight.blastRadiusSmallerCheck") },
  ];
  if (preparation?.sideEffects === "scoped-resources-plus-platform-events") {
    checks.push({
      checkId: "platform-events", state: containmentSufficient ? "passed" : "failed",
      evidenceRefs: [preparation.effectsEvidenceRef.locator],
      message: containmentSufficient ? `공급자 표준 이벤트: ${preparation.platformEvents.providerStandardEvents}; 기존 수신자 목록: ${preparation.platformEvents.recipientInventory}. 통합·수신자·권한 변경과 별도 dispatch는 0이며, 승인 대상 payload만 허용합니다. 알려진 고위험 후속 효과·승인 조건 충돌이 없고 필수 대상 조회가 성공했다는 제출 근거를 점검합니다. 수신·후속 처리 완료나 원격 근거 진위를 자동 검증하지 않습니다.` : hostText("skillChecksKo.mutationRiskPreflight.platformEventsCheck", { providerStandardEvents: preparation.platformEvents.providerStandardEvents, recipientInventory: preparation.platformEvents.recipientInventory }),
    });
  }
  const unresolved = [];
  let verdict = "READY";
  if (unsafe.length || !scopeIncluded || scopeExcluded || !authorizationMatched) {
    verdict = "BLOCKED";
    unresolved.push(...unsafe, ...(!scopeIncluded || scopeExcluded ? [hostText("skillChecksKo.mutationRiskPreflight.unresolvedScopeMismatch")] : []), ...(!authorizationMatched ? [hostText("skillChecksKo.mutationRiskPreflight.unresolvedAuthorizationMismatch")] : []));
  } else if (!currentStateMatched) {
    verdict = "NEEDS_INPUT";
    unresolved.push(hostText("skillChecksKo.mutationRiskPreflight.unresolvedCurrentStateEvidence"));
  } else if (!["observed", "not-required"].includes(approval.status)) {
    verdict = "NEEDS_APPROVAL";
    unresolved.push(hostText("skillChecksKo.mutationRiskPreflight.unresolvedApprovalNeeded", { status: approval.status }));
  } else if (!recoverySufficient || !blastRadiusMatched) {
    verdict = "NEEDS_REDESIGN";
    if (!recoverySufficient) unresolved.push(recoveryMessage);
    if (!blastRadiusMatched) unresolved.push(hostText("skillChecksKo.mutationRiskPreflight.unresolvedBlastRadiusRecompute"));
  }

  const recoveryRefs = uniqueRefs([input.recoveryPlan.backupRef, input.recoveryPlan.restoreProcedureRef, input.recoveryPlan.restoreTestEvidenceRef, ...containmentRefs]);
  return {
    schemaVersion: VERSION, operationId: input.operationId, actionDigest, targetDigest,
    classification: { actionClass: input.actionClass, reversibility: input.recoveryPlan.irreversibilityAccepted ? "irreversible" : (recoverySufficient && !containment ? "reversible" : "conditional"), externalImpact, dataLossPotential, permissionImpact },
    checks,
    approval: { required: approvalRequired, status: approval.status, evidenceRefs: approval.refs },
    recovery: { available: input.recoveryPlan.available, restoreTested: !containment && Boolean(input.recoveryPlan.restoreTestEvidenceRef), irreversibilityAccepted: input.recoveryPlan.irreversibilityAccepted, evidenceRefs: recoveryRefs },
    blastRadius: input.expectedBlastRadius, unresolved: [...new Set(unresolved)],
    invalidationTriggers: ["action 또는 planned tool 변경", "target 또는 environment 변경", "current-state evidence 또는 fingerprint 변경", "scope 또는 authorization 변경", "승인 evidence의 만료 또는 범위 변경", "복구 계획 변경", "예상 blast radius 변경"],
    observedAt: now.toISOString(), verdict,
  };
}

async function readInput(argv) {
  const index = argv.indexOf("--input");
  if (index >= 0) {
    if (!argv[index + 1]) throw new SyntaxError(hostText("skillChecksKo.mutationRiskPreflight.inputPathRequired"));
    return JSON.parse(await readFile(argv[index + 1], "utf8"));
  }
  let raw = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) raw += chunk;
  if (!raw.trim()) throw new SyntaxError(hostText("skillChecksKo.mutationRiskPreflight.jsonInputRequired"));
  return JSON.parse(raw);
}

async function main() {
  let output, phase = "input-read";
  try {
    const input = await readInput(process.argv.slice(2));
    phase = "evaluation";
    output = evaluatePreflight(input);
  } catch (error) {
    if (phase === "input-read" && error instanceof SyntaxError) output = blockedReport({}, [error.message], new Date());
    else {
      // The bounded OS/producer code (ENOENT, EACCES, ...) is kept; never the message or path.
      const code = failureCode(error);
      process.stderr.write(`${JSON.stringify({ component: "mutation-risk-preflight", phase, errorCode: "PREFLIGHT_RUNTIME_ERROR", ...(code ? { code } : {}) })}\n`);
      process.exitCode = 2;
      return;
    }
  }
  process.stdout.write(`${JSON.stringify(output)}\n`);
  process.exitCode = output.verdict === "READY" ? 0 : 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
