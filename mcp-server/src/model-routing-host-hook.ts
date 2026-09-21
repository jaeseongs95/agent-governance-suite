import { randomBytes } from "node:crypto";
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import type { HostModelCapabilitiesV1, ModelApplicationRecordV2, ModelCatalogV1 } from "../../contracts/types.js";
import { ModelRoutingStore, RoutingObservationSigner } from "../../skills/coordinate-subagents/scripts/model-routing-store.mjs";
import { ModelRoutingServiceCore } from "../../skills/coordinate-subagents/scripts/model-routing-service-core.mjs";
import { canonicalJson, convergenceDigest } from "./convergence-logic.js";
import { claudeCodeActorId, findToolUseObservation, transcriptCandidates } from "./native-tool-observation.js";
import { isReasoningEffort, lowerReasoningEffort } from "./host-attestation.js";
import { resolveSessionMessageStateDirectory, resolveWorkflowDatabasePath } from "./runtime-config.js";
import { requestSessionMessageOnce } from "./session-message-client.js";
import type { SessionPresence } from "./session-message-store.js";
import { ContractValidator } from "./schema-validator.js";
import { SqliteWorkflowStore } from "./sqlite-workflow-store.js";

export type NativeRoutingHost = "codex" | "claude-code";
type NativeObservation = NonNullable<ModelApplicationRecordV2["observed"]>;
type NativeSettings = Pick<NativeObservation, "models" | "nativeReasoning" | "runtimeMode">;
type HookInput = Record<string, unknown>;
const HOST_IDS = { codex: "openai-codex", "claude-code": "anthropic-claude-code" } as const;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;
const MAX_INPUT = 1024 * 1024;
const MAX_TRANSCRIPT = 2 * MAX_INPUT;
const KEY_NAME = "model_routing_native_observer_v1";
const CATALOG = fileURLToPath(new URL("../../skills/coordinate-subagents/references/model-catalog/", import.meta.url));
const ROOT_TOOLS = /^(?:mcp__agent[-_]governance[-_]suite__|mcp__plugin_agent-governance-suite_agent-governance-suite__)(resolve_model_assignment|record_model_application)$/u;

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function text(value: unknown): string | null { return typeof value === "string" && value.length > 0 ? value : null; }
function check(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }

/** Same privacy-preserving actor convention as the existing Claude v1 adapter; no actor is read from tool_input. */
export function nativeRoutingActor(host: NativeRoutingHost, sessionId: string, agentId: string | null): string {
  check(SAFE_ID.test(sessionId) && (agentId === null || SAFE_ID.test(agentId)), "Invalid native hook identity.");
  const claude = claudeCodeActorId(sessionId, agentId);
  return host === "claude-code" ? claude : claude.replace(/^claude-code:/u, "codex:");
}

/** Bound memory and I/O. A missing exact transcript message remains unknown, never a latest-message guess. */
export function readNativeTranscript(file: string): string | null {
  let fd: number | null = null;
  try {
    const info = statSync(file);
    if (!info.isFile()) return null;
    fd = openSync(file, "r");
    const start = Math.max(0, info.size - MAX_TRANSCRIPT);
    const buffer = Buffer.alloc(Math.min(info.size, MAX_TRANSCRIPT));
    const bytes = readSync(fd, buffer, 0, buffer.length, start);
    const value = buffer.subarray(0, bytes).toString("utf8");
    return start > 0 ? value.slice(value.indexOf("\n") + 1) : value;
  } catch { return null; } finally { if (fd !== null) closeSync(fd); }
}

