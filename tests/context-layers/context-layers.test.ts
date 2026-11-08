import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import type { ApiResultV1 } from "../../contracts/types.js";
import { WorkflowContractError } from "../../contracts/types.js";
import { runContinuityHook } from "../../mcp-server/src/continuity-hook.js";
import { ContinuityService } from "../../mcp-server/src/continuity-service.js";
import { SqliteContinuityStore } from "../../mcp-server/src/continuity-store.js";
import { CURRENT_MEMORY_MAX_BYTES } from "../../mcp-server/src/continuity-memory.js";
import { ContextLayerService, GLOBAL_CONTEXT_MAX_BYTES, normalizeRoleName, ROLE_CONTEXT_MAX_BYTES } from "../../mcp-server/src/context-layer-service.js";
import { ContextLayerStore } from "../../mcp-server/src/context-layer-store.js";
import { hostActorId } from "../../mcp-server/src/host-attestation.js";
import { InMemoryPluginUpdateStore } from "../../mcp-server/src/plugin-update-store.js";
import { PluginUpdateService } from "../../mcp-server/src/plugin-update-service.js";
import { FileSkillRegistry } from "../../mcp-server/src/registry.js";
import { ContractValidator } from "../../mcp-server/src/schema-validator.js";
import { createMcpServer } from "../../mcp-server/src/server.js";
import { closeSessionMessaging } from "../../mcp-server/src/session-message-client.js";
import { SessionMessageService } from "../../mcp-server/src/session-message-service.js";
import { SqliteWorkflowStore } from "../../mcp-server/src/sqlite-workflow-store.js";
import { WorkflowService } from "../../mcp-server/src/workflow-service.js";
import { callerMeta, metaIngress, rootCaller } from "../helpers/caller.js";
import { AdminError } from "../../mcp-server/src/admin-webauthn.js";
import { ensureBootstrapped, fakeAuthenticator, signAndCommit } from "../helpers/fake-authenticator.js";

// Three contexts (AGS3-T-0023, user decisions 2026-11-07): global (every session, 4000 bytes since 4.0.0, changed only by a record
// the user's passkey signs on the admin page), role (keyed by the registered role the user bound the session to, 1000
// bytes, shared by that role's sessions) and situational (the session's own current memory, 2000 bytes, unchanged). The
// role a session may use comes only from its signed binding (AGS3-T-0024), never from the board's self-written role.
const registryPath = fileURLToPath(new URL("../../skills/registry.json", import.meta.url));
const directories: string[] = [];
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

function directory(): string {
  const created = mkdtempSync(path.join(tmpdir(), "ags-context-layers-"));
  directories.push(created);
  return created;
}

const ADMIN_URL = "http://localhost:47615/";

function serviceAt(file: string, now = () => new Date()): ContextLayerService {
  return new ContextLayerService(create => ContextLayerStore.open(file, create), now, ADMIN_URL);
}

/** The user's passkey on the admin page (a software authenticator). */
const admin = fakeAuthenticator(-7, "test admin");
const caller = (host = "codex", sessionId = "s1") => ({ host, sessionId, actor: hostActorId(host, sessionId) });

function code(action: () => unknown): { code: string; reasonCode: unknown; details: Record<string, unknown> | null } {
  try { action(); } catch (error) {
    if (error instanceof WorkflowContractError) return { code: error.code, reasonCode: error.details?.reasonCode, details: error.details };
    throw error;
  }
  throw new Error("expected a contract error");
}

/** Saves the global body the way the admin page does: a record the user's passkey signs. */
function saveGlobal(service: ContextLayerService, body: string): string {
  ensureBootstrapped(service, admin);
  return signAndCommit(service, admin, { op: "global.set", body }).record.recordHash;
}

/** The registered role with this (normalized) name; registers it first when the user has not yet. */
function roleId(service: ContextLayerService, role: string): string {
  ensureBootstrapped(service, admin);
  const name = normalizeRoleName(role)!;
  const found = service.adminState().roles.find(item => item.name.toLowerCase() === name.toLowerCase());
  if (found) return found.roleId;
  const id = `role-${Buffer.from(name).toString("hex").slice(0, 60)}`;
  signAndCommit(service, admin, { op: "role.add", roleId: id, name });
  return id;
}

