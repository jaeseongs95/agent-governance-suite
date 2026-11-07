import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { ADMIN_PAGE_HTML } from "../../mcp-server/src/admin-page.generated.js";
import { type AdminChange, JEV_BUDGET_MAX_USD, SETTING_CHANGE_REASONS } from "../../mcp-server/src/admin-log.js";
import { adminSettingsView, applyAdminJev, editExemptPaths, jevBudgetLimit, type JevInstallationView } from "../../mcp-server/src/admin-settings.js";
import { AdminError } from "../../mcp-server/src/admin-webauthn.js";
import { ContextLayerService } from "../../mcp-server/src/context-layer-service.js";
import { ContextLayerStore } from "../../mcp-server/src/context-layer-store.js";
import { handleContinuityHook, runContinuityHook } from "../../mcp-server/src/continuity-hook.js";
import { ContinuityService } from "../../mcp-server/src/continuity-service.js";
import { SqliteContinuityStore } from "../../mcp-server/src/continuity-store.js";
import { resolveHostLocale } from "../../mcp-server/src/i18n.js";
import { JevKeyVault, JevKeyVaultError, jevKeyFingerprint } from "../../mcp-server/src/jev-key-vault.js";
import { InMemoryClassificationBudget } from "../../mcp-server/src/skill-classification/service.js";
import type { ProviderProfile } from "../../mcp-server/src/skill-classification/types.js";
import { ensureBootstrapped, fakeAuthenticator, type FakeAuthenticator, signAndCommit } from "../helpers/fake-authenticator.js";

// The settings the admin page edits besides the contexts (AGS3-T-0024 completion condition 2): each is a signed record,
// read through the verified fold by the hook (locale, edit gate), the MCP server (JEV switch, budget, preset, keys) and
// the page. Each case signs the value, reads it at the real reader, then bends one thing (a tampered record, an
// environment value, a moved ciphertext) and checks the fallback. A software authenticator stands in for the passkey.
const directories: string[] = [];
const stores: SqliteContinuityStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

function stateDirectory(): string {
  const created = mkdtempSync(path.join(tmpdir(), "ags-admin-settings-"));
  directories.push(created);
  return created;
}

function setup() {
  const directory = stateDirectory();
  const file = path.join(directory, "context-layers.sqlite3");
  const vault = new JevKeyVault(path.join(directory, "jev-key-vault.bin"));
  const service = new ContextLayerService(create => ContextLayerStore.open(file, create), undefined, "http://localhost:47615/", vault);
  const owner = fakeAuthenticator();
  ensureBootstrapped(service, owner);
  // Only this test's state: the shared directory (settings.json) and the shared context file are both here.
  const environment: NodeJS.ProcessEnv = { AGENT_GOVERNANCE_CONTEXT_LAYER_DB_PATH: file, AGENT_GOVERNANCE_SHARED_STATE_DIR: directory };
  return { directory, file, vault, service, owner, environment };
}

function sql(file: string, statement: string, ...values: Array<string | number | null>): void {
  const database = new DatabaseSync(file);
  try { database.prepare(statement).run(...values); } finally { database.close(); }
}

function rows(file: string, statement: string): Array<Record<string, unknown>> {
  const database = new DatabaseSync(file);
  try { return database.prepare(statement).all() as Array<Record<string, unknown>>; } finally { database.close(); }
}

function adminCode(action: () => unknown): string {
  try { action(); } catch (error) {
    if (error instanceof AdminError) return `${error.code}${error.details.reason ? `/${String(error.details.reason)}` : ""}`;
    throw error;
  }
  return "NO_ERROR";
}

function registerKey(service: ContextLayerService, signer: FakeAuthenticator, name: string, secret: string | null, fingerprintOf = secret ?? "x") {
  const prepared = service.prepareIntent({ op: "jevKey.set", name, fingerprint: jevKeyFingerprint(fingerprintOf) }, false);
  return service.commit({ intent: prepared.intent, assertion: signer.assert(prepared.intent), requestId: randomUUID(), proposalId: null, secret });
}

const coveredReasons = new Set<string>();
function coversReason(reason: string): string {
  coveredReasons.add(reason);
  return reason;
}

