import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { AdminError } from "../../mcp-server/src/admin-webauthn.js";
import { runContinuityHook } from "../../mcp-server/src/continuity-hook.js";
import { ContextLayerService, GLOBAL_CONTEXT_MAX_BYTES, ROLE_CONTEXT_MAX_BYTES } from "../../mcp-server/src/context-layer-service.js";
import { ContextLayerStore } from "../../mcp-server/src/context-layer-store.js";
import { hostActorId } from "../../mcp-server/src/host-attestation.js";
import { jevKeyFingerprint, JevKeyVault } from "../../mcp-server/src/jev-key-vault.js";
import { ensureBootstrapped, fakeAuthenticator, signAndCommit } from "../helpers/fake-authenticator.js";

// AGS3-D-0088: a role body was only ever saved when someone asked for it, and the person could not write it at all.
// AGS3-D-0087: JEV was ready but nothing made an agent call it. AGS3-D-0086: a tool description named the old limit.
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

const admin = fakeAuthenticator(-7, "test admin");

function setup() {
  const root = mkdtempSync(path.join(tmpdir(), "ags-d0088-"));
  directories.push(root);
  const file = path.join(root, "layers.sqlite3");
  const vault = new JevKeyVault(path.join(root, "jev-key-vault.bin"));
  const service = new ContextLayerService(create => ContextLayerStore.open(file, create), undefined, "http://localhost:47615/", vault);
  ensureBootstrapped(service, admin);
  const environment: NodeJS.ProcessEnv = {
    AGENT_GOVERNANCE_CONTEXT_LAYER_DB_PATH: file,
    AGENT_GOVERNANCE_DB_PATH: path.join(root, "workflow.sqlite3"),
    AGENT_GOVERNANCE_CONTINUITY_DB_PATH: path.join(root, "continuity.sqlite3"),
    AGENT_GOVERNANCE_LOCALE: "en",
  };
  return { service, environment };
}

function addRole(service: ContextLayerService, name: string): string {
  const roleId = `role-${randomUUID()}`;
  signAndCommit(service, admin, { op: "role.add", roleId, name });
  return roleId;
}

function bind(service: ContextLayerService, host: string, sessionId: string, roleId: string): void {
  signAndCommit(service, admin, { op: "binding.set", host, sessionId, roleId });
}

function adminCode(action: () => unknown): string {
  try { action(); } catch (error) {
    if (error instanceof AdminError) return error.code;
    throw error;
  }
  return "NO_ERROR";
}

function cueKeys(service: ContextLayerService, host: string, sessionId: string, turnStart: boolean): string[] {
  return (service.hookText(host, sessionId, hostActorId(host, sessionId), false, turnStart) ?? []).map(ref => ref.key);
}

function turnText(environment: NodeJS.ProcessEnv, host: string, sessionId: string, extra: Record<string, unknown> = {}): string {
  const output = runContinuityHook(JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: sessionId, cwd: tmpdir(), prompt: "go on", ...extra }), environment, host, true);
  return output ? (JSON.parse(output) as { hookSpecificOutput?: { additionalContext?: string } }).hookSpecificOutput?.additionalContext ?? "" : "";
}