function bind(service: ContextLayerService, host: string, sessionId: string, role: string | null): void {
  ensureBootstrapped(service, admin);
  signAndCommit(service, admin, { op: "binding.set", host, sessionId, roleId: role === null ? null : roleId(service, role) });
}

function adminCode(action: () => unknown): string {
  try { action(); } catch (error) {
    if (error instanceof AdminError) return error.code;
    throw error;
  }
  throw new Error("expected an admin error");
}

describe("context layer store and service", () => {
  it("keeps the byte limits in UTF-8 bytes of the body: 4000 global, 1000 role, and the situational limit stays 2000", () => {
    const service = serviceAt(path.join(directory(), "layers.sqlite3"));
    expect([GLOBAL_CONTEXT_MAX_BYTES, ROLE_CONTEXT_MAX_BYTES, CURRENT_MEMORY_MAX_BYTES]).toEqual([4000, 1000, 2000]);
    // 1333 Hangul syllables are 3999 bytes; one ASCII byte reaches the limit exactly, one more passes it.
    const atLimit = `${"가".repeat(1333)}a`;
    expect(Buffer.byteLength(atLimit)).toBe(4000);
    expect(service.proposeGlobal(caller(), null, atLimit)).toMatchObject({ pending: true, adminUrl: ADMIN_URL });
    expect(code(() => service.proposeGlobal(caller(), null, `${atLimit}c`))).toMatchObject({ code: "INVALID_INPUT", reasonCode: "CONTEXT_LAYER_TOO_LARGE", details: { actualBytes: 4001, maxBytes: 4000 } });
    bind(service, "codex", "s1", "reviewer");
    const role = `${"가".repeat(333)}a`;
    expect(Buffer.byteLength(role)).toBe(1000);
    expect(service.saveRole("codex", "s1", null, role, "a").bytes).toBe(1000);
    expect(code(() => service.saveRole("codex", "s1", service.load("codex", "s1").role!.stateToken, `${role}b`, "a")))
      .toMatchObject({ code: "INVALID_INPUT", reasonCode: "CONTEXT_LAYER_TOO_LARGE", details: { maxBytes: 1000 } });
  });

  it("lets only the first of two role writers that read the same state token save, across two connections", () => {
    const file = path.join(directory(), "layers.sqlite3");
    const first = new ContextLayerStore(file);
    const second = new ContextLayerStore(file);
    cleanups.push(() => { first.close(); second.close(); });
    const now = "2026-11-07T00:00:00.000Z";
    const a = first.transaction(() => first.saveRole("role-a", null, "A", "actor-a", now));
    const b = second.transaction(() => second.saveRole("role-a", null, "B", "actor-b", now));
    expect(a.kind).toBe("saved");
    expect(b).toEqual({ kind: "stale", actualStateToken: a.kind === "saved" ? a.record.stateToken : null });
    expect(second.readRole("role-a")?.body).toBe("A");
    // A save outside a transaction is a programming error, not a silent unguarded write.
    expect(() => first.saveRole("role-a", null, "C", "actor-a", now)).toThrow(/inside a transaction/u);
  });

  it("refuses an agent request on a stale token, and a signed change that lost the race to another one", () => {
    const service = serviceAt(path.join(directory(), "layers.sqlite3"));
    const first = saveGlobal(service, "first");
    expect(code(() => service.proposeGlobal(caller(), null, "x"))).toMatchObject({ code: "STALE_REVISION", reasonCode: "CONTEXT_LAYER_STATE_STALE", details: { actualStateToken: first } });
    const mine = service.prepareIntent({ op: "global.set", body: "mine" }, false);
    saveGlobal(service, "theirs");
    expect(adminCode(() => service.commit({ intent: mine.intent, assertion: admin.assert(mine.intent), requestId: "req-mine-0001", proposalId: null }))).toBe("ADMIN_TARGET_STALE");
    expect(service.load("codex", "s").global?.body).toBe("theirs");
  });

  it("decides role access only from the approved binding: unbound sessions are refused, a role's sessions share one body", () => {
    const service = serviceAt(path.join(directory(), "layers.sqlite3"));
    expect(code(() => service.saveRole("codex", "s1", null, "x", "a"))).toMatchObject({ code: "BINDING_REQUIRED", reasonCode: "ROLE_NOT_BOUND" });
    bind(service, "codex", "s1", " 리뷰어 ");
    bind(service, "claude-code", "s2", "리뷰어");
    bind(service, "antigravity", "s3", "builder");
    const saved = service.saveRole("codex", "s1", null, "기준: 근거 없는 판정 금지", "a");
    // Another host's session of the same role reads the same body and must name its token to replace it.
    expect(service.load("claude-code", "s2")).toMatchObject({ binding: { role: "리뷰어" }, role: { body: "기준: 근거 없는 판정 금지", stateToken: saved.stateToken } });
    expect(code(() => service.saveRole("claude-code", "s2", null, "덮어쓰기", "b"))).toMatchObject({ code: "STALE_REVISION" });
    expect(service.load("antigravity", "s3").role).toBeNull();
    expect(service.load("codex", "unbound")).toMatchObject({ binding: null, role: null });
    bind(service, "codex", "s1", null);
    expect(code(() => service.saveRole("codex", "s1", saved.stateToken, "x", "a"))).toMatchObject({ code: "BINDING_REQUIRED" });
  });

  it("normalizes role names with NFC and trimming and rejects names that cannot be one key", () => {
    expect(normalizeRoleName("  리뷰어\u0009")).toBe("리뷰어");
    expect(normalizeRoleName("리뷰어")).toBe("리뷰어");
    for (const bad of ["", "   ", "a\nb", "a\u0000", "x".repeat(101), 3]) expect(normalizeRoleName(bad)).toBeNull();
    const service = serviceAt(path.join(directory(), "layers.sqlite3"));
    expect(code(() => service.proposeBinding(caller("codex", "s"), "a\nb"))).toMatchObject({ code: "INVALID_INPUT", reasonCode: "ROLE_NAME_INVALID" });
  });

  it("refuses a stored role body that fails its digest or limit as an integrity failure", () => {
    const file = path.join(directory(), "layers.sqlite3");
    const service = serviceAt(file);
    bind(service, "codex", "s", "reviewer");
    service.saveRole("codex", "s", null, "ok", "a");
    const store = new ContextLayerStore(file);
    (store as unknown as { database: { exec(sql: string): void } }).database.exec("UPDATE role_contexts SET body = 'tampered'");
    store.close();
    expect(code(() => service.load("codex", "s"))).toMatchObject({ code: "INTEGRITY_FAILED", reasonCode: "CONTEXT_LAYER_INTEGRITY_FAILED" });
  });

  it("refuses a file that holds other content instead of adopting it", () => {
    const file = path.join(directory(), "foreign.sqlite3");
    writeFileSync(file, "");
    // An empty file is a new database; a file with an unrelated table is refused untouched.
    new ContextLayerStore(file).close();
    const other = path.join(directory(), "other.sqlite3");
    const database = new DatabaseSync(other);
    database.exec("CREATE TABLE something (x INTEGER)");
    database.close();
    expect(() => new ContextLayerStore(other)).toThrow(/does not own/u);
  });

  it("does not create the shared file for a read", () => {
    const file = path.join(directory(), "absent.sqlite3");
    expect(serviceAt(file).load("codex", "s")).toMatchObject({ global: null, binding: null, role: null });
    expect(serviceAt(file).hookText("codex", "s", "actor", true)).toBeNull();
    expect(existsSync(file)).toBe(false);
  });
});

