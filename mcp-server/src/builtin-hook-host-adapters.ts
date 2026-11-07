import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { types as utilTypes } from "node:util";
import { hookFailure, retainHookFailureCause, retainHookFailureSecondary } from "./hook-error-diagnostics.js";
import { closeSync, constants, fstatSync, openSync, readSync, statSync } from "node:fs";
import path from "node:path";
import { registerHookHostAdapter, type HookHostAdapter, type HostDeliveryProfile, type NativePeerWaitObservation, type HookSettingsDiagnostic, type AdaptedHostInput, type HostLifecycle, type ContinuityAction, type LineageRead, type ForkOriginRead } from "./host-input-adapter.js";
import { claudeForkHostRead } from "./claude-fork-host.js";
import { parseWakeMessages } from "./session-message-client.js";
import type { InputObservation, InputObservationKind } from "./input-observation.js";
import { normalizePeerWaitTargets } from "./peer-wait-policy.js";
import type { SessionMessageTransport } from "./session-message-relay.js";
import { transportDeliveryCapabilities } from "./wake-transports.js";
import { canonicalJson } from "./convergence-logic.js";
import type { CallerExecution } from "./caller-identity.js";
import { observeClaudeExecution, readSessionModel, sessionModelDirectory } from "./host-attestation-hook.js";
import { resolveWorkflowDatabasePath } from "./runtime-config.js";
import { shellEditTargets } from "./shell-edit-targets.js";

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/**
 * The absolute paths a file-edit tool call will change, resolved against the hook's working directory. The tool input
 * key is host-owned; a missing or non-string value yields no path, and the caller still sees an edit (empty list).
 */
function editTargetPaths(input: Record<string, unknown>, paths: unknown[]): string[] {
  const base = text(input.cwd) || process.cwd();
  return [...new Set(paths.filter((value): value is string => typeof value === "string" && value.trim() !== "")
    .map(value => path.resolve(base, value.trim())))];
}

/** Codex apply_patch: every file the patch adds, updates, deletes or moves to (`*** <Action> File: <path>`, `*** Move to:`). */
export function applyPatchTargets(command: unknown): string[] {
  if (typeof command !== "string") return [];
  const paths: string[] = [];
  for (const line of command.split("\n")) {
    const match = /^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+?)\r?$/u.exec(line);
    if (match) paths.push(match[1]!);
  }
  return paths;
}

function setEditTargets(adapted: AdaptedHostInput, input: Record<string, unknown>, targets: (toolName: string, toolInput: Record<string, unknown>) => unknown[] | null): void {
  const { observation } = adapted;
  if (observation.kind !== "tool-boundary" || observation.boundaryPhase !== "before") return;
  const paths = targets(observation.toolName ?? "", observation.toolInput ?? {});
  if (paths) observation.editTargets = editTargetPaths(input, paths);
}

