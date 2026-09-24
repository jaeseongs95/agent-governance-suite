import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'vitest';

import * as install from '../../../scripts/qualification/v06-b3-linux-install.mjs';

const sha = (value) => createHash('sha256').update(value).digest('hex');
const linuxRoot = process.platform === 'linux' && process.getuid?.() === 0;
const FIXTURE_PARENT = process.env.AGS_V06_B3B_FIXTURE_PARENT;
const fixtureReady = linuxRoot && Boolean(FIXTURE_PARENT);
const unshareReady = fixtureReady && spawnSync('unshare', ['--mount', '--propagation', 'private', 'true']).status === 0;
const liveReady = linuxRoot && process.env.AGS_V06_B3B_R4_LIVE === '1';
const REPO = path.resolve(import.meta.dirname, '../../..');
const MODULE_URL = pathToFileURL(path.join(REPO, 'scripts/qualification/v06-b3-linux-install.mjs')).href;
const ARCHIVE = 'b'.repeat(64);
const MOUNT_LINE = (id, parent, dev, root, mountPoint, fstype = 'ext4') =>
  `${id} ${parent} ${dev} ${root} ${mountPoint} rw,relatime shared:1 - ${fstype} /dev/vda rw`;

function fixture() {
  const top = mkdtempSync(path.join(FIXTURE_PARENT, 'r4-'));
  chmodSync(top, 0o755);
  const src = path.join(top, 'src');
  const artifacts = { 'entry/a.mjs': 'a\n', 'lib/deep/c.json': '{}\n' };
  for (const [name, text] of Object.entries(artifacts)) {
    mkdirSync(path.join(src, path.dirname(name)), { recursive: true, mode: 0o755 });
    writeFileSync(path.join(src, name), text, { mode: 0o644 });
  }
  for (const name of [install.TRUST_PINS.v03i.manifestPath, install.TRUST_PINS.v2.docPath]) {
    mkdirSync(path.join(src, path.dirname(name)), { recursive: true, mode: 0o755 });
    copyFileSync(path.join(REPO, name), path.join(src, name));
    chmodSync(path.join(src, name), 0o644);
  }
  const hostBytes = Buffer.from(JSON.stringify({ format: 'agent-governance-suite.host-integration.v1',
    artifacts: Object.entries(artifacts).map(([name, text]) => ({ path: name, sha256: `sha256:${sha(text)}` })),
    entryPoints: ['mcp-server', 'scope-baseline', 'scope-compare', 'acceptance-cli'].map((id) => ({ id, path: 'entry/a.mjs',
      executionClosure: ['entry/a.mjs'] })) }));
  writeFileSync(path.join(src, 'host-integration.json'), hostBytes, { mode: 0o644 });
  const baseDir = path.join(top, 'usr', 'lib');
  mkdirSync(baseDir, { recursive: true, mode: 0o755 });
  const nodeBytes = readFileSync(process.execPath);
  const { record } = install.installProtectedRuntime({ baseDir, nodeVersion: '24.21.0', archiveSha256: ARCHIVE, nodeBytes,
    expectedNodeSha256: sha(nodeBytes), packageSource: src, trustedHostIntegrationSha256s: [sha(hostBytes)] });
  const verifyArgs = { baseDir, nodeVersion: '24.21.0', archiveSha256: ARCHIVE, expectedNodeSha256: sha(nodeBytes),
    releaseSha256: record.releaseSha256, trustedHostIntegrationSha256s: [sha(hostBytes)] };
  return { top, baseDir, record, verifyArgs };
}

