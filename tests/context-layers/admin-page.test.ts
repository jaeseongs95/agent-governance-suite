import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, request as httpRequest, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { ADMIN_PAGE_HTML } from "../../mcp-server/src/admin-page.generated.js";
import { ADMIN_BODY_MAX_BYTES, type AdminSessionView, type AdminSettingsView, createAdminRequestHandler } from "../../mcp-server/src/admin-page-server.js";
import { ADMIN_ERROR_CODES, AdminError } from "../../mcp-server/src/admin-webauthn.js";
import { adminRecordHash } from "../../mcp-server/src/admin-log.js";
import { adminSettingsView } from "../../mcp-server/src/admin-settings.js";
import { JevKeyVault, jevKeyFingerprint } from "../../mcp-server/src/jev-key-vault.js";
import { ContextLayerService } from "../../mcp-server/src/context-layer-service.js";
import { ContextLayerStore } from "../../mcp-server/src/context-layer-store.js";
import { runContinuityHook } from "../../mcp-server/src/continuity-hook.js";
import { hostActorId } from "../../mcp-server/src/host-attestation.js";
import { ensureBootstrapped, type FakeAlgorithm, fakeAuthenticator, signAndCommit } from "../helpers/fake-authenticator.js";

// The signed admin log (AGS3-T-0024): every rule in the implementation brief B.3-B.11 and E.1 has a case here. Each
// error code is produced by one bent field of an otherwise valid flow, and the same flow without that bend succeeds
// (red/green within one case). A software authenticator stands in for the browser passkey.
const directories: string[] = [];
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

function layersFile(): string {
  const created = mkdtempSync(path.join(tmpdir(), "ags-admin-page-"));
  directories.push(created);
  return path.join(created, "layers.sqlite3");
}

function serviceAt(file: string, now: () => Date = () => new Date()): ContextLayerService {
  return new ContextLayerService(create => ContextLayerStore.open(file, create), now, "http://localhost:47615/",
    new JevKeyVault(path.join(path.dirname(file), "jev-key-vault.bin")));
}

function adminCode(action: () => unknown): string {
  try { action(); } catch (error) {
    if (error instanceof AdminError) return error.code;
    throw error;
  }
  return "NO_ERROR";
}

/** Runs one SQL statement on the shared file the way another program on this computer could. */
function sql(file: string, statement: string, ...values: Array<string | number | null>): void {
  const database = new DatabaseSync(file);
  try { database.prepare(statement).run(...values); } finally { database.close(); }
}

const tested = new Set<string>();
function covers(code: string): string {
  tested.add(code);
  return code;
}