/** Keeps vendor event names and actor fields at the host adapter boundary. */
function adaptBuiltinHookInput(input: Record<string, unknown>, host: string, actor: InputObservation["actor"]): AdaptedHostInput {
  const event = text(input.hook_event_name);
  let kind: InputObservationKind = "unknown";
  let lifecycle: HostLifecycle = "none";
  let continuityAction: ContinuityAction | undefined;
  let boundaryPhase: "before" | "after" | undefined;
  if (event === "SessionStart") {
    lifecycle = "start";
    const source = input.source;
    // A fork starts only its own namespace; its event conveys no parent restore authority.
    if (source === "fork") continuityAction = { kind: "startup" };
    else if (source === "startup" || source === "clear" || source === "resume" || source === "compact") continuityAction = { kind: source };
  }
  else if (event === "SessionEnd") {
    kind = "turn-end";
    lifecycle = "end";
  } else if (event === "UserPromptSubmit") kind = "user-input";
  else if (event === "PreToolUse") {
    kind = "tool-boundary";
    boundaryPhase = "before";
  } else if (event === "PostToolUse") {
    kind = "tool-boundary";
    boundaryPhase = "after";
  } else if (event === "Stop") kind = "turn-end";
  // Claude Code and Codex 0.166 name the hook that adds context to a new subagent SubagentStart; it carries agent_id.
  else if (event === "SubagentStart") kind = "subagent-start";
  if (event === "PreCompact") continuityAction = { kind: "pre-compact" };
  else if (event === "PostCompact") {
    const turnId = input.turn_id, error = input.error;
    continuityAction = { kind: "post-compact", turnId: typeof turnId === "string" ? turnId : null, successful: error === undefined || error === null };
  }

  const wake = kind === "user-input" ? parseWakeMessages(input.prompt) : { nonces: [], wakeOnly: false };
  const workspaceId = text(input.workspace_id) || text(input.cwd);
  const callId = text(input.tool_use_id).trim();
  const collaborationId = text(input.collaboration_id);
  const role = text(input.role);
  return {
    lifecycle,
    outputEventName: event,
    ...(continuityAction ? { continuityAction } : {}),
    observation: {
      host,
      sessionId: text(input.session_id),
      kind,
      actor,
      ...(callId ? { callId } : {}),
      ...(boundaryPhase === undefined ? {} : { boundaryPhase }),
      ...(kind === "tool-boundary" ? { toolName: text(input.tool_name), toolInput: record(input.tool_input) } : {}),
      ...(kind === "user-input" ? { wakeCandidates: wake.nonces, wakeOnly: wake.wakeOnly } : {}),
      ...(workspaceId ? { workspaceId } : {}),
      ...(collaborationId ? { collaborationId } : {}),
      ...(role ? { role } : {}),
    },
  };
}

/** 3.0 fallback for marker-free recognized events. Host adapters reject supported child markers;
 * a child without such evidence can still inherit the parent session ID under the deferred gate. */
function adaptInferredRootHookInput(input: Record<string, unknown>, host: string, prefix: "CODEX" | "ANTIGRAVITY"): AdaptedHostInput {
  const actor: InputObservation["actor"] = {
    role: "indeterminate", basis: "unavailable", reasonCode: `${prefix}_NATIVE_EVENT_UNRECOGNIZED`,
  };
  const adapted = adaptBuiltinHookInput(input, host, actor);
  if (adapted.lifecycle === "none" && adapted.observation.kind === "unknown" && adapted.continuityAction === undefined) return adapted;
  if (!adapted.observation.sessionId.trim()) actor.reasonCode = `${prefix}_NATIVE_SESSION_ID_INVALID`;
  else if (adapted.observation.kind === "subagent-start") {
    // A subagent start is a child by definition (it names the parent session): never inferred as the root.
    if (typeof input.agent_id === "string" && input.agent_id.trim()) Object.assign(actor, { role: "child", basis: "observed", reasonCode: `${prefix}_NATIVE_CHILD_AGENT_ID` });
    else actor.reasonCode = `${prefix}_NATIVE_SUBAGENT_START_AGENT_ID_INVALID`;
  } else Object.assign(actor, { role: "root", basis: "inferred", reasonCode: `${prefix}_ROOT_INFERRED_CHILD_GATE_DEFERRED` });
  return adapted;
}

