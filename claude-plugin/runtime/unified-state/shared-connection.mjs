import { existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const APPLICATION_ID = 0x4147534e; // AGSN: inactive native format, distinct from R1 opaque fixtures.
const FORMAT_VERSION = 1;
const MODULES = Object.freeze({
  workflow: { version: 5, tables: ["workflow_metadata", "workflow_runs", "plugin_update_state", "convergence_roots", "convergence_root_identities", "convergence_epochs", "convergence_leases", "convergence_attempts", "convergence_reviews", "workflow_attempt_links", "state_cleanup_claims", "execution_observation_claims"] },
  continuity: { version: 2, tables: ["continuity_metadata", "continuity_tasks", "continuity_snapshots", "continuity_requests", "continuity_tombstones", "continuity_observations"] },
  messaging: { version: 1, tables: ["messages", "relay_leases", "wake_nonces", "session_presence", "prepared_messages", "input_observations", "session_activity"] },
  trust: { version: 1, tables: ["trust_metadata", "input_source_receipts"] },
  board: { version: 0, tables: ["sessions"] },
});
export class SharedStateError extends Error {
  constructor(code, message) { super(message); this.name = "SharedStateError"; this.code = code; }
}
function need(condition, code, message) { if (!condition) throw new SharedStateError(code, message); }
function milliseconds(value) { need(Number.isSafeInteger(value) && value >= 0, "INVALID_CLOCK", "A nonnegative safe integer clock is required."); return value; }
function synchronous(value) { need(!value || typeof value.then !== "function", "ASYNC_TRANSACTION_UNSUPPORTED", "SQLite transaction callbacks must be synchronous."); return value; }

export function resolveInactiveSharedDatabasePath(directory) {
  need(path.isAbsolute(directory) && !directory.startsWith("\\\\"), "INVALID_PATH", "An explicit local, caller-owned inactive directory is required.");
  mkdirSync(directory, { recursive: true });
  need(!lstatSync(directory).isSymbolicLink(), "INVALID_PATH", "The candidate directory must not be a symlink.");
  const filename = path.join(realpathSync(directory), "ags-state.sqlite3");
  if (existsSync(filename)) need(!lstatSync(filename).isSymbolicLink() && lstatSync(filename).nlink === 1, "INVALID_PATH", "The candidate DB must not be linked.");
  return filename;
}

/** Durable observation outside the domain savepoint, with one writer lock throughout. */
export function runObservedTimeTransaction(database, observe, operation, afterDomain = () => {}) {
  database.exec("BEGIN IMMEDIATE");
  let result;
  let rejected = false;
  let rejection;
  try {
    const now = observe();
    database.exec("SAVEPOINT domain_operation");
    try { result = synchronous(operation(now)); }
    catch (error) { rejected = true; rejection = error; database.exec("ROLLBACK TO domain_operation"); }
    database.exec("RELEASE domain_operation");
    afterDomain();
    database.exec("COMMIT");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* Preserve the clock/storage failure. */ }
    throw error;
  }
  if (rejected) throw rejection;
  return result;
}