describe("signed admin log: one case per error code", () => {
  it.each([-7, -257, -8] as FakeAlgorithm[])("registers a first key with algorithm %i and signs a global change with it", alg => {
    const service = serviceAt(layersFile());
    const key = fakeAuthenticator(alg);
    signAndCommit(service, key, key.addChange(), { bootstrap: true });
    signAndCommit(service, key, { op: "global.set", body: `signed by ${alg}` });
    expect(service.load("codex", "s")).toMatchObject({ global: { body: `signed by ${alg}` }, failures: [] });
    expect(service.adminState().bootstrap).toMatchObject({ credentialId: key.credentialId });
  });

  it(covers("ADMIN_KEY_NOT_REGISTERED"), () => {
    const service = serviceAt(layersFile());
    const key = fakeAuthenticator();
    expect(adminCode(() => service.prepareIntent({ op: "global.set", body: "x" }, false))).toBe("ADMIN_KEY_NOT_REGISTERED");
    // A record that is not a key registering itself cannot start the log, even when it reaches the commit directly.
    const other = fakeAuthenticator();
    const prepared = service.prepareIntent(key.addChange(), true);
    expect(adminCode(() => service.commit({ intent: prepared.intent, assertion: other.assert(prepared.intent), requestId: randomUUID(), proposalId: null }))).toBe("ADMIN_KEY_NOT_REGISTERED");
    expect(adminCode(() => service.commit({ intent: prepared.intent, assertion: key.assert(prepared.intent), requestId: randomUUID(), proposalId: null }))).toBe("NO_ERROR");
  });

  it(covers("ADMIN_ALREADY_BOOTSTRAPPED"), () => {
    const service = serviceAt(layersFile());
    const first = fakeAuthenticator(), second = fakeAuthenticator();
    // Two first registrations prepared at once: the one committed second is refused (first key cannot be taken over).
    const a = service.prepareIntent(first.addChange(), true);
    const b = service.prepareIntent(second.addChange(), true);
    service.commit({ intent: a.intent, assertion: first.assert(a.intent), requestId: randomUUID(), proposalId: null });
    expect(adminCode(() => service.commit({ intent: b.intent, assertion: second.assert(b.intent), requestId: randomUUID(), proposalId: null }))).toBe("ADMIN_ALREADY_BOOTSTRAPPED");
    expect(adminCode(() => service.prepareIntent(second.addChange(), true))).toBe("ADMIN_ALREADY_BOOTSTRAPPED");
    expect(service.adminState().keys.map(key => key.credentialId)).toEqual([first.credentialId]);
  });

  it(covers("ADMIN_KEY_UNKNOWN"), () => {
    const service = serviceAt(layersFile());
    const owner = fakeAuthenticator(), stranger = fakeAuthenticator();
    ensureBootstrapped(service, owner);
    expect(adminCode(() => signAndCommit(service, stranger, { op: "global.set", body: "x" }))).toBe("ADMIN_KEY_UNKNOWN");
    expect(adminCode(() => signAndCommit(service, owner, { op: "global.set", body: "x" }))).toBe("NO_ERROR");
  });

  it(`${covers("ADMIN_KEY_REVOKED")} and a key added by a valid key signs`, () => {
    const service = serviceAt(layersFile());
    const owner = fakeAuthenticator(), spare = fakeAuthenticator(-8);
    ensureBootstrapped(service, owner);
    signAndCommit(service, owner, spare.addChange("spare"));
    expect(adminCode(() => signAndCommit(service, spare, { op: "global.set", body: "by spare" }))).toBe("NO_ERROR");
    signAndCommit(service, owner, { op: "key.revoke", credentialId: spare.credentialId });
    expect(adminCode(() => signAndCommit(service, spare, { op: "global.set", body: "after revoke" }))).toBe("ADMIN_KEY_REVOKED");
    expect(service.load("codex", "s").global?.body).toBe("by spare");
  });

  it(covers("ADMIN_LAST_KEY_REVOKE_REFUSED"), () => {
    const service = serviceAt(layersFile());
    const owner = fakeAuthenticator(), spare = fakeAuthenticator();
    ensureBootstrapped(service, owner);
    expect(adminCode(() => signAndCommit(service, owner, { op: "key.revoke", credentialId: owner.credentialId }))).toBe("ADMIN_LAST_KEY_REVOKE_REFUSED");
    signAndCommit(service, owner, spare.addChange());
    expect(adminCode(() => signAndCommit(service, owner, { op: "key.revoke", credentialId: owner.credentialId }))).toBe("NO_ERROR");
  });

  it(covers("ADMIN_ALGORITHM_UNSUPPORTED"), () => {
    const service = serviceAt(layersFile());
    const owner = fakeAuthenticator();
    ensureBootstrapped(service, owner);
    const p384 = generateKeyPairSync("ec", { namedCurve: "secp384r1" }).publicKey.export({ format: "der", type: "spki" }).toString("base64url");
    const extra = fakeAuthenticator(-257);
    expect(adminCode(() => signAndCommit(service, owner, { ...extra.addChange(), alg: -35 }))).toBe("ADMIN_ALGORITHM_UNSUPPORTED");
    expect(adminCode(() => signAndCommit(service, owner, { ...extra.addChange(), alg: -7, publicKey: p384 }))).toBe("ADMIN_ALGORITHM_UNSUPPORTED");
    expect(adminCode(() => signAndCommit(service, owner, { ...extra.addChange(), alg: -7 }))).toBe("ADMIN_ALGORITHM_UNSUPPORTED");
    expect(adminCode(() => signAndCommit(service, owner, extra.addChange()))).toBe("NO_ERROR");
  });

  it(covers("WEBAUTHN_PUBLIC_KEY_UNAVAILABLE"), () => {
    const service = serviceAt(layersFile());
    const owner = fakeAuthenticator();
    expect(adminCode(() => service.prepareIntent({ ...owner.addChange(), publicKey: "AAAA" }, true))).toBe("WEBAUTHN_PUBLIC_KEY_UNAVAILABLE");
    expect(adminCode(() => service.prepareIntent(owner.addChange(), true))).toBe("NO_ERROR");
  });

  it.each([
    [covers("ADMIN_SIGNATURE_INVALID"), { corruptSignature: true }],
    ["ADMIN_SIGNATURE_INVALID", { type: "webauthn.create" }],
    [covers("ADMIN_CHALLENGE_MISMATCH"), { challenge: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }],
    [covers("ADMIN_ORIGIN_REJECTED"), { origin: "https://evil.example" }],
    ["ADMIN_ORIGIN_REJECTED", { origin: "http://127.0.0.1:47615" }],
    [covers("ADMIN_RPID_MISMATCH"), { rpId: "evil.example" }],
    [covers("ADMIN_USER_VERIFICATION_MISSING"), { flags: 0x01 }],
  ] as const)("refuses %s for an assertion bent as %o and accepts the unbent one", (expected, bend) => {
    const service = serviceAt(layersFile());
    const owner = fakeAuthenticator();
    ensureBootstrapped(service, owner);
    expect(adminCode(() => signAndCommit(service, owner, { op: "global.set", body: "x" }, { assertion: bend }))).toBe(expected);
    expect(service.load("codex", "s").global).toBeNull();
    expect(adminCode(() => signAndCommit(service, owner, { op: "global.set", body: "x" }))).toBe("NO_ERROR");
  });

  it(covers("ADMIN_INTENT_NONCANONICAL"), () => {
    const service = serviceAt(layersFile());
    const owner = fakeAuthenticator();
    ensureBootstrapped(service, owner);
    const { intent } = service.prepareIntent({ op: "global.set", body: "x" }, false);
    const spaced = JSON.stringify(JSON.parse(intent), null, 1);
    expect(adminCode(() => service.commit({ intent: spaced, assertion: owner.assert(spaced), requestId: randomUUID(), proposalId: null }))).toBe("ADMIN_INTENT_NONCANONICAL");
    expect(adminCode(() => service.commit({ intent, assertion: owner.assert(intent), requestId: randomUUID(), proposalId: null }))).toBe("NO_ERROR");
  });

  it(covers("ADMIN_INTENT_EXPIRED"), () => {
    const file = layersFile();
    const start = Date.parse("2026-11-07T12:00:00.000Z");
    const service = serviceAt(file, () => new Date(start));
    const owner = fakeAuthenticator();
    ensureBootstrapped(service, owner);
    const { intent } = service.prepareIntent({ op: "global.set", body: "x" }, false);
    const later = serviceAt(file, () => new Date(start + 10 * 60_000 + 1));
    expect(adminCode(() => later.commit({ intent, assertion: owner.assert(intent), requestId: randomUUID(), proposalId: null }))).toBe("ADMIN_INTENT_EXPIRED");
    const inTime = serviceAt(file, () => new Date(start + 10 * 60_000));
    expect(adminCode(() => inTime.commit({ intent, assertion: owner.assert(intent), requestId: randomUUID(), proposalId: null }))).toBe("NO_ERROR");
  });

  it(`${covers("ADMIN_TARGET_STALE")}, while a change to another target does not contend`, () => {
    const service = serviceAt(layersFile());
    const owner = fakeAuthenticator();
    ensureBootstrapped(service, owner);
    const mine = service.prepareIntent({ op: "global.set", body: "mine" }, false);
    const role = service.prepareIntent({ op: "role.add", roleId: "role-1", name: "reviewer" }, false);
    signAndCommit(service, owner, { op: "global.set", body: "theirs" });
    expect(adminCode(() => service.commit({ intent: mine.intent, assertion: owner.assert(mine.intent), requestId: randomUUID(), proposalId: null }))).toBe("ADMIN_TARGET_STALE");
    expect(adminCode(() => service.commit({ intent: role.intent, assertion: owner.assert(role.intent), requestId: randomUUID(), proposalId: null }))).toBe("NO_ERROR");
    // The page names the revision its edit started from; a moved target is refused before the passkey prompt.
    const current = service.adminState().global!.stateToken;
    expect(adminCode(() => service.prepareIntent({ op: "global.set", body: "x" }, false, null))).toBe("ADMIN_TARGET_STALE");
    expect(adminCode(() => service.prepareIntent({ op: "global.set", body: "x" }, false, current))).toBe("NO_ERROR");
  });

  it(`${covers("ADMIN_LOG_REGRESSED")} in the process that saw the newer record; tail truncation is a declared limit`, () => {
    const file = layersFile();
    const resident = serviceAt(file);
    const owner = fakeAuthenticator();
    ensureBootstrapped(resident, owner);
    signAndCommit(resident, owner, { op: "global.set", body: "r-old" });
    signAndCommit(resident, owner, { op: "global.set", body: "r-new" });
    sql(file, "DELETE FROM admin_log WHERE seq = (SELECT MAX(seq) FROM admin_log)");
    expect(resident.load("codex", "s")).toMatchObject({ global: { body: "r-old" }, failures: [{ layer: "global", code: "ADMIN_LOG_REGRESSED" }] });
    // Declared limit (brief B.8): a process that never saw the cut record cannot tell. This pins that it passes.
    expect(serviceAt(file).load("codex", "s")).toMatchObject({ global: { body: "r-old" }, failures: [] });
  });

  it(covers("ADMIN_PROPOSAL_NOT_FOUND"), () => {
    const service = serviceAt(layersFile());
    const owner = fakeAuthenticator();
    ensureBootstrapped(service, owner);
    expect(adminCode(() => service.rejectProposal("prop-missing"))).toBe("ADMIN_PROPOSAL_NOT_FOUND");
    expect(adminCode(() => signAndCommit(service, owner, { op: "global.set", body: "x" }, { proposalId: "prop-missing" }))).toBe("ADMIN_PROPOSAL_NOT_FOUND");
    // A request for another target cannot be marked applied by this record.
    const requested = service.proposeGlobal({ host: "codex", sessionId: "s", actor: "a" }, null, "asked");
    expect(adminCode(() => signAndCommit(service, owner, { op: "role.add", roleId: "role-x", name: "x" }, { proposalId: requested.proposalId }))).toBe("ADMIN_PROPOSAL_NOT_FOUND");
    expect(adminCode(() => signAndCommit(service, owner, { op: "global.set", body: "asked" }, { proposalId: requested.proposalId }))).toBe("NO_ERROR");
  });

  it(`${covers("ADMIN_CHANGE_INVALID")} for a role name that differs only in case or spacing`, () => {
    const service = serviceAt(layersFile());
    const owner = fakeAuthenticator();
    ensureBootstrapped(service, owner);
    signAndCommit(service, owner, { op: "role.add", roleId: "role-1", name: "SSH 포털 담당" });
    expect(adminCode(() => signAndCommit(service, owner, { op: "role.add", roleId: "role-2", name: "ssh 포털 담당" }))).toBe("ADMIN_CHANGE_INVALID");
    expect(adminCode(() => service.prepareIntent({ op: "role.add", roleId: "role-2", name: " untrimmed" }, false))).toBe("ADMIN_CHANGE_INVALID");
    expect(adminCode(() => service.prepareIntent({ op: "global.set", body: "x", extra: 1 }, false))).toBe("ADMIN_CHANGE_INVALID");
    expect(adminCode(() => signAndCommit(service, owner, { op: "role.add", roleId: "role-2", name: "SSH 포털 검수" }))).toBe("NO_ERROR");
  });

  it(`${covers("ADMIN_RECORD_ALTERED")}: a record changed in the file is not applied and the target keeps its last valid revision`, () => {
    const file = layersFile();
    const service = serviceAt(file);
    const owner = fakeAuthenticator();
    ensureBootstrapped(service, owner);
    const good = signAndCommit(service, owner, { op: "global.set", body: "GOOD" }).record;
    const newer = signAndCommit(service, owner, { op: "global.set", body: "NEWER" }).record;
    sql(file, "UPDATE admin_log SET intent = replace(intent, 'NEWER', 'EVIL') WHERE seq = ?", newer.seq);
    expect(serviceAt(file).load("codex", "s")).toMatchObject({ global: { body: "GOOD", revision: good.seq }, failures: [{ layer: "global", code: "ADMIN_RECORD_ALTERED", revision: good.seq }] });
  });

  it("has a case for every admin error code", () => {
    // Codes produced only at the HTTP boundary or by the fold are covered in the cases above and below by name.
    expect([...ADMIN_ERROR_CODES].filter(code => !tested.has(code))).toEqual([]);
  });
});