function adaptCodexHookInput(input: Record<string, unknown>, host: string): AdaptedHostInput {
  const adapted = adaptInferredRootHookInput(input, host, "CODEX");
  // apply_patch is Codex's file edit; its patch text is tool_input.command (Codex hooks, PreToolUse).
  setEditTargets(adapted, input, (tool, toolInput) => {
    if (tool === "apply_patch") return applyPatchTargets(toolInput.command);
    // Codex 0.166 exec_command emits canonical Bash with { command: args.cmd }, not the model-facing tool name.
    if (tool !== "Bash" && tool !== "exec_command" && tool !== "shell_command" && tool !== "shell") return null;
    const dialect = /(?:powershell|pwsh)(?:\.exe)?$/iu.test(text(toolInput.shell)) || (!toolInput.shell && process.platform === "win32") ? "powershell" : "posix";
    return shellEditTargets(toolInput.cmd ?? toolInput.command, dialect);
  });
  // Codex Stop reports a turn its Stop hook already continued; a second continuation could loop without a host limit.
  if (adapted.observation.kind === "turn-end" && adapted.lifecycle === "none" && input.stop_hook_active === true) adapted.observation.stopHookActive = true;
  if (adapted.observation.actor.role !== "root") return adapted;
  if (Object.hasOwn(input, "agent_id")) {
    // Codex's native subagent hook context serializes agent_id even though session_id names the parent.
    // Missing markers retain the 3.0 stopgap; a positive or malformed marker must never inherit it.
    adapted.observation.actor = typeof input.agent_id === "string" && input.agent_id.trim()
      ? { role: "child", basis: "observed", reasonCode: "CODEX_NATIVE_CHILD_AGENT_ID" }
      : { role: "indeterminate", basis: "unavailable", reasonCode: "CODEX_NATIVE_AGENT_ID_INVALID" };
    return adapted;
  }
  // The fork fact comes only from the host's SessionStart source; the parent comes from the rollout's first line.
  if (adapted.continuityAction?.kind === "startup" && input.source === "fork") {
    adapted.continuityAction = { kind: "fork" };
    const transcriptPath = text(input.transcript_path);
    const sessionId = adapted.observation.sessionId;
    if (transcriptPath && sessionId) adapted.readForkOrigin = () => readCodexForkOrigin(transcriptPath, sessionId);
  }
  return adapted;
}

// session_meta carries the session's base instructions, so its line can be long; same bound as the Claude window.
const CODEX_FORK_ORIGIN_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Parent session of a Codex fork from the `session_meta` first line of the host-given rollout JSONL.
 * Format source: tester TEST observation on Codex 0.166 (hook stdin has no parent key; the first line's
 * payload carries id, forked_from_id and timestamp). The host writes the child's own first line when it
 * creates the fork, before the model runs. Only the first line of that path is read; no body text is returned.
 */
function readCodexForkOrigin(transcriptPath: string, sessionId: string): ForkOriginRead {
  let descriptor: number | null = null;
  let firstLine: string;
  try {
    descriptor = openSync(transcriptPath, constants.O_RDONLY | constants.O_NONBLOCK);
    const stats = fstatSync(descriptor);
    if (!stats.isFile()) return { reason: "FORK_ORIGIN_TRANSCRIPT_UNREADABLE" };
    const buffer = Buffer.alloc(Math.min(stats.size, CODEX_FORK_ORIGIN_MAX_BYTES));
    const bytes = readSync(descriptor, buffer, 0, buffer.length, 0);
    const newline = buffer.subarray(0, bytes).indexOf(0x0a);
    if (newline < 0) return { reason: "FORK_ORIGIN_FORMAT_INVALID" };
    firstLine = buffer.subarray(0, newline).toString("utf8");
  } catch (cause) {
    return { reason: (cause as NodeJS.ErrnoException).code === "ENOENT" ? "FORK_ORIGIN_TRANSCRIPT_ABSENT" : "FORK_ORIGIN_TRANSCRIPT_UNREADABLE" };
  } finally {
    if (descriptor !== null) try { closeSync(descriptor); } catch { /* read already finished or failed above */ }
  }
  let entry: unknown;
  try { entry = JSON.parse(firstLine); } catch { return { reason: "FORK_ORIGIN_FORMAT_INVALID" }; }
  const meta = record(entry);
  const payload = meta.payload;
  if (meta !== entry || meta.type !== "session_meta" || record(payload) !== payload) return { reason: "FORK_ORIGIN_FORMAT_INVALID" };
  const fields = payload as Record<string, unknown>;
  if (fields.id !== sessionId) return { reason: "FORK_ORIGIN_SESSION_MISMATCH" };
  if (!Object.hasOwn(fields, "forked_from_id")) return { reason: "FORK_ORIGIN_ABSENT" };
  const parentSessionId = fields.forked_from_id;
  if (typeof parentSessionId !== "string" || !parentSessionId || parentSessionId === sessionId) return { reason: "FORK_ORIGIN_FORMAT_INVALID" };
  const at = typeof fields.timestamp === "string" ? Date.parse(fields.timestamp) : Number.NaN;
  if (!Number.isFinite(at)) return { reason: "FORK_ORIGIN_FORMAT_INVALID" };
  return { parentSessionId, at };
}

