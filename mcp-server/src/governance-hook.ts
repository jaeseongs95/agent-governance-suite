import { isHookEntry } from "./hook-entry.js";
import "./builtin-hook-host-adapters.js";
import { readFileSync } from "node:fs";
import { adaptHostInput, isGovernanceHookTool, resolveHookHost } from "./host-input-adapter.js";
import { SqliteWorkflowStore } from "./sqlite-workflow-store.js";
import { resolveWorkflowDatabasePath } from "./runtime-config.js";
import { runContinuityHook } from "./continuity-hook.js";
import { HOST_ATTESTATION_TOOLS } from "./host-attestation.js";
import { observeClaudeExecution, readSessionModel, sessionModelDirectory } from "./host-attestation-hook.js";
import { WorkflowContractError } from "../../contracts/types.js";
import { hookFailureContext, retainHookFailureSecondary, writeFailureDiagnostic } from "./hook-error-diagnostics.js";

const CONTINUITY_TOOLS = new Set(["open_convergence_root", "checkpoint_context", "inspect_context", "load_context", "suppress_context_restore", "purge_direct_context"]);
type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
}
function denied(reasonCode: string): RecordValue {
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reasonCode } };
}
function missing(reasonCode: string): never {
  throw new WorkflowContractError("BINDING_REQUIRED", "The host hook input does not identify this call.", { reasonCode });
}

/**
 * Claude Code PreToolUse for AGS tools. Claude's tools/call `_meta` carries only the tool-use ID, so this hook
 * records the caller (session, agent) and the observed execution under that ID; the server claims the row once.
 * It never rewrites arguments and never decides permission, so the host's own approval flow runs unchanged.
 * Codex and agy need no hook: their `_meta` names the caller (docs/ags30-session-binding-design.md 2.2).
 */
export async function runGovernanceHook(
  host: string, raw: string, environment: NodeJS.ProcessEnv = process.env,
): Promise<{ ok: boolean; output: string }> {
  let store: SqliteWorkflowStore | undefined;
  let failure: unknown;
  let failed = false;
  try {
    const input = record(JSON.parse(raw));
    const { observation } = adaptHostInput(input, host);
    const toolName = observation.toolName ?? "";
    if (observation.kind !== "tool-boundary" || observation.boundaryPhase !== "before" || !isGovernanceHookTool(host, toolName)) {
      return { ok: true, output: "" };
    }
    const tool = toolName.split("__").at(-1)!;
    const callId = observation.callId?.trim();
    const sessionId = observation.sessionId.trim();
    if (!callId || !sessionId) missing("HOOK_CALL_FIELDS_MISSING");
    // A present but malformed agent marker must not record a root row.
    const agentId = Object.hasOwn(input, "agent_id") ? input.agent_id : null;
    if (Object.hasOwn(input, "agent_id") && (typeof agentId !== "string" || !agentId.trim())) missing("HOOK_AGENT_ID_INVALID");
    // The continuity hook reads the host process for a deferred fork here, before the server pins from lineage.
    if (CONTINUITY_TOOLS.has(tool)) runContinuityHook(raw, environment, host, true);
    const databasePath = resolveWorkflowDatabasePath(environment);
    const execution = HOST_ATTESTATION_TOOLS.has(tool)
      ? observeClaudeExecution(input, { host, readSessionModel: (id) => readSessionModel(sessionModelDirectory(databasePath), id) })
      : { unavailable: "EXECUTION_NOT_REQUIRED" };
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
    const reasonCode = failure instanceof WorkflowContractError && typeof failure.details?.reasonCode === "string"
      ? failure.details.reasonCode : "GOVERNANCE_HOOK_FAILED";
    try { writeFailureDiagnostic(JSON.stringify({ component: "governance-hook", reasonCode, context: hookFailureContext(failure) })); }
    catch { /* The nonzero failure and denial do not depend on diagnostic output. */ }
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
