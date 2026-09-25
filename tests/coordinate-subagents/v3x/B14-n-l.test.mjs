import { spawnSync } from 'node:child_process';
import { copyFile, link, mkdir, mkdtemp, readFile, rename, rm, statfs, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, expect, test } from 'vitest';

const helperDirectory = fileURLToPath(new URL('../../../scripts/qualification/resource-storage-linux-helper/', import.meta.url));
const fixture = fileURLToPath(new URL('./fixtures/resource-storage-provisioning/linux/classify-cases.json', import.meta.url));
const files = ['manifest.json', 'resource-storage-linux.c', 'resource-storage-linux', 'consume.mjs', 'build.mjs'];
const linux = process.platform === 'linux';
const roots = [];
afterAll(async () => { for (const root of roots) await rm(root, { recursive: true, force: true }); });

const load = async () => import(join(helperDirectory, 'consume.mjs'));
const temporary = async (parent = tmpdir()) => {
  const root = await mkdtemp(join(parent, 'ags-b14nl-'));
  roots.push(root);
  return root;
};
const copyHelper = async (root, name) => {
  const directory = join(root, name);
  await mkdir(directory);
  for (const file of files) await copyFile(join(helperDirectory, file), join(directory, file));
  return directory;
};

test.skipIf(!linux)('real handle identity reads generation, fsid and inode and fails closed', async () => {
  const { observeLinuxStorageIdentity: observe, sameStorageIdentity } = await load();
  const root = await temporary();
  const first = join(root, 'first.sqlite3');
  await writeFile(first, 'one');
  const observed = observe(first);
  if ((await statfs(root)).type !== 0xef53) {
    // Only ext4 is allowed; any other temp file system must be refused, not observed.
    expect(observed).toMatchObject({ status: 'UNSUPPORTED_FILESYSTEM', code: 'FILESYSTEM_NOT_ALLOWED' });
    return;
  }
  expect(observed).toMatchObject({
    status: 'OBSERVED', qualification: 'FIXTURE_ONLY', linkCount: 1, handleType: 1, handleBytes: 8,
    fileSystem: { magic: '0xef53', name: 'ext4' },
  });
  expect(observed.generation).not.toBe('00000000');
  expect(observed.identity).toMatch(/^[0-9a-f]{16}:[0-9a-f]{16}:00000001:[0-9a-f]{16}$/);
  expect(BigInt(`0x${observed.inode}`)).toBe((await import('node:fs')).statSync(first, { bigint: true }).ino);
  expect(sameStorageIdentity(observed, observe(first))).toBe(true);

  // Caller JSON or Node fstat values are never promoted to an expected identity.
  expect(() => observe(first, { expectedIdentity: observed.identity })).toThrow(/CALLER_FIELD_REJECTED/);
  expect(sameStorageIdentity(observed, { ...observed, schema: undefined })).toBe(false);
  expect(sameStorageIdentity(observed, observed.identity)).toBe(false);
  expect(sameStorageIdentity(observed, { ...observed, identity: `${observed.identity}00` })).toBe(false);

  const alias = join(root, 'alias.sqlite3');
  await link(first, alias);
  expect(observe(first)).toMatchObject({ status: 'BLOCKED_ALIAS', linkCount: 2, identity: observed.identity });
  expect(observe(alias)).toMatchObject({ status: 'BLOCKED_ALIAS', linkCount: 2, identity: observed.identity });
  await unlink(alias);

  const replacement = join(root, 'replacement.sqlite3');
  const parked = join(root, 'parked.sqlite3');
  await writeFile(replacement, 'two');
  await rename(first, parked);
  await rename(replacement, first);
  const swapped = observe(first);
  expect(swapped.status).toBe('OBSERVED');
  expect(sameStorageIdentity(swapped, observed)).toBe(false);
  expect(observe(parked).identity).toBe(observed.identity);

  // Delete and recreate: even if the inode number is reused, the generation differs.
  const recycled = join(root, 'recycled.sqlite3');
  await writeFile(recycled, 'a');
  const before = observe(recycled);
  await unlink(recycled);
  await writeFile(recycled, 'b');
  const after = observe(recycled);
  expect(after.status).toBe('OBSERVED');
  expect(after.identity).not.toBe(before.identity);

  const target = join(root, 'target');
  const linkedDirectory = join(root, 'linked');
  await mkdir(target);
  await writeFile(join(target, 'inside.sqlite3'), 'x');
  await symlink(target, linkedDirectory);
  await symlink(first, join(root, 'file-link.sqlite3'));
  expect(observe(join(linkedDirectory, 'inside.sqlite3'))).toMatchObject({ status: 'BLOCKED_SYMLINK', code: 'SYMLINK_IN_PATH' });
  expect(observe(join(root, 'file-link.sqlite3'))).toMatchObject({ status: 'BLOCKED_SYMLINK' });
  expect(observe('/proc/self/root' + first)).toMatchObject({ status: 'BLOCKED_SYMLINK' });
  expect(observe(target)).toMatchObject({ status: 'BLOCKED_NOT_REGULAR' });
  expect(observe(join(root, 'missing.sqlite3'))).toMatchObject({ status: 'UNKNOWN', code: 'OPEN_FAILED' });
  expect(observe('relative.sqlite3')).toMatchObject({ status: 'UNKNOWN', code: 'INVALID_PATH' });
});