describe("signed admin log: records, requests and reset", () => {
  it("returns the stored record for a repeated request ID instead of signing or storing twice", () => {
    const service = serviceAt(layersFile());
    const owner = fakeAuthenticator();
    ensureBootstrapped(service, owner);
    const { intent } = service.prepareIntent({ op: "global.set", body: "once" }, false);
    const requestId = randomUUID();
    const first = service.commit({ intent, assertion: owner.assert(intent), requestId, proposalId: null });
    const again = service.commit({ intent, assertion: owner.assert(intent), requestId, proposalId: null });
    expect(again).toEqual({ record: first.record, duplicate: true });
    expect(service.recordByRequest(requestId)?.seq).toBe(first.record.seq);
    expect(service.recordByRequest(randomUUID())).toBeNull();
    expect(service.adminState().globalHistory).toHaveLength(1);
  });

  it("deletes a role with its bindings and its body in the transaction of the signed deletion", () => {
    const service = serviceAt(layersFile());
    const owner = fakeAuthenticator();
    ensureBootstrapped(service, owner);
    signAndCommit(service, owner, { op: "role.add", roleId: "role-1", name: "reviewer" });
    signAndCommit(service, owner, { op: "binding.set", host: "codex", sessionId: "s1", roleId: "role-1" });
    service.saveRole("codex", "s1", null, "role body", "a");
    expect(service.adminState().roles).toMatchObject([{ roleId: "role-1", bindingCount: 1, context: { body: "role body" } }]);
    signAndCommit(service, owner, { op: "role.delete", roleId: "role-1" });
    expect(service.adminState()).toMatchObject({ roles: [], bindings: [] });
    expect(service.load("codex", "s1")).toMatchObject({ binding: null, role: null });
    // A new role never reuses the old body: the body went with the deletion.
    signAndCommit(service, owner, { op: "role.add", roleId: "role-2", name: "reviewer" });
    signAndCommit(service, owner, { op: "binding.set", host: "codex", sessionId: "s1", roleId: "role-2" });
    expect(service.load("codex", "s1").role).toBeNull();
  });

  it("keeps a renamed role's binding and body (they refer to its ID)", () => {
    const service = serviceAt(layersFile());
    const owner = fakeAuthenticator();
    ensureBootstrapped(service, owner);
    signAndCommit(service, owner, { op: "role.add", roleId: "role-1", name: "reviewer" });
    signAndCommit(service, owner, { op: "binding.set", host: "codex", sessionId: "s1", roleId: "role-1" });
    service.saveRole("codex", "s1", null, "kept", "a");
    signAndCommit(service, owner, { op: "role.rename", roleId: "role-1", name: "auditor" });
    expect(service.load("codex", "s1")).toMatchObject({ binding: { role: "auditor", roleId: "role-1" }, role: { body: "kept" } });
  });

  it("drops a binding unused for 30 days, counted from the last use, not from binding", () => {
    const file = layersFile();
    let now = Date.parse("2026-11-07T00:00:00.000Z");
    const service = serviceAt(file, () => new Date(now));
    const owner = fakeAuthenticator();
    ensureBootstrapped(service, owner);
    signAndCommit(service, owner, { op: "role.add", roleId: "role-1", name: "reviewer" });
    signAndCommit(service, owner, { op: "binding.set", host: "codex", sessionId: "s1", roleId: "role-1" });
    service.saveRole("codex", "s1", null, "body", "a");
    now += 20 * 24 * 3600_000;
    expect(service.hookText("codex", "s1", hostActorId("codex", "s1"), true)?.map(line => line.key)).toContain("hooks.contextLayers.role");
    now += 20 * 24 * 3600_000; // 40 days after binding, 20 after the last use
    expect(service.load("codex", "s1").binding).toMatchObject({ role: "reviewer" });
    now += 11 * 24 * 3600_000;
    expect(service.load("codex", "s1").binding).toBeNull();
  });

  it("drops decided agent requests 30 days after the decision and keeps pending ones", () => {
    const file = layersFile();
    let now = Date.parse("2026-11-07T00:00:00.000Z");
    const service = serviceAt(file, () => new Date(now));
    const old = service.proposeGlobal({ host: "codex", sessionId: "s1", actor: "a" }, null, "old");
    service.rejectProposal(old.proposalId);
    const waiting = service.proposeGlobal({ host: "codex", sessionId: "s2", actor: "a" }, null, "waiting");
    const count = () => {
      const database = new DatabaseSync(file);
      try { return (database.prepare("SELECT id FROM admin_proposals ORDER BY id").all() as Array<{ id: string }>).map(row => row.id); } finally { database.close(); }
    };
    now += 29 * 24 * 3600_000;
    service.proposeGlobal({ host: "codex", sessionId: "s3", actor: "a" }, null, "day 29");
    expect(count()).toContain(old.proposalId);
    now += 2 * 24 * 3600_000;
    service.proposeGlobal({ host: "codex", sessionId: "s4", actor: "a" }, null, "day 31");
    expect(count()).not.toContain(old.proposalId);
    expect(count()).toContain(waiting.proposalId);
  });

  it("discards failed records with a signed acknowledgement and keeps the current valid state", () => {
    const file = layersFile();
    const service = serviceAt(file);
    const owner = fakeAuthenticator();
    ensureBootstrapped(service, owner);
    signAndCommit(service, owner, { op: "global.set", body: "GOOD" });
    const newer = signAndCommit(service, owner, { op: "global.set", body: "NEWER" }).record;
    sql(file, "UPDATE admin_log SET intent = replace(intent, 'NEWER', 'EVIL') WHERE seq = ?", newer.seq);
    expect(service.adminState().failures).toMatchObject([{ target: "global", code: "ADMIN_RECORD_ALTERED", change: { op: "global.set", body: "EVIL" } }]);
    signAndCommit(service, owner, { op: "ack", target: "global" });
    expect(service.adminState().failures).toEqual([]);
    expect(service.load("codex", "s")).toMatchObject({ global: { body: "GOOD" }, failures: [] });
    expect(adminCode(() => service.prepareIntent({ op: "ack", target: "binding:only-one-part" }, false))).toBe("ADMIN_CHANGE_INVALID");
  });

  it("resets by archiving every record (CLI only): every signed item is back to its default, the reset stays visible, no rollback alarm", () => {
    const file = layersFile();
    const resident = serviceAt(file);
    const owner = fakeAuthenticator();
    ensureBootstrapped(resident, owner);
    signAndCommit(resident, owner, { op: "global.set", body: "before reset" });
    signAndCommit(resident, owner, { op: "role.add", roleId: "role-1", name: "reviewer" });
    const last = resident.adminState().lastSeq;
    // The reset command runs in its own process.
    const reset = serviceAt(file).reset();
    expect(reset).toMatchObject({ archived: last });
    expect(resident.adminState()).toMatchObject({ keys: [], roles: [], global: null, bootstrap: null, resets: [{ id: reset.id, archived: last }] });
    expect(resident.load("codex", "s").failures).toEqual([]);
    // A new first key may register after a reset.
    const next = fakeAuthenticator(-8);
    expect(adminCode(() => signAndCommit(resident, next, next.addChange(), { bootstrap: true }))).toBe("NO_ERROR");
  });
});