test.skipIf(!fixtureReady)('mountinfo read or parse failure and unexpected boundary mounts are refused (injected mount table)', () => {
  const fx = fixture();
  try {
    const { suiteDir, installRoot, packageRoot } = fx.record.paths;
    const table = path.join(fx.top, 'mountinfo');
    const verifyWith = (lines) => { writeFileSync(table, `${lines.join('\n')}\n`); return () => install.verifyProtectedRuntime({ ...fx.verifyArgs, mountinfoFile: table }); };
    const root = MOUNT_LINE(1, 0, '254:0', '/', '/');
    assert.doesNotThrow(verifyWith([root, MOUNT_LINE(2, 1, '0:5', '/', '/proc', 'proc')]));
    assert.throws(() => install.verifyProtectedRuntime({ ...fx.verifyArgs, mountinfoFile: path.join(fx.top, 'missing') }), /mountinfo unavailable/);
    assert.throws(verifyWith(['garbage line without separator']), /mountinfo parse failure/);
    assert.throws(verifyWith([]), /mountinfo parse failure|no mount covers/);
    assert.throws(verifyWith([root, MOUNT_LINE(9, 1, '254:0', '/', packageRoot)]), /mount inside the protected subtree/);
    assert.throws(verifyWith([root, MOUNT_LINE(9, 1, '254:0', '/some/dir', installRoot)]), /mount inside the protected subtree/);
    assert.throws(verifyWith([root, MOUNT_LINE(9, 1, '0:41', '/', suiteDir, 'tmpfs')]), /mount inside the protected subtree/);
    assert.throws(verifyWith([root, MOUNT_LINE(9, 1, '254:0', '/elsewhere', fx.baseDir)]), /bind mount on a protected path ancestor/);
    assert.throws(verifyWith([root, MOUNT_LINE(9, 1, '254:1', '/', fx.top)]), /device/);
    assert.doesNotThrow(verifyWith([root, MOUNT_LINE(9, 1, '254:0', '/', fx.top)]));
    const record = install.verifyProtectedRuntime({ ...fx.verifyArgs, mountinfoFile: table });
    writeFileSync(table, `${[root, MOUNT_LINE(10, 1, '254:0', '/', fx.top)].join('\n')}\n`);
    assert.throws(() => install.runVerifiedRuntime(record, ['--version'], { mountinfoFile: table }), /mount boundary changed after verification/);
  } finally { rmSync(fx.top, { recursive: true, force: true }); }
});

// Real mounts, only inside a private mount namespace (unshare --mount --propagation private) on fixture paths.
const MOUNT_PROBE = `import { spawnSync } from 'node:child_process';import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
const m = await import(process.env.AGS_R4_MODULE);
const { verifyArgs, record, top } = JSON.parse(process.env.AGS_R4_INPUT);
const run = (cmd, args) => { const r = spawnSync(cmd, args, { encoding: 'utf8' }); if (r.status !== 0) throw new Error(cmd + ' ' + args.join(' ') + ': ' + r.stderr); };
const out = {};
const attempt = (key, fn) => { try { fn(); out[key] = 'ACCEPTED'; } catch (error) { out[key] = 'REJECTED: ' + error.message.split('\\n')[0]; } };
const paths = record.paths;
out.baseline = (() => { try { m.verifyProtectedRuntime(verifyArgs); return 'ACCEPTED'; } catch (e) { return 'REJECTED: ' + e.message; } })();
run('mount', ['--bind', paths.packageRoot, paths.packageRoot]);
out.sameDeviceMountinfo = readFileSync('/proc/self/mountinfo', 'utf8').split('\\n').filter((l) => l.includes(paths.packageRoot));
attempt('sameDeviceBind', () => m.verifyProtectedRuntime(verifyArgs));
run('umount', [paths.packageRoot]);
const snapshot = top + '/mountinfo.before-tmpfs';
writeFileSync(snapshot, readFileSync('/proc/self/mountinfo'));
run('mount', ['-t', 'tmpfs', '-o', 'mode=0755', 'none', paths.binDir]);
out.tmpfsDev = spawnSync('stat', ['-c', '%d', paths.binDir], { encoding: 'utf8' }).stdout.trim();
attempt('tmpfs', () => m.verifyProtectedRuntime(verifyArgs));
attempt('tmpfsWithStaleMountinfo', () => m.verifyProtectedRuntime({ ...verifyArgs, mountinfoFile: snapshot }));
run('umount', [paths.binDir]);
run('mount', ['--bind', verifyArgs.baseDir, verifyArgs.baseDir]);
attempt('ancestorBind', () => m.verifyProtectedRuntime(verifyArgs));
run('umount', [verifyArgs.baseDir]);
const verified = m.verifyProtectedRuntime(verifyArgs);
run('mount', ['--bind', paths.installRoot, paths.installRoot]);
attempt('changedBetweenVerifyAndUse', () => m.runVerifiedRuntime(verified, ['--version']));
run('umount', [paths.installRoot]);
attempt('useAfterRestore', () => m.runVerifiedRuntime(verified, ['--version']));
process.stdout.write(JSON.stringify(out));`;