/** One caller-owned, inactive SQLite connection; no profile, env, service or credential lookup. */
export class InactiveSharedConnection {
  #database;
  #clock;
  #closed = false;
  #initializing = false;
  #counter = 0;
  #highWater = 0;
  #ready = false;
  constructor({ databasePath, mode, clock = Date.now }) {
    need(mode === "fixture-only", "INACTIVE_MODE_REQUIRED", "Only explicit fixture-only mode is supported.");
    need(typeof databasePath === "string" && path.isAbsolute(databasePath) && !databasePath.startsWith("\\\\"), "INVALID_PATH", "An explicit local inactive file is required.");
    need(typeof clock === "function", "INVALID_CLOCK", "An explicit clock function is required.");
    if (existsSync(databasePath)) need(!lstatSync(databasePath).isSymbolicLink() && lstatSync(databasePath).nlink === 1, "INVALID_PATH", "The inactive DB must not be linked.");
    this.databasePath = databasePath;
    this.#clock = clock;
    this.#database = new DatabaseSync(databasePath);
    try {
      this.#database.exec("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;");
      this.#database.exec("BEGIN IMMEDIATE");
      this.#ready = this.#validateFormat();
      this.#database.exec("COMMIT");
    } catch (error) { this.#database.close(); throw error; }
  }
  #open() { need(!this.#closed, "CONNECTION_CLOSED", "The shared owner is closed."); }
  #tables() { return this.#database.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name <> 'sqlite_sequence' ORDER BY name").all().map(row => row.name); }
  #validateFormat() {
    const app = this.#database.prepare("PRAGMA application_id").get().application_id;
    const version = this.#database.prepare("PRAGMA user_version").get().user_version;
    const empty = app === 0 && version === 0 && this.#tables().length === 0;
    need(empty || app === APPLICATION_ID && version === FORMAT_VERSION, "FOREIGN_OR_NEWER_DATABASE", "Only empty or matching inactive native-format files are supported.");
    if (!empty) this.#validate();
    return !empty;
  }
  #shape(module) {
    return JSON.stringify(MODULES[module].tables.map(name => ({ name, columns: this.#database.prepare(`PRAGMA table_info(${name})`).all(), sql: this.#database.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name=?").get(name)?.sql })));
  }
  #validate() {
    const expected = ["authority_time", "shared_module_schema", ...Object.values(MODULES).flatMap(module => module.tables)].sort();
    need(JSON.stringify(this.#tables()) === JSON.stringify(expected), "SHARED_SCHEMA_DRIFT", "The native-format table inventory is incomplete or changed.");
    const rows = this.#database.prepare("SELECT * FROM shared_module_schema ORDER BY module").all();
    need(rows.length === 5 && rows.every(row => MODULES[row.module]?.version === row.version && row.schema_json === this.#shape(row.module)), "SHARED_SCHEMA_DRIFT", "Module versions and native schemas must match their committed headers.");
    const times = this.#database.prepare("SELECT * FROM authority_time").all();
    need(times.length === 1 && times[0].singleton === 1 && Number.isSafeInteger(times[0].last_ms) && times[0].last_ms >= 0, "SHARED_SCHEMA_DRIFT", "Authority clock metadata is invalid.");
  }
  initialize(operation) {
    this.#open();
    this.#database.exec("BEGIN IMMEDIATE");
    this.#initializing = true;
    try {
      this.#validateFormat();
      this.#database.exec("CREATE TABLE IF NOT EXISTS shared_module_schema(module TEXT PRIMARY KEY, version INTEGER NOT NULL, schema_json TEXT NOT NULL) STRICT; CREATE TABLE IF NOT EXISTS authority_time(singleton INTEGER PRIMARY KEY CHECK(singleton=1), last_ms INTEGER NOT NULL CHECK(last_ms>=0)) STRICT; INSERT OR IGNORE INTO authority_time VALUES(1,0);");
      synchronous(operation());
      this.#validate();
      this.#database.exec(`PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=${FORMAT_VERSION}; COMMIT;`);
      this.#ready = true;
      this.#database.exec("PRAGMA journal_mode=WAL;");
    } catch (error) { try { this.#database.exec("ROLLBACK"); } catch { /* Primary error wins. */ } throw error; }
    finally { this.#initializing = false; }
  }
  #observe(value) {
    const observed = milliseconds(value);
    const previous = this.#database.prepare("SELECT last_ms FROM authority_time WHERE singleton=1").get().last_ms;
    this.#highWater = Math.max(this.#highWater, previous, observed);
    this.#database.prepare("UPDATE authority_time SET last_ms=? WHERE singleton=1").run(this.#highWater);
    return this.#highWater;
  }
  transaction(operation) {
    this.#open();
    need(this.#ready || this.#initializing, "SCHEMA_NOT_READY", "All module schemas must be initialized before domain work.");
    if (this.#database.isTransaction) {
      const savepoint = `shared_${++this.#counter}`;
      this.#database.exec(`SAVEPOINT ${savepoint}`);
      try { const result = synchronous(operation()); this.#database.exec(`RELEASE ${savepoint}`); return result; }
      catch (error) { this.#database.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint};`); throw error; }
    }
    // Nested observations are also retained after an outer domain rollback, under the same writer lock.
    this.#highWater = 0;
    return runObservedTimeTransaction(this.#database, () => this.#observe(this.#clock()), operation, () => this.#observe(this.#highWater));
  }
  borrow(module) {
    this.#open();
    need(Object.hasOwn(MODULES, module), "UNKNOWN_MODULE", "A supported module is required.");
    let closed = false;
    const check = () => { this.#open(); need(!closed, "ADAPTER_CLOSED", "The borrowed module handle is closed."); };
    const inTransaction = () => { check(); return this.#database.isTransaction; };
    const sqlCheck = sql => { check(); need(!/\b(?:BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|ATTACH|DETACH)\b|PRAGMA\s+(?:user_version|application_id|journal_mode)\s*=/iu.test(sql), "OWNER_SQL_REQUIRED", "Connection control belongs to the shared owner."); };
    const database = {
      exec: sql => { sqlCheck(sql); return this.#database.exec(sql); },
      prepare: sql => {
        sqlCheck(sql);
        const statement = this.#database.prepare(sql);
        return Object.freeze({ get: (...args) => { check(); return statement.get(...args); }, all: (...args) => { check(); return statement.all(...args); }, run: (...args) => { check(); return statement.run(...args); } });
      },
      close: () => { closed = true; },
      transaction: operation => { check(); return this.transaction(operation); },
      get inTransaction() { return inTransaction(); },
    };
    return Object.freeze({
      isShared: true,
      databasePath: this.databasePath,
      database: Object.freeze(database),
      get inTransaction() { return inTransaction(); },
      getSchemaVersion: () => { check(); return this.#database.prepare("SELECT version FROM shared_module_schema WHERE module=?").get(module)?.version ?? 0; },
      setSchemaVersion: version => { check(); need(this.#initializing && version === MODULES[module].version, "MODULE_VERSION_CONFLICT", "Only the declared module version may be initialized."); this.#database.prepare("INSERT INTO shared_module_schema VALUES(?,?,'') ON CONFLICT(module) DO UPDATE SET version=excluded.version").run(module, version); },
      initialize: operation => { check(); need(this.#initializing, "OWNER_SCHEMA_REQUIRED", "Module initialization must belong to the owner's atomic assembly."); synchronous(operation()); this.#database.prepare("UPDATE shared_module_schema SET schema_json=? WHERE module=?").run(this.#shape(module), module); },
      transaction: operation => { check(); return this.transaction(operation); },
      time: value => { check(); need(this.#database.isTransaction, "TIME_TRANSACTION_REQUIRED", "Time and expiry decisions require the writer transaction."); return this.#observe(Math.max(milliseconds(value), milliseconds(this.#clock()))); },
    });
  }
  inspect() {
    this.#open();
    return { databasePath: this.databasePath, databases: this.#database.prepare("PRAGMA database_list").all(), userVersion: this.#database.prepare("PRAGMA user_version").get().user_version, modules: this.#database.prepare("SELECT * FROM shared_module_schema ORDER BY module").all(), counts: Object.fromEntries(this.#tables().map(name => [name, this.#database.prepare(`SELECT count(*) AS n FROM ${name}`).get().n])), time: this.#database.prepare("SELECT last_ms FROM authority_time").get().last_ms, integrity: this.#database.prepare("PRAGMA integrity_check").all(), foreignKeyViolations: this.#database.prepare("PRAGMA foreign_key_check").all() };
  }
  close() { if (!this.#closed) { this.#database.close(); this.#closed = true; } }
}