/** Read host-owned fields only. Codex's documented hook has no effective effort/mode field. */
export function nativeRoutingSettings(
  input: HookInput, host: NativeRoutingHost, models: ModelCatalogV1["models"],
  readTranscript: (file: string) => string | null = readNativeTranscript,
): NativeSettings {
  const session = text(input.session_id), agent = text(input.agent_id), call = text(input.tool_use_id);
  check(session && SAFE_ID.test(session) && (!agent || SAFE_ID.test(agent)) && call && SAFE_ID.test(call), "Native tool event identity is missing.");
  let model: string | null = null;
  let effort: string | null = null;
  if (host === "codex") {
    model = text(input.model);
  } else {
    const transcript = text(input.transcript_path);
    if (transcript) {
      for (const candidate of transcriptCandidates(transcript, session, agent)) {
        const body = readTranscript(candidate);
        const exact = body ? findToolUseObservation(body, call, session, agent) : null;
        if (exact) { model = exact.model; effort = exact.effort; break; }
      }
    }
    const hookEffort = text(object(input.effort).level);
    // A larger requested effort never replaces the lower effective observation.
    effort = isReasoningEffort(hookEffort) && isReasoningEffort(effort) ? lowerReasoningEffort(hookEffort, effort)
      : isReasoningEffort(hookEffort) ? hookEffort : isReasoningEffort(effort) ? effort : null;
  }
  if (model && !/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/u.test(model)) model = null;
  // An alias or unknown ID is not silently promoted to an exact catalog version.
  const known = models.find(item => item.id === model);
  const nativeReasoning = known?.nativeKinds.includes("enum") && effort && ["low", "medium", "high", "xhigh", "max"].includes(effort)
    ? { kind: "enum" as const, value: effort } : null;
  return {
    models: model ? [{ resolvedModel: model, modelOrigin: known?.modelOrigin ?? "unknown" }] : [],
    nativeReasoning,
    // Neither documented hook proves standard vs Ultra/Ultracode. Never infer it from effort.
    runtimeMode: null,
  };
}

export interface NativeHookDependencies {
  store: ModelRoutingStore;
  signer: RoutingObservationSigner;
  presence: SessionPresence;
  now: string;
  models: ModelCatalogV1["models"];
  hostContract?: unknown;
  readTranscript?: (file: string) => string | null;
}

/** A local operator contract supplies supported controls, not an attestation of effective execution. */
function capabilitySnapshot(input: HookInput, host: NativeRoutingHost, settings: NativeSettings, deps: NativeHookDependencies): HostModelCapabilitiesV1 {
  const { presence, now } = deps;
  const observed = settings.models[0];
  const target = { host: HOST_IDS[host], sessionId: presence.sessionId, instanceId: presence.instanceId!, actorId: nativeRoutingActor(host, presence.sessionId, text(input.agent_id)) };
  const contract = deps.hostContract === undefined ? null : object(deps.hostContract);
  if (contract) {
    check(Object.keys(contract).every(key => ["schemaVersion", "host", "hostVersion", "supportedBindings", "executionCapabilities", "sourceReference"].includes(key)), "Unsupported native contract field.");
    check(contract.schemaVersion === "1.0.0" && contract.host === target.host, "Native contract host/version mismatch.");
  }
  const binding = observed ? [{ model: observed.resolvedModel, resolvedModel: observed.resolvedModel, modelOrigin: observed.modelOrigin,
    servingProvider: "unknown", accessPath: "unknown", nativeReasoning: settings.nativeReasoning ?? { kind: "not-exposed" }, runtimeMode: "unknown",
    invocationSurface: "peer-session", observableFields: settings.nativeReasoning ? ["model", "reasoning"] : ["model"], aliasResolution: null, possibleFallbacks: [] }] : [];
  const snapshot = {
    schemaVersion: "1.0.0", ...target, hostVersion: contract?.hostVersion ?? "unknown", adapterVersion: "p3-native-hook-v1",
    observedAt: now, expiresAt: new Date(Date.parse(now) + 60000).toISOString(),
    supportedBindings: contract?.supportedBindings ?? binding,
    executionCapabilities: contract?.executionCapabilities ?? { dispatch: "unknown", observe: true, cancel: "unknown", resume: "unknown", filesystem: "unknown", tools: [], approvals: "unknown", isolation: "unknown", inputModalities: [] },
    source: contract ? "configuration" : "host-observation",
    sourceReference: `native-hook:${convergenceDigest({ host, call: input.tool_use_id, settings, contract })}`,
  };
  const validator = new ContractValidator();
  const validated = validator.hostModelCapabilitiesV1({ ...snapshot, snapshotDigest: convergenceDigest(snapshot) });
  // An operator file cannot upgrade current observation coverage or advertise an unobserved runtime mode.
  validated.supportedBindings = validated.supportedBindings.map(item => ({ ...item, observableFields:
    observed?.resolvedModel === item.resolvedModel && item.model === item.resolvedModel
      ? settings.nativeReasoning && canonicalJson(settings.nativeReasoning) === canonicalJson(item.nativeReasoning) ? ["model", "reasoning"] : ["model"] : [] }));
  const unsigned: Record<string, unknown> = { ...validated };
  delete unsigned.snapshotDigest;
  return validator.hostModelCapabilitiesV1({ ...unsigned, snapshotDigest: convergenceDigest(unsigned) });
}