test.skipIf(!unshareReady)('real bind/tmpfs mounts in a private namespace: same-device bind, other device, verify-to-use change are refused', () => {
  const fx = fixture();
  try {
    const before = sha(readFileSync('/proc/self/mountinfo'));
    const probe = spawnSync('unshare', ['--mount', '--propagation', 'private', process.execPath, '--input-type=module', '-e', MOUNT_PROBE],
      { encoding: 'utf8', env: { ...process.env, AGS_R4_MODULE: MODULE_URL,
        AGS_R4_INPUT: JSON.stringify({ verifyArgs: fx.verifyArgs, record: fx.record, top: fx.top }) } });
    assert.equal(probe.status, 0, probe.stderr);
    const out = JSON.parse(probe.stdout);
    process.stdout.write(`V06-b3b-r4 mount probe ${JSON.stringify(out)}\n`);
    assert.equal(sha(readFileSync('/proc/self/mountinfo')), before, 'host mount table must not change');
    assert.equal(out.baseline, 'ACCEPTED');
    assert.equal(out.sameDeviceMountinfo.length, 1);
    assert.match(out.sameDeviceBind, /REJECTED: .*mount inside the protected subtree/);
    assert.notEqual(out.tmpfsDev, String(lstatSync(fx.baseDir).dev));
    assert.match(out.tmpfs, /REJECTED: .*(mount inside the protected subtree|device)/);
    assert.match(out.tmpfsWithStaleMountinfo, /REJECTED: .*device/);
    assert.match(out.ancestorBind, /REJECTED: .*bind mount on a protected path ancestor/);
    assert.match(out.changedBetweenVerifyAndUse, /REJECTED: .*(mount boundary changed|mount inside the protected subtree)/);
    assert.equal(out.useAfterRestore, 'ACCEPTED');
  } finally { rmSync(fx.top, { recursive: true, force: true }); }
});

test.skipIf(!liveReady)('live read-only: both existing roots pass the mount boundary with the host mount table', () => {
  const PINNED = install.PINNED;
  const legacy = install.verifyInstalledNode({ baseDir: '/usr/lib', releaseSha256: PINNED.releaseSha256, expectedNodeSha256: PINNED.nodeSha256 });
  const v2 = install.verifyProtectedRuntime({ baseDir: '/usr/lib', nodeVersion: PINNED.version, archiveSha256: PINNED.releaseSha256,
    expectedNodeSha256: PINNED.nodeSha256, releaseSha256: '32a825d9da1c613e097e6246cf282b89777cc13d043fda3dd68113c1fc208edd' });
  const used = install.runVerifiedRuntime(v2, ['--version']);
  process.stdout.write(`V06-b3b-r4 live ${JSON.stringify({ legacy: legacy.identity, v2: v2.node.identity, boundary: v2.boundary, used })}\n`);
  assert.deepEqual([legacy.identity.ino, legacy.identity.nlink, legacy.sha256], ['516804', 1, PINNED.nodeSha256]);
  assert.deepEqual([v2.node.identity.ino, v2.node.identity.nlink, v2.package.files.length], ['516919', 1, 179]);
  assert.deepEqual([used.fdSha256, used.stdout], [PINNED.nodeSha256, `v${PINNED.version}`]);
});
