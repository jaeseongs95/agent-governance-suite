import { spawnSync } from "node:child_process";
import { ERROR_CODE, type ErrorCode, WorkflowContractError } from "../../contracts/types.js";
import { isCatalogKey, msg, type StoredMessageRef } from "./i18n.js";

/** Validator labels with a catalog phrase; any other label is shown as given. */
const VALIDATOR_SUBJECTS: Readonly<Record<string, string>> = { "CS stage bundle": "csStageBundle", "Engineering stage": "engineeringStage" };

/** Child CLIs report their own failures as `{code,message}` or `{error:{code,message}}` on stdout or stderr. */
function childError(...streams: string[]): {code: string; message: string; ref: StoredMessageRef | null} | null {
  type Reported = {code?: unknown; message?: unknown; messageKey?: unknown; params?: unknown};
  for (const text of streams) {
    try {
      const parsed = JSON.parse(text) as Reported & {error?: Reported | null};
      const source = typeof parsed.code === "string" ? parsed : parsed.error;
      if (source && typeof source.code === "string") {
        // A key this catalog knows is re-rendered in the reader's locale; otherwise the child's own sentence is kept.
        const ref = typeof source.messageKey === "string" && isCatalogKey(source.messageKey)
          && source.params !== null && typeof source.params === "object" && !Array.isArray(source.params)
          ? {key: source.messageKey, params: source.params as Readonly<Record<string, unknown>>} : null;
        return {code: source.code, message: typeof source.message === "string" ? source.message : "", ref};
      }
    } catch { /* not JSON; try the next stream */ }
  }
  return null;
}

/**
 * Runs a stage-bundle validator CLI and returns its parsed JSON. Process failure is judged before the output is
 * parsed, so a timeout, signal, CLI error or missing script keeps its own cause instead of looking like bad JSON.
 */
export function runStageValidator(label: string, script: string, args: string[], okStatuses: readonly number[]): Record<string, unknown> {
  const checked = spawnSync(process.execPath, [script, ...args],
    {encoding: "utf8", timeout: 10_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true});
  const stdout = checked.stdout ?? "";
  const stderr = checked.stderr ?? "";
  const subject = { subject: VALIDATOR_SUBJECTS[label] ?? "other", label };
  if (checked.error) {
    const errno = (checked.error as NodeJS.ErrnoException).code ?? null;
    // The validator never ran to completion: the server is unavailable, the supplied files were not judged.
    throw new WorkflowContractError("MCP_UNAVAILABLE", msg("workflow.validatorProcess.couldNotRun", { ...subject, reason: errno ?? checked.error.name }),
      {step: "spawn", reason: "VALIDATOR_SPAWN_FAILED", errno, signal: checked.signal});
  }
  if (checked.signal) {
    throw new WorkflowContractError("MCP_UNAVAILABLE", msg("workflow.validatorProcess.terminated", { ...subject, signal: checked.signal }),
      {step: "terminated", reason: "VALIDATOR_TERMINATED", signal: checked.signal, status: checked.status});
  }
  let parsed: Record<string, unknown> | null = null;
  try { parsed = JSON.parse(stdout) as Record<string, unknown>; } catch { /* judged below */ }
  // An allowed non-zero status needs a JSON report; stderr also identifies load failures without a report.
  if (!okStatuses.includes(checked.status ?? -1) || (!parsed && (checked.status !== 0 || stderr.trim()))) {
    const cause = childError(stdout, stderr);
    const code = cause && (ERROR_CODE as readonly string[]).includes(cause.code) ? cause.code as ErrorCode : "GATE_FAILED";
    // A catalog key from the child nests, so the reader's locale renders it; an unkeyed sentence passes through as it is.
    throw new WorkflowContractError(code, cause?.ref || cause?.message
      ? msg("workflow.validatorProcess.childFailure", { message: cause.ref ?? cause.message })
      : msg("workflow.validatorProcess.exitStatus", { ...subject, status: String(checked.status) }),
      {step: "exit", status: checked.status, childCode: cause?.code ?? null});
  }
  // A successful validator exit without a JSON report is a validator failure, never the caller's invalid input.
  if (!parsed) throw new WorkflowContractError("MCP_UNAVAILABLE", msg("workflow.validatorProcess.unboundedOutput", subject),
    {step: "parse", reason: "VALIDATOR_OUTPUT_INVALID", status: checked.status});
  return parsed;
}