/** Invoked only by the installed native hook. No new model-callable publication or authority API. */
export function handleNativeRoutingHook(input: HookInput, host: NativeRoutingHost, deps: NativeHookDependencies): Record<string, unknown> {
  const tool = ROOT_TOOLS.exec(text(input.tool_name) ?? "")?.[1];
  const event = input.hook_event_name;
  if (!tool || !["PreToolUse", "PostToolUse"].includes(String(event))) return {};
  check(Number.isFinite(Date.parse(deps.now)) && new Date(deps.now).toISOString() === deps.now, "Invalid observation time.");
  const { presence, store, signer, now } = deps;
  check(presence.host === host && presence.sessionId === input.session_id && presence.instanceId && presence.state === "online"
    && presence.leaseUntil && Date.parse(presence.leaseUntil) > Date.parse(now), "Native session instance is not current.");
  const settings = nativeRoutingSettings(input, host, deps.models, deps.readTranscript);
  const expiresAt = new Date(Date.parse(now) + 60000).toISOString();
  if (tool === "resolve_model_assignment") {
    if (event !== "PreToolUse" || text(input.agent_id)) return {}; // The presence slot belongs to the parent, not a child actor.
    const snapshot = capabilitySnapshot(input, host, settings, deps);
    store.publishCapability(signer.issue("capability", snapshot, { issuedAt: now, expiresAt }), signer, { ...presence, host: HOST_IDS[host] }, now);
    return {};
  }
  const args = object(input.tool_input), application = object(args.application);
  const target = object(application.target);
  check(target.host === HOST_IDS[host] && target.sessionId === presence.sessionId && target.instanceId === presence.instanceId
    && target.actorId === nativeRoutingActor(host, presence.sessionId, text(input.agent_id)), "The tool issuer is not the recorded routing actor.");
  const entry = store.decision(String(application.decisionDigest ?? ""));
  check(entry && canonicalJson(entry.decision.binding) === canonicalJson(application.binding) && canonicalJson(entry.decision.target) === canonicalJson(target), "Native observation task binding mismatch.");
  const dispatch = store.dispatch(convergenceDigest({ binding: application.binding }));
  check(dispatch && dispatch.decision_digest === entry.decision.decisionDigest && dispatch.dispatched_at === application.dispatchedAt, "A matching native dispatch has not been registered.");
  if (settings.models.length === 0 && settings.nativeReasoning === null) return {};
  const observation: NativeObservation = {
    binding: entry.decision.binding, target: entry.decision.target!, decisionDigest: entry.decision.decisionDigest,
    source: "host-event", reference: `native-tool-issuer:${convergenceDigest({ host, call: input.tool_use_id, event, application: convergenceDigest(application) })}`,
    observedAt: now, ...settings, terminalOutcome: "unknown",
  };
  // Never use tool_input.observation, requested settings, last_assistant_message, or a worker's PASS.
  // For PostToolUse, first prove this is the actual successful AGS record result, not a lookalike tool payload.
  let previous: ModelApplicationRecordV2 | null = null;
  if (event === "PostToolUse") {
    const result = object(input.tool_response);
    const content = Array.isArray(result.content) ? result.content : [];
    const output = content.find(item => object(item).type === "text");
    const response = object(JSON.parse(String(object(output).text ?? "null")));
    check(result.isError !== true && response.ok === true, "The routing record call did not succeed.");
    previous = new ContractValidator().modelApplicationRecordV2(object(response.data).record);
    check(canonicalJson(store.application(previous.recordDigest)) === canonicalJson(previous)
      && previous.decisionDigest === application.decisionDigest && canonicalJson(previous.binding) === canonicalJson(application.binding)
      && previous.dispatchedAt === application.dispatchedAt, "Native post-tool record is not stored for this application.");
    if (previous.observationAdmitted) return {};
  }
  store.bindNativeHookObservation(application, signer.issue("observation", observation, { issuedAt: now, expiresAt }), signer, now);
  if (event === "PreToolUse") return {}; // No updatedInput/allow decision: existing approval handling is unchanged.
  const service = new ModelRoutingServiceCore({ store, clock: () => now });
  const result = service.call("record_model_application", { application });
  check(result.ok, "Native post-tool record admission failed.");
  const recorded = new ContractValidator().modelApplicationRecordV2(object(result.data).record);
  return { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: JSON.stringify({
    kind: "ags-model-application-observation", supersedesDiagnosticRecord: previous!.recordDigest,
    artifact: object(result.data).artifact, modelVerification: recorded.modelVerification, reasoningVerification: recorded.reasoningVerification,
    runtimeModeVerification: recorded.runtimeModeVerification, terminalOutcome: recorded.terminalOutcome, trustedGateSatisfied: false,
  }) } };
}