describe("role save cue at each user turn (AGS3-D-0088)", () => {
  it("tells a bound session to save, separately for an empty and a filled role, and says nothing to an unbound one", () => {
    const { service } = setup();
    const roleId = addRole(service, "builder");
    expect(cueKeys(service, "codex", "unbound", true)).not.toContain("hooks.contextLayers.roleSaveCue");
    bind(service, "codex", "s1", roleId);
    expect(service.hookText("codex", "s1", hostActorId("codex", "s1"), true, true)!.find(ref => ref.key === "hooks.contextLayers.roleSaveCue")?.params)
      .toMatchObject({ role: "builder", state: "empty" });
    signAndCommit(service, admin, { op: "role.body.set", roleId, body: "kept decision", expectedStateToken: null });
    expect(service.hookText("codex", "s1", hostActorId("codex", "s1"), true, true)!.find(ref => ref.key === "hooks.contextLayers.roleSaveCue")?.params)
      .toMatchObject({ role: "builder", state: "filled" });
  });

  it("repeats every turn but not at other boundaries", () => {
    const { service } = setup();
    bind(service, "codex", "s1", addRole(service, "builder"));
    service.hookText("codex", "s1", hostActorId("codex", "s1"), true);
    expect(cueKeys(service, "codex", "s1", true)).toEqual(["hooks.contextLayers.roleSaveCue"]);
    expect(cueKeys(service, "codex", "s1", true)).toEqual(["hooks.contextLayers.roleSaveCue"]);
    expect(cueKeys(service, "codex", "s1", false)).toEqual([]);
  });

  it.each(["claude-code", "codex", "antigravity"])("reaches a %s session through its real turn-start hook path", host => {
    const { service, environment } = setup();
    bind(service, host, "turn-session", addRole(service, "builder"));
    const text = turnText(environment, host, "turn-session");
    expect(text).toContain("[AGS role save role=builder]");
    expect(text).toContain("checkpoint_role_context (expectedStateToken null)");
    expect(turnText(environment, host, "other-session")).not.toContain("[AGS role save");
  });

  it("does not cue a turn that only wakes the session", () => {
    const { service, environment } = setup();
    bind(service, "codex", "turn-session", addRole(service, "builder"));
    const wake = "[agent-governance-suite:wake:0123456789abcdef0123456789abcdef]";
    expect(turnText(environment, "codex", "turn-session", { prompt: wake })).not.toContain("[AGS role save");
  });
});

describe("role body edited on the admin page (AGS3-D-0088)", () => {
  it("saves with the user's passkey and delivers it to the role's session at the next turn", () => {
    const { service, environment } = setup();
    const roleId = addRole(service, "builder");
    bind(service, "codex", "turn-session", roleId);
    const { record } = signAndCommit(service, admin, { op: "role.body.set", roleId, body: "ROLE-BODY-MARKER", expectedStateToken: null });
    expect(record.target).toBe(`roleBody:${roleId}`);
    const shared = service.load("codex", "turn-session").role;
    expect(shared).toMatchObject({ body: "ROLE-BODY-MARKER", updatedBy: "admin-page" });
    expect(turnText(environment, "codex", "turn-session")).toContain("ROLE-BODY-MARKER");
    expect(service.adminState().failures).toEqual([]);
  });

  it("refuses an edit based on a body that has changed since, before and after the passkey", () => {
    const { service } = setup();
    const roleId = addRole(service, "builder");
    bind(service, "codex", "s1", roleId);
    const prepared = service.prepareIntent({ op: "role.body.set", roleId, body: "page edit", expectedStateToken: null }, false);
    const agent = service.saveRole("codex", "s1", null, "agent edit", hostActorId("codex", "s1"));
    expect(adminCode(() => service.commit({ intent: prepared.intent, assertion: admin.assert(prepared.intent), requestId: randomUUID(), proposalId: null }))).toBe("ADMIN_TARGET_STALE");
    expect(service.load("codex", "s1").role).toMatchObject({ body: "agent edit", stateToken: agent.stateToken });
    expect(adminCode(() => service.prepareIntent({ op: "role.body.set", roleId, body: "again", expectedStateToken: null }, false))).toBe("ADMIN_TARGET_STALE");
    expect(service.adminState().failures).toEqual([]);
  });

  it("keeps the role limit and refuses a role that does not exist or a malformed change", () => {
    const { service } = setup();
    const roleId = addRole(service, "builder");
    expect(adminCode(() => service.prepareIntent({ op: "role.body.set", roleId, body: "x".repeat(ROLE_CONTEXT_MAX_BYTES + 1), expectedStateToken: null }, false))).toBe("ADMIN_CHANGE_INVALID");
    expect(adminCode(() => service.prepareIntent({ op: "role.body.set", roleId: "role-missing", body: "x", expectedStateToken: null }, false))).toBe("ADMIN_CHANGE_INVALID");
    expect(adminCode(() => service.prepareIntent({ op: "role.body.set", roleId, body: "x" }, false))).toBe("ADMIN_CHANGE_INVALID");
    expect(service.prepareIntent({ op: "role.body.set", roleId, body: "x".repeat(ROLE_CONTEXT_MAX_BYTES), expectedStateToken: null }, false).intent).toContain("role.body.set");
  });

  it("does not disturb the role registry chain, so a later role change still verifies", () => {
    const { service } = setup();
    const roleId = addRole(service, "builder");
    signAndCommit(service, admin, { op: "role.body.set", roleId, body: "one", expectedStateToken: null });
    signAndCommit(service, admin, { op: "role.rename", roleId, name: "maker" });
    expect(service.adminState().failures).toEqual([]);
    expect(service.adminState().roles).toMatchObject([{ name: "maker", context: { body: "one" } }]);
  });
});

