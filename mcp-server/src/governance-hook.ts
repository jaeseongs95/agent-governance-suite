import { isHookEntry } from "./hook-entry.js";
import "./builtin-hook-host-adapters.js";
import { readFileSync } from "node:fs";
import { types } from "node:util";
import { adaptHostInput, hookExecutionObserver, isGovernanceHookTool, resolveHookHost } from "./host-input-adapter.js";
import { SqliteWorkflowStore } from "./sqlite-workflow-store.js";
import { assertDistinctDatabasePaths, resolveContinuityDatabasePath, resolveWorkflowDatabasePath } from "./runtime-config.js";
import { runContinuityHook } from "./continuity-hook.js";
import { HOST_ATTESTATION_TOOLS } from "./host-attestation.js";
import { observationFailureCode } from "./host-attestation-hook.js";
import { ContinuityStoreError, SqliteContinuityStore } from "./continuity-store.js";
import { ContinuityService } from "./continuity-service.js";
import { failureReason } from "./failure-diagnostics.js";
import { WorkflowContractError } from "../../contracts/types.js";
import { hookFailureContext, retainHookFailureSecondary, writeDiagnostic, writeFailureDiagnostic } from "./hook-error-diagnostics.js";
import { msg } from "./i18n.js";

const CONTINUITY_TOOLS = new Set(["open_convergence_root", "checkpoint_context", "inspect_context", "load_context", "suppress_context_restore", "purge_direct_context"]);
type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
}
function denied(reasonCode: string): RecordValue {
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reasonCode } };
}
/**
 * A refused start never reaches the server, so the server cannot record the start failure that keeps the session's
 * edits passing (design ags30-phase-check 7.6). The hook records the same observation itself.
 */
function recordStartRefusal(environment: NodeJS.ProcessEnv, sessionId: string, reasonCode: string): void {
  const continuityPath = resolveContinuityDatabasePath(environment);
  assertDistinctDatabasePaths(resolveWorkflowDatabasePath(environment), continuityPath);
  const continuity = new SqliteContinuityStore(continuityPath);
  try {
    new ContinuityService(continuity, null).recordWorkflowStartFailure(sessionId,
      new WorkflowContractError("BINDING_REQUIRED", msg("services.governanceHook.startRefused", {}), { reasonCode }));
  } finally { continuity.close(); }
}
function missing(reasonCode: string): never {
  throw new WorkflowContractError("BINDING_REQUIRED", msg("services.governanceHook.callUnidentified", {}), { reasonCode });
}

/**
 * The denial names the failed cause: a contract reason, the failed observation step (TRANSCRIPT_READ_FAILED,
 * SESSION_MODEL_INVALID, ...), a continuity store reason, an OS/SQLite/JSON class or a
 * producer reason. Only a cause with none of these is GOVERNANCE_HOOK_FAILED. All are fixed codes, never messages.
 */
function failureReasonCode(failure: unknown): string {
  try {
    if (types.isProxy(failure)) return "GOVERNANCE_HOOK_FAILED";
    if (failure instanceof WorkflowContractError) {
      return typeof failure.details?.reasonCode === "string" ? failure.details.reasonCode : `WORKFLOW_${failure.code}`;
    }
    if (failure instanceof ContinuityStoreError) return failure.reason;
  } catch { return "GOVERNANCE_HOOK_FAILED"; }
  return observationFailureCode(failure) ?? failureReason(failure).reason ?? "GOVERNANCE_HOOK_FAILED";
}

/**
 * PreToolUse for AGS tools on hosts whose tools/call `_meta` lacks the model: Claude Code (only the tool-use ID) and
 * agy (only the conversation IDs). The hook records the observed execution under the host adapter's call ID; the
 * server claims the row once. It never rewrites arguments and never decides permission, so the host's own approval
 * flow runs unchanged. Codex needs no hook: its `_meta` names the caller and model (docs/archive/ags30-session-binding-design.md 2.2).
 */
