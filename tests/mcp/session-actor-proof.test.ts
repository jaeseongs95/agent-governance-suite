import { createHmac } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { WorkflowContractError } from "../../contracts/types.js";
import * as board from "../../skills/session-board/scripts/board-store.mjs";
import { UnavailableContinuityService } from "../../mcp-server/src/continuity-service.js";
import type { ActorObservation, InputObservation } from "../../mcp-server/src/input-observation.js";
import { UnavailableKoreanProseGlossary } from "../../mcp-server/src/korean-prose-glossary.js";
import { InMemoryPluginUpdateStore } from "../../mcp-server/src/plugin-update-store.js";
import { PluginUpdateService } from "../../mcp-server/src/plugin-update-service.js";
import { FileSkillRegistry } from "../../mcp-server/src/registry.js";
import { ContractValidator } from "../../mcp-server/src/schema-validator.js";
import { assertDistinctDatabasePaths } from "../../mcp-server/src/runtime-config.js";
import { createMcpServer } from "../../mcp-server/src/server.js";
import { SESSION_PROOF_FIELD, SessionActorProofs } from "../../mcp-server/src/session-actor-proof.js";
import { SessionMessageService } from "../../mcp-server/src/session-message-service.js";
import { SqliteWorkflowStore } from "../../mcp-server/src/sqlite-workflow-store.js";
import { TrustService } from "../../mcp-server/src/trust-service.js";
import { TrustStore } from "../../mcp-server/src/trust-store.js";
import { WorkflowService } from "../../mcp-server/src/workflow-service.js";
import { InMemoryWorkflowStore } from "../../mcp-server/src/workflow-store.js";
import { CURRENT_VERSION } from "./version-fixtures.js";
import { concurrentClaims } from "../helpers/concurrent-claim-process.js";

// IO spies start with real implementations; the denial test makes them fail fast.
// The verifier is always the real SessionActorProofs implementation.
vi.mock("node:fs", async importOriginal => {
  const original = await importOriginal<typeof import("node:fs")>();
  return { ...original, existsSync: vi.fn(original.existsSync) };
});
vi.mock("../../skills/session-board/scripts/board-store.mjs", async importOriginal => {
  const original = await importOriginal<typeof import("../../skills/session-board/scripts/board-store.mjs")>();
  return {
    ...original,
    openBoard: vi.fn(original.openBoard),
    listSessions: vi.fn(original.listSessions),
    readSession: vi.fn(original.readSession),
  };
});

const NOW = Date.parse("2026-10-27T00:00:00.000Z");
const TTL = 300_000;
const registryPath = fileURLToPath(new URL("../../skills/registry.json", import.meta.url));
const directories: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function ownedDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "session-actor-proof-owned-"));
  directories.push(directory);
  return directory;
}

/** Fake core adapter output, never native host/process identity collection. */
function fakeObservation(overrides: Partial<InputObservation> = {}): InputObservation {
  return {
    host: "fixture-host", sessionId: "fixture-root", callId: "fixture-call",
    kind: "tool-boundary", boundaryPhase: "before",
    actor: { role: "root", basis: "observed", reasonCode: "FIXTURE_ROOT_OBSERVED" },
    ...overrides,
  };
}

function withProof(proofs: SessionActorProofs, tool: string, args: Record<string, unknown> = {}, observation = fakeObservation()): Record<string, unknown> {
  return { ...args, [SESSION_PROOF_FIELD]: proofs.issue(observation, tool, args) };
}