const CLAUDE_EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/** Claude's supported native hook schema omits agent_id for root calls.
 * Absence supports inference only; an explicit empty or malformed ID never does. */
function adaptClaudeHookInput(input: Record<string, unknown>, host: string): AdaptedHostInput {
  const actor: InputObservation["actor"] = {
    role: "indeterminate", basis: "unavailable", reasonCode: "CLAUDE_NATIVE_EVENT_UNRECOGNIZED",
  };
  const adapted = adaptBuiltinHookInput(input, host, actor);
  setEditTargets(adapted, input, (tool, toolInput) => {
    if (CLAUDE_EDIT_TOOLS.has(tool)) return [tool === "NotebookEdit" ? toolInput.notebook_path : toolInput.file_path];
    return tool === "Bash" || tool === "PowerShell" ? shellEditTargets(toolInput.command, tool === "PowerShell" ? "powershell" : "posix") : null;
  });
  const knownEvent = adapted.lifecycle !== "none" || adapted.observation.kind !== "unknown" || adapted.continuityAction !== undefined;
  if (!knownEvent) return adapted;
  if (!adapted.observation.sessionId.trim()) actor.reasonCode = "CLAUDE_NATIVE_SESSION_ID_INVALID";
  else if (Object.hasOwn(input, "agent_type") && (typeof input.agent_type !== "string" || !input.agent_type.trim())) {
    actor.reasonCode = "CLAUDE_NATIVE_AGENT_TYPE_INVALID";
  } else if (Object.hasOwn(input, "agent_id")) {
    if (typeof input.agent_id !== "string" || !input.agent_id.trim()) actor.reasonCode = "CLAUDE_NATIVE_AGENT_ID_INVALID";
    else Object.assign(actor, { role: "child", basis: "observed", reasonCode: "CLAUDE_NATIVE_CHILD_AGENT_ID" });
  } else if (adapted.observation.kind === "subagent-start") actor.reasonCode = "CLAUDE_NATIVE_SUBAGENT_START_AGENT_ID_INVALID";
  else Object.assign(actor, { role: "root", basis: "inferred", reasonCode: "CLAUDE_NATIVE_ROOT_AGENT_ID_ABSENT" });
  const transcriptPath = text(input.transcript_path);
  const sessionId = adapted.observation.sessionId;
  // The fork fact comes only from the host's SessionStart source. The parent is the one the host process was started
  // from when its argv names it (D0352 N1z); otherwise it is chosen later from lineage.
  if (adapted.continuityAction?.kind === "startup" && input.source === "fork") {
    adapted.continuityAction = { kind: "fork" };
    const startRead = sessionId ? claudeForkHostRead(sessionId, "start") : undefined;
    if (startRead) adapted.readForkHostParent = startRead;
  } else if (sessionId && adapted.observation.kind === "tool-boundary" && adapted.observation.boundaryPhase === "before") {
    // Windows reads the host process here instead of at SessionStart; the service reads it only for a deferred fork.
    const boundaryRead = claudeForkHostRead(sessionId, "boundary");
    if (boundaryRead) adapted.readForkHostParent = boundaryRead;
  }
  if (transcriptPath && sessionId) adapted.readLineage = () => readClaudeLineage(transcriptPath, sessionId);
  return adapted;
}

// Design r03 D2: the lineage window is the newest 2 MiB and at most 4000 complete lines.
const CLAUDE_LINEAGE_MAX_BYTES = 2 * 1024 * 1024;
const CLAUDE_LINEAGE_MAX_LINES = 4000;

/**
 * Structural `uuid` fields of this session's own entries in the host-given transcript, oldest first, with each
 * entry's `timestamp`. A fork copies the parent's entries with their uuids and rewrites sessionId to the child
 * (B08 r01/r04); the copied entries keep the time the parent wrote them (review 902e T1, real-host check pending).
 * Message bodies are never returned. Only the path the host passed is read, never a copy elsewhere.
 * Out of scope: a same-account process that edits this host-written file can also read the continuity
 * database and its secret directly, so lineage cannot protect against it (design r03 section 2).
 * Entries outside the window are not lineage evidence: a parent anchor there yields FORK_PARENT_NOT_FOUND.
 * A complete line that is not JSON means the host format changed, so no IDs are returned at all (D2).
 */
