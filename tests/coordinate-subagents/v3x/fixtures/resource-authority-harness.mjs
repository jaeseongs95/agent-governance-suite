import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { clearTimeout, setTimeout } from 'node:timers';
import { setTimeout as delay } from 'node:timers/promises';

import { ResourcePoolsAdmissionStore } from '../../../../mcp-server/src/resource/admit-pools.ts';
import { resolveResourceAuthorityConfig } from '../../../../mcp-server/src/resource/authority-config.ts';
import { initializeResourceStoreSchema } from '../../../../mcp-server/src/resource/store-schema.ts';

const checkpoints = ['after-begin', 'before-commit', 'after-commit'];
const faults = ['barrier', 'crash'];
const fixtureUrl = new URL(import.meta.url);
const file = (root, id, suffix) => path.join(root, `${id}.${suffix}`);

function assertTemporaryRoot(root) {
  const actual = realpathSync(root);
  if (!lstatSync(root).isDirectory() || path.relative(actual, root) !== ''
    || path.relative(realpathSync(tmpdir()), path.dirname(actual)) !== ''
    || !path.basename(actual).startsWith('ags-b16a-')) {
    throw new Error('Harness requires its own temporary root.');
  }
}

function configFor(root) {
  assertTemporaryRoot(root);
  const shared = path.join(root, 'shared');
  if (lstatSync(shared).isSymbolicLink() || path.relative(shared, realpathSync(shared)) !== '') {
    throw new Error('Harness shared root must not redirect.');
  }
  const config = resolveResourceAuthorityConfig({ AGENT_GOVERNANCE_SHARED_STATE_DIR: shared }, process.platform, root);
  const relative = path.relative(root, config.databasePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)
    || (existsSync(config.databasePath) && lstatSync(config.databasePath).isSymbolicLink())) {
    throw new Error('Harness database path must remain inside its temporary root.');
  }
  return config;
}

function validateFault({ at, fault } = {}) {
  if (at === undefined && fault === undefined) return;
  if (!checkpoints.includes(at)) throw new Error('Unknown resource transaction checkpoint.');
  if (!faults.includes(fault)) throw new Error('Unknown resource transaction fault.');
}

/** Test-only: B06's real fork/connection pattern, with bounded faults around the existing admission transaction. */
export class ResourceAuthorityHarness {
  #workers = [];
  #closing;

