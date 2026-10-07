import { DatabaseSync } from "node:sqlite";
import { canonicalJson, hashBytes, hashJson } from "../engineering-practices/io.mjs";
import { runObservedTimeTransaction, resolveInactiveSharedDatabasePath, SharedStateError } from "./shared-connection.mjs";

const APPLICATION_ID = 0x41475355;
const SCHEMA_VERSION = 1;
const CANDIDATE_TABLES = ["authority_time", "conflicts", "import_intents", "import_journal", "import_sources", "leases", "module_schema", "record_history", "records", "write_intents"];
const MODULE_VERSIONS = Object.freeze({ workflow: [5], continuity: [2, 3], board: [0], messaging: [1], trust: [1] });
const TABLES = Object.freeze({
  workflow_runs: { module: "workflow", keys: ["run_id"], revision: "revision" },
  continuity_tasks: { module: "continuity", keys: ["task_correlation"], epoch: "current_epoch" },
  continuity_snapshots: { module: "continuity", keys: ["task_correlation", "epoch"], revision: "revision", epoch: "epoch" },
  continuity_requests: { module: "continuity", keys: ["task_correlation", "epoch", "request_hash"], epoch: "epoch" },
  sessions: { module: "board", keys: ["host", "session_id"] },
  messages: { module: "messaging", keys: ["message_id"] },
  input_source_receipts: { module: "trust", keys: ["receipt_id"] },
});

export class UnifiedStateError extends Error {
  constructor(code, message) { super(message); this.name = "UnifiedStateError"; this.code = code; }
}
function need(condition, code, message) { if (!condition) throw new UnifiedStateError(code, message); }
function text(value, label) { need(typeof value === "string" && value.length > 0 && value.length <= 4096, "INVALID_INPUT", `${label}: a bounded string is required.`); return value; }
function integer(value, label, minimum = 0) { need(Number.isSafeInteger(value) && value >= minimum, "INVALID_INPUT", `${label}: a safe integer is required.`); return value; }
function scopeKey(scope) {
  need(scope && Object.keys(scope).sort().join(",") === "host,sessionId,taskId", "INVALID_SCOPE", "Exactly host/sessionId/taskId are required.");
  return canonicalJson({ host: text(scope.host, "host"), sessionId: text(scope.sessionId, "sessionId"), taskId: text(scope.taskId, "taskId") });
}
function rejectSecrets(value, depth = 0) {
  need(depth <= 64, "INVALID_INPUT", "Fixture JSON nesting must be bounded.");
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    need(!/secret|private.?key|signing.?key|access.?token|refresh.?token/iu.test(key), "SECRET_IMPORT_UNSUPPORTED", "Secret/key transfer is outside this inactive candidate.");
    rejectSecrets(child, depth + 1);
  }
}
function normalizeRecord(entry, boundScope) {
  need(entry && TABLES[entry.table], "UNSUPPORTED_TABLE", "This legacy table has no candidate fixture mapping.");
  const definition = TABLES[entry.table];
  need(entry.module === definition.module, "INVALID_INPUT", "Table/module mismatch.");
  need(scopeKey(entry.scope) === boundScope, "SCOPE_DENIED", "A source row cannot cross the bound fixture scope.");
  need(entry.row && Object.getPrototypeOf(entry.row) === Object.prototype, "INVALID_INPUT", "An explicit plain fixture row is required.");
  rejectSecrets(entry.row);
  for (const [column, value] of Object.entries(entry.row)) {
    if (column.endsWith("_json") && typeof value === "string") rejectSecrets(JSON.parse(value));
  }
  const key = Object.fromEntries(definition.keys.map((column) => {
    const value = entry.row[column];
    need(typeof value === "string" && value.length > 0 || Number.isSafeInteger(value) && value >= 0, "INVALID_INPUT", `Missing original key ${column}.`);
    return [column, value];
  }));
  if (["sessions", "input_source_receipts"].includes(entry.table)) {
    const scope = JSON.parse(boundScope);
    need(entry.row.host === scope.host && entry.row.session_id === scope.sessionId, "SCOPE_DENIED", "Original host/session do not match the bound scope.");
  }
  if (entry.table === "messages") {
    const scope = JSON.parse(boundScope);
    need(entry.row.target_host === scope.host && entry.row.target_session_id === scope.sessionId, "SCOPE_DENIED", "Message recipient does not match the bound scope.");
  }
  const revision = definition.revision ? integer(entry.row[definition.revision], "revision") : 0;
  const epoch = definition.epoch ? integer(entry.row[definition.epoch], "epoch", 1) : 0;
  const rowJson = JSON.stringify(entry.row);
  return { module: entry.module, table: entry.table, keyJson: canonicalJson(key), rowJson, payloadDigest: hashBytes(rowJson), revision, epoch };
}