describe("hook reads only verified records (direct SQLite edits and D-0069)", () => {
  const session = "hook-session";
  function env(file: string): NodeJS.ProcessEnv {
    const root = path.dirname(file);
    return { AGENT_GOVERNANCE_CONTEXT_LAYER_DB_PATH: file, AGENT_GOVERNANCE_DB_PATH: path.join(root, "workflow.sqlite3"),
      AGENT_GOVERNANCE_CONTINUITY_DB_PATH: path.join(root, "continuity.sqlite3"), AGENT_GOVERNANCE_LOCALE: "en", AGENT_GOVERNANCE_ADMIN_PORT: "47615" };
  }
  function start(file: string, host = "codex"): string {
    const output = runContinuityHook(JSON.stringify({ hook_event_name: "SessionStart", source: "startup", session_id: session, cwd: tmpdir() }), env(file), host, true);
    return output ? (JSON.parse(output) as { hookSpecificOutput?: { additionalContext?: string } }).hookSpecificOutput?.additionalContext ?? "" : "";
  }
  function bound(file: string) {
    const service = serviceAt(file);
    const owner = fakeAuthenticator();
    ensureBootstrapped(service, owner);
    const good = signAndCommit(service, owner, { op: "global.set", body: "GLOBAL-GOOD" }).record;
    signAndCommit(service, owner, { op: "role.add", roleId: "role-1", name: "reviewer" });
    signAndCommit(service, owner, { op: "binding.set", host: "codex", sessionId: session, roleId: "role-1" });
    service.saveRole("codex", session, null, "ROLE-BODY", "a");
    return { service, owner, good };
  }

  it("does not apply a record UPDATEd in the file and announces the revision in use, once", () => {
    const file = layersFile();
    const { service, owner, good } = bound(file);
    const newer = signAndCommit(service, owner, { op: "global.set", body: "GLOBAL-NEWER" }).record;
    sql(file, "UPDATE admin_log SET intent = replace(intent, 'GLOBAL-NEWER', 'GLOBAL-EVIL') WHERE seq = ?", newer.seq);
    const text = start(file);
    expect(text).not.toContain("GLOBAL-EVIL");
    expect(text).toContain("GLOBAL-GOOD");
    expect(text).toContain(`[AGS verification failed · global context · r${good.seq} in use · tell the user · agents cannot fix this]`);
    expect(text).toContain("ADMIN_RECORD_ALTERED");
    expect(text).toContain("http://localhost:47615/");
    expect(text.match(/verification failed/gu)).toHaveLength(1);
    expect(text).toContain("ROLE-BODY");
  });

  it("does not apply a record INSERTed with a key nobody registered, for the global context or for this session's binding", () => {
    const file = layersFile();
    const { service, good } = bound(file);
    const intruder = fakeAuthenticator();
    const state = service.adminState();
    const head = state.global!.stateToken;
    const forge = (target: string, change: unknown, prev: string | null) => {
      const intent = JSON.stringify({ change, domain: "ags.admin", issuedAt: new Date().toISOString(), prevTargetHash: prev, rpId: "localhost", target, v: 1 });
      const assertion = intruder.assert(intent);
      // A well-formed record with its own correct hash: only the signer gives it away.
      sql(file, `INSERT INTO admin_log (target, intent, credential_id, authenticator_data, client_data_json, signature, record_hash, request_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`, target, intent, assertion.credentialId, assertion.authenticatorData, assertion.clientDataJSON,
      assertion.signature, adminRecordHash({ intent, ...assertion }), new Date().toISOString());
    };
    forge("global", { body: "GLOBAL-FORGED", op: "global.set" }, head);
    const text = start(file);
    expect(text).not.toContain("GLOBAL-FORGED");
    expect(text).toContain(`r${good.seq} in use`);
    expect(serviceAt(file).load("codex", session).failures).toMatchObject([{ layer: "global", code: "ADMIN_KEY_UNKNOWN", revision: good.seq }]);
    // A forged unbinding of this session is not applied either: the session keeps its signed role.
    forge(`binding:codex:${session}`, { host: "codex", op: "binding.set", roleId: null, sessionId: session }, null);
    expect(start(file)).toContain("ROLE-BODY");
  });

  it("gives the role context when the global record fails, and the global context when the role body cannot be read (D-0069)", () => {
    const file = layersFile();
    const { service, owner } = bound(file);
    const newer = signAndCommit(service, owner, { op: "global.set", body: "GLOBAL-NEWER" }).record;
    sql(file, "UPDATE admin_log SET signature = 'AAAA' WHERE seq = ?", newer.seq);
    expect(start(file)).toContain("ROLE-BODY");
    sql(file, "UPDATE role_contexts SET body = 'tampered'");
    const text = start(file);
    expect(text).toContain("GLOBAL-GOOD");
    expect(text).toContain("[AGS shared context unreadable · role context");
    expect(text).not.toContain("tampered");
  });

  it("falls back to the default (no role) when the session's only binding record is forged, and says so", () => {
    const file = layersFile();
    const service = serviceAt(file);
    const owner = fakeAuthenticator();
    ensureBootstrapped(service, owner);
    signAndCommit(service, owner, { op: "role.add", roleId: "role-1", name: "reviewer" });
    const binding = signAndCommit(service, owner, { op: "binding.set", host: "codex", sessionId: session, roleId: "role-1" }).record;
    service.saveRole("codex", session, null, "ROLE-BODY", "a");
    sql(file, "UPDATE admin_log SET intent = replace(intent, 'role-1', 'role-2') WHERE seq = ?", binding.seq);
    const text = start(file);
    expect(text).not.toContain("ROLE-BODY");
    expect(text).toContain("[AGS verification failed · this session's role binding · no valid revision, default in use");
  });
});