test.skipIf(!linux)('volatile file systems are unsupported on a real handle', async () => {
  const { observeLinuxStorageIdentity: observe } = await load();
  let shm;
  try {
    if ((await statfs('/dev/shm')).type !== 0x01021994) return;
    shm = await temporary('/dev/shm');
  } catch {
    return;
  }
  await writeFile(join(shm, 'volatile.sqlite3'), 'x');
  expect(observe(join(shm, 'volatile.sqlite3'))).toMatchObject({
    status: 'UNSUPPORTED_FILESYSTEM', code: 'FILESYSTEM_NOT_ALLOWED', fileSystem: { name: 'tmpfs' },
  });
});

test.skipIf(!linux)('decision table blocks missing generation and unstable file systems', async () => {
  const { cases } = JSON.parse(await readFile(fixture, 'utf8'));
  for (const item of cases) {
    const child = spawnSync(join(helperDirectory, 'resource-storage-linux'),
      ['--classify-fixture', item.magic, item.handleType, item.handle, item.inode], { encoding: 'utf8', env: {} });
    expect(child.status, item.name).toBe(0);
    const body = JSON.parse(child.stdout);
    expect(body, item.name).toMatchObject({ mode: 'CLASSIFY_FIXTURE', status: item.status, code: item.code });
    expect(body.identity, item.name).toBeUndefined();
  }
});

test.skipIf(!linux)('helper source and artifact are bound to the manifest', async () => {
  const { observeLinuxStorageIdentity: observe } = await load();
  const manifest = JSON.parse(await readFile(join(helperDirectory, 'manifest.json'), 'utf8'));
  const root = await temporary();
  const target = join(root, 'target.sqlite3');
  await writeFile(target, 'x');

  const damaged = await copyHelper(root, 'damaged');
  const bytes = await readFile(join(damaged, manifest.artifact));
  bytes[bytes.length - 1] ^= 0xff;
  await writeFile(join(damaged, manifest.artifact), bytes);
  expect(observe(target, { helperDirectory: damaged })).toMatchObject({ status: 'UNKNOWN', code: 'HELPER_DIGEST_MISMATCH' });

  const changedSource = await copyHelper(root, 'changed-source');
  await writeFile(join(changedSource, manifest.source), 'different source');
  expect(observe(target, { helperDirectory: changedSource })).toMatchObject({ status: 'UNKNOWN', code: 'HELPER_DIGEST_MISMATCH' });

  const missingSource = await copyHelper(root, 'missing-source');
  await unlink(join(missingSource, manifest.source));
  expect(observe(target, { helperDirectory: missingSource })).toMatchObject({ status: 'UNKNOWN', code: 'HELPER_DIGEST_MISMATCH' });

  const { buildHelper, compilerVersion, COMPILE_FLAGS } = await import(join(helperDirectory, 'build.mjs'));
  expect(manifest.flags).toEqual([...COMPILE_FLAGS]);
  const compiler = compilerVersion();
  if (compiler === null) return;
  const built = buildHelper(await temporary());
  expect(built.sourceSha256).toBe(manifest.sourceSha256);
  if (compiler === manifest.compiler) expect(built.artifactSha256).toBe(manifest.artifactSha256);
});