export function readClaudeLineage(transcriptPath: string, sessionId: string): LineageRead {
  let descriptor: number | null = null;
  let content: string;
  try {
    descriptor = openSync(transcriptPath, constants.O_RDONLY | constants.O_NONBLOCK);
    const stats = fstatSync(descriptor);
    if (!stats.isFile()) return { reason: "LINEAGE_TRANSCRIPT_UNREADABLE" };
    const length = Math.min(stats.size, CLAUDE_LINEAGE_MAX_BYTES);
    const buffer = Buffer.alloc(length);
    const bytes = readSync(descriptor, buffer, 0, length, stats.size - length);
    content = buffer.subarray(0, bytes).toString("utf8");
    // A cut first line is partial; drop it rather than parse a fragment.
    if (stats.size > length) content = content.slice(content.indexOf("\n") + 1);
  } catch (cause) {
    return { reason: (cause as NodeJS.ErrnoException).code === "ENOENT" ? "LINEAGE_TRANSCRIPT_ABSENT" : "LINEAGE_TRANSCRIPT_UNREADABLE" };
  } finally {
    if (descriptor !== null) try { closeSync(descriptor); } catch { /* read already finished or failed above */ }
  }
  // The text after the last newline is a line the host may still be writing; it is not read.
  const lines = content.split("\n").slice(0, -1).slice(-CLAUDE_LINEAGE_MAX_LINES);
  const ids: string[] = [];
  const at: number[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try { entry = record(JSON.parse(line)); } catch { return { reason: "LINEAGE_FORMAT_INVALID" }; }
    if (entry.sessionId === sessionId && typeof entry.uuid === "string" && entry.uuid) {
      ids.push(entry.uuid);
      at.push(typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : Number.NaN);
    }
  }
  return ids.length > 0 ? { ids, at } : { reason: "LINEAGE_IDS_ABSENT" };
}

function adaptGeminiHookInput(input: Record<string, unknown>, host: string): AdaptedHostInput {
  return adaptBuiltinHookInput(input, host, {
    role: "indeterminate", basis: "unavailable", reasonCode: "GEMINI_ACTOR_OBSERVATION_UNSUPPORTED",
  });
}

const ANTIGRAVITY_EDIT_TOOLS = new Set(["Write", "Edit", "MultiEdit"]);

/** ponytail: Antigravity PreToolUse carries no tool call ID (agy hooks.md), so each hook run
 * draws a random one to keep the root proof one-use. Bind the native ID once Antigravity sends one. */
function adaptAntigravityHookInput(input: Record<string, unknown>, host: string): AdaptedHostInput {
  const adapted = adaptInferredRootHookInput(input, host, "ANTIGRAVITY");
  // The native runner emits this prompt boundary as a non-persistent ephemeralMessage at turn invocation zero.
  adapted.restoreCurrentAtTurnStart = adapted.observation.kind === "user-input";
  // The runner maps the file tools to Write, Edit and MultiEdit and passes their arguments. agy 1.4.12 CLI hook input
  // (test server capture): write_file and edit_file name the file in Path. write_to_file, replace_file_content and
  // multi_replace_file_content (agy hooks docs) name it in TargetFile.
  setEditTargets(adapted, input, (tool, toolInput) => {
    if (ANTIGRAVITY_EDIT_TOOLS.has(tool)) return [toolInput.TargetFile ?? toolInput.Path];
    return tool === "Bash" || tool === "PowerShell" ? shellEditTargets(toolInput.CommandLine ?? toolInput.command, tool === "PowerShell" ? "powershell" : "posix") : null;
  });
  const { observation } = adapted;
  if (observation.kind === "tool-boundary" && observation.boundaryPhase === "before" && !observation.callId) {
    // agy gives the hook no call ID. The key holds what the host writes on both sides (conversation, tool, arguments)
    // so the server finds this row for its tools/call; the random suffix keeps each call's observation distinct.
    observation.callId = `${antigravityCallKey(observation.sessionId, observation.toolName ?? "", observation.toolInput ?? {}).call}:${randomUUID()}`;
  }
  return adapted;
}

