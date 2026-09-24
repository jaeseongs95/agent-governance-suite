import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, link, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, expect, test } from 'vitest';

const qualification = fileURLToPath(new URL('../../../scripts/qualification/', import.meta.url));
const shell = join(process.env.WINDIR ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const files = ['resource-storage-windows.ps1', 'resource-storage-windows.cs', 'resource-storage-windows.dll'];
let root;
afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });

test.skipIf(process.platform !== 'win32')('Windows handle identity and measured in-memory helper fail closed', async () => {
  root = await mkdtemp(join(tmpdir(), 'ags-b14nwa-'));
  const install = join(root, 'install');
  await mkdir(install);
  for (const name of files) await copyFile(join(qualification, name), join(install, name));
  const first = join(root, 'first.sqlite3');
  const alias = join(root, 'alias.sqlite3');
  const replacement = join(root, 'replacement.sqlite3');
  const parked = join(root, 'parked.sqlite3');
  await writeFile(first, 'one');
  await writeFile(replacement, 'two');

  const invoke = (path, directory = install) => {
    const child = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', join(directory, files[0]), '-Path', path], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        TEMP: join(root, 'nonexistent-temp'), TMP: join(root, 'nonexistent-temp'),
        WINDIR: join(root, 'spoofed-windir'),
      },
    });
    expect(child.error).toBeUndefined();
    expect(child.stderr.trim()).toBe('');
    return { code: child.status, body: JSON.parse(child.stdout.trim()) };
  };

  const observed = invoke(first);
  expect(observed.code).toBe(0);
  expect(observed.body).toMatchObject({ status: 'OBSERVED', qualification: 'FIXTURE_ONLY', linkCount: 1, reparse: false });
  expect(observed.body.identity).toMatch(/^[0-9a-f]{16}:[0-9a-f]{32}$/);

  const built = join(root, 'built');
  await mkdir(built);
  const build = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', join(qualification, 'build-resource-storage-windows.ps1'), '-OutputDirectory', built], {
    cwd: root, encoding: 'utf8',
  });
  expect(build.status, build.stderr).toBe(0);
  expect(build.stderr.trim()).toBe('');
  const hashes = JSON.parse(build.stdout.trim());
  const sha = (bytes) => createHash('sha256').update(bytes).digest('hex').toUpperCase();
  expect(hashes.sourceSha256).toBe(sha(await readFile(join(qualification, files[1]))));
  expect(hashes.artifactSha256).toBe(sha(await readFile(join(built, files[2]))));
  expect(hashes.normalizedArtifactSha256).toBe(hashes.normalizedCommittedSha256);

  await link(first, alias);
  const linked = invoke(first);
  const aliasResult = invoke(alias);
  expect(linked.code).toBe(2);
  expect(linked.body).toMatchObject({ status: 'BLOCKED_ALIAS', linkCount: 2, identity: observed.body.identity });
  expect(aliasResult.body).toMatchObject({ status: 'BLOCKED_ALIAS', linkCount: 2, identity: observed.body.identity });

  await rename(first, parked);
  await rename(replacement, first);
  const swapped = invoke(first);
  expect(swapped.code).toBe(0);
  expect(swapped.body.identity).not.toBe(observed.body.identity);
  expect(invoke(parked).body.identity).toBe(observed.body.identity);

  const targetDirectory = join(root, 'target');
  const junction = join(root, 'junction');
  await mkdir(targetDirectory);
  await symlink(targetDirectory, junction, 'junction');
  const reparse = invoke(junction);
  expect(reparse.code).toBe(2);
  expect(reparse.body).toMatchObject({ status: 'BLOCKED_REPARSE', reparse: true });
  await writeFile(join(targetDirectory, 'inside.sqlite3'), 'through junction');
  expect(invoke(join(junction, 'inside.sqlite3'))).toMatchObject({
    code: 2, body: { status: 'BLOCKED_REPARSE', reparse: true },
  });

  const missing = invoke(join(root, 'missing.sqlite3'));
  expect(missing.code).toBe(1);
  expect(missing.body).toMatchObject({ status: 'UNKNOWN', code: 'OPEN_FAILED' });

  const damaged = join(root, 'damaged');
  await mkdir(damaged);
  for (const name of files) await copyFile(join(qualification, name), join(damaged, name));
  const dllPath = join(damaged, files[2]);
  const dll = await readFile(dllPath);
  dll[0] ^= 0xff;
  await writeFile(dllPath, dll);
  expect(invoke(first, damaged)).toMatchObject({ code: 1, body: { status: 'UNKNOWN', code: 'LOADER_FAILED' } });

  const changedSource = join(root, 'changed-source');
  await mkdir(changedSource);
  for (const name of files) await copyFile(join(qualification, name), join(changedSource, name));
  await writeFile(join(changedSource, files[1]), 'different source');
  expect(invoke(first, changedSource)).toMatchObject({ code: 1, body: { status: 'UNKNOWN', code: 'LOADER_FAILED' } });

  const missingSource = join(root, 'missing-source');
  await mkdir(missingSource);
  for (const name of [files[0], files[2]]) await copyFile(join(qualification, name), join(missingSource, name));
  expect(invoke(first, missingSource)).toMatchObject({ code: 1, body: { status: 'UNKNOWN', code: 'LOADER_FAILED' } });
});