function locale(environment: NodeJS.ProcessEnv) {
  return resolveHostLocale({ environment, packageLocalePath: path.join(environment.AGENT_GOVERNANCE_SHARED_STATE_DIR!, "no-package-locale.json") });
}

describe("display locale: signed, environment first", () => {
  it("applies the signed locale, keeps the last valid one when a newer record is altered, and lets the environment win", () => {
    const { service, owner, environment, file } = setup();
    // No settings file and no package locale here: the root locale (en) is the default.
    expect(locale(environment)).toMatchObject({ locale: "en", source: "root" });
    const korean = signAndCommit(service, owner, { op: "locale.set", locale: "ko" }).record;
    expect(locale(environment)).toMatchObject({ locale: "ko", source: "signed" });
    const english = signAndCommit(service, owner, { op: "locale.set", locale: "en" }).record;
    sql(file, "UPDATE admin_log SET signature = 'AAAA' WHERE seq = ?", english.seq);
    expect(locale(environment)).toMatchObject({ locale: "ko", source: "signed" });
    expect(service.adminState().failures).toMatchObject([{ target: "locale", code: "ADMIN_RECORD_ALTERED", revision: korean.seq }]);
    // An environment value is never silently overridden: it wins, and the page shows the locale as locked by it.
    expect(locale({ ...environment, AGENT_GOVERNANCE_LOCALE: "en" })).toMatchObject({ locale: "en", source: "environment" });
  });

  it("falls back to the default when the only locale record was altered in the file", () => {
    const { service, owner, environment, file } = setup();
    const only = signAndCommit(service, owner, { op: "locale.set", locale: "ko" }).record;
    sql(file, "UPDATE admin_log SET signature = 'AAAA' WHERE seq = ?", only.seq);
    expect(locale(environment)).toMatchObject({ locale: "en", source: "root" });
    expect(service.load("codex", "s").failures).toMatchObject([{ layer: "locale", code: "ADMIN_RECORD_ALTERED", revision: null }]);
  });

  it("renders the hook's text in the signed locale", () => {
    const { service, owner, environment, directory } = setup();
    signAndCommit(service, owner, { op: "global.set", body: "GLOBAL-RULE" });
    const environmentFor = (extra: NodeJS.ProcessEnv) => ({ ...environment, AGENT_GOVERNANCE_DB_PATH: path.join(directory, "workflow.sqlite3"),
      AGENT_GOVERNANCE_CONTINUITY_DB_PATH: path.join(directory, "continuity.sqlite3"), AGENT_GOVERNANCE_ADMIN_PORT: "47615", ...extra });
    const start = (extra: NodeJS.ProcessEnv = {}) => {
      const output = runContinuityHook(JSON.stringify({ hook_event_name: "SessionStart", source: "startup", session_id: `s-${randomUUID()}`, cwd: tmpdir() }),
        environmentFor(extra), "codex", true);
      return (JSON.parse(output) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;
    };
    expect(start()).toContain("[AGS 전역 컨텍스트");
    signAndCommit(service, owner, { op: "locale.set", locale: "en" });
    expect(start()).toContain("[AGS global context");
    expect(start({ AGENT_GOVERNANCE_LOCALE: "ko" })).toContain("[AGS 전역 컨텍스트");
  });
});

describe("edit gate exceptions: signed, environment first", () => {
  const repo = fileURLToPath(new URL("../../.phase-fixture/admin-settings", import.meta.url));
  const session = "edit-session";
  const write = (name: string) => ({ hook_event_name: "PreToolUse", session_id: session, cwd: repo, tool_name: "Write",
    tool_input: { file_path: path.join(repo, name), content: "x" } });
  function gate(environment: NodeJS.ProcessEnv): boolean[] {
    const store = new SqliteContinuityStore(":memory:");
    stores.push(store);
    const continuity = new ContinuityService(store, null, null);
    return ["notes/a.md", "notes/b.md", "notes/c.md"].map(name =>
      (handleContinuityHook(write(name), continuity, "claude-code", environment, "en").hookSpecificOutput as { permissionDecision?: string } | undefined)
        ?.permissionDecision === "deny");
  }

  it("exempts a signed directory at the edit gate, and an environment list replaces it", () => {
    const { service, owner, environment } = setup();
    // Positive control: without an exemption the third product file is refused.
    expect(gate(environment)).toEqual([false, false, true]);
    signAndCommit(service, owner, { op: "editExempt.set", paths: [path.join(repo, "notes")] });
    expect(editExemptPaths(environment)).toEqual([path.join(repo, "notes")]);
    expect(gate(environment)).toEqual([false, false, false]);
    const elsewhere = path.join(repo, "elsewhere");
    expect(editExemptPaths({ ...environment, AGENT_GOVERNANCE_PHASE_EXEMPT_PATHS: elsewhere })).toEqual([elsewhere]);
    expect(gate({ ...environment, AGENT_GOVERNANCE_PHASE_EXEMPT_PATHS: elsewhere })).toEqual([false, false, true]);
  });

  it("keeps the last valid list when a newer record is altered, and opens nothing when the file cannot be read", () => {
    const { service, owner, environment, file } = setup();
    const first = path.join(repo, "notes");
    signAndCommit(service, owner, { op: "editExempt.set", paths: [first] });
    const wider = signAndCommit(service, owner, { op: "editExempt.set", paths: [first, path.parse(repo).root] }).record;
    sql(file, "UPDATE admin_log SET record_hash = 'sha256:00' WHERE seq = ?", wider.seq);
    expect(editExemptPaths(environment)).toEqual([first]);
    expect(editExemptPaths(environment, () => { throw new Error("unreadable"); })).toEqual([]);
  });

  it("refuses a relative or repeated path before the passkey prompt", () => {
    const { service } = setup();
    expect(adminCode(() => service.prepareIntent({ op: "editExempt.set", paths: ["relative/notes"] }, false))).toBe("ADMIN_CHANGE_INVALID");
    expect(adminCode(() => service.prepareIntent({ op: "editExempt.set", paths: [path.resolve("x"), path.resolve("x")] }, false))).toBe("ADMIN_CHANGE_INVALID");
    expect(adminCode(() => service.prepareIntent({ op: "editExempt.set", paths: [] }, false))).toBe("NO_ERROR");
  });
});

describe("JEV switch, preset and budget", () => {
  const runtime = (jevEnabled: boolean) => ({ config: { jevEnabled, mode: "select" } });

  it("is off by default and turns on only by a signed switch inside what the installation allows", () => {
    const { service, owner } = setup();
    const signed = () => service.verifiedState()?.jev ?? null;
    expect(applyAdminJev(runtime(true), signed()).config.jevEnabled).toBe(false);
    signAndCommit(service, owner, { op: "jev.set", enabled: true, limitUsd: 2, presets: { "skill-classification": true } });
    expect(applyAdminJev(runtime(true), signed()).config.jevEnabled).toBe(true);
    // The installation's config can still turn it off: the narrower of the two applies.
    expect(applyAdminJev(runtime(false), signed()).config.jevEnabled).toBe(false);
    signAndCommit(service, owner, { op: "jev.set", enabled: true, limitUsd: 2, presets: { "skill-classification": false } });
    expect(applyAdminJev(runtime(true), signed()).config.jevEnabled).toBe(false);
  });

  it("keeps the last valid switch when the newer record's signer was rewritten in the file", () => {
    const { service, owner, file } = setup();
    signAndCommit(service, owner, { op: "jev.set", enabled: true, limitUsd: 1, presets: {} });
    const off = signAndCommit(service, owner, { op: "jev.set", enabled: false, limitUsd: 1, presets: {} }).record;
    // Rewrite the newer record's signer in the file: the fold refuses it and runs on the earlier "on".
    sql(file, "UPDATE admin_log SET credential_id = 'someone-else' WHERE seq = ?", off.seq);
    expect(service.verifiedState()?.jev).toMatchObject({ enabled: true });
    expect(service.load("codex", "s").failures).toMatchObject([{ layer: "jev" }]);
  });

  it(`refuses an unknown preset (${coversReason("JEV_PRESET_UNKNOWN")}) and a budget over the cap`, () => {
    const { service } = setup();
    expect(adminCode(() => service.prepareIntent({ op: "jev.set", enabled: true, limitUsd: null, presets: { "made-up": true } }, false)))
      .toBe("ADMIN_CHANGE_INVALID/JEV_PRESET_UNKNOWN");
    expect(adminCode(() => service.prepareIntent({ op: "jev.set", enabled: true, limitUsd: JEV_BUDGET_MAX_USD + 0.01, presets: {} }, false))).toBe("ADMIN_CHANGE_INVALID");
    expect(adminCode(() => service.prepareIntent({ op: "jev.set", enabled: true, limitUsd: -1, presets: {} }, false))).toBe("ADMIN_CHANGE_INVALID");
  });

  it("reserves within the narrower of the installation's and the signed budget, read at each reservation", () => {
    const profile = { profileId: "p", providerKind: "jev", vendorId: "v" } as ProviderProfile;
    let signed: number | null = 1;
    // An installation with no budget: the signed one counts from zero in this process.
    const budget = new InMemoryClassificationBudget({ jev: { limitUsd: null, spentUsd: null }, vendors: {}, jevSignedLimitUsd: () => signed });
    expect(budget.reserve(profile, "r1", 0.6)).toBe(true);
    expect(budget.reserve(profile, "r2", 0.6)).toBe(false);
    signed = 2;
    expect(budget.reserve(profile, "r2", 0.6)).toBe(true);
    signed = null;
    expect(budget.reserve(profile, "r3", 0.1)).toBe(false);
    // An installation limit bounds a larger signed one.
    const bounded = new InMemoryClassificationBudget({ jev: { limitUsd: 0.5, spentUsd: 0 }, vendors: {}, jevSignedLimitUsd: () => 3 });
    expect(bounded.reserve(profile, "b1", 0.6)).toBe(false);
    expect(bounded.reserve(profile, "b2", 0.4)).toBe(true);
    // An installation limit with an unknown spent amount still refuses, as before the page.
    expect(new InMemoryClassificationBudget({ jev: { limitUsd: 3, spentUsd: null }, vendors: {}, jevSignedLimitUsd: () => 3 }).reserve(profile, "u", 0.1)).toBe(false);
    expect(jevBudgetLimit(null, null)).toBeNull();
    expect(jevBudgetLimit(4, 9)).toBe(4);
  });

  it("shows the page the switch, the presets, the budget and this process's tally without any key value", () => {
    const { service, owner, environment } = setup();
    signAndCommit(service, owner, { op: "jev.set", enabled: true, limitUsd: 3, presets: {} });
    registerKey(service, owner, "JEV_FIXTURE_KEY", "sk-fixture-value-1");
    const installation: JevInstallationView = { configured: true, allows: true, mode: "select", profileCount: 1, limitUsd: 4,
      credentials: [{ name: "JEV_FIXTURE_KEY", vendorIds: ["vendor-a"] }, { name: "JEV_ENV_KEY", vendorIds: ["vendor-b"] }], error: null };
    const view = adminSettingsView({ environment: { ...environment, JEV_ENV_KEY: "from-env" }, signed: service.adminState().signedSettings,
      locale: { value: "ko", source: "root" }, localeOptions: ["ko", "en"], installation, usage: { spentUsd: 0.25, reservedUsd: 0.1 } });
    expect(view.jev).toMatchObject({ enabled: true, switchOn: true, presets: [{ presetId: "skill-classification", enabled: true }],
      budget: { installationLimitUsd: 4, signedLimitUsd: 3, limitUsd: 3, maxUsd: JEV_BUDGET_MAX_USD }, usage: { spentUsd: 0.25, reservedUsd: 0.1 } });
    expect(view.jev.keys).toMatchObject([{ name: "JEV_ENV_KEY", fingerprint: null, environment: true }, { name: "JEV_FIXTURE_KEY", stored: true,
      fingerprint: jevKeyFingerprint("sk-fixture-value-1"), environment: false }]);
    expect(JSON.stringify(view)).not.toContain("sk-fixture-value-1");
    expect(JSON.stringify(view)).not.toContain("from-env");
    expect(adminSettingsView({ environment, signed: service.adminState().signedSettings, locale: { value: "ko", source: "root" }, localeOptions: ["ko"],
      installation: { ...installation, allows: false }, usage: null }).jev).toMatchObject({ enabled: false, lockedBy: "AGENT_GOVERNANCE_CLASSIFICATION_CONFIG" });
  });
});

describe("JEV keys: fingerprint signed, value encrypted", () => {
  it("stores the value encrypted, gives it back only through the verified record, and never shows it", () => {
    const { service, owner, file, directory } = setup();
    registerKey(service, owner, "JEV_FIXTURE_KEY", "sk-fixture-value-1");
    expect(service.jevKey("JEV_FIXTURE_KEY")).toBe("sk-fixture-value-1");
    expect(service.jevKey("OTHER")).toBeNull();
    // Neither the log, the stored row nor the page state holds the value.
    const stored = JSON.stringify(rows(file, "SELECT * FROM jev_keys")) + JSON.stringify(rows(file, "SELECT * FROM admin_log"));
    expect(stored).not.toContain("sk-fixture-value-1");
    expect(readFileSync(file).includes(Buffer.from("sk-fixture-value-1"))).toBe(false);
    expect(JSON.stringify(service.adminState())).not.toContain("sk-fixture-value-1");
    expect(service.adminState().signedSettings.jevKeys).toMatchObject([{ name: "JEV_FIXTURE_KEY", fingerprint: jevKeyFingerprint("sk-fixture-value-1"), stored: true }]);
    // Replacing it keeps one row; deleting it removes the row and the key.
    registerKey(service, owner, "JEV_FIXTURE_KEY", "sk-fixture-value-2");
    expect(service.jevKey("JEV_FIXTURE_KEY")).toBe("sk-fixture-value-2");
    signAndCommit(service, owner, { op: "jevKey.delete", name: "JEV_FIXTURE_KEY" });
    expect(service.jevKey("JEV_FIXTURE_KEY")).toBeNull();
    expect(rows(file, "SELECT name FROM jev_keys")).toEqual([]);
    expect(directory).toBeTruthy();
  });

  it(`refuses a value that does not match the signed fingerprint (${coversReason("JEV_KEY_FINGERPRINT_MISMATCH")}), a value with another change (${coversReason("SECRET_UNEXPECTED")}) and an unknown deletion (${coversReason("JEV_KEY_NOT_FOUND")})`, () => {
    const { service, owner, file } = setup();
    expect(adminCode(() => registerKey(service, owner, "JEV_FIXTURE_KEY", "sk-other", "sk-signed"))).toBe("ADMIN_CHANGE_INVALID/JEV_KEY_FINGERPRINT_MISMATCH");
    expect(adminCode(() => registerKey(service, owner, "JEV_FIXTURE_KEY", null, "sk-signed"))).toBe("ADMIN_CHANGE_INVALID/JEV_KEY_FINGERPRINT_MISMATCH");
    const prepared = service.prepareIntent({ op: "global.set", body: "x" }, false);
    expect(adminCode(() => service.commit({ intent: prepared.intent, assertion: owner.assert(prepared.intent), requestId: randomUUID(), proposalId: null, secret: "sk-1" })))
      .toBe("ADMIN_CHANGE_INVALID/SECRET_UNEXPECTED");
    expect(adminCode(() => service.prepareIntent({ op: "jevKey.delete", name: "NEVER_REGISTERED" }, false))).toBe("ADMIN_CHANGE_INVALID/JEV_KEY_NOT_FOUND");
    expect(rows(file, "SELECT name FROM jev_keys")).toEqual([]);
    expect(service.adminState().signedSettings.jevKeys).toEqual([]);
  });

  it(`refuses a key registration when no vault is configured (${coversReason("JEV_KEY_VAULT_UNAVAILABLE")})`, () => {
    const { file, owner } = setup();
    const noVault = new ContextLayerService(create => ContextLayerStore.open(file, create), undefined, null);
    expect(adminCode(() => registerKey(noVault, owner, "JEV_FIXTURE_KEY", "sk-fixture"))).toBe("ADMIN_CHANGE_INVALID/JEV_KEY_VAULT_UNAVAILABLE");
  });

  it("does not give a ciphertext moved to another name, a value under a forged fingerprint, or one without its data key", () => {
    const { service, owner, file, directory, vault } = setup();
    registerKey(service, owner, "KEY_A", "sk-value-a");
    registerKey(service, owner, "KEY_B", "sk-value-b");
    sql(file, "UPDATE jev_keys SET sealed = (SELECT sealed FROM jev_keys WHERE name = 'KEY_A'), fingerprint = (SELECT fingerprint FROM jev_keys WHERE name = 'KEY_A') WHERE name = 'KEY_B'");
    // The row's fingerprint no longer matches the signed one for KEY_B: not used.
    expect(service.jevKey("KEY_B")).toBeNull();
    // KEY_A's row now claims KEY_B's signed fingerprint: it no longer matches KEY_A's signed record, so it is not used.
    sql(file, "UPDATE jev_keys SET fingerprint = ? WHERE name = 'KEY_A'", jevKeyFingerprint("sk-value-b"));
    expect(() => vault.open("KEY_B", jevKeyFingerprint("sk-value-b"), String(rows(file, "SELECT sealed FROM jev_keys WHERE name = 'KEY_A'")[0]!.sealed)))
      .toThrow(JevKeyVaultError);
    expect(service.jevKey("KEY_A")).toBeNull();
    rmSync(path.join(directory, "jev-key-vault.bin"));
    registerKey(service, owner, "KEY_C", "sk-value-c");
    rmSync(path.join(directory, "jev-key-vault.bin"));
    expect(() => service.jevKey("KEY_C")).toThrow(JevKeyVaultError);
  });

  it("archives the keys with the log on reset", () => {
    const { service, owner, file } = setup();
    registerKey(service, owner, "JEV_FIXTURE_KEY", "sk-fixture-value-1");
    service.reset();
    expect(rows(file, "SELECT name FROM jev_keys")).toEqual([]);
    expect(service.jevKey("JEV_FIXTURE_KEY")).toBeNull();
  });
});

describe("shared file schema and the page", () => {
  it("upgrades a version 1 file in place and keeps its records", () => {
    const directory = stateDirectory();
    const file = path.join(directory, "context-layers.sqlite3");
    const database = new DatabaseSync(file);
    const log = `seq INTEGER PRIMARY KEY AUTOINCREMENT, target TEXT NOT NULL, intent TEXT NOT NULL, credential_id TEXT NOT NULL,
      authenticator_data TEXT NOT NULL, client_data_json TEXT NOT NULL, signature TEXT NOT NULL, record_hash TEXT NOT NULL, request_id TEXT, created_at TEXT NOT NULL`;
    database.exec(`CREATE TABLE admin_log (${log}) STRICT; CREATE TABLE admin_log_archive (x TEXT) STRICT; CREATE TABLE admin_resets (id INTEGER) STRICT;
      CREATE TABLE admin_proposals (id TEXT) STRICT; CREATE TABLE role_contexts (role_id TEXT) STRICT; CREATE TABLE role_context_history (id INTEGER) STRICT;
      CREATE TABLE session_seen (host TEXT) STRICT; CREATE TABLE context_deliveries (actor_id TEXT) STRICT;
      INSERT INTO role_contexts VALUES ('kept'); PRAGMA user_version = 1;`);
    database.close();
    ContextLayerStore.open(file, false)!.close();
    expect(rows(file, "SELECT name FROM sqlite_schema WHERE name = 'jev_keys'")).toHaveLength(1);
    expect(rows(file, "PRAGMA user_version")).toEqual([{ user_version: 2 }]);
    expect(rows(file, "SELECT role_id FROM role_contexts")).toEqual([{ role_id: "kept" }]);
  });

  it("announces a failed setting record to the agent at the hook, by name", () => {
    const { service, owner, file } = setup();
    const record = signAndCommit(service, owner, { op: "editExempt.set", paths: [path.resolve("notes")] }).record;
    sql(file, "UPDATE admin_log SET signature = 'AAAA' WHERE seq = ?", record.seq);
    const text = service.hookText("codex", "s", "codex:s", true)!.map(line => line.key);
    expect(text).toContain("hooks.contextLayers.verifyFailed");
    expect(service.load("codex", "s").failures).toMatchObject([{ layer: "editExempt", revision: null }]);
  });

  it("has a page message for every settings refusal reason", () => {
    expect([...SETTING_CHANGE_REASONS].filter(reason => !coveredReasons.has(reason))).toEqual([]);
    for (const reason of SETTING_CHANGE_REASONS) expect(ADMIN_PAGE_HTML).toContain(`${reason}:`);
  });

  it("names every settings change the page signs", () => {
    const ops: Array<AdminChange["op"]> = ["jev.set", "jevKey.set", "jevKey.delete", "locale.set", "editExempt.set"];
    for (const op of ops) expect(ADMIN_PAGE_HTML).toContain(`op: '${op}'`);
  });
});
