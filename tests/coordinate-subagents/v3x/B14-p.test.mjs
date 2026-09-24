import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, copyFile, writeFile, readFile, rename, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, expect, test } from 'vitest';

const source = fileURLToPath(new URL('./probes/sqlite-identity/', import.meta.url));
let root;
afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });

test.skipIf(process.platform !== 'win32')('SQLite main xFileControl binds the opened handle before any schema write', async () => {
  root = await mkdtemp(join(tmpdir(), 'ags-b14p-'));
  const install = join(root, 'install');
  await mkdir(install);
  for (const name of ['run.mjs', 'probe.ps1']) await copyFile(join(source, name), join(install, name));
  expect((await readdir(install)).sort()).toEqual(['probe.ps1', 'run.mjs']);

  const database = join(root, 'resource.sqlite3');
  const replacement = join(root, 'replacement.sqlite3');
  const parked = join(root, 'parked.sqlite3');
  await writeFile(database, '');
  await writeFile(replacement, '');

  const invoke = (...args) => {
    const child = spawnSync(process.execPath, [join(install, 'run.mjs'), database, ...args], {
      cwd: install,
      encoding: 'utf8',
      env: { ...process.env, HOME: root, USERPROFILE: root, LOCALAPPDATA: root, XDG_STATE_HOME: root },
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
  expect((await readdir(root)).filter((name) => name.startsWith('resource.sqlite3'))).toEqual(['resource.sqlite3']);

  const observed = invoke();
  expect(observed.code).toBe(0);
  expect(observed.body.status).toBe('observed');
  expect(observed.body.wroteSchema).toBe(false);
  expect(observed.body.identity).toMatch(/^[0-9a-f]{16}:[0-9a-f]{32}$/);

  const accepted = invoke(observed.body.identity, '--write-schema');
  expect(accepted.code).toBe(0);
  expect(accepted.body).toMatchObject({ status: 'matched', identity: observed.body.identity, wroteSchema: true });
  expect((await readFile(database)).subarray(0, 16).toString()).toBe('SQLite format 3\0');

  await rename(database, parked);
  await rename(replacement, database);
  const before = await readFile(database);
  const rejected = invoke(observed.body.identity, '--write-schema');
  expect(rejected.code).toBe(2);
  expect(rejected.body).toMatchObject({ status: 'mismatch', wroteSchema: false });
  expect(rejected.body.identity).not.toBe(observed.body.identity);
  expect(await readFile(database)).toEqual(before);
  expect((await readdir(root)).filter((name) => name.startsWith('resource.sqlite3'))).toEqual(['resource.sqlite3']);
});
