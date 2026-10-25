import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ open: vi.fn(), exec: vi.fn(), prepare: vi.fn(), close: vi.fn(),
  write: vi.fn<(fd: number, data: unknown) => number>(() => 0) }));
vi.mock("node:fs", async original => ({ ...await original<typeof import("node:fs")>(), writeSync: calls.write }));
vi.mock("node:sqlite", () => ({
  DatabaseSync: class {
    constructor(file: string, options?: { readOnly?: boolean }) { calls.open(file, options); }
    exec(sql: string) { return calls.exec(sql); }
    prepare(sql: string) { return calls.prepare(sql); }
    close() { return calls.close(); }
  },
}));
import { buildGlossaryDatabase, checkGlossaryDatabase, parseGlossarySeed, SqliteKoreanProseGlossary } from "../../mcp-server/src/korean-prose-glossary.js";
import { failureContext } from "../../mcp-server/src/failure-diagnostics.js";
import { InMemoryPluginUpdateStore } from "../../mcp-server/src/plugin-update-store.js";
import { PluginUpdateService } from "../../mcp-server/src/plugin-update-service.js";
import { FileSkillRegistry } from "../../mcp-server/src/registry.js";
import { ContractValidator } from "../../mcp-server/src/schema-validator.js";
import { createMcpServer } from "../../mcp-server/src/server.js";
import { WorkflowService } from "../../mcp-server/src/workflow-service.js";
import { InMemoryWorkflowStore } from "../../mcp-server/src/workflow-store.js";
import { CURRENT_VERSION } from "./version-fixtures.js";

// Only SQLite ports are controlled. No helper-call mocks or arbitrary primitive,
// saturated-history, reused-primary or function exceptions justify product layers.
const databasePath = "synthetic\0never-an-actual-database";
const metadata = { id: "synthetic-glossary", version: "fixture-v1" };
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const emptyDigest = hash("[]");
const sourceText = "일반 문장";
const request = { schemaVersion: "1.0.0" as const, sourceText, sourceDigest: hash(sourceText) };
const unavailable = { schemaVersion: "1.0.0", status: "unavailable", sourceDigest: request.sourceDigest,
  glossary: null, matches: [], matchSetDigest: null, warnings: ["GLOSSARY_UNAVAILABLE"] };
const stderr = calls.write;
beforeEach(() => {
  for (const fn of Object.values(calls)) fn.mockReset();
  calls.prepare.mockImplementation((sql: string) => ({
    run: vi.fn(), get: () => ({ integrity_check: "ok" }),
    all: () => sql === "SELECT key, value FROM metadata ORDER BY key"
      ? [{ key: "schemaVersion", value: "1.0.0" }, { key: "glossaryId", value: metadata.id },
        { key: "glossaryVersion", value: metadata.version }, { key: "contentDigest", value: emptyDigest }] : [],
  }));
  stderr.mockReturnValue(0);
});
afterEach(() => vi.restoreAllMocks());
const diagnosticText = () => stderr.mock.calls.map(call => String(call[1])).join("");
function diagnostic() {
  const lines = diagnosticText().trim().split(/\r?\n/u);
  expect(lines).toHaveLength(1);
  expect(stderr.mock.calls[0]?.[0]).toBe(2);
  return JSON.parse(lines[0]!);
}
function thrown(action: () => unknown) {
  let error: unknown; let failed = false;
  try { action(); } catch (cause) { failed = true; error = cause; }
  expect(failed).toBe(true);
  return error;
}
const sqliteError = (marker: string, errcode = 1) => Object.freeze(Object.assign(
  new Error(marker), { code: "ERR_SQLITE_ERROR", errcode }));
function buildFault(primary: Error, rollback?: Error) {
  calls.exec.mockImplementation((sql: string) => {
    if (sql.startsWith("CREATE TABLE metadata")) throw primary; // BEGIN already succeeded.
    if (sql === "ROLLBACK;" && rollback) throw rollback;
  });
}
function assertPrivate(text: string) {
  for (const marker of ["PRIVATE_PRIMARY", "PRIVATE_ROLLBACK", "PRIVATE_CLOSE", "PRIVATE_OPEN", "PRIVATE_SINK", databasePath]) {
    expect(text).not.toContain(marker);
  }
}