export async function runGovernanceHook(
  host: string, raw: string, environment: NodeJS.ProcessEnv = process.env,
): Promise<{ ok: boolean; output: string }> {
  let store: SqliteWorkflowStore | undefined;
  let failure: unknown;
  let failed = false;
  let tool = "";
  let sessionId = "";
  try {
    const input = record(JSON.parse(raw));
    const { observation } = adaptHostInput(input, host);
    const toolName = observation.toolName ?? "";
    if (observation.kind !== "tool-boundary" || observation.boundaryPhase !== "before" || !isGovernanceHookTool(host, toolName)) {
      return { ok: true, output: "" };
    }
    tool = toolName.split("__").at(-1)!;
    const callId = observation.callId?.trim();
    sessionId = observation.sessionId.trim();
    if (!callId || !sessionId) missing("HOOK_CALL_FIELDS_MISSING");
    // A present but malformed agent marker must not record a root row.
    const agentId = Object.hasOwn(input, "agent_id") ? input.agent_id : null;
    if (Object.hasOwn(input, "agent_id") && (typeof agentId !== "string" || !agentId.trim())) missing("HOOK_AGENT_ID_INVALID");
    // The continuity hook reads the host process for a deferred fork here, before the server pins from lineage.
    if (CONTINUITY_TOOLS.has(tool)) runContinuityHook(raw, environment, host, true);
    const databasePath = resolveWorkflowDatabasePath(environment);
    const observe = hookExecutionObserver(host);
    const execution = !HOST_ATTESTATION_TOOLS.has(tool) ? { unavailable: "EXECUTION_NOT_REQUIRED" }
      : observe ? observe(input, environment) : { unavailable: "HOOK_EXECUTION_OBSERVER_UNAVAILABLE" };
    store = new SqliteWorkflowStore(databasePath);
    const transcriptPath = typeof input.transcript_path === "string" && input.transcript_path ? input.transcript_path : null;
    store.recordCallAdmission({ host, callId, tool, sessionId, agentId: agentId as string | null, execution, transcriptPath });
  } catch (cause) { failure = cause; failed = true; }
  finally {
    try { store?.close(); } catch (cause) {
      if (!failed) { failure = cause; failed = true; }
      else if (failure instanceof Error) retainHookFailureSecondary(failure, cause);
    }
  }
  if (failed) {
    const reasonCode = failureReasonCode(failure);
    // The observation step's own cause class (EACCES, EISDIR, ...) stays separate from the step code.
    const causeReason = observationFailureCode(failure) && failure instanceof Error ? failureReason(failure.cause).reason : null;
    try { writeDiagnostic("governance-hook", "governance-hook-failure", { reasonCode, ...(causeReason ? { causeReason } : {}),
      context: hookFailureContext(failure) }, line => writeFailureDiagnostic(line + "\n")); }
    catch { /* The nonzero failure and denial do not depend on diagnostic output. */ }
    if (tool === "start_workflow" && sessionId) {
      try { recordStartRefusal(environment, sessionId, reasonCode); }
      catch (cause) {
        try { writeDiagnostic("governance-hook", "workflow-start-failure-unrecorded", { reasonCode: "WORKFLOW_START_FAILURE_UNRECORDED",
          causeReason: failureReason(cause).reason ?? "UNEXPECTED_FAILURE" }, line => writeFailureDiagnostic(line + "\n")); } catch { /* The denial stands either way. */ }
      }
    }
    return { ok: false, output: JSON.stringify(denied(reasonCode)) };
  }
  return { ok: true, output: "" };
}

if (isHookEntry(import.meta.url, "governance-hook")) {
  try {
    const result = await runGovernanceHook(resolveHookHost(process.argv.slice(2)), readFileSync(0, "utf8"));
    if (result.output) process.stdout.write(result.output);
    if (!result.ok) process.exitCode = 2;
    process.stdout.on("error", () => { process.exitCode = 2; });
  } catch { process.exitCode = 2; }
}