async function server() {
  const root = directory();
  const layers = path.join(root, "layers.sqlite3");
  const validator = new ContractValidator();
  const store = new SqliteWorkflowStore(path.join(root, "workflow.sqlite3"));
  const continuityStore = new SqliteContinuityStore(path.join(root, "continuity.sqlite3"));
  const service = new WorkflowService(new FileSkillRegistry(registryPath, validator), validator, store);
  const messaging = path.join(root, "messaging");
  const contextLayers = serviceAt(layers);
  const mcp = createMcpServer(service, new PluginUpdateService(new InMemoryPluginUpdateStore()), new ContinuityService(continuityStore, validator, store),
    undefined, undefined, validator, "default", null, path.join(root, "board.sqlite3"), new SessionMessageService(messaging), null, null, metaIngress(),
    "en", contextLayers);
  // No form capability: nothing in these tools asks the client for an approval any more.
  const client = new Client({ name: "context-layers", version: "1" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await mcp.connect(serverTransport);
  await client.connect(clientTransport);
  cleanups.push(() => { store.close(); continuityStore.close(); closeSessionMessaging(messaging); });
  cleanups.push(async () => { await client.close(); await mcp.close(); });
  const call = async <T>(name: string, args: Record<string, unknown>, session = "session-a", agentKey?: string) => {
    const response = await client.callTool({ name, arguments: { schemaVersion: "1.0.0", ...args }, _meta: callerMeta({ host: "synthetic-host", sessionId: session }, agentKey) });
    const text = (response.content as Array<{ type: string; text?: string }>).find(item => item.type === "text")?.text;
    return JSON.parse(text!) as ApiResultV1<T>;
  };
  return { call, contextLayers, layers, client };
}

/** The user approves an agent's request on the page: the requested change, signed, naming the request. */
function approve(contextLayers: ContextLayerService, proposalId: string) {
  ensureBootstrapped(contextLayers, admin);
  const proposal = contextLayers.adminState().proposals.find(item => item.id === proposalId)!;
  return signAndCommit(contextLayers, admin, proposal.change, { proposalId });
}

describe("context layer MCP tools", () => {
  it("lists the four tools", async () => {
    const { client } = await server();
    const names = (await client.listTools()).tools.map(tool => tool.name);
    expect(names).toEqual(expect.arrayContaining(["load_shared_context", "checkpoint_global_context", "bind_session_role", "checkpoint_role_context"]));
  });

  it("stores a global change as a request that applies only after the user signs it on the page", async () => {
    const { call, contextLayers } = await server();
    const requested = await call<{ pending: boolean; proposalId: string; adminUrl: string }>("checkpoint_global_context", { expectedStateToken: null, body: "Answer in Korean." });
    expect(requested).toMatchObject({ ok: true, data: { pending: true, adminUrl: ADMIN_URL } });
    expect(Object.keys(requested.data!).sort()).toEqual(["adminUrl", "pending", "proposalId"]);
    // Nothing applies before the signature; the page shows the request with who asked.
    expect(await call("load_shared_context", {}, "session-b")).toMatchObject({ ok: true, data: { global: null } });
    expect(contextLayers.adminState().proposals).toMatchObject([{ id: requested.data!.proposalId, host: "synthetic-host", sessionId: "session-a",
      change: { op: "global.set", body: "Answer in Korean." }, baseChanged: false }]);
    const { record } = approve(contextLayers, requested.data!.proposalId);
    expect(await call("load_shared_context", {}, "session-b")).toMatchObject({ ok: true, data: { global: { body: "Answer in Korean.", stateToken: record.recordHash } } });
    expect(contextLayers.adminState().proposals).toEqual([]);
  });

  it("keeps one pending request per session and target, and a rejected request applies nothing", async () => {
    const { call, contextLayers } = await server();
    const older = await call<{ proposalId: string }>("checkpoint_global_context", { expectedStateToken: null, body: "old" });
    const newer = await call<{ proposalId: string }>("checkpoint_global_context", { expectedStateToken: null, body: "new" });
    expect(contextLayers.adminState().proposals.map(item => item.id)).toEqual([newer.data!.proposalId]);
    ensureBootstrapped(contextLayers, admin);
    expect(adminCode(() => signAndCommit(contextLayers, admin, { op: "global.set", body: "old" }, { proposalId: older.data!.proposalId }))).toBe("ADMIN_PROPOSAL_NOT_FOUND");
    contextLayers.rejectProposal(newer.data!.proposalId);
    expect(adminCode(() => contextLayers.rejectProposal(newer.data!.proposalId))).toBe("ADMIN_PROPOSAL_NOT_FOUND");
    expect((await call<{ global: unknown }>("load_shared_context", {})).data).toMatchObject({ global: null });
  });

  it("refuses a request on a stale token", async () => {
    const { call, contextLayers } = await server();
    const current = saveGlobal(contextLayers, "current");
    expect(await call("checkpoint_global_context", { expectedStateToken: null, body: "x" })).toMatchObject({ ok: false, error: { code: "STALE_REVISION", details: { actualStateToken: current } } });
  });

  it("binds only to a registered role; after approval the session's subagents inherit it, other sessions do not; unbinding ends access", async () => {
    const { call, contextLayers } = await server();
    expect(await call("checkpoint_role_context", { expectedStateToken: null, body: "x" })).toMatchObject({ ok: false, error: { code: "BINDING_REQUIRED", details: { adminUrl: ADMIN_URL } } });
    expect(await call("bind_session_role", { role: "리뷰어" })).toMatchObject({ ok: false, error: { code: "INVALID_INPUT", details: { reasonCode: "ROLE_NOT_REGISTERED", adminUrl: ADMIN_URL } } });
    roleId(contextLayers, "리뷰어");
    const requested = await call<{ proposalId: string }>("bind_session_role", { role: " 리뷰어 " });
    expect(requested).toMatchObject({ ok: true, data: { pending: true } });
    expect(await call("load_shared_context", {})).toMatchObject({ data: { binding: null } });
    approve(contextLayers, requested.data!.proposalId);
    const saved = await call<{ stateToken: string }>("checkpoint_role_context", { expectedStateToken: null, body: "근거 없는 판정 금지" }, "session-a", "child-1");
    expect(saved.ok).toBe(true);
    expect(await call("load_shared_context", {}, "session-a", "child-1")).toMatchObject({ data: { binding: { role: "리뷰어" }, role: { body: "근거 없는 판정 금지" } } });
    expect(await call("load_shared_context", {}, "session-b")).toMatchObject({ data: { binding: null, role: null } });
    const unbind = await call<{ proposalId: string }>("bind_session_role", { role: null });
    approve(contextLayers, unbind.data!.proposalId);
    expect(await call("checkpoint_role_context", { expectedStateToken: saved.data!.stateToken, body: "y" })).toMatchObject({ ok: false, error: { code: "BINDING_REQUIRED" } });
  });

  it("rejects unknown or missing arguments", async () => {
    const { call } = await server();
    expect(await call("checkpoint_global_context", { body: "x" })).toMatchObject({ ok: false, error: { code: "INVALID_INPUT", details: { reasonCode: "CONTEXT_LAYER_ARGUMENTS_INVALID" } } });
    expect(await call("load_shared_context", { role: "x" })).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
  });
});

describe("context layer injection at hook boundaries", () => {
  const session = "hook-session";

  function environment(root: string): NodeJS.ProcessEnv & { AGENT_GOVERNANCE_CONTEXT_LAYER_DB_PATH: string; AGENT_GOVERNANCE_CONTINUITY_DB_PATH: string } {
    return {
      AGENT_GOVERNANCE_CONTEXT_LAYER_DB_PATH: path.join(root, "layers.sqlite3"),
      AGENT_GOVERNANCE_DB_PATH: path.join(root, "workflow.sqlite3"),
      AGENT_GOVERNANCE_CONTINUITY_DB_PATH: path.join(root, "continuity.sqlite3"),
      AGENT_GOVERNANCE_LOCALE: "en",
    };
  }

  function context(output: string): string {
    if (!output) return "";
    return (JSON.parse(output) as { hookSpecificOutput?: { additionalContext?: string } }).hookSpecificOutput?.additionalContext ?? "";
  }

  function hook(env: NodeJS.ProcessEnv, input: Record<string, unknown>, host = "codex"): string {
    return context(runContinuityHook(JSON.stringify({ session_id: session, cwd: tmpdir(), ...input }), env, host, true));
  }

  function checkpoint(env: NodeJS.ProcessEnv, body: string): void {
    const store = new SqliteContinuityStore(env.AGENT_GOVERNANCE_CONTINUITY_DB_PATH!);
    try {
      const continuity = new ContinuityService(store, new ContractValidator());
      const result = continuity.checkpointContext({ schemaVersion: "1.0.0", requestId: `req-${body.length}`, expectedStateToken: (continuity.loadContext({ schemaVersion: "1.0.0" }, rootCaller("codex", session)).data as { stateToken?: string } | null)?.stateToken ?? null,
        status: "active", core: { objective: body, completionCriteria: [], constraints: [], decisions: [], progress: [], blockers: [], nextActions: [] }, evidenceRefs: [] }, rootCaller("codex", session));
      expect(result.error).toBeNull();
    } finally { store.close(); }
  }

  it("adds nothing and creates no shared file when no layer was ever saved", () => {
    const root = directory();
    const env = environment(root);
    expect(hook(env, { hook_event_name: "SessionStart", source: "startup" })).toBe("");
    expect(existsSync(env.AGENT_GOVERNANCE_CONTEXT_LAYER_DB_PATH!)).toBe(false);
  });

  it("gives the global and the bound role context at a session start, resume and compaction", () => {
    const env = environment(directory());
    const layers = serviceAt(env.AGENT_GOVERNANCE_CONTEXT_LAYER_DB_PATH!);
    saveGlobal(layers, "GLOBAL-MARKER-7341");
    bind(layers, "codex", session, "reviewer");
    layers.saveRole("codex", session, null, "ROLE-MARKER-2290", "a");
    for (const source of ["startup", "resume", "compact", "clear"]) {
      const text = hook(env, { hook_event_name: "SessionStart", source });
      expect(text, source).toContain("GLOBAL-MARKER-7341");
      expect(text, source).toContain("ROLE-MARKER-2290");
      expect(text, source).toContain("[AGS role context role=reviewer");
    }
    // Another session on another host gets the global context but not this session's role.
    const other = hook(env, { hook_event_name: "SessionStart", source: "startup", session_id: "other" }, "claude-code");
    expect(other).toContain("GLOBAL-MARKER-7341");
    expect(other).not.toContain("ROLE-MARKER-2290");
  });

  it("keeps the restored situational body at resume and adds the layers after it", () => {
    const env = environment(directory());
    hook(env, { hook_event_name: "SessionStart", source: "startup" });
    checkpoint(env, "SITUATION-MARKER-5512");
    saveGlobal(serviceAt(env.AGENT_GOVERNANCE_CONTEXT_LAYER_DB_PATH!), "GLOBAL-MARKER-7341");
    const text = hook(env, { hook_event_name: "SessionStart", source: "resume" });
    expect(text.indexOf("SITUATION-MARKER-5512")).toBeGreaterThanOrEqual(0);
    expect(text.indexOf("GLOBAL-MARKER-7341")).toBeGreaterThan(text.indexOf("SITUATION-MARKER-5512"));
  });

  it("delivers a layer that changed during the session once, at the next prompt, and announces a cleared one", () => {
    const env = environment(directory());
    const layers = serviceAt(env.AGENT_GOVERNANCE_CONTEXT_LAYER_DB_PATH!);
    saveGlobal(layers, "first version");
    expect(hook(env, { hook_event_name: "SessionStart", source: "startup" })).toContain("first version");
    expect(hook(env, { hook_event_name: "UserPromptSubmit", prompt: "go on" })).not.toContain("AGS global context");
    saveGlobal(layers, "second version");
    const changed = hook(env, { hook_event_name: "UserPromptSubmit", prompt: "go on" });
    expect(changed).toContain("second version");
    expect(changed).toContain("changed during this session");
    expect(hook(env, { hook_event_name: "UserPromptSubmit", prompt: "go on" })).not.toContain("second version");
    saveGlobal(layers, "");
    expect(hook(env, { hook_event_name: "UserPromptSubmit", prompt: "go on" })).toContain("[AGS global context was cleared]");
  });

  it("gives the bound role's name before its role context has a body, again when the binding changes, and announces an unbinding (AGS3-D-0072)", () => {
    const env = environment(directory());
    const layers = serviceAt(env.AGENT_GOVERNANCE_CONTEXT_LAYER_DB_PATH!);
    bind(layers, "codex", session, "reviewer");
    const start = hook(env, { hook_event_name: "SessionStart", source: "startup" });
    expect(start).toContain("[AGS assigned role role=reviewer]");
    expect(start).not.toContain("[AGS role context");
    expect(hook(env, { hook_event_name: "UserPromptSubmit", prompt: "go on" })).not.toContain("[AGS assigned role");
    bind(layers, "codex", session, "builder");
    expect(hook(env, { hook_event_name: "UserPromptSubmit", prompt: "go on" })).toContain("[AGS assigned role role=builder · changed during this session]");
    bind(layers, "codex", session, null);
    expect(hook(env, { hook_event_name: "UserPromptSubmit", prompt: "go on" })).toContain("[AGS role binding removed · previous role=builder]");
    expect(hook(env, { hook_event_name: "UserPromptSubmit", prompt: "go on" })).not.toContain("role binding removed");
  });

  it("gives a subagent at its start the skill cue, the shared layers of its session's role and its session's situational context", () => {
    const env = environment(directory());
    hook(env, { hook_event_name: "SessionStart", source: "startup" });
    checkpoint(env, "SITUATION-MARKER-5512");
    const layers = serviceAt(env.AGENT_GOVERNANCE_CONTEXT_LAYER_DB_PATH!);
    saveGlobal(layers, "GLOBAL-MARKER-7341");
    bind(layers, "claude-code", session, "reviewer");
    layers.saveRole("claude-code", session, null, "ROLE-MARKER-2290", "a");
    const start = { hook_event_name: "SubagentStart", agent_id: "agent-1", agent_type: "Explore" };
    const claude = hook(env, start, "claude-code");
    expect(claude).toContain("[AGS subagent start check]");
    expect(claude).toContain("GLOBAL-MARKER-7341");
    expect(claude).toContain("ROLE-MARKER-2290");
    expect(claude).toContain("SITUATION-MARKER-5512");
    const codex = hook(env, { ...start, turn_id: "t" }, "codex");
    expect(codex).toContain("SITUATION-MARKER-5512");
    expect(codex).toContain("GLOBAL-MARKER-7341");
    expect(codex).not.toContain("ROLE-MARKER-2290");
    // Another session's subagent never gets this session's situational context.
    expect(hook(env, { ...start, session_id: "someone-else" }, "codex")).not.toContain("SITUATION-MARKER-5512");
  });

  it("keeps the subagent cue and the shared layers when the situational store cannot be opened", () => {
    const root = directory();
    const blocked = path.join(root, "not-a-directory");
    writeFileSync(blocked, "synthetic file");
    const env = { ...environment(root), AGENT_GOVERNANCE_CONTINUITY_DB_PATH: path.join(blocked, "c.sqlite3"), AGENT_GOVERNANCE_DB_PATH: path.join(blocked, "w.sqlite3") };
    saveGlobal(serviceAt(env.AGENT_GOVERNANCE_CONTEXT_LAYER_DB_PATH), "GLOBAL-MARKER-7341");
    const text = hook(env, { hook_event_name: "SubagentStart", agent_id: "agent-1", agent_type: "worker" }, "codex");
    expect(text).toContain("[AGS subagent start check]");
    expect(text).toContain("GLOBAL-MARKER-7341");
  });

  it("still gives the shared layers when the session's continuity store cannot be opened (fail-open hook)", () => {
    const root = directory();
    const blocked = path.join(root, "not-a-directory");
    writeFileSync(blocked, "synthetic file");
    const env = { ...environment(root), AGENT_GOVERNANCE_CONTINUITY_DB_PATH: path.join(blocked, "c.sqlite3"), AGENT_GOVERNANCE_DB_PATH: path.join(blocked, "w.sqlite3") };
    saveGlobal(serviceAt(env.AGENT_GOVERNANCE_CONTEXT_LAYER_DB_PATH), "GLOBAL-MARKER-7341");
    const output = runContinuityHook(JSON.stringify({ hook_event_name: "SessionStart", source: "startup", session_id: session, cwd: tmpdir() }), env, "claude-code");
    expect(context(output)).toContain("GLOBAL-MARKER-7341");
    // The governance hook's fail-closed call still sees the store failure.
    expect(() => runContinuityHook(JSON.stringify({ hook_event_name: "SessionStart", source: "startup", session_id: session }), env, "claude-code", true)).toThrow();
  });

  it("delivers a change to a subagent at the boundary after an AGS progress tool, once", () => {
    const env = environment(directory());
    const layers = serviceAt(env.AGENT_GOVERNANCE_CONTEXT_LAYER_DB_PATH!);
    saveGlobal(layers, "first version");
    hook(env, { hook_event_name: "SubagentStart", agent_id: "agent-1", agent_type: "worker" }, "codex");
    saveGlobal(layers, "second version");
    const after = { hook_event_name: "PostToolUse", agent_id: "agent-1", tool_name: "mcp__agent_governance_suite__record_stage_result", tool_input: {}, tool_use_id: "call-1" };
    expect(hook(env, after, "codex")).toContain("second version");
    expect(hook(env, { ...after, tool_use_id: "call-2" }, "codex")).not.toContain("second version");
    // The root actor of the same session has its own delivery mark.
    expect(hook(env, { hook_event_name: "UserPromptSubmit", prompt: "x" }, "codex")).toContain("second version");
    expect(layers.adminState().globalHistory.map(entry => entry.body)).toEqual(["second version", "first version"]);
    expect(hostActorId("codex", session, "agent-1")).not.toBe(hostActorId("codex", session));
  });

  // Codex 0.166 counts a hook's additionalContextLimit in approximate tokens, ceil(UTF-8 bytes / 4) (codex-rs
  // hooks/src/output_spill.rs, utils/string/src/truncate.rs approx_token_count; tag rust-v0.166.0), read here from the
  // continuity hook's own entries in hooks/hooks.json. Claude Code keeps 10,000 characters of a hook's additionalContext
  // (claude-overlay/README.md, TLS session messages). agy publishes no limit; it is measured on the real host.
  it("stays within each host's additionalContext limit with every layer at its limit", () => {
    const codexHooks = (JSON.parse(readFileSync(path.join(fileURLToPath(new URL("../../", import.meta.url)), "hooks/hooks.json"), "utf8")) as
      { hooks: Record<string, Array<{ hooks: Array<{ command: string; additionalContextLimit?: number }> }>> }).hooks;
    const codexLimit = (event: string) => codexHooks[event]!.flatMap(group => group.hooks).find(hook => hook.command.includes("continuity-hook.mjs"))!.additionalContextLimit!;
    const env = { ...environment(directory()), AGENT_GOVERNANCE_LOCALE: "ko" };
    hook(env, { hook_event_name: "SessionStart", source: "startup" });
    // Worst case: each body at its byte limit, in the widest UTF-8 the bodies are likely to use (Hangul, 3 bytes).
    const situation = "가".repeat(600);
    checkpoint(env, situation);
    const layers = serviceAt(env.AGENT_GOVERNANCE_CONTEXT_LAYER_DB_PATH!);
    saveGlobal(layers, `${"가".repeat(666)}ab`);
    bind(layers, "codex", session, "r".repeat(100));
    layers.saveRole("codex", session, null, `${"가".repeat(333)}a`, "a");
    const sizes: Record<string, { bytes: number; characters: number }> = {};
    const measure = (name: string, text: string) => { sizes[name] = { bytes: Buffer.byteLength(text), characters: text.length }; };
    measure("SubagentStart", hook(env, { hook_event_name: "SubagentStart", agent_id: "agent-1", agent_type: "worker", turn_id: "t" }));
    measure("SessionStart:resume", hook(env, { hook_event_name: "SessionStart", source: "resume" }));
    hook(env, { hook_event_name: "PreCompact", trigger: "manual" });
    measure("SessionStart:compact", hook(env, { hook_event_name: "SessionStart", source: "compact" }));
    console.log(`CONTEXT_LAYER_SIZES ${JSON.stringify(sizes)}`);
    for (const [name, size] of Object.entries(sizes)) {
      expect(Math.ceil(size.bytes / 4), name).toBeLessThanOrEqual(codexLimit(name.split(":")[0]!));
      expect(size.characters, name).toBeLessThanOrEqual(10_000);
    }
  });
});