function expectContractFailure(action: () => unknown, code: string, reasonCode: string): void {
  let failure: unknown;
  try { action(); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(WorkflowContractError);
  expect(failure).toMatchObject({ code, details: { reasonCode } });
}

function tamperSignature(token: string): string {
  const [prefix, payload, signature] = token.split(".");
  if (!prefix || !payload || !signature) throw new Error("Fixture proof is malformed.");
  return `${prefix}.${payload}.${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`;
}

function tamperSession(token: string): string {
  const [prefix, payload, signature] = token.split(".");
  if (!prefix || !payload || !signature) throw new Error("Fixture proof is malformed.");
  const body = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
  body.sessionId = "different-fixture-session";
  return `${prefix}.${Buffer.from(JSON.stringify(body)).toString("base64url")}.${signature}`;
}

describe("session actor proof issuance", () => {
  it.each(["observed", "inferred"] as const)("accepts root %s from a fake core adapter through the actual issuer", basis => {
    const proofs = new SessionActorProofs(new InMemoryWorkflowStore(), () => NOW);
    const actor: ActorObservation = { role: "root", basis, reasonCode: `FIXTURE_ROOT_${basis.toUpperCase()}` };
    const observation = fakeObservation({ actor });
    expect(proofs.verify("get_trust_capabilities", withProof(proofs, "get_trust_capabilities", {}, observation)))
      .toEqual({ host: observation.host, sessionId: observation.sessionId, actor });
  });

  it.each([
    { role: "child", basis: "observed", reasonCode: "FIXTURE_CHILD_OBSERVED" },
    { role: "child", basis: "inferred", reasonCode: "FIXTURE_CHILD_INFERRED" },
    { role: "indeterminate", basis: "observed", reasonCode: "FIXTURE_INDETERMINATE_OBSERVED" },
    { role: "indeterminate", basis: "unavailable", reasonCode: "FIXTURE_INDETERMINATE_UNAVAILABLE" },
    { role: "root", basis: "unavailable", reasonCode: "FIXTURE_ROOT_UNAVAILABLE" },
  ] satisfies ActorObservation[])("issues zero proofs for $role/$basis and touches no proof store state", actor => {
    const store = new InMemoryWorkflowStore();
    const key = vi.spyOn(store, "getOrCreateSecret");
    const claim = vi.spyOn(store, "claimExecutionObservation");
    const proofs = new SessionActorProofs(store, () => NOW);
    const issued: string[] = [];
    expectContractFailure(() => issued.push(proofs.issue(fakeObservation({ actor }), "get_trust_capabilities", {})), "BINDING_INVALID", actor.reasonCode);
    expect(issued).toEqual([]);
    expect(key).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
  });
});

describe("session actor proof call identity", () => {
  it.each([undefined, ""])("rejects missing/empty callId before reading the signing key", callId => {
    const store = new InMemoryWorkflowStore();
    const key = vi.spyOn(store, "getOrCreateSecret");
    const observation = fakeObservation();
    if (callId === undefined) delete observation.callId;
    else observation.callId = callId;
    expectContractFailure(() => new SessionActorProofs(store, () => NOW).issue(observation, "get_trust_capabilities", {}), "BINDING_INVALID", "ROOT_CALL_ID_MISSING");
    expect(key).not.toHaveBeenCalled();
  });

  it("rejects a legacy caller binding at issuance and verification even with a genuine proof", () => {
    const proofs = new SessionActorProofs(new InMemoryWorkflowStore(), () => NOW);
    const legacy = { _sessionBinding: { host: "fixture-host", sessionId: "claimed-session" } };
    expectContractFailure(() => proofs.issue(fakeObservation(), "get_trust_capabilities", legacy), "BINDING_INVALID", "CALLER_SESSION_BINDING_REJECTED");
    const genuine = withProof(proofs, "get_trust_capabilities");
    expectContractFailure(() => proofs.verify("get_trust_capabilities", { ...genuine, ...legacy }), "BINDING_INVALID", "CALLER_SESSION_BINDING_REJECTED");
    expect(proofs.verify("get_trust_capabilities", genuine).sessionId).toBe("fixture-root");
  });

  it("requires the current proof instead of treating caller identity fields as evidence", () => {
    const proofs = new SessionActorProofs(new InMemoryWorkflowStore(), () => NOW);
    expectContractFailure(() => proofs.verify("get_trust_capabilities", {}), "BINDING_REQUIRED", "ROOT_HOOK_PROOF_REQUIRED");
  });
});

describe("session actor proof scope", () => {
  it.each(["signature", "signed-session"] as const)("rejects %s mutation without consuming the genuine token", mutation => {
    const proofs = new SessionActorProofs(new InMemoryWorkflowStore(), () => NOW);
    const genuine = withProof(proofs, "get_trust_capabilities");
    const token = genuine[SESSION_PROOF_FIELD] as string;
    const changed = mutation === "signature" ? tamperSignature(token) : tamperSession(token);
    expectContractFailure(() => proofs.verify("get_trust_capabilities", { [SESSION_PROOF_FIELD]: changed }), "BINDING_INVALID", "ROOT_PROOF_SIGNATURE_INVALID");
    expect(proofs.verify("get_trust_capabilities", genuine).sessionId).toBe("fixture-root");
  });

  it("rejects a different tool and arguments, including a different target session", () => {
    const proofs = new SessionActorProofs(new InMemoryWorkflowStore(), () => NOW);
    const args = { schemaVersion: "1.0.0", targetSessionId: "session-a", value: 1 };
    const genuine = withProof(proofs, "fixture-operation", args);
    for (const [tool, changed] of [
      ["another-operation", genuine],
      ["fixture-operation", { ...genuine, value: 2 }],
      ["fixture-operation", { ...genuine, targetSessionId: "session-b" }],
    ] as const) {
      expectContractFailure(() => proofs.verify(tool, changed), "BINDING_INVALID", "ROOT_PROOF_SCOPE_OR_TIME_INVALID");
    }
    expect(proofs.verify("fixture-operation", genuine).sessionId).toBe("fixture-root");
  });

  it.each([[-1, false], [0, true], [TTL - 1, true], [TTL, false], [TTL + 1, false]] as const)("checks the fixed-clock boundary at offset %i", (offset, allowed) => {
    let now = NOW;
    const proofs = new SessionActorProofs(new InMemoryWorkflowStore(), () => now);
    const genuine = withProof(proofs, "get_trust_capabilities");
    now = NOW + offset;
    if (allowed) expect(proofs.verify("get_trust_capabilities", genuine).sessionId).toBe("fixture-root");
    else expectContractFailure(() => proofs.verify("get_trust_capabilities", genuine), "BINDING_INVALID", "ROOT_PROOF_SCOPE_OR_TIME_INVALID");
  });

  it("consumes a call nonce once, including reissued tokens with different arguments", () => {
    const proofs = new SessionActorProofs(new InMemoryWorkflowStore(), () => NOW);
    const genuine = withProof(proofs, "fixture-operation", { value: 1 });
    proofs.verify("fixture-operation", genuine);
    expectContractFailure(() => proofs.verify("fixture-operation", genuine), "BINDING_INVALID", "ROOT_PROOF_ALREADY_CONSUMED");
    const reissued = withProof(proofs, "fixture-operation", { value: 2 });
    expectContractFailure(() => proofs.verify("fixture-operation", reissued), "BINDING_INVALID", "ROOT_PROOF_ALREADY_CONSUMED");
    expect(proofs.verify("fixture-operation", withProof(proofs, "fixture-operation", {}, fakeObservation({ callId: "another-call" })))).toMatchObject({ sessionId: "fixture-root" });
  });

  it("keeps identical call IDs in different sessions and hosts independent", () => {
    const proofs = new SessionActorProofs(new InMemoryWorkflowStore(), () => NOW);
    for (const observation of [fakeObservation(), fakeObservation({ sessionId: "another-session" }), fakeObservation({ host: "another-host" })]) {
      expect(proofs.verify("get_trust_capabilities", withProof(proofs, "get_trust_capabilities", {}, observation)))
        .toMatchObject({ host: observation.host, sessionId: observation.sessionId });
    }
  });
});

describe("session actor proof rejection diagnostics", () => {
  function rejectionDetails(action: () => unknown) {
    let failure: unknown;
    try { action(); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(WorkflowContractError);
    expect(failure).toMatchObject({ code: "BINDING_INVALID", message: "The current root hook proof is invalid." });
    return (failure as WorkflowContractError).details;
  }

  // Fixture-only mutation: the genuine token and existing key come from the real issuer/store.
  function resign(store: InMemoryWorkflowStore, genuine: Record<string, unknown>, patch: Record<string, unknown>) {
    const [prefix, encoded] = (genuine[SESSION_PROOF_FIELD] as string).split(".");
    const payload = JSON.parse(Buffer.from(encoded!, "base64url").toString("utf8")) as Record<string, unknown>;
    const body = `${prefix}.${Buffer.from(JSON.stringify({ ...payload, ...patch })).toString("base64url")}`;
    const secret = store.getOrCreateSecret("governance-root-call-key-v3", () => { throw new Error("Fixture signing key must already exist."); });
    const signature = createHmac("sha256", Buffer.from(secret, "base64url")).update(body).digest("base64url");
    return { ...genuine, [SESSION_PROOF_FIELD]: `${body}.${signature}` };
  }

  it.each([
    { offset: -1, tool: "fixture-operation", changeInput: false, failedCheck: "issuedInFuture",
      relativeTimeMs: { issuedAtMinusNow: 1, expiresAtMinusNow: "above-range", lifetimeMinusTtl: 0 } },
    { offset: TTL, tool: "fixture-operation", changeInput: false, failedCheck: "expired",
      relativeTimeMs: { issuedAtMinusNow: -TTL, expiresAtMinusNow: 0, lifetimeMinusTtl: 0 } },
    { offset: TTL + 1, tool: "fixture-operation", changeInput: false, failedCheck: "expired",
      relativeTimeMs: { issuedAtMinusNow: "below-range", expiresAtMinusNow: -1, lifetimeMinusTtl: 0 } },
    { offset: 0, tool: "another-operation", changeInput: false, failedCheck: "tool",
      relativeTimeMs: { issuedAtMinusNow: 0, expiresAtMinusNow: TTL, lifetimeMinusTtl: 0 } },
    { offset: 0, tool: "fixture-operation", changeInput: true, failedCheck: "inputDigest",
      relativeTimeMs: { issuedAtMinusNow: 0, expiresAtMinusNow: TTL, lifetimeMinusTtl: 0 } },
  ] as const)("reports only $failedCheck and bounded clock deltas at offset $offset without claiming", ({ offset, tool, changeInput, failedCheck, relativeTimeMs }) => {
    let now = NOW;
    const store = new InMemoryWorkflowStore();
    const claim = vi.spyOn(store, "claimExecutionObservation");
    const proofs = new SessionActorProofs(store, () => now);
    const genuine = withProof(proofs, "fixture-operation", { value: 1 });
    now += offset;
    expect(rejectionDetails(() => proofs.verify(tool, changeInput ? { ...genuine, value: 2 } : genuine))).toEqual({
      reasonCode: "ROOT_PROOF_SCOPE_OR_TIME_INVALID", failedChecks: [failedCheck], relativeTimeMs,
    });
    expect(claim).not.toHaveBeenCalled();
    now = NOW;
    expect(proofs.verify("fixture-operation", genuine).sessionId).toBe("fixture-root");
    expect(claim).toHaveBeenCalledTimes(1);
    expectContractFailure(() => proofs.verify("fixture-operation", genuine), "BINDING_INVALID", "ROOT_PROOF_ALREADY_CONSUMED");
  });

  it.each(["issuedInFuture", "tool"] as const)("preserves %s rejection before canonicalizing a non-serializable input", failedCheck => {
    let now = NOW;
    const store = new InMemoryWorkflowStore();
    const claim = vi.spyOn(store, "claimExecutionObservation");
    const proofs = new SessionActorProofs(store, () => now);
    const genuine = withProof(proofs, "fixture-operation");
    if (failedCheck === "issuedInFuture") now -= 1;
    expect(rejectionDetails(() => proofs.verify("another-operation", { ...genuine, nonSerializable: undefined }))).toEqual({
      reasonCode: "ROOT_PROOF_SCOPE_OR_TIME_INVALID", failedChecks: [failedCheck],
      relativeTimeMs: { issuedAtMinusNow: failedCheck === "issuedInFuture" ? 1 : 0,
        expiresAtMinusNow: failedCheck === "issuedInFuture" ? "above-range" : TTL, lifetimeMinusTtl: 0 },
    });
    expect(claim).not.toHaveBeenCalled();
    now = NOW;
    expect(proofs.verify("fixture-operation", genuine).sessionId).toBe("fixture-root");
  });

  it.each([
    { patch: { host: null }, failedCheck: "shape" },
    { patch: { issuedAt: null }, failedCheck: "shape" },
    { patch: { actor: { role: "child", basis: "observed", reasonCode: "FIXTURE_CHILD_OBSERVED" } }, failedCheck: "actorInput" },
  ])("reports $failedCheck without scope/time metadata for a signed invalid shape or actor", ({ patch, failedCheck }) => {
    const store = new InMemoryWorkflowStore();
    const claim = vi.spyOn(store, "claimExecutionObservation");
    const proofs = new SessionActorProofs(store, () => NOW);
    const genuine = withProof(proofs, "fixture-operation");
    expect(rejectionDetails(() => proofs.verify("fixture-operation", resign(store, genuine, patch)))).toEqual({
      reasonCode: "ROOT_PROOF_SCOPE_OR_TIME_INVALID", failedChecks: [failedCheck],
    });
    expect(claim).not.toHaveBeenCalled();
    expect(proofs.verify("fixture-operation", genuine).sessionId).toBe("fixture-root");
  });

  it("keeps the exact TTL equality guard and reports only its relative deviation", () => {
    const store = new InMemoryWorkflowStore();
    const claim = vi.spyOn(store, "claimExecutionObservation");
    const proofs = new SessionActorProofs(store, () => NOW);
    const genuine = withProof(proofs, "fixture-operation");
    expect(rejectionDetails(() => proofs.verify("fixture-operation", resign(store, genuine, { expiresAt: NOW + TTL + 1 })))).toEqual({
      reasonCode: "ROOT_PROOF_SCOPE_OR_TIME_INVALID", failedChecks: ["ttl"],
      relativeTimeMs: { issuedAtMinusNow: 0, expiresAtMinusNow: "above-range", lifetimeMinusTtl: 1 },
    });
    expect(claim).not.toHaveBeenCalled();
    expect(proofs.verify("fixture-operation", genuine).sessionId).toBe("fixture-root");
  });

  it("represents overflowed relative deltas explicitly without changing expiration denial", () => {
    let now = -Number.MAX_VALUE;
    const store = new InMemoryWorkflowStore();
    const claim = vi.spyOn(store, "claimExecutionObservation");
    const proofs = new SessionActorProofs(store, () => now);
    const genuine = withProof(proofs, "fixture-operation");
    now = Number.MAX_VALUE;
    expect(rejectionDetails(() => proofs.verify("fixture-operation", genuine))).toEqual({
      reasonCode: "ROOT_PROOF_SCOPE_OR_TIME_INVALID", failedChecks: ["expired"],
      relativeTimeMs: { issuedAtMinusNow: "non-finite", expiresAtMinusNow: "non-finite", lifetimeMinusTtl: -TTL },
    });
    expect(claim).not.toHaveBeenCalled();
  });

  it("checks the signature before exposing any rejection diagnostics and preserves the genuine proof", () => {
    const store = new InMemoryWorkflowStore();
    const claim = vi.spyOn(store, "claimExecutionObservation");
    const proofs = new SessionActorProofs(store, () => NOW);
    const genuine = withProof(proofs, "fixture-operation");
    expect(rejectionDetails(() => proofs.verify("fixture-operation", {
      [SESSION_PROOF_FIELD]: tamperSession(genuine[SESSION_PROOF_FIELD] as string),
    }))).toEqual({ reasonCode: "ROOT_PROOF_SIGNATURE_INVALID" });
    expect(claim).not.toHaveBeenCalled();
    expect(proofs.verify("fixture-operation", genuine).sessionId).toBe("fixture-root");
  });
});

describe("session actor proof SQLite connections", () => {
  it("keeps an explicit proof clock independent of the store clock", () => {
    const store = new InMemoryWorkflowStore();
    vi.spyOn(store, "currentTimeMilliseconds").mockImplementation(() => { throw new Error("Store clock must not run."); });
    const proofs = new SessionActorProofs(store, () => NOW);
    expect(proofs.verify("get_trust_capabilities", withProof(proofs, "get_trust_capabilities"))).toMatchObject({ sessionId: "fixture-root" });
  });

  it("uses native store UTC despite an 8ms process Date divergence and still rejects replay", () => {
    const databasePath = path.join(ownedDirectory(), "workflow.sqlite3");
    const issuerStore = new SqliteWorkflowStore(databasePath);
    let verifierStore: SqliteWorkflowStore | undefined;
    try {
      verifierStore = new SqliteWorkflowStore(databasePath);
      const processNow = Date.now();
      const localClock = vi.spyOn(Date, "now").mockReturnValue(processNow + 8);
      const signed = withProof(new SessionActorProofs(issuerStore), "get_trust_capabilities");
      localClock.mockReturnValue(processNow);
      const verifier = new SessionActorProofs(verifierStore);
      expect(verifier.verify("get_trust_capabilities", signed)).toMatchObject({ sessionId: "fixture-root" });
      expectContractFailure(() => verifier.verify("get_trust_capabilities", signed), "BINDING_INVALID", "ROOT_PROOF_ALREADY_CONSUMED");
    } finally {
      try { verifierStore?.close(); } finally { issuerStore.close(); }
    }
  });

  it("preserves clock read failure without falling back or consuming the genuine proof", () => {
    const store = new SqliteWorkflowStore(path.join(ownedDirectory(), "workflow.sqlite3"));
    try {
      const proofs = new SessionActorProofs(store);
      const signed = withProof(proofs, "get_trust_capabilities");
      const failure = new WorkflowContractError("MCP_UNAVAILABLE", "Fixture clock unavailable.");
      const clock = vi.spyOn(store, "currentTimeMilliseconds").mockImplementation(() => { throw failure; });
      expect(() => proofs.issue(fakeObservation({ callId: "other-call" }), "get_trust_capabilities", {})).toThrow(failure);
      expect(() => proofs.verify("get_trust_capabilities", signed)).toThrow(failure);
      clock.mockRestore();
      expect(proofs.verify("get_trust_capabilities", signed)).toMatchObject({ sessionId: "fixture-root" });
    } finally { store.close(); }
  });

  it("reports a closed store clock as unavailable instead of using process time", () => {
    const store = new SqliteWorkflowStore(path.join(ownedDirectory(), "workflow.sqlite3"));
    store.close();
    expect(() => store.currentTimeMilliseconds()).toThrow(expect.objectContaining({ code: "MCP_UNAVAILABLE" }));
  });

  it.each([0, 1])("allows one claim across two real owned connections, first verifier %i", first => {
    const databasePath = path.join(ownedDirectory(), "workflow.sqlite3");
    const left = new SqliteWorkflowStore(databasePath);
    let right: SqliteWorkflowStore | undefined;
    try {
      right = new SqliteWorkflowStore(databasePath);
      const proofs = [new SessionActorProofs(left, () => NOW), new SessionActorProofs(right, () => NOW)];
      const signed = withProof(proofs[0]!, "get_trust_capabilities");
      expect(proofs[first]!.verify("get_trust_capabilities", signed)).toMatchObject({ sessionId: "fixture-root" });
      expectContractFailure(() => proofs[1 - first]!.verify("get_trust_capabilities", signed), "BINDING_INVALID", "ROOT_PROOF_ALREADY_CONSUMED");
      const reissued = withProof(proofs[1 - first]!, "get_trust_capabilities");
      expectContractFailure(() => proofs[first]!.verify("get_trust_capabilities", reissued), "BINDING_INVALID", "ROOT_PROOF_ALREADY_CONSUMED");
    } finally {
      try { right?.close(); } finally { left.close(); }
    }
  });
});

type ProofClaimResult = {
  ok: boolean;
  pid: number;
  actor?: { host: string; sessionId: string };
  code?: string;
  reasonCode?: string;
};

function issueSqliteProof(databasePath: string, observation = fakeObservation()): Record<string, unknown> {
  const store = new SqliteWorkflowStore(databasePath);
  try { return withProof(new SessionActorProofs(store, () => NOW), "get_trust_capabilities", {}, observation); }
  finally { store.close(); }
}

async function concurrentlyVerifyProof(databasePaths: string[], args: Record<string, unknown>): Promise<void> {
  // Existing helper waits for every opened connection's ready message before releasing
  // all independent processes. These are competing attempts, not sequential verifiers.
  const results = await concurrentClaims<ProofClaimResult>(
    new URL("./fixtures/concurrent-session-proof-worker.ts", import.meta.url),
    databasePaths.map(databasePath => ({ databasePath, tool: "get_trust_capabilities", args, now: NOW })),
  );
  expect(results).toHaveLength(2);
  expect(new Set(results.map(result => result.pid)).size).toBe(2);
  expect(results.every(result => Number.isInteger(result.pid) && result.pid !== process.pid)).toBe(true);
  const accepted = results.filter(result => result.ok);
  const rejected = results.filter(result => !result.ok);
  expect(accepted).toHaveLength(1);
  expect(accepted[0]?.actor).toMatchObject({ host: "fixture-host", sessionId: "fixture-root" });
  expect(rejected).toHaveLength(1);
  expect(rejected[0]).toMatchObject({ code: "BINDING_INVALID", reasonCode: "ROOT_PROOF_ALREADY_CONSUMED" });
}

describe("session actor proof concurrent SQLite claims and path aliases", () => {
  // Local bound covers the reused helper's 15s ready/result deadlines and owned-child drain.
  it("OB-CLAIM-CONCURRENT accepts exactly one proof across independent ready-barrier processes", async () => {
    const databasePath = path.join(ownedDirectory(), "workflow.sqlite3");
    const signed = issueSqliteProof(databasePath);
    await concurrentlyVerifyProof([databasePath, databasePath], signed);
    const reopened = new SqliteWorkflowStore(databasePath);
    try {
      expectContractFailure(() => new SessionActorProofs(reopened, () => NOW).verify("get_trust_capabilities", signed), "BINDING_INVALID", "ROOT_PROOF_ALREADY_CONSUMED");
    } finally { reopened.close(); }
  }, 45_000);

  it("OB-PATH-ALIASES shares the proof secret and one-use claim through a directory symlink or junction", async context => {
    const directory = ownedDirectory();
    const realDirectory = path.join(directory, "real");
    const aliasDirectory = path.join(directory, "alias");
    mkdirSync(realDirectory);
    try {
      symlinkSync(realDirectory, aliasDirectory, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code && ["EPERM", "EACCES", "ENOTSUP", "EOPNOTSUPP", "ENOSYS"].includes(code)) {
        // Only inability to create this owned link is unsupported. Assertion, open,
        // worker, signature, replay and timeout failures below must never become skips.
        console.warn(`OB-PATH-ALIASES UNSUPPORTED: ${process.platform} cannot create owned directory link (${code}).`);
        context.skip();
        return;
      }
      throw error;
    }
    const databasePath = path.join(realDirectory, "workflow.sqlite3");
    const aliasPath = path.join(aliasDirectory, "workflow.sqlite3");
    const signed = issueSqliteProof(databasePath);
    expect(databasePath).not.toBe(aliasPath);
    expect(realpathSync.native(aliasPath)).toBe(realpathSync.native(databasePath));
    expect(() => assertDistinctDatabasePaths(databasePath, aliasPath)).toThrow(/different files/u);

    // Prove that an alias-issued HMAC is accepted through the canonical path too;
    // this uses a distinct call so the competing proof remains unconsumed.
    const aliasSigned = issueSqliteProof(aliasPath, fakeObservation({ callId: "alias-secret-check" }));
    const canonical = new SqliteWorkflowStore(databasePath);
    try {
      expect(new SessionActorProofs(canonical, () => NOW).verify("get_trust_capabilities", aliasSigned)).toMatchObject({ sessionId: "fixture-root" });
    } finally { canonical.close(); }
    await concurrentlyVerifyProof([databasePath, aliasPath], signed);
    const replay = new SqliteWorkflowStore(aliasPath);
    try {
      expectContractFailure(() => new SessionActorProofs(replay, () => NOW).verify("get_trust_capabilities", signed), "BINDING_INVALID", "ROOT_PROOF_ALREADY_CONSUMED");
    } finally { replay.close(); }
  }, 45_000);
});

function cachedUpdates(): PluginUpdateService {
  const store = new InMemoryPluginUpdateStore();
  store.putPluginUpdateState({
    targetId: "agent-governance-suite", currentVersion: CURRENT_VERSION, latestVersion: CURRENT_VERSION,
    latestTag: `v${CURRENT_VERSION}`, latestCommit: "a".repeat(40), etag: "owned-proof-fixture", comparison: "up-to-date",
    lastAttemptAt: "2026-10-27T00:00:00.000Z", lastSuccessfulCheckAt: "2026-10-27T00:00:00.000Z",
    nextCheckAt: "2099-01-01T00:00:00.000Z", lastNotifiedVersion: null, lastNotifiedAt: null, lastErrorCode: null,
  });
  return new PluginUpdateService(store);
}

interface Envelope {
  ok: boolean;
  data: Record<string, unknown> | null;
  error: { code: string; message: string; details: Record<string, unknown> | null } | null;
}

function envelope(response: Awaited<ReturnType<Client["callTool"]>>): Envelope {
  const content = response.content as Array<{ type: string; text?: string }>;
  const first = content.find(item => item.type === "text");
  expect(first?.text).toBeTypeOf("string");
  return JSON.parse(first!.text!) as Envelope;
}

async function mcpFixture(configured = true) {
  const store = new InMemoryWorkflowStore();
  const proofs = new SessionActorProofs(store, () => NOW);
  const validator = new ContractValidator();
  const service = new WorkflowService(new FileSkillRegistry(registryPath, validator), validator, store);
  const updates = cachedUpdates();
  const continuity = new UnavailableContinuityService();
  const glossary = new UnavailableKoreanProseGlossary();
  const messages = new SessionMessageService(path.join(ownedDirectory(), "unused-messaging"));
  const trustStore = new TrustStore(":memory:");
  const trust = new TrustService(trustStore);
  const classification = {
    inventory: vi.fn(async () => { throw new Error("Unexpected classification IO"); }),
    classify: vi.fn(async () => { throw new Error("Unexpected classification IO"); }),
    accept: vi.fn(async () => { throw new Error("Unexpected classification IO"); }),
  };
  const boardPath = path.join(ownedDirectory(), "board.sqlite3");
  // A populated but invalid fixture catches accidental board access, even if opening fails.
  writeFileSync(boardPath, "synthetic-not-a-database", "utf8");
  const server = createMcpServer(service, updates, continuity, undefined, glossary, validator, "default", null, boardPath, messages, trust, classification, configured ? proofs : null);
  const client = new Client({ name: "owned-session-proof-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  } catch (error) {
    try { await client.close(); } finally { try { await server.close(); } finally { trustStore.close(); } }
    throw error;
  }
  return {
    client, proofs, store, service, updates, continuity, glossary, messages, trust, classification,
    async close() {
      try { await client.close(); } finally { try { await server.close(); } finally { trustStore.close(); } }
    },
  };
}

async function allTools(client: Client) {
  const tools: Awaited<ReturnType<Client["listTools"]>>["tools"] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined);
    tools.push(...page.tools);
    cursor = page.nextCursor;
    if (cursor) {
      expect(seen.has(cursor)).toBe(false);
      seen.add(cursor);
    }
  } while (cursor);
  expect(tools.length).toBeGreaterThan(0);
  expect(new Set(tools.map(tool => tool.name)).size).toBe(tools.length);
  return tools;
}

describe("session actor proof all tools gate", () => {
  it("advertises only the public proof field and denies absent/forged proofs before side effects for every tool", async () => {
    const fixture = await mcpFixture();
    try {
      const spies = [
        vi.spyOn(fixture.updates, "check"), vi.spyOn(fixture.updates, "cachedStatus"), vi.spyOn(fixture.updates, "takeNotice"),
        vi.spyOn(fixture.service, "planWorkflow"), vi.spyOn(fixture.service, "openConvergenceRoot"),
        vi.spyOn(fixture.service, "claimWorkflowAttempt"), vi.spyOn(fixture.service, "startGuardedWorkflow"),
        vi.spyOn(fixture.service, "getConvergenceStatus"), vi.spyOn(fixture.service, "resolveConvergenceGate"),
        vi.spyOn(fixture.service, "startWorkflow"), vi.spyOn(fixture.service, "rejectUnguardedWorkflow"), vi.spyOn(fixture.service, "recordStageResult"),
        vi.spyOn(fixture.service, "getWorkflowStatus"), vi.spyOn(fixture.service, "finalizeWorkflow"), vi.spyOn(fixture.service, "abortWorkflow"),
        vi.spyOn(fixture.continuity, "checkpointContext"), vi.spyOn(fixture.continuity, "inspectContext"),
        vi.spyOn(fixture.continuity, "loadContext"), vi.spyOn(fixture.continuity, "suppressContextRestore"), vi.spyOn(fixture.continuity, "purgeDirectContext"),
        vi.spyOn(fixture.continuity, "bindOpenedRoot"),
        vi.spyOn(fixture.glossary, "lookup"), vi.spyOn(fixture.trust, "capabilities"), vi.spyOn(fixture.trust, "validateCollaborationDecision"),
        vi.spyOn(fixture.messages, "prepare"), vi.spyOn(fixture.messages, "send"), vi.spyOn(fixture.messages, "acknowledge"),
        vi.spyOn(fixture.messages, "status"), vi.spyOn(fixture.messages, "listPresence"),
        vi.spyOn(fixture.store, "claimExecutionObservation"), vi.spyOn(fixture.store, "insertRun"), vi.spyOn(fixture.store, "nextRunSequence"),
        vi.mocked(existsSync), vi.mocked(board.openBoard), vi.mocked(board.listSessions), vi.mocked(board.readSession),
        ...Object.values(fixture.classification),
      ];
      const tools = await allTools(fixture.client);
      for (const spy of spies) {
        spy.mockClear();
        // A gate regression must fail before starting networking, a broker, or DB work.
        spy.mockImplementation((): never => { throw new Error("Unexpected downstream effect before proof authorization"); });
      }
      for (const tool of tools) {
        expect(tool.inputSchema.properties).toHaveProperty(SESSION_PROOF_FIELD);
        expect(JSON.stringify(tool.inputSchema)).not.toContain('"_sessionBinding"');
        const absent = envelope(await fixture.client.callTool({ name: tool.name, arguments: {} }));
        expect(absent, tool.name).toMatchObject({ ok: false, error: { code: "BINDING_REQUIRED", details: { reasonCode: "ROOT_HOOK_PROOF_REQUIRED" } } });
        const genuine = fixture.proofs.issue(fakeObservation({ callId: `forged-${tool.name}` }), tool.name, {});
        const forged = envelope(await fixture.client.callTool({ name: tool.name, arguments: { [SESSION_PROOF_FIELD]: tamperSignature(genuine) } }));
        expect(forged, tool.name).toMatchObject({ ok: false, error: { code: "BINDING_INVALID", details: { reasonCode: "ROOT_PROOF_SIGNATURE_INVALID" } } });
      }
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally { await fixture.close(); }
  });

  it("rejects an unconfigured verifier and legacy caller binding before list board IO", async () => {
    const fixture = await mcpFixture(false);
    try {
      const exists = vi.mocked(existsSync);
      const open = vi.mocked(board.openBoard);
      exists.mockClear();
      open.mockClear();
      const genuine = withProof(fixture.proofs, "list_session_status", { schemaVersion: "1.0.0" });
      expect(envelope(await fixture.client.callTool({ name: "list_session_status", arguments: genuine })))
        .toMatchObject({ ok: false, error: { code: "BINDING_REQUIRED" } });
      expect(envelope(await fixture.client.callTool({ name: "list_session_status", arguments: { ...genuine, _sessionBinding: { host: "fixture-host", sessionId: "fixture-root" } } })))
        .toMatchObject({ ok: false, error: { code: "BINDING_INVALID", details: { reasonCode: "CALLER_SESSION_BINDING_REJECTED" } } });
      expect(exists).not.toHaveBeenCalled();
      expect(open).not.toHaveBeenCalled();
    } finally { await fixture.close(); }
  });
});

describe("session actor proof positive/domain", () => {
  it.each(["observed", "inferred"] as const)("allows known-valid get_trust_capabilities for fake core root %s", async basis => {
    const fixture = await mcpFixture();
    try {
      const observation = fakeObservation({ actor: { role: "root", basis, reasonCode: "FIXTURE_ROOT_POSITIVE" } });
      const args = withProof(fixture.proofs, "get_trust_capabilities", {}, observation);
      const result = envelope(await fixture.client.callTool({ name: "get_trust_capabilities", arguments: args }));
      expect(result).toMatchObject({ ok: true, error: null, data: {
        provenanceRecording: true, directUserInputAttestation: false, authorityIssuance: false,
        scopedDelegation: false, acceptedOrigins: ["peer", "system", "developer", "project", "artifact"],
        acceptedAuthorityEffects: ["none", "restrict-only"],
      } });
      expect(envelope(await fixture.client.callTool({ name: "get_trust_capabilities", arguments: args })))
        .toMatchObject({ ok: false, error: { code: "BINDING_INVALID", details: { reasonCode: "ROOT_PROOF_ALREADY_CONSUMED" } } });
    } finally { await fixture.close(); }
  });

  it("preserves a domain contract error after a genuine proof crosses the server gate", async () => {
    const fixture = await mcpFixture();
    try {
      const failure = new WorkflowContractError("MCP_UNAVAILABLE", "Synthetic message storage is unavailable.", { reason: "SYNTHETIC_STORAGE_FAILED" });
      const prepare = vi.spyOn(fixture.messages, "prepare").mockRejectedValue(failure);
      const input = { schemaVersion: "1.0.0", targetHost: "fixture-target", targetSessionId: "fixture-target-session", body: "synthetic hello" };
      const args = withProof(fixture.proofs, "prepare_session_message", input);
      const result = envelope(await fixture.client.callTool({ name: "prepare_session_message", arguments: args }));
      expect(result).toMatchObject({ ok: false, error: {
        code: "MCP_UNAVAILABLE", message: failure.message, details: { reason: "SYNTHETIC_STORAGE_FAILED" },
      } });
      expect(prepare).toHaveBeenCalledOnce();
      expect(prepare.mock.calls[0]![0]).not.toHaveProperty(SESSION_PROOF_FIELD);
      expect(prepare.mock.calls[0]![0]).toMatchObject({ _sessionBinding: { host: "fixture-host", sessionId: "fixture-root" } });
    } finally { await fixture.close(); }
  });
});
