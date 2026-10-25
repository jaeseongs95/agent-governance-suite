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
    throw new WorkflowContractError("GATE_FAILED", `${label} validator could not run (${errno ?? checked.error.name}).`,
      {step: "spawn", errno, signal: checked.signal});
  }
  if (checked.signal) {
    throw new WorkflowContractError("GATE_FAILED", `${label} validator was terminated by ${checked.signal}.`,
      {step: "terminated", signal: checked.signal, status: checked.status});
  }
  let parsed: Record<string, unknown> | null = null;
  try { parsed = JSON.parse(stdout) as Record<string, unknown>; } catch { /* judged below */ }
  // An allowed status with no JSON but a stderr message (e.g. node failing to load the script) is a CLI failure too.
  if (!okStatuses.includes(checked.status ?? -1) || (!parsed && stderr.trim())) {
    const cause = childError(stdout, stderr);
    const code = cause && (ERROR_CODE as readonly string[]).includes(cause.code) ? cause.code as ErrorCode : "GATE_FAILED";
    throw new WorkflowContractError(code, cause?.message || `${label} validator exited with status ${checked.status}.`,
      {step: "exit", status: checked.status, childCode: cause?.code ?? null, stderr: stderr.slice(0, 500) || null});
  }
  if (!parsed) throw new WorkflowContractError("INVALID_INPUT", `${label} validator did not return bounded JSON.`, {step: "parse", status: checked.status});
  return parsed;
}
