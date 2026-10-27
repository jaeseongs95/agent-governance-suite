import { isHookEntry } from "./hook-entry.js";
import "./builtin-hook-host-adapters.js";
import { readFileSync } from "node:fs";
import { adaptHostInput, hookAttestationKind, hookRewriteDecision, isGovernanceHookTool, resolveHookHost, withHookHostAdapter, type HookHostAdapter } from "./host-input-adapter.js";
import { actorAccess } from "./input-observation.js";
import { SessionActorProofs, SESSION_PROOF_FIELD, withoutSessionProof } from "./session-actor-proof.js";
import { SqliteWorkflowStore } from "./sqlite-workflow-store.js";
import { resolveHostAttestation, resolveWorkflowDatabasePath } from "./runtime-config.js";
import { runSessionBoardHook } from "./session-board-hook.js";
import { handleSessionMessageHook } from "./session-message-hook.js";
import { runContinuityHook } from "./continuity-hook.js";
import { HOST_ATTESTATION_FIELD, HOST_ATTESTATION_TOOLS, withoutHostAttestation, type HostExecutionAdapter } from "./host-attestation.js";
import { handleRegisteredHostAttestationHook, snapshotHookAttestationStrategy, type HookAttestationStrategy } from "./host-attestation-hook.js";
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

/** One trusted installation dependency tuple, never deserialized from hook JSON. */
export interface GovernanceHookComposition {
  inputAdapter: Readonly<HookHostAdapter>;
  attestation: Readonly<{ kind: string; strategy: Readonly<HookAttestationStrategy> }>;
}

/** One authorization entry per governance call. Domain hooks run before signing;
 * missing/failed domain output cannot turn into a valid root proof. */