  constructor(options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options)
      || Object.keys(options).some(key => key !== 'timeoutMs')) throw new Error('Unknown harness options.');
    const timeoutMs = options.timeoutMs ?? 5_000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000) {
      throw new Error('Harness timeout must be between 100 and 30000 ms.');
    }
    const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'ags-b16a-'));
    Object.defineProperties(this, { root: { value: root, enumerable: true }, timeoutMs: { value: timeoutMs } });
    try {
      mkdirSync(path.join(root, 'shared'));
      const config = Object.freeze(configFor(root));
      Object.defineProperty(this, 'config', { value: config, enumerable: true });
      const database = new DatabaseSync(config.databasePath);
      try { initializeResourceStoreSchema(database, config); } finally { database.close(); }
    } catch (error) { assertTemporaryRoot(root); rmSync(root, { recursive: true, force: true }); throw error; }
  }

  static async create(options) {
    const harness = new ResourceAuthorityHarness(options);
    try {
      // Sequential boot avoids turning schema setup into an unrelated migration race.
      for (let index = 0; index < 2; index += 1) {
        const child = fork(fixtureUrl, ['--resource-authority-worker', harness.root, String(harness.timeoutMs)], {
          execArgv: ['--import', 'tsx'], windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        });
        const worker = { child, pending: new Map(), stderr: '' };
        harness.#workers.push(worker);
        child.stderr.on('data', chunk => { worker.stderr = (worker.stderr + chunk).slice(-4_096); });
        worker.closed = new Promise(resolve => child.once('close', (code, signal) => {
          worker.ended = true;
          for (const waiter of worker.pending.values()) waiter.reject(new Error(`Harness process exited (${code ?? signal}): ${worker.stderr}`));
          worker.pending.clear();
          resolve({ pid: child.pid, code, signal });
        }));
        child.on('error', error => {
          for (const waiter of worker.pending.values()) waiter.reject(error);
          worker.pending.clear();
        });
        child.on('message', message => {
          const waiter = worker.pending.get(message.id);
          if (!waiter) return;
          if (message.error) waiter.reject(new Error(message.error)); else waiter.resolve(message.result);
        });
        await harness.#response(index, 'ready');
      }
      return harness;
    } catch (error) { await harness.close(); throw error; }
  }

  get children() { return this.#workers.map(worker => worker.child); }

  #response(index, id, message) {
    const worker = this.#workers[index];
    if (!worker || worker.ended || this.#closing) return Promise.reject(new Error('Harness process is unavailable.'));
    return new Promise((resolve, reject) => {
      const settle = callback => value => { clearTimeout(timer); worker.pending.delete(id); callback(value); };
      const timer = setTimeout(() => {
        // Reject only after every child is reaped and the disposable files are removed.
        worker.pending.delete(id);
        this.close().then(() => reject(new Error('Harness operation timed out.')), reject);
      }, this.timeoutMs);
      worker.pending.set(id, { resolve: settle(resolve), reject: settle(reject) });
      if (message) worker.child.send({ ...message, id }, error => {
        if (error) worker.pending.get(id)?.reject(error);
      });
    });
  }

  request(index, message) { return this.#response(index, randomUUID(), message); }

  async configure(input) {
    await Promise.all(this.children.map((_child, index) => this.request(index, { ...input, type: 'configure' })));
  }

  admit(index, request, fault = {}) {
    validateFault(fault);
    const id = randomUUID();
    const result = this.#response(index, id, { type: 'admit', request, ...fault });
    const wait = async suffix => {
      const target = file(this.root, id, suffix);
      const deadline = Date.now() + this.timeoutMs;
      while (!existsSync(target)) {
        if (Date.now() >= deadline || this.#closing) throw new Error(`Harness ${suffix} checkpoint was not reached.`);
        await delay(10);
      }
      return JSON.parse(readFileSync(target, 'utf8'));
    };
    return { result, started: () => wait('started'), reached: () => wait('reached'),
      release: () => writeFileSync(file(this.root, id, 'release'), '', { flag: 'wx' }) };
  }

  close() {
    this.#closing ??= (async () => {
      for (const worker of this.#workers) if (!worker.ended) worker.child.kill('SIGKILL');
      const exits = await Promise.all(this.#workers.map(worker => worker.closed));
      assertTemporaryRoot(this.root);
      rmSync(this.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      return exits;
    })();
    return this.#closing;
  }
}

function runWorker(root, timeoutMs) {
  const config = configFor(root);
  const database = new DatabaseSync(config.databasePath);
  initializeResourceStoreSchema(database, config);
  const connectionToken = randomUUID();
  database.exec('CREATE TEMP TABLE harness_connection (token TEXT, marker TEXT);');
  database.prepare('INSERT INTO harness_connection VALUES (?, NULL)').run(connectionToken);
  let store;
  let active;
  const checkpoint = at => {
    if (active?.at !== at) return;
    writeFileSync(file(root, active.id, 'reached'), JSON.stringify({ at, pid: process.pid }), { flag: 'wx' });
    if (active.fault === 'crash') process.exit(73);
    const signal = new Int32Array(new SharedArrayBuffer(4));
    const deadline = Date.now() + timeoutMs * 2;
    while (!existsSync(file(root, active.id, 'release'))) {
      if (Date.now() >= deadline) throw new Error('Harness barrier release timed out.');
      Atomics.wait(signal, 0, 0, 10);
    }
  };
  const observedDatabase = new Proxy(database, {
    get(target, key) {
      if (key === 'exec') return sql => {
        const normalized = sql.trim().toUpperCase();
        if (normalized === 'BEGIN IMMEDIATE;' && active) {
          writeFileSync(file(root, active.id, 'started'), JSON.stringify({ pid: process.pid }), { flag: 'wx' });
        }
        if (normalized === 'COMMIT;') checkpoint('before-commit');
        const result = target.exec(sql);
        if (normalized === 'BEGIN IMMEDIATE;') checkpoint('after-begin');
        if (normalized === 'COMMIT;') checkpoint('after-commit');
        return result;
      };
      const value = target[key];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  process.on('message', message => {
    try {
      if (['databasePath', 'root', 'config', 'environment'].some(key => Object.hasOwn(message, key))) {
        throw new Error('Caller database path or root is forbidden.');
      }
      let result;
      if (message.type === 'configure') {
        store = new ResourcePoolsAdmissionStore(observedDatabase, config, message.policies, () => message.now);
        result = { pid: process.pid };
      } else if (message.type === 'inspect') {
        const connection = database.prepare('SELECT token, marker FROM temp.harness_connection').get();
        result = { pid: process.pid, databasePath: config.databasePath,
          realmId: database.prepare('SELECT realm_id FROM resource_authority').get().realm_id,
          connectionToken: connection.token, marker: connection.marker,
          ...Object.fromEntries([['reservations', 'resource_reservations'], ['holds', 'resource_reservation_holds'],
            ['requests', 'resource_admission_requests']].map(([key, table]) =>
            [key, database.prepare(`SELECT count(*) AS n FROM ${table}`).get().n])) };
      } else if (message.type === 'marker') {
        database.prepare('UPDATE temp.harness_connection SET marker = ?').run(message.value);
        result = { pid: process.pid };
      } else if (message.type === 'admit') {
        validateFault(message);
        if (!store) throw new Error('Harness admission is not configured.');
        if (!/^[0-9a-f-]{36}$/u.test(message.id)) throw new Error('Invalid harness operation id.');
        active = message;
        try { result = store.admitIdempotent(message.request); } finally { active = undefined; }
      } else throw new Error('Unknown harness operation.');
      process.send({ id: message.id, result });
    } catch (error) { process.send({ id: message.id, error: error.message }); }
  });
  process.on('disconnect', () => { database.close(); process.exit(0); });
  process.send({ id: 'ready', result: { pid: process.pid } });
}

if (process.argv[2] === '--resource-authority-worker') {
  const timeoutMs = Number(process.argv[4]);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000) throw new Error('Invalid worker timeout.');
  runWorker(process.argv[3], timeoutMs);
}