/** No environment/vendor installation resolver and no legacy database or constructor access. */
export function resolveInactiveDatabasePath(directory) {
  try { return resolveInactiveSharedDatabasePath(directory); }
  catch (error) { if (error instanceof SharedStateError) throw new UnifiedStateError(error.code, error.message); throw error; }
}

/** Component candidate only: caller-bound fixture scopes are not authenticated host identities. */
export class InactiveUnifiedAuthority {
  #database;
  #clock;
  #fault;
  constructor({ directory, mode, clock = Date.now, fault = () => {} }) {
    need(mode === "fixture-only", "INACTIVE_MODE_REQUIRED", "Only explicit fixture-only mode is supported.");
    this.databasePath = resolveInactiveDatabasePath(directory);
    this.#clock = clock;
    this.#fault = fault;
    this.#database = new DatabaseSync(this.databasePath);
    try {
      const app = this.#database.prepare("PRAGMA application_id").get().application_id;
      const version = this.#database.prepare("PRAGMA user_version").get().user_version;
      const tables = this.#database.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all();
      need(app === APPLICATION_ID && version === SCHEMA_VERSION || app === 0 && version === 0 && tables.length === 0, "FOREIGN_OR_NEWER_DATABASE", "Existing files must already be this inactive candidate, or empty.");
      if (app === APPLICATION_ID) {
        need(canonicalJson(tables.map((table) => table.name).sort()) === canonicalJson(CANDIDATE_TABLES), "CANDIDATE_SCHEMA_DRIFT", "An existing candidate must retain all expected state tables.");
        const modules = this.#database.prepare("SELECT * FROM module_schema").all();
        need(modules.length === 5 && modules.every((module) => module.candidate_version === 1 && canonicalJson(JSON.parse(module.source_versions_json)) === canonicalJson(MODULE_VERSIONS[module.module])), "CANDIDATE_SCHEMA_DRIFT", "Stored module schema metadata must match the candidate version.");
      }
      this.#database.exec("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;");
      this.#database.exec("PRAGMA journal_mode=WAL;");
      this.#transaction(() => {
        this.#database.exec(`
          CREATE TABLE IF NOT EXISTS module_schema(module TEXT PRIMARY KEY, candidate_version INTEGER NOT NULL, source_versions_json TEXT NOT NULL) STRICT;
          CREATE TABLE IF NOT EXISTS authority_time(singleton INTEGER PRIMARY KEY CHECK(singleton=1), last_ms INTEGER NOT NULL CHECK(last_ms>=0)) STRICT;
          CREATE TABLE IF NOT EXISTS records(scope_key TEXT NOT NULL, module TEXT NOT NULL REFERENCES module_schema(module), source_id TEXT NOT NULL, table_name TEXT NOT NULL, key_json TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>=0), epoch INTEGER NOT NULL CHECK(epoch>=0), payload_digest TEXT NOT NULL, row_json TEXT NOT NULL, PRIMARY KEY(scope_key,module,source_id,table_name,key_json)) STRICT;
          CREATE TABLE IF NOT EXISTS record_history(scope_key TEXT NOT NULL, module TEXT NOT NULL, source_id TEXT NOT NULL, table_name TEXT NOT NULL, key_json TEXT NOT NULL, revision INTEGER NOT NULL, epoch INTEGER NOT NULL, payload_digest TEXT NOT NULL, row_json TEXT NOT NULL, PRIMARY KEY(scope_key,module,source_id,table_name,key_json,revision)) STRICT;
          CREATE TABLE IF NOT EXISTS import_sources(scope_key TEXT NOT NULL, source_id TEXT NOT NULL, source_digest TEXT NOT NULL, schema_json TEXT NOT NULL, PRIMARY KEY(scope_key,source_id)) STRICT;
          CREATE TABLE IF NOT EXISTS import_intents(scope_key TEXT NOT NULL, intent_id TEXT NOT NULL, source_id TEXT NOT NULL, source_digest TEXT NOT NULL, next_index INTEGER NOT NULL, total INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN ('PENDING','COMPLETE','CONFLICT')), PRIMARY KEY(scope_key,intent_id)) STRICT;
          CREATE TABLE IF NOT EXISTS import_journal(scope_key TEXT NOT NULL, intent_id TEXT NOT NULL, row_index INTEGER NOT NULL, payload_digest TEXT NOT NULL, outcome TEXT NOT NULL CHECK(outcome IN ('INSERTED','IDENTICAL')), PRIMARY KEY(scope_key,intent_id,row_index), FOREIGN KEY(scope_key,intent_id) REFERENCES import_intents(scope_key,intent_id)) STRICT;
          CREATE TABLE IF NOT EXISTS conflicts(scope_key TEXT NOT NULL, intent_id TEXT NOT NULL, row_index INTEGER NOT NULL, reason TEXT NOT NULL, existing_digest TEXT, incoming_digest TEXT NOT NULL, PRIMARY KEY(scope_key,intent_id,row_index,reason)) STRICT;
          CREATE TABLE IF NOT EXISTS leases(scope_key TEXT NOT NULL, module TEXT NOT NULL, source_id TEXT NOT NULL, table_name TEXT NOT NULL, key_json TEXT NOT NULL, generation INTEGER NOT NULL CHECK(generation>=1), owner TEXT NOT NULL, expires_ms INTEGER NOT NULL, PRIMARY KEY(scope_key,module,source_id,table_name,key_json)) STRICT;
          CREATE TABLE IF NOT EXISTS write_intents(scope_key TEXT NOT NULL, intent_id TEXT NOT NULL, command_digest TEXT NOT NULL, receipt_id TEXT NOT NULL, response_state TEXT NOT NULL CHECK(response_state IN ('UNKNOWN','ACKED')), result_json TEXT NOT NULL, PRIMARY KEY(scope_key,intent_id)) STRICT;
        `);
        for (const [module, versions] of Object.entries(MODULE_VERSIONS)) this.#database.prepare("INSERT OR IGNORE INTO module_schema VALUES (?,1,?)").run(module, JSON.stringify(versions));
        this.#database.prepare("INSERT OR IGNORE INTO authority_time VALUES (1,0)").run();
        this.#database.exec(`PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=${SCHEMA_VERSION};`);
      });
    } catch (error) { this.#database.close(); throw error; }
  }
  #transaction(action) {
    this.#database.exec("BEGIN IMMEDIATE");
    try { const result = action(); this.#database.exec("COMMIT"); return result; }
    catch (error) { this.#database.exec("ROLLBACK"); throw error; }
  }
  #observedTimeTransaction(action) {
    return runObservedTimeTransaction(this.#database, () => this.#now(), action);
  }
  #identity(scope, ref) {
    need(ref && TABLES[ref.table]?.module === ref.module, "UNSUPPORTED_TABLE", "An explicit supported record reference is required.");
    const keys = TABLES[ref.table].keys;
    need(ref.key && Object.keys(ref.key).sort().join(",") === [...keys].sort().join(","), "INVALID_INPUT", "Original primary key fields must be explicit.");
    if (ref.scope) need(scopeKey(ref.scope) === scope, "SCOPE_DENIED", "Cross-scope access is denied.");
    return [scope, ref.module, text(ref.sourceId, "sourceId"), ref.table, canonicalJson(ref.key)];
  }
  #now() {
    const observed = integer(this.#clock(), "clock");
    const previous = this.#database.prepare("SELECT last_ms FROM authority_time WHERE singleton=1").get().last_ms;
    const now = Math.max(previous, observed);
    this.#database.prepare("UPDATE authority_time SET last_ms=? WHERE singleton=1").run(now);
    return now;
  }
  #row(scope, ref) { return this.#database.prepare("SELECT * FROM records WHERE scope_key=? AND module=? AND source_id=? AND table_name=? AND key_json=?").get(...this.#identity(scope, ref)); }
  #decoded(row) { return row ? { sourceId: row.source_id, module: row.module, table: row.table_name, key: JSON.parse(row.key_json), revision: row.revision, epoch: row.epoch, payloadDigest: row.payload_digest, row: JSON.parse(row.row_json), trustVerification: "NOT_VERIFIED_BY_THIS_CANDIDATE" } : null; }
  bindProvider(scope) {
    const bound = scopeKey(scope);
    return Object.freeze({
      databasePath: this.databasePath,
      importFixture: (request) => this.#importFixture(bound, request),
      read: (ref) => this.#decoded(this.#row(bound, ref)),
      history: (ref) => this.#database.prepare("SELECT * FROM record_history WHERE scope_key=? AND module=? AND source_id=? AND table_name=? AND key_json=? ORDER BY revision").all(...this.#identity(bound, ref)).map((row) => this.#decoded(row)),
      claim: (ref, request) => this.#claim(bound, ref, request),
      commit: (ref, request) => this.#commit(bound, ref, request),
      receipt: (intentId) => this.#receipt(bound, intentId),
      acknowledge: (intentId, receiptId) => this.#database.prepare("UPDATE write_intents SET response_state='ACKED' WHERE scope_key=? AND intent_id=? AND receipt_id=? AND response_state='UNKNOWN'").run(bound, text(intentId, "intentId"), text(receiptId, "receiptId")).changes === 1,
    });
  }
  #importFixture(scope, { snapshotJson, sourceDigest, intentId, batchSize = 100 }) {
    text(intentId, "intentId");
    need(typeof snapshotJson === "string" && Buffer.byteLength(snapshotJson) <= 1024 * 1024, "INVALID_INPUT", "An explicit fixture snapshot of at most 1 MiB is required.");
    need(hashBytes(snapshotJson) === sourceDigest, "SOURCE_DIGEST_MISMATCH", "Source bytes and supplied digest must match.");
    const snapshot = JSON.parse(snapshotJson);
    text(snapshot.sourceId, "sourceId");
    need(Array.isArray(snapshot.records) && snapshot.records.length <= 1000, "INVALID_INPUT", "Fixture records must be bounded.");
    integer(batchSize, "batchSize", 1);
    need(batchSize <= 1000, "INVALID_INPUT", "A chunk must be bounded.");
    need(snapshot.moduleVersions && Object.keys(snapshot.moduleVersions).length > 0, "INVALID_INPUT", "Source module versions are required.");
    for (const [module, version] of Object.entries(snapshot.moduleVersions)) need(MODULE_VERSIONS[module]?.includes(version), "UNSUPPORTED_SCHEMA", `Unsupported ${module} source schema.`);
    const normalized = snapshot.records.map((entry) => {
      need(Object.hasOwn(snapshot.moduleVersions, entry.module), "INVALID_INPUT", "Every row must have a declared source schema.");
      return normalizeRecord(entry, scope);
    });
    return this.#transaction(() => {
      const prior = this.#database.prepare("SELECT * FROM import_intents WHERE scope_key=? AND intent_id=?").get(scope, intentId);
      const source = this.#database.prepare("SELECT * FROM import_sources WHERE scope_key=? AND source_id=?").get(scope, snapshot.sourceId);
      const conflict = (index, reason, existingDigest, incomingDigest, markIntent = true) => {
        this.#database.prepare("INSERT OR IGNORE INTO conflicts VALUES (?,?,?,?,?,?)").run(scope, intentId, index, reason, existingDigest ?? null, incomingDigest);
        if (!prior) this.#database.prepare("INSERT INTO import_intents VALUES (?,?,?,?,0,?,'CONFLICT')").run(scope, intentId, snapshot.sourceId, sourceDigest, normalized.length);
        else if (markIntent) this.#database.prepare("UPDATE import_intents SET state='CONFLICT' WHERE scope_key=? AND intent_id=?").run(scope, intentId);
        return { state: "CONFLICT", reason, nextIndex: prior?.next_index ?? 0 };
      };
      if (prior && (prior.source_id !== snapshot.sourceId || prior.source_digest !== sourceDigest)) return conflict(-1, "INTENT_SOURCE_CHANGED", prior.source_digest, sourceDigest, false);
      if (source && source.source_digest !== sourceDigest) return conflict(-1, "SOURCE_CHANGED", source.source_digest, sourceDigest);
      if (prior?.state === "CONFLICT") return { state: "CONFLICT", nextIndex: prior.next_index };
      if (prior?.state === "COMPLETE") return { state: "COMPLETE", nextIndex: prior.next_index, inserted: 0 };
      const start = prior?.next_index ?? 0;
      const end = Math.min(start + batchSize, normalized.length);
      const staged = new Map();
      for (let index = start; index < end; index++) {
        const row = normalized[index];
        const identity = canonicalJson([row.module, row.table, row.keyJson]);
        const existing = staged.get(identity) ?? this.#database.prepare("SELECT payload_digest FROM records WHERE scope_key=? AND module=? AND source_id=? AND table_name=? AND key_json=?").get(scope, row.module, snapshot.sourceId, row.table, row.keyJson);
        if (existing && existing.payload_digest !== row.payloadDigest) return conflict(index, "ROW_PAYLOAD_CONFLICT", existing.payload_digest, row.payloadDigest);
        staged.set(identity, { payload_digest: row.payloadDigest });
      }
      this.#database.prepare("INSERT OR IGNORE INTO import_sources VALUES (?,?,?,?)").run(scope, snapshot.sourceId, sourceDigest, JSON.stringify(snapshot.moduleVersions));
      this.#database.prepare("INSERT OR IGNORE INTO import_intents VALUES (?,?,?,?,0,?,'PENDING')").run(scope, intentId, snapshot.sourceId, sourceDigest, normalized.length);
      let inserted = 0;
      for (let index = start; index < end; index++) {
        const row = normalized[index];
        const args = [scope, row.module, snapshot.sourceId, row.table, row.keyJson, row.revision, row.epoch, row.payloadDigest, row.rowJson];
        const result = this.#database.prepare("INSERT OR IGNORE INTO records VALUES (?,?,?,?,?,?,?,?,?)").run(...args);
        if (result.changes === 1) {
          inserted++;
          this.#database.prepare("INSERT INTO record_history VALUES (?,?,?,?,?,?,?,?,?)").run(...args);
        }
        this.#fault("after-row-before-journal");
        this.#database.prepare("INSERT INTO import_journal VALUES (?,?,?,?,?)").run(scope, intentId, index, row.payloadDigest, result.changes === 1 ? "INSERTED" : "IDENTICAL");
      }
      const state = end === normalized.length ? "COMPLETE" : "PENDING";
      this.#database.prepare("UPDATE import_intents SET next_index=?,state=? WHERE scope_key=? AND intent_id=?").run(end, state, scope, intentId);
      this.#fault("after-marker-before-commit");
      return { state, nextIndex: end, inserted };
    });
  }
  #claim(scope, ref, { expectedRevision, owner, ttlMs }) {
    text(owner, "owner"); integer(expectedRevision, "expectedRevision"); integer(ttlMs, "ttlMs", 1);
    const identity = this.#identity(scope, ref);
    return this.#observedTimeTransaction((now) => {
      const record = this.#row(scope, ref);
      need(record?.revision === expectedRevision, "STALE_REVISION", "Claim requires the current revision.");
      const lease = this.#database.prepare("SELECT * FROM leases WHERE scope_key=? AND module=? AND source_id=? AND table_name=? AND key_json=?").get(...identity);
      if (lease && lease.expires_ms > now) return lease.owner === owner ? { generation: lease.generation, owner, expiresMs: lease.expires_ms } : null;
      const generation = (lease?.generation ?? 0) + 1;
      const expiresMs = integer(now + ttlMs, "expiresMs");
      this.#database.prepare("INSERT INTO leases VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(scope_key,module,source_id,table_name,key_json) DO UPDATE SET generation=excluded.generation,owner=excluded.owner,expires_ms=excluded.expires_ms").run(...identity, generation, owner, expiresMs);
      return { generation, owner, expiresMs };
    });
  }
  #receipt(scope, intentId) {
    const row = this.#database.prepare("SELECT * FROM write_intents WHERE scope_key=? AND intent_id=?").get(scope, text(intentId, "intentId"));
    return row ? { intentId, receiptId: row.receipt_id, effectState: "COMMITTED_LOCAL", responseState: row.response_state, result: JSON.parse(row.result_json) } : null;
  }
  #commit(scope, ref, { expectedRevision, lease, row, intentId, receiptId }) {
    text(intentId, "intentId"); text(receiptId, "receiptId"); integer(expectedRevision, "expectedRevision");
    need(lease && Number.isSafeInteger(lease.generation) && lease.generation > 0, "INVALID_INPUT", "A lease generation is required.");
    text(lease.owner, "lease.owner");
    const definition = TABLES[ref.table];
    need(definition?.revision, "MUTATION_UNSUPPORTED", "Only explicit revision-bearing fixture rows support candidate CAS.");
    const normalized = normalizeRecord({ module: ref.module, table: ref.table, row, scope: JSON.parse(scope) }, scope);
    need(normalized.keyJson === canonicalJson(ref.key) && normalized.revision === expectedRevision + 1, "INVALID_INPUT", "CAS must preserve original keys and increment the row revision once.");
    const identity = this.#identity(scope, ref);
    const commandDigest = hashJson({ ref, expectedRevision, lease, row, receiptId });
    const result = this.#observedTimeTransaction((now) => {
      const prior = this.#database.prepare("SELECT command_digest FROM write_intents WHERE scope_key=? AND intent_id=?").get(scope, intentId);
      if (prior) {
        need(prior.command_digest === commandDigest, "INTENT_CONFLICT", "Same intent with different command/payload is denied.");
        return { applied: false, receipt: this.#receipt(scope, intentId) };
      }
      const record = this.#row(scope, ref);
      need(record?.epoch === normalized.epoch, "EPOCH_CHANGE_UNSUPPORTED", "Epoch/correlation changes require a separate approved migration/rebind contract.");
      const update = this.#database.prepare(`UPDATE records SET revision=?,payload_digest=?,row_json=?
        WHERE scope_key=? AND module=? AND source_id=? AND table_name=? AND key_json=? AND revision=?
        AND EXISTS(SELECT 1 FROM leases WHERE scope_key=? AND module=? AND source_id=? AND table_name=? AND key_json=? AND generation=? AND owner=? AND expires_ms>?)`)
        .run(normalized.revision, normalized.payloadDigest, normalized.rowJson, ...identity, expectedRevision, ...identity, lease.generation, lease.owner, now);
      // A rejected write still commits the observed authority time, so a clock rollback cannot revive an expired lease.
      if (update.changes !== 1) return { rejected: true };
      this.#database.prepare("INSERT INTO record_history VALUES (?,?,?,?,?,?,?,?,?)").run(...identity, normalized.revision, normalized.epoch, normalized.payloadDigest, normalized.rowJson);
      const storedResult = JSON.stringify({ revision: normalized.revision, payloadDigest: normalized.payloadDigest });
      this.#database.prepare("INSERT INTO write_intents VALUES (?,?,?,?,'UNKNOWN',?)").run(scope, intentId, commandDigest, receiptId, storedResult);
      this.#fault("after-effect-before-receipt-commit");
      return { applied: true, receipt: this.#receipt(scope, intentId) };
    });
    need(!result.rejected, "STALE_REVISION_OR_LEASE", "Current revision and unexpired lease generation must match.");
    this.#fault("after-commit-before-response");
    return result;
  }
  inspect() {
    const tables = this.#database.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all();
    return { databasePath: this.databasePath, databases: this.#database.prepare("PRAGMA database_list").all(), userVersion: this.#database.prepare("PRAGMA user_version").get().user_version, modules: this.#database.prepare("SELECT * FROM module_schema ORDER BY module").all(), counts: Object.fromEntries(tables.map(({ name }) => [name, this.#database.prepare(`SELECT count(*) AS n FROM "${name.replaceAll('"', '""')}"`).get().n])), integrity: this.#database.prepare("PRAGMA integrity_check").all(), foreignKeyViolations: this.#database.prepare("PRAGMA foreign_key_check").all() };
  }
  close() { this.#database.close(); }
}

/** Provider adapters share the authority object; they never resolve/open another DB. */
export function createProviderAdapter(authority, fixtureScope) { return authority.bindProvider(fixtureScope); }
export function fixtureDigest(snapshotJson) { return hashBytes(snapshotJson); }