describe("admin page HTTP boundary", () => {
  async function page(options: { sessions?: AdminSessionView[]; failSessions?: boolean } = {}) {
    const file = layersFile();
    const service = serviceAt(file);
    const server: Server = createServer();
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const settings = (admin: { signedSettings: Parameters<typeof adminSettingsView>[0]["signed"] }): AdminSettingsView => adminSettingsView({ environment: {},
      signed: admin.signedSettings, locale: { value: "ko", source: "settings" }, localeOptions: ["en", "ko"], usage: null,
      installation: { configured: false, allows: true, mode: null, profileCount: 0, limitUsd: null, credentials: [], error: null } });
    server.on("request", createAdminRequestHandler({ service, port, settings: async admin => settings(admin),
      listSessions: async () => { if (options.failSessions) throw Object.assign(new Error("x"), { code: "PRESENCE_DOWN" }); return options.sessions ?? []; } }));
    cleanups.push(() => new Promise<void>(resolve => server.close(() => resolve())));
    const call = (method: string, pathName: string, headers: Record<string, string> = {}, body?: string) =>
      new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; text: string }>((resolve, reject) => {
        const request = httpRequest({ host: "127.0.0.1", port, method, path: pathName, headers: { host: `localhost:${port}`, ...headers } }, response => {
          const chunks: Buffer[] = [];
          response.on("data", chunk => chunks.push(chunk as Buffer));
          response.on("end", () => resolve({ status: response.statusCode!, headers: response.headers, text: Buffer.concat(chunks).toString("utf8") }));
        });
        request.on("error", reject);
        if (body !== undefined) request.write(body);
        request.end();
      });
    const post = (pathName: string, value: unknown, headers: Record<string, string> = {}) =>
      call("POST", pathName, { origin: `http://localhost:${port}`, "content-type": "application/json", ...headers }, JSON.stringify(value));
    return { service, port, call, post };
  }

  it("serves the page with a nonce CSP and no inline placeholder left", async () => {
    const { call } = await page();
    const response = await call("GET", "/");
    expect(response.status).toBe(200);
    const csp = String(response.headers["content-security-policy"]);
    const nonce = /script-src 'nonce-([^']+)'/u.exec(csp)?.[1];
    expect(nonce).toBeTruthy();
    expect(csp).toContain("frame-ancestors 'none'");
    expect(response.text).not.toContain("__CSP_NONCE__");
    expect(response.text.length).toBeGreaterThanOrEqual(ADMIN_PAGE_HTML.length - 200);
    expect(response.headers["x-frame-options"]).toBe("DENY");
  });

  it("refuses a foreign Host (DNS rebinding) and moves 127.0.0.1 to localhost with the reason", async () => {
    const { call, port } = await page();
    expect((await call("GET", "/api/state", { host: `evil.example:${port}` })).status).toBe(403);
    const moved = await call("GET", "/", { host: `127.0.0.1:${port}` });
    expect(moved.status).toBe(200);
    expect(moved.text).toContain(`http://localhost:${port}/`);
    expect(moved.text).toContain("WebAuthn");
    expect(JSON.parse((await call("GET", "/api/state", { host: `127.0.0.1:${port}` })).text)).toMatchObject({ error: { code: "HOST_REJECTED" } });
  });

  it("refuses a POST from another origin, without JSON content type, or over the size cap", async () => {
    const { post, call, port } = await page();
    const change = { change: { op: "global.set", body: "x" }, bootstrap: false };
    expect(JSON.parse((await post("/api/intent", change, { origin: "https://evil.example" })).text)).toMatchObject({ error: { code: "ADMIN_ORIGIN_REJECTED" } });
    expect((await call("POST", "/api/intent", { "content-type": "application/json" }, JSON.stringify(change))).status).toBe(403);
    expect((await post("/api/intent", change, { "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await post("/api/intent", change, { "content-type": "text/plain" })).status).toBe(415);
    const big = await post("/api/intent", { change: { op: "global.set", body: "x".repeat(ADMIN_BODY_MAX_BYTES) } });
    expect([big.status, JSON.parse(big.text).error.code]).toEqual([413, "REQUEST_TOO_LARGE"]);
    expect(port).toBeGreaterThan(0);
  });

  it("registers the first key, saves through intent and commit, and answers a lost response by request ID", async () => {
    const { post, call, port } = await page();
    const owner = fakeAuthenticator();
    // The browser signs on this page, so its client data names this page's origin.
    const onPage = { origin: `http://localhost:${port}` };
    const bootstrap = JSON.parse((await post("/api/intent", { change: owner.addChange(), bootstrap: true })).text) as { intent: string; allowCredentials: string[] };
    expect(bootstrap.allowCredentials).toEqual([owner.credentialId]);
    const first = await post("/api/commit", { intent: bootstrap.intent, assertion: owner.assert(bootstrap.intent, onPage), requestId: randomUUID(), proposalId: null });
    expect(first.status).toBe(200);
    const prepared = JSON.parse((await post("/api/intent", { change: { op: "global.set", body: "from the page" }, bootstrap: false })).text) as { intent: string };
    const requestId = randomUUID();
    const saved = JSON.parse((await post("/api/commit", { intent: prepared.intent, assertion: owner.assert(prepared.intent, onPage), requestId, proposalId: null })).text);
    expect(saved).toMatchObject({ duplicate: false, record: { target: "global" } });
    expect(JSON.parse((await call("GET", `/api/request/${requestId}`)).text)).toEqual({ record: saved.record });
    expect(JSON.parse((await call("GET", `/api/request/${randomUUID()}`)).text)).toEqual({ record: null });
    expect(JSON.parse((await call("GET", "/api/state")).text)).toMatchObject({ global: { body: "from the page" }, keys: [{ credentialId: owner.credentialId }] });
    // A signature made on a look-alike page at another localhost port is refused by the page server.
    const elsewhere = JSON.parse((await post("/api/intent", { change: { op: "global.set", body: "phished" }, bootstrap: false })).text) as { intent: string };
    const phished = await post("/api/commit", { intent: elsewhere.intent, assertion: owner.assert(elsewhere.intent, { origin: "http://localhost:3000" }), requestId: randomUUID(), proposalId: null });
    expect([phished.status, JSON.parse(phished.text).error.code]).toEqual([403, "ADMIN_ORIGIN_REJECTED"]);
    expect((await post("/api/proposals/%E0%A4%A/reject", {})).status).toBe(400);
    // A second first registration through the API is refused with 409.
    const again = await post("/api/intent", { change: fakeAuthenticator().addChange(), bootstrap: true });
    expect([again.status, JSON.parse(again.text).error.code]).toEqual([409, "ADMIN_ALREADY_BOOTSTRAPPED"]);
    // An unsigned "save" by any local program (an agent with curl) is refused.
    const fresh = JSON.parse((await post("/api/intent", { change: { op: "global.set", body: "by curl" }, bootstrap: false })).text) as { intent: string };
    const unsigned = await post("/api/commit", { intent: fresh.intent, assertion: { credentialId: owner.credentialId, authenticatorData: "AA", clientDataJSON: "AA", signature: "AA" }, requestId: randomUUID(), proposalId: null });
    expect([unsigned.status, JSON.parse(unsigned.text).error.code]).toEqual([400, "ADMIN_SIGNATURE_INVALID"]);
  });

  it("lists present sessions with their signed binding, a bound session no longer present as ended, and a presence failure by code", async () => {
    const sessions: AdminSessionView[] = [{ host: "codex", hostLabel: "codex", sessionId: "live", state: "online", cwd: "/w", summary: "doing", selfRole: "self", lastSeenAt: null }];
    const { service, call } = await page({ sessions });
    const owner = fakeAuthenticator();
    ensureBootstrapped(service, owner);
    signAndCommit(service, owner, { op: "role.add", roleId: "role-1", name: "reviewer" });
    signAndCommit(service, owner, { op: "binding.set", host: "claude-code", sessionId: "gone", roleId: "role-1" });
    const state = JSON.parse((await call("GET", "/api/state")).text);
    expect(state.sessions).toMatchObject([{ sessionId: "live", binding: null, selfRole: "self" }, { sessionId: "gone", state: "ended", binding: { roleId: "role-1" } }]);
    expect(state.sessionsError).toBeNull();
    const failing = await page({ failSessions: true });
    expect(JSON.parse((await failing.call("GET", "/api/state")).text)).toMatchObject({ sessions: [], sessionsError: { code: "PRESENCE_DOWN" } });
  });

  it("takes a JEV key only with its signed registration, never sends it back, and refuses a control character", async () => {
    const { service, post, call, port } = await page();
    const owner = fakeAuthenticator();
    ensureBootstrapped(service, owner);
    const onPage = { origin: `http://localhost:${port}` };
    const value = "sk-page-fixture-value";
    const prepared = JSON.parse((await post("/api/intent", { change: { op: "jevKey.set", name: "JEV_PAGE_KEY", fingerprint: jevKeyFingerprint(value) }, bootstrap: false })).text) as { intent: string };
    const bad = await post("/api/commit", { intent: prepared.intent, assertion: owner.assert(prepared.intent, onPage), requestId: randomUUID(), proposalId: null, secret: "sk-" });
    expect([bad.status, JSON.parse(bad.text).error]).toEqual([400, { code: "REQUEST_INVALID", details: { field: "secret" } }]);
    const saved = await post("/api/commit", { intent: prepared.intent, assertion: owner.assert(prepared.intent, onPage), requestId: randomUUID(), proposalId: null, secret: value });
    expect(saved.status).toBe(200);
    expect(saved.text).not.toContain(value);
    const state = await call("GET", "/api/state");
    expect(state.text).not.toContain(value);
    expect(JSON.parse(state.text).settings.jev.keys).toMatchObject([{ name: "JEV_PAGE_KEY", fingerprint: jevKeyFingerprint(value), stored: true }]);
    expect(service.jevKey("JEV_PAGE_KEY")).toBe(value);
  });

  it("rejects an agent request from the page", async () => {
    const { service, post } = await page();
    const requested = service.proposeGlobal({ host: "codex", sessionId: "s", actor: "a" }, null, "asked");
    expect((await post(`/api/proposals/${requested.proposalId}/reject`, {})).status).toBe(200);
    const again = await post(`/api/proposals/${requested.proposalId}/reject`, {});
    expect([again.status, JSON.parse(again.text).error.code]).toEqual([404, "ADMIN_PROPOSAL_NOT_FOUND"]);
  });
});