const digest = (value: string) => createHash("sha256").update(value, "utf8").digest("hex").slice(0, 32);
/** Row key prefixes for one agy call: `caller` = conversation and tool, `call` = that plus the canonical arguments. */
export function antigravityCallKey(conversationId: string, toolName: string, args: unknown): { caller: string; call: string } {
  const caller = digest(JSON.stringify([conversationId, toolName.split("__").at(-1) ?? toolName]));
  return { caller, call: `${caller}:${digest(canonicalJson(args ?? {}, "Tool arguments"))}` };
}

const AGY_EFFORT = /^(.+)-(low|medium|high)$/;
/** agy names the model and effort in one hook field (`gemini-4-argon-medium`, agy 1.4.12 `agy models`). */
function observeAntigravityExecution(input: Record<string, unknown>): CallerExecution {
  const name = text(input.model);
  if (!name) return { unavailable: "ANTIGRAVITY_MODEL_NAME_MISSING" };
  const match = AGY_EFFORT.exec(name);
  return { model: match?.[1] ?? name, effort: match?.[2] ?? null, turnId: null, provenance: "antigravity:hook-model-name" };
}

const GOVERNANCE_TOOL_PREFIXES = new Set([
  "mcp__agent_governance_suite__", "mcp__agent-governance-suite__",
  "mcp__plugin_agent-governance-suite_agent-governance-suite__",
]);
function ownsGovernanceTool(toolName: string): boolean {
  const separator = toolName.lastIndexOf("__");
  return separator > 0 && GOVERNANCE_TOOL_PREFIXES.has(toolName.slice(0, separator + 2));
}

const queueSettingsFailureReasons = {
  "directory-stat": "QUEUE_SETTINGS_DIRECTORY_STAT_FAILED",
  open: "QUEUE_SETTINGS_OPEN_FAILED",
  read: "QUEUE_SETTINGS_READ_FAILED",
  close: "QUEUE_SETTINGS_CLOSE_FAILED",
} as const;

function queueEnabled(host: string, explicit: string | undefined, environment: NodeJS.ProcessEnv,
  diagnose: (reason: string, observation?: HookSettingsDiagnostic) => void, defaultEnabled = false): boolean {
  const disabled = (reason: string, observation?: HookSettingsDiagnostic) => {
    if (observation) diagnose(reason, Object.freeze(observation)); else diagnose(reason);
    return false;
  };
  const failed = (phase: keyof typeof queueSettingsFailureReasons, cause: unknown) =>
    retainHookFailureCause(hookFailure(queueSettingsFailureReasons[phase], "Queue settings I/O failed."), cause);
  const absent = (error: unknown): boolean => {
    if (!error || typeof error !== "object" || utilTypes.isProxy(error)) return false;
    try { return Object.getOwnPropertyDescriptor(error, "code")?.value === "ENOENT"; }
    catch { return false; }
  };
  if (explicit !== undefined) {
    if (explicit === "1") return true;
    return explicit === "0" ? false : disabled("invalid-environment");
  }
  const directory = environment.PLUGIN_DATA;
  if (directory === undefined) return defaultEnabled;
  // Windows root-relative paths still depend on the current drive.
  if (!path.isAbsolute(directory) || (process.platform === "win32" && ["\\", "/"].includes(path.parse(directory).root))) {
    return disabled("invalid-plugin-data");
  }
  let descriptor = -1;
  let validDirectory: boolean;
  let acquisitionPhase: "directory-stat" | "open" = "directory-stat";
  try {
    validDirectory = statSync(directory).isDirectory();
    if (validDirectory) {
      acquisitionPhase = "open";
      descriptor = openSync(path.join(directory, "session-messaging.json"), constants.O_RDONLY | constants.O_NONBLOCK);
    }
  } catch (cause) {
    return absent(cause) ? defaultEnabled : disabled("read-failed", {phase: acquisitionPhase, cleanup: "not-acquired", failure: failed(acquisitionPhase, cause)});
  }
  // Diagnose validation outside the I/O catch: an observer failure is not an open failure.
  if (!validDirectory) return disabled("invalid-plugin-data");
  let enabled = false;
  let issue: string | undefined;
  let primary: Error | undefined;
  let primaryPhase: "read" | "close" = "read";
  let missingRead = false;
  let closeFailed = false;
  const rejected = (reason: string) => { issue = reason; return false; };
  try {
    enabled = (() => {
      const stat = fstatSync(descriptor);
      if (!stat.isFile()) return rejected("invalid-file-type");
      if (stat.size > 4096) return rejected("too-large");
      // One extra byte detects growth after fstat; short reads cannot bypass the limit.
      const bytes = Buffer.alloc(4097);
      let length = 0;
      while (length < bytes.length) {
        const count = readSync(descriptor, bytes, length, bytes.length - length, null);
        if (count === 0) break;
        length += count;
      }
      if (length > 4096) return rejected("too-large");
      let settings: Record<string, unknown>;
      try { settings = record(JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(bytes.subarray(0, length)))); }
      catch { return rejected("invalid-settings"); }
      const hostSettings = record(settings[host]);
      if (settings.schemaVersion !== "1.0.0" || typeof hostSettings.queueWake !== "boolean") return rejected("invalid-settings");
      return hostSettings.queueWake;
    })();
  } catch (cause) {
    missingRead = absent(cause);
    primary = failed("read", cause);
  } finally {
    // A throwing close has unknown completion. Never retry a possibly reused descriptor.
    try { closeSync(descriptor); }
    catch (cause) {
      closeFailed = true;
      const closeFailure = failed("close", cause);
      if (primary) retainHookFailureSecondary(primary, closeFailure);
      else { primary = closeFailure; primaryPhase = "close"; }
    }
  }
  // Preserve the legacy absence/default decision only when cleanup completed normally.
  if (missingRead && !closeFailed) return defaultEnabled;
  if (primary) return disabled(issue ?? (primaryPhase === "close" ? "close-failed" : "read-failed"),
    {phase: primaryPhase, cleanup: closeFailed ? "unknown" : "closed", failure: primary});
  return issue === undefined ? enabled : disabled(issue);
}

