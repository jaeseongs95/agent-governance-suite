import assert from "node:assert/strict";
import fs from "node:fs";
import {mkdtemp, mkdir, cp, symlink, writeFile, readFile, rm, unlink} from "node:fs/promises";
import {spawn} from "node:child_process";
import {syncBuiltinESMExports} from "node:module";
import os from "node:os";
import path from "node:path";
import {pathToFileURL} from "node:url";
import {readyMock, readyEstimateMock, mockEnv, mockResponse, hash} from "./prepared-fixture.mjs";
import type {PreparedBootstrapConfig} from "./bootstrap.mts";

type Api = typeof import("./bootstrap.mts");
const repo = path.resolve(process.argv[2]!);
const helper = path.resolve(process.argv[3] ?? path.join(repo, "tests/skill-classification/live-bootstrap/bootstrap.mts"));
assert(process.argv[2], "Usage: prepared-regression.mts REPO [HELPER]");
const api = await import(pathToFileURL(helper).href) as Api;
const root = await mkdtemp(path.join(os.tmpdir(), "ags-prepared-regression-"));
const checks: string[] = [];
const ledgerOf = (config: PreparedBootstrapConfig) => JSON.parse(fs.readFileSync(path.join(config.outputDirectory, "ledger.json"), "utf8"));
const edit = (file: string, change: (record: Record<string, unknown>) => void) => {const value = JSON.parse(fs.readFileSync(file, "utf8")); change(value); fs.writeFileSync(file, JSON.stringify(value));};
const authorityFile = (config: PreparedBootstrapConfig) => path.join(config.outputDirectory, config.currentAuthority!.reference.path);
function assertHold(config: PreparedBootstrapConfig, expectedRows = config.limits!.requests) {
  const ledger = ledgerOf(config);
  assert.equal(ledger.entries.length, expectedRows, "WHOLE_SELECTION_RESERVED_BEFORE_SEND");
  assert.equal(ledger.entries.reduce((sum: number, row: {reservedUsd: number}) => sum + row.reservedUsd, 0), expectedRows * 0.001);
  assert(ledger.entries.every((row: {actualCostUsd: unknown}) => row.actualCostUsd === null), "NO_SYNTHETIC_USAGE_AS_SETTLED_CHARGE");
  return ledger;
}
async function fixture(id: string, options: Parameters<typeof readyMock>[4] = {}, sourceRepo = repo) {
  return readyMock(api, sourceRepo, path.join(root, id), id, options);
}
function child(configFile: string, mode = "normal") {
  const worker = path.join(import.meta.dirname, "prepared-child.mts");
  const processEnv: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "Path", "SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR"]) {
    if (process.env[name]) processEnv[name] = process.env[name];
  }
  // Real independent processes; no credential values inherited, only explicit dummy mockEnv inside worker.
  const process_ = spawn(process.execPath, ["--import", "tsx", worker, repo, helper, configFile, mode],
    {cwd: repo, env: processEnv, stdio: ["ignore", "pipe", "pipe", "ipc"], shell: false, windowsHide: true});
  type Message = {type: string; calls: number; status: string};
  const messages: Message[] = [], waiting = new Set<() => void>();
  let exited = false, stderr = "";
  process_.stderr?.on("data", bytes => {stderr = (stderr + String(bytes)).slice(-8000);});
  process_.on("message", message => {messages.push(message as Message); for (const check of waiting) check();});
  const exit = new Promise<void>((resolve, reject) => {
    process_.once("error", reject);
    process_.once("exit", () => {exited = true; for (const check of waiting) check(); resolve();});
  });
  const wait = (type: string) => new Promise<Message>((resolve, reject) => {
    const timer = setTimeout(() => {waiting.delete(check); process_.kill(); reject(new Error(`IPC_TIMEOUT:${type}:${stderr}`));}, 30000);
    const check = () => {
      const index = messages.findIndex(message => message.type === type);
      if (index !== -1) {clearTimeout(timer); waiting.delete(check); resolve(messages.splice(index, 1)[0]!);}
      else if (exited) {clearTimeout(timer); waiting.delete(check); reject(new Error(`CHILD_EXIT_BEFORE_${type}:${stderr}`));}
    };
    waiting.add(check); check();
  });
  return {process_, wait, exit, get stderr() {return stderr;}};
}
function mutation(config: PreparedBootstrapConfig, kind: string, sourceRepo: string) {
  if (kind === "authority") edit(authorityFile(config), value => {value.approved = false;});
  else if (kind === "owner") edit(authorityFile(config), value => {value.ownerId = "revoked-owner";});
  else if (kind === "revision") edit(authorityFile(config), value => {value.budgetRevision = "budget-2";});
  else if (kind === "cancel") edit(authorityFile(config), value => {value.cancelled = true;});
  else if (kind === "ledger") fs.appendFileSync(path.join(config.outputDirectory, "ledger.json"), "\n");
  else if (kind === "lock") edit(path.join(config.outputDirectory, "bootstrap.lock"), value => {value.writerId = "other-writer";});
  else if (kind === "evidence") fs.appendFileSync(path.join(config.outputDirectory, config.evidence.route!.path), "\n");
  else if (kind === "source" || kind === "digest") {
    assert.notEqual(path.resolve(sourceRepo), repo, "NEVER_MUTATE_PRODUCT_REPO");
    const file = path.join(sourceRepo, "mcp-server/src/skill-classification", kind === "digest" ? "digest.ts" : "providers.ts");
    const bytes = fs.readFileSync(file), length = bytes.length;
    assert(length > 0);
    bytes[length - 1] = bytes[length - 1] === 10 ? 32 : 10;
    fs.writeFileSync(file, bytes);
    assert.equal(fs.statSync(file).size, length, "SAME_LENGTH_SOURCE_HASH_MUTATION");
  } else throw new Error("Unknown mutation");
}
async function atFsBoundary(config: PreparedBootstrapConfig, phase: string, action: () => Promise<void>, change?: () => void) {
  const original = {openSync: fs.openSync, fsyncSync: fs.fsyncSync, renameSync: fs.renameSync, readFileSync: fs.readFileSync};
  const claimFds = new Set<number>();
  let journaledUnknown = false, fired = false;
  const revoke = () => {if (!fired) {fired = true; if (change) change(); else edit(authorityFile(config), value => {value.cancelled = true;});}};
  // Scoped to this one fixture process. Restore bindings before any other case/child starts.
  fs.openSync = (...args: Parameters<typeof fs.openSync>) => {
    const fd = original.openSync(...args);
    if (String(args[0]).endsWith(".attempt-1.claim.json")) claimFds.add(fd);
    return fd;
  };
  fs.fsyncSync = fd => {original.fsyncSync(fd); if (phase === "claim-fsync" && claimFds.has(fd)) revoke();};
  fs.renameSync = (from, to) => {
    original.renameSync(from, to);
    if (String(to) === path.join(config.outputDirectory, "ledger.json")) {
      const ledger = JSON.parse(original.readFileSync(to, "utf8"));
      journaledUnknown = ledger.entries.some((row: {state: string}) => row.state === "unknown");
      if (phase === "journal-rename" && journaledUnknown) revoke();
    }
  };
  fs.readFileSync = ((...args: Parameters<typeof fs.readFileSync>) => {
    const bytes = Reflect.apply(original.readFileSync, fs, args) as ReturnType<typeof fs.readFileSync>;
    if (phase === "transport-final" && journaledUnknown && String(args[0]) === path.join(config.outputDirectory, config.evidence.operatorAuthorization!.path)) revoke();
    return bytes; // Final classify fence reads old snapshot; subsequent transport fence must see revocation.
  }) as typeof fs.readFileSync;
  syncBuiltinESMExports();
  try {await action(); assert(fired, `BOUNDARY_NOT_REACHED:${phase}`);}
  finally {Object.assign(fs, original); syncBuiltinESMExports();}
}
try {
  const {config, prepared} = await fixture("nonexpiring");
  const future = Date.parse("2030-01-01T00:00:00.000Z");
  const pre = await api.preflight(config, prepared, future);
  assert.equal(pre.status, "READY_FOR_OPERATOR_DISPATCH", "PREPARATION_AGE_IS_NOT_AUTHORITY_EXPIRY");
  assert.equal(pre.validatedEvidenceDeadlineMs, null);
  let calls = 0;
  const normal = await api.run(config, {now: () => future, executionKind: "offline-mock", env: {...mockEnv},
    fetcher: async (_url, init) => {calls++; assertHold(config); return mockResponse(init);}});
  assert.equal(calls, 2); assert.equal(normal.status, "RAW_EVALUATION_RECORDED");
  checks.push("old immutable preparation permits two reserved synthetic dispatches");
  const issuer = await fixture("issuer", {issuerExpiry: {kind: "route", validUntil: new Date(future).toISOString()}});
  let issuerCalls = 0, issuerEnvReads = 0;
  const expired = await api.run(issuer.config, {now: () => future, executionKind: "offline-mock",
    env: new Proxy({}, {get: () => {issuerEnvReads++; assert.fail("EXPIRED_ISSUER_MUST_BLOCK_ENV");}}),
    fetcher: async () => {issuerCalls++; assert.fail("EXPIRED_ISSUER_MUST_BLOCK_TRANSPORT");}});
  assert.equal(expired.status, "BLOCKED"); assert.equal(issuerCalls, 0); assert.equal(issuerEnvReads, 0);
  if (expired.status === "BLOCKED") assert(expired.blocked.includes("EVIDENCE_UNBOUND:route"));
  checks.push("issuer exact deadline blocks preflight/environment/transport");

  const backward = Date.parse("2001-01-01T00:00:00.000Z");
  assert.equal((await api.preflight(config, prepared, backward)).status, "READY_FOR_OPERATOR_DISPATCH");
  checks.push("identical immutable preparation remains valid under backward wallclock");
  const revoked = await fixture("backward-revoked");
  edit(authorityFile(revoked.config), value => {value.cancelled = true;});
  let revokedReads = 0, revokedSends = 0;
  const revokedResult = await api.run(revoked.config, {now: () => backward, executionKind: "offline-mock",
    env: new Proxy({}, {get: () => {revokedReads++; assert.fail("CLOCK_ROLLBACK_MUST_NOT_REVIVE_REVOKED_AUTHORITY");}}),
    fetcher: async () => {revokedSends++; assert.fail("REVOKED_MUST_NOT_SEND");}});
  assert.equal(revokedResult.status, "BLOCKED"); assert.equal(revokedReads, 0); assert.equal(revokedSends, 0);
  checks.push("backward wallclock does not revive revoked current authority");
  const deadline = future + 1000;
  const rollback = await fixture("observed-expiry-rollback", {issuerExpiry: {kind: "route", validUntil: new Date(deadline).toISOString()}});
  let armedRollback = false, postArmReads = 0, rollbackSends = 0;
  const rollbackResult = await api.run(rollback.config, {now: () => {
    if (!armedRollback) return future;
    return ++postArmReads === 1 ? deadline + 1 : future - 5000;
  }, executionKind: "offline-mock", env: {...mockEnv, get AGS_BOOTSTRAP_JEV_KEY() {armedRollback = true; return mockEnv.AGS_BOOTSTRAP_JEV_KEY;}},
  fetcher: async () => {rollbackSends++; assert.fail("OBSERVED_EXPIRY_MUST_NOT_REVIVE_AFTER_ROLLBACK");}});
  assert(postArmReads >= 2); assert.equal(rollbackSends, 0); assert.equal(rollbackResult.status, "RAW_EVALUATION_RECORDED");
  if (rollbackResult.status === "RAW_EVALUATION_RECORDED") assert.equal(rollbackResult.stopReason, "BOUND_EVIDENCE_EXPIRED");
  assertHold(rollback.config);
  checks.push("observed issuer expiry survives backward wallclock within the same run");

  for (const scope of ["cross-run", "account", "global"]) {
    const {config: value} = await fixture(`unsupported-${scope}`);
    (value.currentAuthority as unknown as {scope: string}).scope = scope;
    let reads = 0, sends = 0;
    const result = await api.run(value, {executionKind: "offline-mock",
      env: new Proxy({}, {get: () => {reads++; assert.fail("UNSUPPORTED_SCOPE_MUST_NOT_READ_ENV");}}),
      fetcher: async () => {sends++; assert.fail("UNSUPPORTED_SCOPE_MUST_NOT_DISPATCH");}});
    assert.equal(result.status, "BLOCKED"); assert.equal(reads, 0); assert.equal(sends, 0);
    if (result.status === "BLOCKED") assert(result.blocked.includes("AUTHORITY_SCOPE_UNSUPPORTED"));
    checks.push(`unsupported ${scope} dispatch0`);
  }
  const copiedRepo = path.join(root, "source-copy");
  await mkdir(copiedRepo);
  for (const relative of ["mcp-server/src/skill-classification", "skills", "tests/skill-classification/fixtures.json",
    "tests/skill-classification/evaluation.ts", "package.json"]) {
    const target = path.join(copiedRepo, relative); await mkdir(path.dirname(target), {recursive: true});
    await cp(path.join(repo, relative), target, {recursive: true});
  }
  await symlink(path.join(repo, "node_modules"), path.join(copiedRepo, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  const sourceFile = path.join(copiedRepo, "mcp-server/src/skill-classification/providers.ts");
  const sourceBytes = await readFile(sourceFile);
  const digestFile = path.join(copiedRepo, "mcp-server/src/skill-classification/digest.ts");
  const digestBytes = await readFile(digestFile);
  for (const stage of ["credential", "encode"] as const) {
    for (const kind of ["authority", "owner", "revision", "cancel", "ledger", "lock", "evidence", "source", "digest"]) {
      const {config: value, prepared: bound} = await fixture(`${stage}-${kind}`, {}, copiedRepo);
      let armed = false, fired = false, sends = 0;
      let changedLedger: Buffer | null = null;
      const adapter = bound.api.providers.jevNoulWireAdapter, originalEncode = adapter.encode;
      const change = () => {if (!fired) {fired = true; mutation(value, kind, copiedRepo); if (kind === "ledger") changedLedger = fs.readFileSync(path.join(value.outputDirectory, "ledger.json"));}};
      if (stage === "encode") adapter.encode = function(...args: Parameters<typeof originalEncode>) {
        const [request, profile] = args;
        const wire = originalEncode.call(adapter, request, profile); if (armed) change(); return wire;
      };
      const environment = {...mockEnv, get AGS_BOOTSTRAP_JEV_KEY() {
        armed = true;
        if (stage === "credential") queueMicrotask(change); // Actual await after the getter must consume this mutation.
        return mockEnv.AGS_BOOTSTRAP_JEV_KEY;
      }};
      try {
        let result: Awaited<ReturnType<Api["run"]>> | null = null;
        try {
          result = await api.run(value, {executionKind: "offline-mock", env: environment,
            fetcher: async () => {sends++; assert.fail("STALE_STATE_MUST_NOT_DISPATCH");}});
        } catch (error) {
          if (kind !== "ledger") throw error; // A final persistent ledger conflict may reject the whole run.
          assert(error instanceof Error);
        }
        assert(fired); assert.equal(sends, 0);
        if (kind === "ledger") {
          assert(changedLedger !== null, "LEDGER_MUTATION_CAPTURED");
          assert.deepEqual(fs.readFileSync(path.join(value.outputDirectory, "ledger.json")), changedLedger, "EXTERNAL_LEDGER_BYTES_MUST_NOT_BE_OVERWRITTEN");
          assert.equal(fs.readdirSync(value.outputDirectory).filter(name => name.endsWith(".raw.json")).length, 1, "RAW_FAILURE_RECORD_SURVIVES_LEDGER_CONFLICT");
        } else {
          assert.equal(result?.status, "RAW_EVALUATION_RECORDED");
          if (result?.status === "RAW_EVALUATION_RECORDED") assert.equal(result.ledger.entries[0]!.dispatchState, "not-started");
        }
        assertHold(value); // Existing hold rows survive even when the run rejects.
        checks.push(`${stage} ${kind} mutation dispatch0`);
      } finally {adapter.encode = originalEncode; await writeFile(sourceFile, sourceBytes); await writeFile(digestFile, digestBytes);}
    }
  }
  // Estimator authoring follows the existing synthetic wire measurement fixture, not a billing oracle.
  for (const stage of ["credential", "encode"] as const) {
    for (const target of ["inputArtifact", "source"] as const) {
      const {config: value, prepared: bound, measurements} = await readyEstimateMock(api, repo, path.join(root, `estimate-${stage}-${target}`), `estimate-${stage}-${target.toLowerCase()}`);
      assert.equal(measurements.length, 21);
      const checked = await api.preflight(value, bound);
      assert.equal(checked.status, "READY_FOR_OPERATOR_DISPATCH", "ESTIMATE_FIXTURE_MUST_BE_ADMISSIBLE_BEFORE_MUTATION");
      const reference = target === "inputArtifact" ? value.estimator!.inputArtifact : value.estimator!.sources[0]!;
      const targetFile = path.join(value.outputDirectory, reference.path);
      assert.equal(fs.realpathSync(targetFile), path.resolve(targetFile), "CANONICAL_LOCAL_ESTIMATE_REFERENCE");
      assert.equal(hash(await readFile(targetFile)), reference.digest);
      let armed = false, fired = false, sends = 0;
      let changedBytes: Buffer | null = null;
      const change = () => {if (!fired) {fired = true; fs.appendFileSync(targetFile, "\n"); changedBytes = fs.readFileSync(targetFile);}};
      const adapter = bound.api.providers.jevNoulWireAdapter, originalEncode = adapter.encode;
      if (stage === "encode") adapter.encode = function(...args: Parameters<typeof originalEncode>) {
        const wire = originalEncode.call(adapter, ...args); if (armed) change(); return wire;
      };
      const environment = {...mockEnv, get AGS_BOOTSTRAP_JEV_KEY() {
        armed = true; if (stage === "credential") queueMicrotask(change); return mockEnv.AGS_BOOTSTRAP_JEV_KEY;
      }};
      try {
        const result = await api.run(value, {executionKind: "offline-mock", env: environment,
          fetcher: async () => {sends++; assert.fail("STALE_ESTIMATOR_REFERENCE_MUST_NOT_DISPATCH");}});
        assert(fired); assert.equal(sends, 0); assert.equal(result.status, "RAW_EVALUATION_RECORDED");
        if (result.status !== "RAW_EVALUATION_RECORDED") throw new Error("ESTIMATOR_MUTATION_EXPECTED_RAW_FAILURE_RECORD");
        assert.equal(result.ledger.entries[0]!.dispatchState, "not-started");
        assert.deepEqual(fs.readFileSync(targetFile), changedBytes, "ESTIMATOR_CONFLICT_BYTES_PRESERVED");
        assert.equal(ledgerOf(value).entries.length, value.limits!.requests, "WHOLE_ESTIMATE_RUN_HOLD_EXISTS");
        checks.push(`${stage} estimator ${target} mutation dispatch0`);
      } finally {adapter.encode = originalEncode;}
    }
  }
  for (const phase of ["claim-fsync", "journal-rename", "transport-final"]) {
    const {config: value} = await fixture(`boundary-${phase}`, {requests: 1}); let sends = 0;
    await atFsBoundary(value, phase, async () => {
      const result = await api.run(value, {executionKind: "offline-mock", env: {...mockEnv},
        fetcher: async () => {sends++; assert.fail("CLAIMED_REVOKED_ATTEMPT_MUST_NOT_SEND");}});
      assert.equal(sends, 0); assert.equal(result.status, "RAW_EVALUATION_RECORDED");
      const ledger = assertHold(value); assert.equal(ledger.entries[0].state, "unknown"); assert.equal(ledger.entries[0].dispatchState, "unknown");
      assert.equal(fs.readdirSync(value.outputDirectory).filter(name => name.endsWith(".attempt-1.claim.json")).length, 1);
    });
    checks.push(`${phase} revocation dispatch0 durable UNKNOWN`);
  }
  const conflicting = await fixture("claim-fsync-ledger-conflict", {requests: 1});
  let changedLedger: Buffer | null = null, claimBytes: Buffer | null = null, conflictSends = 0;
  await atFsBoundary(conflicting.config, "claim-fsync", async () => {
    await assert.rejects(() => api.run(conflicting.config, {executionKind: "offline-mock", env: {...mockEnv},
      fetcher: async () => {conflictSends++; assert.fail("CLAIM_LEDGER_CONFLICT_MUST_NOT_SEND");}}), /RESERVATION_OWNER_OR_LEDGER_CHANGED/, "LEDGER_CONFLICT_MUST_REJECT_INSTEAD_OF_OVERWRITE");
    assert.equal(conflictSends, 0); assert(changedLedger !== null); assert(claimBytes !== null);
    assert.deepEqual(fs.readFileSync(path.join(conflicting.config.outputDirectory, "ledger.json")), changedLedger, "CLAIM_FSYNC_EXTERNAL_LEDGER_BYTES_PRESERVED");
    assert.equal(fs.readdirSync(conflicting.config.outputDirectory).filter(name => name.endsWith(".raw.json")).length, 1, "CLAIM_CONFLICT_RAW_RECORD_SURVIVES_RUN_REJECTION");
    const files = fs.readdirSync(conflicting.config.outputDirectory).filter(name => name.endsWith(".attempt-1.claim.json"));
    assert.equal(files.length, 1);
    const claim = fs.readFileSync(path.join(conflicting.config.outputDirectory, files[0]!));
    assert.deepEqual(claim, claimBytes, "ORIGINAL_UNKNOWN_CLAIM_PRESERVED");
    assert.equal(JSON.parse(claim.toString("utf8")).state, "UNKNOWN");
    assertHold(conflicting.config); // Disk may still say reserved; durable UNKNOWN is in the consumed claim.
  }, () => {
    fs.appendFileSync(path.join(conflicting.config.outputDirectory, "ledger.json"), "\n");
    changedLedger = fs.readFileSync(path.join(conflicting.config.outputDirectory, "ledger.json"));
    const file = fs.readdirSync(conflicting.config.outputDirectory).find(name => name.endsWith(".attempt-1.claim.json"))!;
    claimBytes = fs.readFileSync(path.join(conflicting.config.outputDirectory, file));
  });
  checks.push("claim fsync ledger conflict rejects preserving disk hold and original UNKNOWN claim");
  const race = await fixture("same-physical-race");
  const firstFile = path.join(root, "race-a.json"), secondFile = path.join(root, "race-b.json");
  await writeFile(firstFile, JSON.stringify(race.config));
  await writeFile(secondFile, JSON.stringify({...race.config, outputDirectory: `${race.config.outputDirectory}${path.sep}..${path.sep}same-physical-race`}));
  const workers = [child(firstFile), child(secondFile)];
  try {
    await Promise.all(workers.map(worker => worker.wait("READY")));
    for (const worker of workers) worker.process_.send({type: "RELEASE"});
    const results = await Promise.all(workers.map(worker => worker.wait("DONE")));
    await Promise.all(workers.map(worker => worker.exit));
    assert.equal(results.filter(result => result.status === "RAW_EVALUATION_RECORDED").length, 1);
    assert.equal(results.reduce((sum, result) => sum + result.calls, 0), 2, "ONE_CANONICAL_RUN_ONLY_NOT_ONE_CALL_GLOBALLY");
    assertHold(race.config);
  } finally {for (const worker of workers) if (worker.process_.exitCode === null) worker.process_.kill();}
  checks.push("two independent IPC children same canonical directory admit one whole reserved run");

  const duplicate = await fixture("existing-operation-claim", {requests: 1});
  const operation = duplicate.prepared.requests[0]!.request;
  const claimFile = path.join(duplicate.config.outputDirectory, `${hash(operation.operationId).slice(7)}.attempt-1.claim.json`);
  const existingClaim = JSON.stringify({runId: duplicate.config.runId, operationId: operation.operationId, requestDigest: operation.requestDigest, state: "UNKNOWN", additionalAttempts: 0});
  await writeFile(claimFile, existingClaim, {flag: "wx"});
  let duplicateCalls = 0;
  const duplicateResult = await api.run(duplicate.config, {executionKind: "offline-mock", env: {...mockEnv}, fetcher: async () => {duplicateCalls++; assert.fail("DURABLE_CLAIM_MUST_NOT_RESEND");}});
  assert.equal(duplicateCalls, 0); assert.equal(duplicateResult.status, "RAW_EVALUATION_RECORDED");
  assert.equal(await readFile(claimFile, "utf8"), existingClaim, "CLAIM_WX_DOES_NOT_REPLACE_OLD_ATTEMPT");
  checks.push("existing operation attempt-1 claim blocks resend without overwriting claim");

  const crash = await fixture("crash-restart", {requests: 1});
  const configFile = path.join(root, "crash.json"); await writeFile(configFile, JSON.stringify(crash.config));
  const worker = child(configFile, "crash");
  try {
    await worker.wait("READY"); worker.process_.send({type: "RELEASE"});
    await worker.wait("DISPATCH");
    const before = assertHold(crash.config); assert.equal(before.entries[0].state, "unknown");
    worker.process_.kill("SIGKILL"); await worker.exit;
    const lockBytes = await readFile(path.join(crash.config.outputDirectory, "bootstrap.lock"));
    const ledgerBytes = await readFile(path.join(crash.config.outputDirectory, "ledger.json"));
    for (const mode of ["persistent-lock", "operator-cleared-lock"] as const) {
      // Simulates a fixture operator mistake, not a product automatic recovery policy.
      if (mode === "operator-cleared-lock") await rm(path.join(crash.config.outputDirectory, "bootstrap.lock"));
      const restart = child(configFile);
      try {
        await restart.wait("READY"); restart.process_.send({type: "RELEASE"});
        const result = await restart.wait("DONE"); await restart.exit;
        assert.equal(result.calls, 0, "UNKNOWN_RESTART_MUST_NOT_RESEND"); assert.equal(result.status, "REJECTED");
        assert.deepEqual(await readFile(path.join(crash.config.outputDirectory, "ledger.json")), ledgerBytes);
        if (mode === "persistent-lock") assert.deepEqual(await readFile(path.join(crash.config.outputDirectory, "bootstrap.lock")), lockBytes);
      } finally {if (restart.process_.exitCode === null) restart.process_.kill();}
    }
    checks.push("actual process crash UNKNOWN plus restarted duplicate no resend even if fixture lock cleared");
  } finally {if (worker.process_.exitCode === null) worker.process_.kill();}

  // Real crash/restart obligations: separate child, durable cut marker, bounded exit, never an in-process revocation proxy.
  const crashCuts = ["before-reserve", "after-reserve", "after-claim", "after-unknown-journal", "after-response", "after-finish"] as const;
  for (const cut of crashCuts) {
    const value = await fixture(`process-cut-${cut}`, {requests: 2});
    const configFile = path.join(root, `process-cut-${cut}.json`);
    await writeFile(configFile, JSON.stringify(value.config));
    const cutter = child(configFile, `cut:${cut}`);
    try {
      await cutter.wait("READY"); cutter.process_.send({type: "RELEASE"});
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([cutter.exit, new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {cutter.process_.kill(); reject(new Error(`CRASH_CUT_EXIT_TIMEOUT:${cut}`));}, 30000);
        })]);
      } finally {if (timer) clearTimeout(timer);}
      assert(cutter.process_.signalCode === "SIGKILL"
        || (process.platform === "win32" && cutter.process_.exitCode !== null && cutter.process_.exitCode !== 0), "ACTUAL_CHILD_CRASH_REQUIRED");
      const marker = JSON.parse(await readFile(path.join(value.config.outputDirectory, "fixture-cut-marker.json"), "utf8"));
      assert.equal(marker.cut, cut); assert.equal(marker.processId, cutter.process_.pid);
      assert.equal(cutter.stderr, "", "CRASH_MUST_NOT_BE_AN_UNCAUGHT_FIXTURE_FAILURE");
      await writeFile(path.join(value.config.outputDirectory, "fixture-cut-observation.json"), JSON.stringify({
        cut, observedSpawnPid: cutter.process_.pid, markerProcessId: marker.processId,
        exitCode: cutter.process_.exitCode, signalCode: cutter.process_.signalCode, stderr: cutter.stderr,
        markerDigest: hash(await readFile(path.join(value.config.outputDirectory, "fixture-cut-marker.json"))),
        actualApiCalls: 0, scope: "same-local-physical-run-output-only"
      }, null, 2) + "\n", {flag: "wx"});
      const expectedCalls = cut === "after-response" ? 1 : cut === "after-finish" ? 2 : 0;
      assert.equal(marker.calls, expectedCalls, "CUT_TRANSPORT_COUNT_BOUNDARY");
      assert.equal(marker.ledgerPresent, cut !== "before-reserve");
      const expectedClaims = cut === "before-reserve" || cut === "after-reserve" ? 0 : cut === "after-finish" ? 2 : 1;
      assert.equal(marker.claimCount, expectedClaims);
      assert.equal(marker.rawCount, cut === "after-finish" ? 2 : 0);
      type SavedFile = {name: string; bytes: Buffer};
      const preserved: SavedFile[] = marker.files.map((entry: {name: string; bytes: number; digest: string}) => {
        assert(!entry.name.includes("/") && !entry.name.includes("\\") && entry.name !== "..");
        const bytes = fs.readFileSync(path.join(value.config.outputDirectory, entry.name));
        assert.equal(bytes.length, entry.bytes); assert.equal(hash(bytes), entry.digest, "CUT_MARKER_MATCHES_DURABLE_FILE");
        return {name: entry.name, bytes};
      });
      assert(preserved.some(entry => entry.name === "bootstrap.lock"), "PERSISTENT_LOCK_AT_EVERY_CUT");
      if (cut !== "before-reserve") assertHold(value.config);
      for (const saved of preserved.filter(entry => entry.name.endsWith(".attempt-1.claim.json"))) {
        assert.equal(JSON.parse(saved.bytes.toString("utf8")).state, "UNKNOWN");
      }
      const restartModes = expectedClaims > 0 ? ["persistent-lock", "operator-cleared-lock"] : ["persistent-lock"];
      for (const restartMode of restartModes) {
        if (restartMode === "operator-cleared-lock") await rm(path.join(value.config.outputDirectory, "bootstrap.lock"));
        const resumed = child(configFile);
        try {
          await resumed.wait("READY"); resumed.process_.send({type: "RELEASE"});
          const result = await resumed.wait("DONE"); await resumed.exit;
          assert.equal(result.calls, 0, "CRASH_RESTART_MUST_NOT_RESEND");
          assert.equal(result.status, "REJECTED");
          for (const saved of preserved) {
            if (saved.name === "bootstrap.lock" && restartMode === "operator-cleared-lock") continue;
            assert.deepEqual(fs.readFileSync(path.join(value.config.outputDirectory, saved.name)), saved.bytes, "CRASH_RESTART_PRESERVES_LEDGER_CLAIM_RAW_BYTES");
          }
          if (cut === "before-reserve") assert.equal(fs.existsSync(path.join(value.config.outputDirectory, "ledger.json")), false);
          const actualClaims = fs.readdirSync(value.config.outputDirectory).filter(name => name.endsWith(".attempt-1.claim.json"));
          assert.equal(actualClaims.length, expectedClaims, "RESTART_CANNOT_CREATE_ANOTHER_ATTEMPT");
        } finally {if (resumed.process_.exitCode === null && resumed.process_.signalCode === null) resumed.process_.kill();}
      }
      // No lock-cleared test for empty before-reserve: a first future dispatch is not a resend.
      checks.push(`actual child crash ${cut} preserves persistent run state and restart dispatch0`);
    } finally {if (cutter.process_.exitCode === null && cutter.process_.signalCode === null) cutter.process_.kill();}
  }
  console.log(JSON.stringify({status: "OFFLINE_PREPARED_REGRESSION_PASS", checks, actualApiCalls: 0, actualCredentialsRead: 0,
    scope: "same-local-physical-run-output-only", globalAccountCrossRunAtomicity: "UNSUPPORTED", qualification: "NOT_RUN"}, null, 2));
} finally {
  const resolved = path.resolve(root); assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
  assert(path.basename(resolved).startsWith("ags-prepared-regression-"));
  const dependencyLink = path.join(resolved, "source-copy/node_modules");
  if (fs.existsSync(dependencyLink)) {assert(fs.lstatSync(dependencyLink).isSymbolicLink()); await unlink(dependencyLink);}
  if (process.env.AGS_BOOTSTRAP_TEST_EVIDENCE_DIR) {
    const evidence = path.resolve(process.env.AGS_BOOTSTRAP_TEST_EVIDENCE_DIR);
    const relative = path.relative(resolved, evidence);
    assert(relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative), "EVIDENCE_OUTSIDE_OWNED_TEMP");
    await mkdir(evidence, {recursive: true}); await cp(resolved, path.join(evidence, path.basename(resolved)), {recursive: true});
  }
  // Dependency link was unlinked before evidence copy and recursive temporary cleanup.
  await rm(resolved, {recursive: true, force: true});
}