export async function runGovernanceHook(
  host: string, raw: string, environment: NodeJS.ProcessEnv = process.env,
  executionAdapters?: ReadonlyMap<string, HostExecutionAdapter>,
  composition?: GovernanceHookComposition,
): Promise<{ ok: boolean; output: string }> {
  let store: SqliteWorkflowStore | undefined;
  let output: RecordValue = {};
  let failure: unknown;
  let failed = false;
  try {
    const execute = async (inputAdapter?: Readonly<HookHostAdapter>) => {
      let selectedStrategy: Readonly<HookAttestationStrategy> | undefined;
      let selectedExecution: HostExecutionAdapter | undefined;
      if (composition !== undefined) {
        // Snapshot all trusted dependencies before adaptation, callbacks or the first await.
        const attestation = composition.attestation;
        if (!inputAdapter?.adaptInput || !inputAdapter.ownsTool || !inputAdapter.attestationKind
          || !attestation || inputAdapter.attestationKind !== attestation.kind) {
          throw new WorkflowContractError("BINDING_REQUIRED", "Host hook composition unavailable.", { reasonCode: "HOST_HOOK_COMPOSITION_UNAVAILABLE" });
        }
        selectedStrategy = snapshotHookAttestationStrategy(attestation.kind, attestation.strategy);
        const adapter = executionAdapters === undefined ? null
          : resolveHostAttestation({ AGENT_GOVERNANCE_HOST_ATTESTATION: host }, executionAdapters);
        if (!adapter) throw new WorkflowContractError("BINDING_REQUIRED", "Host execution adapter unavailable.", {
          reasonCode: "HOST_EXECUTION_ADAPTER_UNAVAILABLE",
        });
        const { host: adapterHost, provider, policyRevision, modelClassForModel, resolveModel } = adapter;
        if (adapterHost !== host || typeof modelClassForModel !== "function" || (resolveModel !== undefined && typeof resolveModel !== "function")) {
          throw new WorkflowContractError("BINDING_REQUIRED", "Host execution adapter unavailable.", { reasonCode: "HOST_EXECUTION_ADAPTER_UNAVAILABLE" });
        }
        selectedExecution = Object.freeze({ host: adapterHost, modelClassForModel: modelClassForModel.bind(adapter),
          ...(provider === undefined ? {} : { provider }), ...(policyRevision === undefined ? {} : { policyRevision }),
          ...(resolveModel ? { resolveModel: resolveModel.bind(adapter) } : {}) });
      }
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
      if (composition !== undefined && HOST_ATTESTATION_TOOLS.has(tool)) args = withoutHostAttestation(args);
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
        // Only trusted installation composition supplies adapters; hook JSON cannot register authority.
        const adapter = composition === undefined
          ? executionAdapters === undefined ? undefined : resolveHostAttestation({ AGENT_GOVERNANCE_HOST_ATTESTATION: host }, executionAdapters)
          : selectedExecution;
        if (adapter === null) throw new WorkflowContractError("BINDING_REQUIRED", "Host execution adapter unavailable.", {
          reasonCode: "HOST_EXECUTION_ADAPTER_UNAVAILABLE",
        });
        domainOutput = handleRegisteredHostAttestationHook(kind, currentInput, { host, databasePath, ...(adapter ? { adapter } : {}),
          ...(composition === undefined ? {} : { observation: { ...observation, toolInput: args }, toolInput: args }), openStore: () => store! }, selectedStrategy);
        if (composition !== undefined) {
          const specific = record(record(domainOutput).hookSpecificOutput);
          if (!domainOutput || typeof domainOutput !== "object" || Array.isArray(domainOutput)
            || (specific.permissionDecision !== "deny" && (!specific.updatedInput || typeof specific.updatedInput !== "object" || Array.isArray(specific.updatedInput)))) {
            throw new WorkflowContractError("BINDING_REQUIRED", "The required host observation did not complete.", {
              reasonCode: "HOST_ATTESTATION_STRATEGY_UNAVAILABLE",
            });
          }
        }
      }
      if (domainOutput) {
        const specific = record(domainOutput.hookSpecificOutput);
        if (specific.permissionDecision === "deny") output = domainOutput;
        else {
          if (!specific.updatedInput || typeof specific.updatedInput !== "object" || Array.isArray(specific.updatedInput)) {
            throw new WorkflowContractError("BINDING_REQUIRED", "The required domain hook did not complete.");
          }
          args = { ...record(specific.updatedInput) };
          if (composition !== undefined && HOST_ATTESTATION_TOOLS.has(tool)
            && (typeof args[HOST_ATTESTATION_FIELD] !== "string" || args[HOST_ATTESTATION_FIELD] === "")) {
            throw new WorkflowContractError("BINDING_REQUIRED", "The required host observation did not complete.", {
              reasonCode: "HOST_ATTESTATION_STRATEGY_UNAVAILABLE",
            });
          }
          // Internal domain hook metadata is replaced by server-verified identity.
          delete args._sessionBinding;
          output = { ...domainOutput, hookSpecificOutput: { ...specific, updatedInput: args } };
        }
      }
      if (record(output.hookSpecificOutput).permissionDecision !== "deny") {
        const proof = new SessionActorProofs(store).issue(observation, tool, args);
        const decision = hookRewriteDecision(host);
        output = { ...output, hookSpecificOutput: { ...record(output.hookSpecificOutput), hookEventName: "PreToolUse",
          ...(decision ? { permissionDecision: decision } : {}), updatedInput: { ...args, [SESSION_PROOF_FIELD]: proof } } };
      }
    };
    const early = composition === undefined ? await execute()
      : await withHookHostAdapter(host, composition.inputAdapter, execute);
    if (early) return early;
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
  return { ok: true, output: JSON.stringify(output) };
}

if (isHookEntry(import.meta.url, "governance-hook")) {
  try {
    const result = await runGovernanceHook(resolveHookHost(process.argv.slice(2)), readFileSync(0, "utf8"));
    if (result.output) process.stdout.write(result.output);
    if (!result.ok) process.exitCode = 2;
    process.stdout.on("error", () => { process.exitCode = 2; });
  } catch { process.exitCode = 2; }
}