function codexQueueEnabled(environment: NodeJS.ProcessEnv, diagnose: (reason: string, observation?: HookSettingsDiagnostic) => void): boolean {
  return queueEnabled("codex", environment.AGENT_GOVERNANCE_CODEX_QUEUE_WAKE, environment, diagnose);
}

function antigravityQueueEnabled(environment: NodeJS.ProcessEnv, diagnose: (reason: string, observation?: HookSettingsDiagnostic) => void, defaultQueueWake?: boolean): boolean {
  // Adapter-owned defaults are settings provenance, never actor, liveness or execution authority.
  // D0364: an inferred default enables the queue only where its idle wake can start. The wake refuses every attempt
  // without the source project identity, so without it the recipient reports no idle wake instead of a live one.
  // ponytail: gates on the project identity only; agentapi is resolved when the wake runs (PATH fallback off Windows)
  // and a missing one still surfaces as a relay failure. Gate on the wake's agentapi resolution if that case appears.
  const wakeReady = Boolean(environment.ANTIGRAVITY_PROJECT_ID?.trim());
  const defaultEnabled = wakeReady && (defaultQueueWake === true || Boolean(environment.ANTIGRAVITY_AGENTAPI_EXE
    || environment.ANTIGRAVITY_CONVERSATION_ID || environment.ANTIGRAVITY_AGENT));
  return queueEnabled("antigravity", environment.AGENT_GOVERNANCE_ANTIGRAVITY_QUEUE_WAKE, environment, diagnose, defaultEnabled);
}

function home(environment: NodeJS.ProcessEnv): string {
  return environment.HOME || environment.USERPROFILE || homedir();
}

/** Claude Code auto memory: `<config dir>/projects/<project>/memory` (CLAUDE_CONFIG_DIR, default ~/.claude). */
function claudeNoteRoots(environment: NodeJS.ProcessEnv): string[] {
  return [path.join(environment.CLAUDE_CONFIG_DIR || path.join(home(environment), ".claude"), "projects", "*", "memory")];
}

/** Antigravity agent artifacts (task, plan, scratch): the CLI's `~/.gemini/antigravity-cli/brain` (agy 1.4.12), the
 * editor's `~/.gemini/antigravity/brain`. Codex keeps memories in SQLite, not in files an edit tool writes. */