for (const operation of ["build", "check"] as const) {
  const invoke = () => operation === "build"
    ? buildGlossaryDatabase(databasePath, [], metadata) : checkGlossaryDatabase(databasePath, []);
  it(operation + " preserves normal values and attempts close once after acquisition", () => {
    const result = invoke();
    if (operation === "build") expect(result).toBeUndefined();
    else expect(result).toEqual({ ...metadata, contentDigest: emptyDigest });
    expect(calls.close).toHaveBeenCalledTimes(1);
    expect(stderr).not.toHaveBeenCalled();
  });
  it(operation + " preserves acquisition failure and never closes an unacquired handle", () => {
    const primary = sqliteError("PRIVATE_OPEN", 14);
    calls.open.mockImplementationOnce(() => { throw primary; });
    expect(thrown(invoke)).toBe(primary);
    expect(calls.exec).not.toHaveBeenCalled();
    expect(calls.close).not.toHaveBeenCalled();
  });
  it(operation + " preserves the exact fresh operation error when close succeeds", () => {
    const primary = sqliteError("PRIVATE_PRIMARY");
    if (operation === "build") buildFault(primary);
    else calls.exec.mockImplementationOnce(() => { throw primary; });
    expect(thrown(invoke)).toBe(primary);
    expect(calls.close).toHaveBeenCalledTimes(1);
    expect(Object.isFrozen(primary)).toBe(true);
  });
  it(operation + " cannot turn a close failure into success", () => {
    const close = sqliteError("PRIVATE_CLOSE", 21);
    calls.close.mockImplementationOnce(() => { throw close; });
    expect(thrown(invoke)).toBe(close);
    expect(calls.close).toHaveBeenCalledTimes(1);
  });
  it(operation + " retains the fresh primary and real close port failure together", () => {
    const primary = sqliteError("PRIVATE_PRIMARY");
    const close = sqliteError("PRIVATE_CLOSE", 21);
    if (operation === "build") buildFault(primary);
    else calls.exec.mockImplementationOnce(() => { throw primary; });
    calls.close.mockImplementationOnce(() => { throw close; });
    expect(thrown(invoke)).toBe(primary);
    expect(failureContext(primary)).toMatchObject({
      producerReason: operation === "build" ? "GLOSSARY_BUILD_FAILED" : "GLOSSARY_LOAD_FAILED",
      secondary: [{ producerReason: "GLOSSARY_CLOSE_FAILED", sqlite: { errcode: 21, primaryCode: 21 } }],
    });
    expect(calls.close).toHaveBeenCalledTimes(1);
    // Throwing library boundaries retain errors for their caller; only terminal consumers print.
    expect(stderr).not.toHaveBeenCalled();
  });
}

it("build retains rollback and close in the existing two-secondary context without printing", () => {
  const primary = sqliteError("PRIVATE_PRIMARY", 19);
  const rollback = sqliteError("PRIVATE_ROLLBACK", 1);
  const close = sqliteError("PRIVATE_CLOSE", 21);
  buildFault(primary, rollback);
  calls.close.mockImplementationOnce(() => { throw close; });
  expect(thrown(() => buildGlossaryDatabase(databasePath, [], metadata))).toBe(primary);
  expect(calls.exec.mock.calls.filter(call => call[0] === "ROLLBACK;")).toHaveLength(1);
  expect(calls.close).toHaveBeenCalledTimes(1);
  const context = failureContext(primary);
  expect(context).toMatchObject({ producerReason: "GLOSSARY_BUILD_FAILED",
    sqlite: { errcode: 19, primaryCode: 19 }, secondary: [
      { producerReason: "GLOSSARY_ROLLBACK_FAILED", sqlite: { errcode: 1, primaryCode: 1 } },
      { producerReason: "GLOSSARY_CLOSE_FAILED", sqlite: { errcode: 21, primaryCode: 21 } },
    ] });
  expect(stderr).not.toHaveBeenCalled();
});

