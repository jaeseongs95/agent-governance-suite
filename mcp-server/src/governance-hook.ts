import { isHookEntry } from "./hook-entry.js";
import "./builtin-hook-host-adapters.js";
import { readFileSync } from "node:fs";
import { adaptHostInput, hookAttestationKind, isGovernanceHookTool, resolveHookHost } from "./host-input-adapter.js";
import { actorAccess } from "./input-observation.js";
import { SessionActorProofs, SESSION_PROOF_FIELD, withoutSessionProof } from "./session-actor-proof.js";
import { SqliteWorkflowStore } from "./sqlite-workflow-store.js";
import { resolveWorkflowDatabasePath } from "./runtime-config.js";
import { runSessionBoardHook } from "./session-board-hook.js";
import { handleSessionMessageHook } from "./session-message-hook.js";
import { runContinuityHook } from "./continuity-hook.js";
import { HOST_ATTESTATION_TOOLS } from "./host-attestation.js";
import { handleRegisteredHostAttestationHook } from "./host-attestation-hook.js";
import { WorkflowContractError } from "../../contracts/types.js";
import { hookFailureContext, retainHookFailureSecondary, writeFailureDiagnostic } from "./hook-error-diagnostics.js";

const BOARD_TOOLS = new Set(["update_session_status", "list_session_status"]);
const MESSAGE_TOOLS = new Set(["prepare_session_message", "send_session_message", "acknowledge_session_messages", "get_session_message_status", "validate_collaboration_decision"]);
const CONTINUITY_TOOLS = new Set(["open_convergence_root", "checkpoint_context", "inspect_context", "load_context", "suppress_context_restore", "purge_direct_context"]);
type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
}
function denied(reasonCode: string): RecordValue {
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reasonCode } };
}

/** One authorization entry per governance call. Domain hooks run before signing;
 * missing/failed domain output cannot turn into a valid root proof. */
export async function runGovernanceHook(host: string, raw: string, environment: NodeJS.ProcessEnv = process.env): Promise<{ ok: boolean; output: string }> {
  let store: SqliteWorkflowStore | undefined;
  let output: RecordValue = {};
  let failure: unknown;
  try {
    const input = record(JSON.parse(raw));
    const { observation } = adaptHostInput(input, host);
    const toolName = observation.toolName ?? "";
    if (observation.kind !== "tool-boundary" || observation.boundaryPhase !== "before" || !isGovernanceHookTool(host, toolName)) {
      return { ok: true, output: "" };
    }
    const access = actorAccess(observation.actor);
    if (!access.allowed) return { ok: true, output: JSON.stringify(denied(access.reasonCode)) };
    const tool = toolName.split("__").at(-1)!;
    let args = withoutSessionProof(observation.toolInput ?? {});
    if (Object.hasOwn(args, "_sessionBinding")) return { ok: true, output: JSON.stringify(denied("CALLER_SESSION_BINDING_REJECTED")) };
    const currentInput = { ...input, tool_input: args };
    let domainOutput: RecordValue | null = null;
    const databasePath = resolveWorkflowDatabasePath(environment);
    store = new SqliteWorkflowStore(databasePath);
    if (BOARD_TOOLS.has(tool)) {
      const encoded = await runSessionBoardHook(host, JSON.stringify(currentInput), undefined, true);
      domainOutput = encoded ? record(JSON.parse(encoded)) : {};
    } else if (MESSAGE_TOOLS.has(tool)) {
      domainOutput = await handleSessionMessageHook(currentInput, host);
    } else if (CONTINUITY_TOOLS.has(tool)) {
      const encoded = runContinuityHook(JSON.stringify(currentInput), environment, host, true);
      domainOutput = encoded ? record(JSON.parse(encoded)) : {};
    } else if (HOST_ATTESTATION_TOOLS.has(tool)) {
      const kind = hookAttestationKind(host);
      if (!kind) throw new WorkflowContractError("BINDING_REQUIRED", "Host execution adapter unavailable.");
      domainOutput = handleRegisteredHostAttestationHook(kind, currentInput, { host, databasePath, openStore: () => store! });
    }
    if (domainOutput) {
      const specific = record(domainOutput.hookSpecificOutput);
      if (specific.permissionDecision === "deny") output = domainOutput;
      else {
        if (!specific.updatedInput || typeof specific.updatedInput !== "object" || Array.isArray(specific.updatedInput)) {
          throw new WorkflowContractError("BINDING_REQUIRED", "The required domain hook did not complete.");
        }
        args = { ...record(specific.updatedInput) };
        // Internal domain hook metadata is replaced by server-verified identity.
        delete args._sessionBinding;
        output = { ...domainOutput, hookSpecificOutput: { ...specific, updatedInput: args } };
      }
    }
    if (record(output.hookSpecificOutput).permissionDecision !== "deny") {
      const proof = new SessionActorProofs(store).issue(observation, tool, args);
      output = { ...output, hookSpecificOutput: { ...record(output.hookSpecificOutput), hookEventName: "PreToolUse", updatedInput: { ...args, [SESSION_PROOF_FIELD]: proof } } };
    }
  } catch (cause) { failure = cause; }
  finally {
    try { store?.close(); } catch (cause) {
      if (failure instanceof Error) retainHookFailureSecondary(failure, cause);
      else failure = cause;
    }
  }
  if (failure) {
    const reasonCode = failure instanceof WorkflowContractError && typeof failure.details?.reasonCode === "string"
      ? failure.details.reasonCode : "GOVERNANCE_HOOK_FAILED";
    try { writeFailureDiagnostic(JSON.stringify({ component: "governance-hook", reasonCode, context: hookFailureContext(failure) })); }
    catch { /* The nonzero failure and denial do not depend on diagnostic output. */ }
    return { ok: false, output: JSON.stringify(denied(reasonCode)) };
  }
  return { ok: true, output: JSON.stringify(output) };
}

if (isHookEntry(import.meta.url, "governance-hook")) {
  try {
    const result = await runGovernanceHook(resolveHookHost(process.argv.slice(2), "codex"), readFileSync(0, "utf8"));
    if (result.output) process.stdout.write(result.output);
    if (!result.ok) process.exitCode = 2;
    process.stdout.on("error", () => { process.exitCode = 2; });
  } catch { process.exitCode = 2; }
}