function antigravityNoteRoots(environment: NodeJS.ProcessEnv): string[] {
  const gemini = path.join(home(environment), ".gemini");
  return [path.join(gemini, "antigravity-cli", "brain"), path.join(gemini, "antigravity", "brain")];
}

// Builtin wiring belongs to this composition module; core registration has no vendor list.
const builtinHookHostAdapters = new Map<string, Readonly<HookHostAdapter>>([
  ["codex", {
    adaptInput: adaptCodexHookInput, ownsTool: ownsGovernanceTool,
    deliveryProfile: (environment, diagnose) => deliveryProfile(codexQueueEnabled(environment, diagnose) ? "codex-queue" : "codex-deferred", false),
    processPid: (pid) => pid, peerWait: codexNativePeerWait,
    // Codex Stop output is decision/reason only (codex-rs hooks StopCommandOutputWire, deny_unknown_fields; 0.166.0).
    continuesTurnWithReason: true,
  }],
  ["claude-code", {
    adaptInput: adaptClaudeHookInput, ownsTool: ownsGovernanceTool,
    observeExecution: (input, environment) => observeClaudeExecution(input, { host: "claude-code",
      readSessionModel: (id) => readSessionModel(sessionModelDirectory(resolveWorkflowDatabasePath(environment)), id) }),
    deliveryProfile: () => deliveryProfile("claude-inbox", true),
    processPid: () => process.ppid, agentNoteRoots: claudeNoteRoots,
  }],
  ["gemini", {
    adaptInput: adaptGeminiHookInput, ownsTool: ownsGovernanceTool,
    // Gemini CLI has no idle wake path of its own; only Antigravity uses the agentapi queue.
    deliveryProfile: () => deliveryProfile("gemini-deferred", false),
    processPid: (pid, observation) => observation ? pid : undefined,
  }],
  ["antigravity", {
    adaptInput: adaptAntigravityHookInput, ownsTool: ownsGovernanceTool, observeExecution: observeAntigravityExecution,
    deliveryProfile: (environment, diagnose, defaultQueueWake) => deliveryProfile(antigravityQueueEnabled(environment, diagnose, defaultQueueWake) ? "antigravity-queue" : "gemini-deferred", false),
    processPid: (pid, observation) => observation ? pid : undefined, agentNoteRoots: antigravityNoteRoots,
  }],
]);

function deliveryProfile(transport: SessionMessageTransport, blocksEmptyWakePrompt: boolean): HostDeliveryProfile {
  return { transport, capabilities: transportDeliveryCapabilities(transport), blocksEmptyWakePrompt };
}

/** Only the observed, local Codex app wait surface is recognized here. */
function codexNativePeerWait(observation: InputObservation): NativePeerWaitObservation | null {
  if (observation.toolName !== "mcp__codex_app__wait_threads") return null;
  const input = observation.toolInput ?? {};
  const timeoutMs = input.timeoutMs === undefined ? 120_000 : input.timeoutMs;
  if (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 3_600_000) return null;
  if (!Array.isArray(input.targets) || input.targets.length < 1 || input.targets.length > 8) return null;
  const targets: Array<{ host: string; sessionId: string }> = [];
  const cursors = new Set<string>();
  for (const value of input.targets) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const target = value as Record<string, unknown>;
    if (typeof target.threadId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(target.threadId)) return null;
    if (target.hostId !== undefined && target.hostId !== "local") return null;
    if (target.afterCursor !== undefined && typeof target.afterCursor !== "string") return null;
    targets.push({ host: "codex", sessionId: target.threadId });
    // Keep every distinct cursor for an identity; conflicting cursors are not collapsed.
    cursors.add(JSON.stringify([target.threadId, target.afterCursor ?? null]));
  }
  return { targets: normalizePeerWaitTargets(targets), timeoutMs,
    queryRevision: createHash("sha256").update(JSON.stringify([...cursors].sort())).digest("hex") };
}

// Static composition executes once per bundled module instance.
for (const [host, adapter] of builtinHookHostAdapters) registerHookHostAdapter(host, adapter);