describe("JEV cue at each user turn (AGS3-D-0087)", () => {
  function readyJev(service: ContextLayerService, overrides: Record<string, unknown> = {}): void {
    signAndCommit(service, admin, { op: "jev.set", enabled: true, limitUsd: 2, presets: { "skill-classification": true },
      model: { providerId: "typesafe", modelId: "jev-1.14.0" }, transmissionAllowed: true, fallbackVendorId: null, ...overrides });
  }

  function registerKey(service: ContextLayerService): void {
    const secret = "test-key-value";
    const prepared = service.prepareIntent({ op: "jevKey.set", name: "JEV_API_KEY", fingerprint: jevKeyFingerprint(secret) }, false);
    service.commit({ intent: prepared.intent, assertion: admin.assert(prepared.intent), requestId: randomUUID(), proposalId: null, secret });
  }

  it("appears only when JEV is ready and its skill preset is on", () => {
    const { service } = setup();
    expect(cueKeys(service, "codex", "s1", true)).not.toContain("hooks.contextLayers.jevCue");
    readyJev(service);
    expect(cueKeys(service, "codex", "s1", true)).not.toContain("hooks.contextLayers.jevCue");
    registerKey(service);
    expect(cueKeys(service, "codex", "s1", true)).toContain("hooks.contextLayers.jevCue");
    expect(cueKeys(service, "codex", "s1", false)).not.toContain("hooks.contextLayers.jevCue");
    readyJev(service, { transmissionAllowed: false });
    expect(cueKeys(service, "codex", "s1", true)).not.toContain("hooks.contextLayers.jevCue");
    readyJev(service, { presets: { "skill-classification": false } });
    expect(cueKeys(service, "codex", "s1", true)).not.toContain("hooks.contextLayers.jevCue");
  });

  it.each(["claude-code", "codex", "antigravity"])("reaches a %s session and leaves the choice to the agent", host => {
    const { service, environment } = setup();
    readyJev(service);
    registerKey(service);
    const text = turnText(environment, host, "turn-session");
    expect(text).toContain("[AGS skill advice]");
    expect(text).toContain("if the call fails choose yourself and continue");
  });
});

describe("tool descriptions name the real limits (AGS3-D-0086)", () => {
  const description = (locale: string, tool: string): string => {
    const file = fileURLToPath(new URL(`../../locales/${locale}/tools.json`, import.meta.url));
    return (JSON.parse(readFileSync(file, "utf8")) as Record<string, string>)[`tools.${tool}.description`]!;
  };

  it.each(["en", "ko"])("%s", locale => {
    expect(description(locale, "checkpoint_global_context")).toContain(String(GLOBAL_CONTEXT_MAX_BYTES));
    expect(description(locale, "checkpoint_role_context")).toContain(String(ROLE_CONTEXT_MAX_BYTES));
  });
});