it("a throwing build never writes diagnostics before its terminal caller handles failure", () => {
  const primary = sqliteError("PRIVATE_PRIMARY");
  buildFault(primary, sqliteError("PRIVATE_ROLLBACK"));
  calls.close.mockImplementationOnce(() => { throw sqliteError("PRIVATE_CLOSE", 21); });
  stderr.mockImplementation(() => { throw new Error("PRIVATE_SINK"); });
  expect(thrown(() => buildGlossaryDatabase(databasePath, [], metadata))).toBe(primary);
  expect(calls.close).toHaveBeenCalledTimes(1);
  expect(calls.exec.mock.calls.filter(call => call[0] === "ROLLBACK;")).toHaveLength(1);
  expect(stderr).not.toHaveBeenCalled();
});

async function connect() {
  const validator = new ContractValidator();
  const registryPath = fileURLToPath(new URL("../../skills/registry.json", import.meta.url));
  const service = new WorkflowService(new FileSkillRegistry(registryPath, validator), validator, new InMemoryWorkflowStore());
  const updates = new InMemoryPluginUpdateStore();
  updates.putPluginUpdateState({ targetId: "agent-governance-suite", currentVersion: CURRENT_VERSION,
    latestVersion: CURRENT_VERSION, latestTag: "v" + CURRENT_VERSION, latestCommit: "c".repeat(40),
    etag: "glossary-failure-fixture", comparison: "up-to-date", lastAttemptAt: "2026-10-01T00:00:00.000Z",
    lastSuccessfulCheckAt: "2026-10-01T00:00:00.000Z", nextCheckAt: "2099-01-01T00:00:00.000Z",
    lastNotifiedVersion: null, lastNotifiedAt: null, lastErrorCode: null });
  const server = createMcpServer(service, new PluginUpdateService(updates), undefined, undefined,
    new SqliteKoreanProseGlossary(databasePath), validator);
  const client = new Client({ name: "glossary-failure-fixture", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
}
async function lookupMcp() {
  const { client, server } = await connect();
  try {
    const response = await client.callTool({ name: "lookup_korean_prose_terms", arguments: request });
    const content = response.content as Array<{ type: string; text?: string }>;
    return JSON.parse(content.find(item => item.type === "text")!.text!);
  } finally { await client.close(); await server.close(); }
}

it("actual MCP lookup keeps missing storage unavailable while reporting the original open failure on stderr", async () => {
  const primary = sqliteError("PRIVATE_OPEN", 14);
  calls.open.mockImplementationOnce(() => { throw primary; });
  const response = await lookupMcp();
  expect(response).toMatchObject({ ok: true, data: unavailable, error: null });
  expect(diagnostic()).toEqual({ component: "korean-prose-glossary", phase: "lookup",
    reason: "GLOSSARY_UNAVAILABLE", context: failureContext(primary) });
  expect(calls.close).not.toHaveBeenCalled();
  expect(response.data).not.toHaveProperty("context");
  assertPrivate(diagnosticText() + JSON.stringify(response));
});

it("actual MCP lookup reports a query primary plus close while preserving the unchanged fail-open response", async () => {
  const primary = sqliteError("PRIVATE_PRIMARY", 11);
  const close = sqliteError("PRIVATE_CLOSE", 21);
  calls.exec.mockImplementationOnce(() => { throw primary; });
  calls.close.mockImplementationOnce(() => { throw close; });
  const response = await lookupMcp();
  expect(response).toMatchObject({ ok: true, data: unavailable, error: null });
  expect(diagnostic()).toMatchObject({ component: "korean-prose-glossary", phase: "lookup",
    context: { producerReason: "GLOSSARY_LOAD_FAILED",
      secondary: [{ producerReason: "GLOSSARY_CLOSE_FAILED" }] } });
  expect(calls.close).toHaveBeenCalledTimes(1);
  assertPrivate(diagnosticText() + JSON.stringify(response));
});

it("actual MCP lookup stays unavailable if the safe diagnostic sink itself fails", async () => {
  calls.exec.mockImplementationOnce(() => { throw sqliteError("PRIVATE_PRIMARY", 11); });
  stderr.mockImplementation(() => { throw new Error("PRIVATE_SINK"); });
  const response = await lookupMcp();
  expect(response).toMatchObject({ ok: true, data: unavailable, error: null });
  expect(calls.close).toHaveBeenCalledTimes(1);
  expect(stderr).toHaveBeenCalledTimes(1);
});

it("actual MCP lookup retains a normal no-match response without failure diagnostics", async () => {
  const response = await lookupMcp();
  expect(response).toMatchObject({ ok: true, error: null,
    data: { schemaVersion: "1.0.0", status: "no-match", sourceDigest: request.sourceDigest,
      glossary: { ...metadata, contentDigest: emptyDigest }, matches: [], warnings: [] } });
  expect(stderr).not.toHaveBeenCalled();
  expect(calls.close).toHaveBeenCalledTimes(1);
});

it.each([
  ["integrity", "GLOSSARY_INTEGRITY_FAILED"],
  ["metadata", "GLOSSARY_METADATA_INVALID"],
  ["digest", "GLOSSARY_DIGEST_STALE"],
])("actual MCP lookup reports the %s validation stage while preserving unavailable", async (mode, reason) => {
  const normal = calls.prepare.getMockImplementation()!;
  calls.prepare.mockImplementation((sql: string) => {
    const statement = normal(sql);
    if (mode === "integrity" && sql === "PRAGMA integrity_check") return { ...statement, get: () => ({ integrity_check: "not-ok" }) };
    if (mode === "metadata" && sql === "SELECT key, value FROM metadata ORDER BY key") return { ...statement, all: () => [] };
    if (mode === "digest" && sql === "SELECT key, value FROM metadata ORDER BY key") {
      return { ...statement, all: () => statement.all().map((row: { key: string; value: string }) =>
        row.key === "contentDigest" ? { ...row, value: "f".repeat(64) } : row) };
    }
    return statement;
  });
  const response = await lookupMcp();
  expect(response).toMatchObject({ ok: true, data: unavailable, error: null });
  expect(diagnostic()).toMatchObject({ component: "korean-prose-glossary", phase: "lookup",
    reason, context: { type: "error", producerReason: reason } });
  expect(calls.close).toHaveBeenCalledTimes(1);
  assertPrivate(diagnosticText() + JSON.stringify(response));
});

it("public check retains its load and close causes for the caller without printing", () => {
  const primary = sqliteError("PRIVATE_PRIMARY", 11);
  calls.exec.mockImplementationOnce(() => { throw primary; });
  calls.close.mockImplementationOnce(() => { throw sqliteError("PRIVATE_CLOSE", 21); });
  stderr.mockImplementation(() => { throw new Error("PRIVATE_SINK"); });
  expect(thrown(() => checkGlossaryDatabase(databasePath, []))).toBe(primary);
  expect(calls.close).toHaveBeenCalledTimes(1);
  expect(stderr).not.toHaveBeenCalled();
  expect(failureContext(primary)).toMatchObject({ producerReason: "GLOSSARY_LOAD_FAILED",
    secondary: [{ producerReason: "GLOSSARY_CLOSE_FAILED" }] });
});

it("public check identifies reviewed seed mismatch after a successful read without logging or returning metadata", () => {
  const mismatched = parseGlossarySeed(JSON.stringify({ entryId: "reviewed", canonicalForm: "검토", policy: "protect",
    sourceRef: "https://example.invalid/reviewed", priority: 1, active: true, forms: [{ form: "검토", kind: "canonical" }] }));
  const error = thrown(() => checkGlossaryDatabase(databasePath, mismatched));
  expect(failureContext(error)).toMatchObject({ producerReason: "GLOSSARY_SEED_MISMATCH" });
  expect(calls.close).toHaveBeenCalledTimes(1);
  expect(stderr).not.toHaveBeenCalled();
});
