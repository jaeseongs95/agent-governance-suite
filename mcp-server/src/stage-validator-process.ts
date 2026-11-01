import { spawnSync } from "node:child_process";
import { ERROR_CODE, type ErrorCode, WorkflowContractError } from "../../contracts/types.js";

/** Child CLIs report their own failures as `{code,message}` or `{error:{code,message}}` on stdout or stderr. */
function childError(...streams: string[]): {code: string; message: string} | null {
  for (const text of streams) {
    try {
      const parsed = JSON.parse(text) as {code?: unknown; message?: unknown; error?: {code?: unknown; message?: unknown} | null};
      const source = typeof parsed.code === "string" ? parsed : parsed.error;
      if (source && typeof source.code === "string") return {code: source.code, message: typeof source.message === "string" ? source.message : ""};
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
  if (checked.error) {
    const errno = (checked.error as NodeJS.ErrnoException).code ?? null;
    // The validator never ran to completion: the server is unavailable, the supplied files were not judged.
    throw new WorkflowContractError("MCP_UNAVAILABLE", `${label} validator could not run (${errno ?? checked.error.name}).`,
      {step: "spawn", reason: "VALIDATOR_SPAWN_FAILED", errno, signal: checked.signal});
  }
  if (checked.signal) {
    throw new WorkflowContractError("MCP_UNAVAILABLE", `${label} validator was terminated by ${checked.signal}.`,
      {step: "terminated", reason: "VALIDATOR_TERMINATED", signal: checked.signal, status: checked.status});
  }
  let parsed: Record<string, unknown> | null = null;
  try { parsed = JSON.parse(stdout) as Record<string, unknown>; } catch { /* judged below */ }
  // An allowed non-zero status needs a JSON report; stderr also identifies load failures without a report.
  if (!okStatuses.includes(checked.status ?? -1) || (!parsed && (checked.status !== 0 || stderr.trim()))) {
    const cause = childError(stdout, stderr);
    const code = cause && (ERROR_CODE as readonly string[]).includes(cause.code) ? cause.code as ErrorCode : "GATE_FAILED";
    throw new WorkflowContractError(code, cause?.message || `${label} validator exited with status ${checked.status}.`,
      {step: "exit", status: checked.status, childCode: cause?.code ?? null});
  }
  // A successful validator exit without a JSON report is a validator failure, never the caller's invalid input.
  if (!parsed) throw new WorkflowContractError("MCP_UNAVAILABLE", `${label} validator did not return bounded JSON.`,
    {step: "parse", reason: "VALIDATOR_OUTPUT_INVALID", status: checked.status});
  return parsed;
}
