import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, copyFile, writeFile, readFile, rename, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, expect, test } from 'vitest';

const source = fileURLToPath(new URL('./', import.meta.url));
let root;
afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });

test.skipIf(process.platform !== 'linux')('Linux SQLite unix VFS xOpen fd identity gates the first schema write', async () => {
  root = await mkdtemp(join(tmpdir(), 'ags-b14pl-'));
  const install = join(root, 'install');
  await mkdir(install);
  for (const name of ['run.mjs', 'probe.py']) await copyFile(join(source, name), join(install, name));
  expect((await readdir(install)).sort()).toEqual(['probe.py', 'run.mjs']);

  const database = join(root, 'resource.sqlite3');
  const replacement = join(root, 'replacement.sqlite3');
  const parked = join(root, 'parked.sqlite3');
  await writeFile(database, '');
  await writeFile(replacement, '');
  const sidecars = async () => (await readdir(root)).filter((name) => name.startsWith('resource.sqlite3')).sort();

  const invoke = (...args) => invokeWith({}, ...args);
  const invokeWith = (extra, ...args) => {
    const child = spawnSync(process.execPath, [join(install, 'run.mjs'), database, ...args], {
      cwd: install,
      encoding: 'utf8',
      env: { ...process.env, HOME: root, XDG_STATE_HOME: root, ...extra },
    });
    expect(child.error).toBeUndefined();
    expect(child.stderr).toBe('');
    return { code: child.status, body: JSON.parse(child.stdout.trim()) };
  };

  const noExpected = invoke('', '--write-schema');
  expect(noExpected.code).toBe(1);
  expect(noExpected.body.status).toBe('error');
  expect(noExpected.body.message).toMatch(/Expected identity is required/);
  expect(await readFile(database)).toEqual(Buffer.alloc(0));
  expect(await sidecars()).toEqual(['resource.sqlite3']);

  const observed = invoke();
  expect(observed.code).toBe(0);
  expect(observed.body).toMatchObject({ status: 'observed', wroteSchema: false, vfs: 'unix' });
  expect(observed.body.identity).toMatch(/^[0-9a-f]{16}:[0-9a-f]{16}$/);
  expect(observed.body.fd).toBeGreaterThanOrEqual(3);
  expect(observed.body.fdPath).toBe(database);
  expect(observed.body.library).toMatch(/libsqlite3\.so/);
  // The identity is taken from the fd SQLite's own xOpen obtained; it must name the same inode as the path.
  const info = await stat(database, { bigint: true });
  const [dev, ino] = observed.body.identity.split(':').map((part) => BigInt(`0x${part}`));
  expect([dev, ino]).toEqual([info.dev, info.ino]);

  const accepted = invoke(observed.body.identity, '--write-schema');
  expect(accepted.code).toBe(0);
  expect(accepted.body).toMatchObject({ status: 'matched', identity: observed.body.identity, wroteSchema: true });
  expect((await readFile(database)).subarray(0, 16).toString()).toBe('SQLite format 3\0');
  expect(await sidecars()).toEqual(['resource.sqlite3']);

  // Replacement: a different file renamed onto the path is rejected before any SQL runs.
  await rename(database, parked);
  await rename(replacement, database);
  const replaced = await readFile(database);
  const rejected = invoke(observed.body.identity, '--write-schema');
  expect(rejected.code).toBe(2);
  expect(rejected.body).toMatchObject({ status: 'mismatch', wroteSchema: false });
  expect(rejected.body.identity).not.toBe(observed.body.identity);
  expect(await readFile(database)).toEqual(replaced);
  expect(await sidecars()).toEqual(['resource.sqlite3']);

  // Restore by copy: identical bytes under a new inode are still rejected.
  await rm(database);
  await copyFile(parked, database);
  const restoredBytes = await readFile(database);
  expect(restoredBytes).toEqual(await readFile(parked));
  const restored = invoke(observed.body.identity, '--write-schema');
  expect(restored.code).toBe(2);
  expect(restored.body).toMatchObject({ status: 'mismatch', wroteSchema: false });
  expect(await readFile(database)).toEqual(restoredBytes);
  expect(await sidecars()).toEqual(['resource.sqlite3']);

  // Moving the original inode back keeps its identity; the check follows the opened file, not the path.
  await rm(database);
  await rename(parked, database);
  const movedBack = invoke(observed.body.identity);
  expect(movedBack.code).toBe(0);
  expect(movedBack.body).toMatchObject({ status: 'matched', identity: observed.body.identity, wroteSchema: false });

  // Race after open: the path now names another inode, but the comparison and the write stay on SQLite's fd.
  const racePark = join(root, 'race-parked.sqlite3');
  const raceReplacement = join(root, 'race-replacement.sqlite3');
  await rename(database, join(root, 'original.sqlite3')); // keep the inode alive so it cannot be reused
  await writeFile(database, '');
  await writeFile(raceReplacement, '');
  const fresh = invoke();
  expect(fresh.code).toBe(0);
  expect(fresh.body.identity).not.toBe(observed.body.identity);
  const raced = invokeWith({ B14PL_SWAP_AFTER_OPEN: JSON.stringify([racePark, raceReplacement]) },
    fresh.body.identity, '--write-schema');
  expect(raced.body).toMatchObject({ status: 'matched', identity: fresh.body.identity, wroteSchema: true });
  expect(raced.code).toBe(0);
  expect(raced.body.fdPath).toBe(racePark);
  expect(await readFile(database)).toEqual(Buffer.alloc(0));
  expect((await readFile(racePark)).subarray(0, 16).toString()).toBe('SQLite format 3\0');
  expect(await sidecars()).toEqual(['resource.sqlite3']);
});