function boundedStdin(): string {
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const chunk = Buffer.alloc(16384), count = readSync(0, chunk, 0, chunk.length, null);
    if (!count) break;
    total += count; check(total <= MAX_INPUT, "Native hook input exceeds the size limit."); chunks.push(chunk.subarray(0, count));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  let workflow: SqliteWorkflowStore | null = null;
  let database: DatabaseSync | null = null;
  try {
    const [flag, host, ...extra] = process.argv.slice(2);
    check(flag === "--host" && (host === "codex" || host === "claude-code") && extra.length === 0, "Expected --host codex|claude-code.");
    const input = object(JSON.parse(boundedStdin()));
    if (!ROOT_TOOLS.test(String(input.tool_name ?? "")) || !["PreToolUse", "PostToolUse"].includes(String(input.hook_event_name))) return;
    const stateDirectory = resolveSessionMessageStateDirectory();
    // Reading presence must not start a broker or change a session's lifecycle.
    if (!existsSync(path.join(stateDirectory, "endpoint.json"))) return;
    const observed = await requestSessionMessageOnce<{ presence: SessionPresence }>("presence", { target: { host, sessionId: input.session_id } }, stateDirectory, 1500);
    const databasePath = resolveWorkflowDatabasePath();
    workflow = new SqliteWorkflowStore(databasePath);
    const key = workflow.getOrCreateSecret(KEY_NAME, () => randomBytes(32).toString("base64url"));
    database = new DatabaseSync(databasePath);
    database.exec("PRAGMA busy_timeout = 1500;");
    const store = new ModelRoutingStore(database);
    const query = object(new ModelRoutingServiceCore({ catalogDirectory: CATALOG }).query({ provider: host === "codex" ? "openai" : "anthropic" }));
    const contractPath = path.join(path.dirname(databasePath), "model-routing-native", `${HOST_IDS[host]}.json`);
    const contract = existsSync(contractPath) ? JSON.parse(readNativeTranscript(contractPath) ?? "null") : undefined;
    const output = handleNativeRoutingHook(input, host, { store, signer: new RoutingObservationSigner(Buffer.from(key, "base64url")),
      presence: observed.presence, now: new Date().toISOString(), models: query.models as ModelCatalogV1["models"],
      ...(contract === undefined ? {} : { hostContract: contract }) });
    if (Object.keys(output).length) process.stdout.write(JSON.stringify(output));
  } catch {
    // Native hooks are optional observers, not approval gates. Never emit raw payloads, secrets or transcript text.
    process.stderr.write("AGS native routing observation unavailable; no execution assurance was added.\n");
  } finally {
    database?.close(); workflow?.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  && /\/model-routing-host-hook\.(?:ts|mjs)$/u.test(import.meta.url)) await main();
