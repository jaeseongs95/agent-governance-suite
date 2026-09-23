import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'vitest';
import {
  buildHostIntegrationDescriptor, parseHostIntegrationManifest,
} from '../../../mcp-server/src/host-integration/manifest.ts';

function packageRoot() {
  const root = mkdtempSync(path.join(tmpdir(), 'ags-host-integration-'));
  mkdirSync(path.join(root, 'bin'));
  writeFileSync(path.join(root, 'bin', 'server.mjs'), '');
  return root;
}

const entry = () => ({ id: 'mcp-server', path: 'bin/server.mjs', executionClosure: ['bin/server.mjs'] });
const manifest = () => ({ format: 'agent-governance-suite.host-integration.v1', entryPoints: [entry()] });

test('accepts an existing package-relative entry point without claiming execution success', () => {
  const root = packageRoot();
  try {
    assert.deepEqual(parseHostIntegrationManifest(manifest(), root), manifest());
    const descriptor = buildHostIntegrationDescriptor(root, [
      { ...entry(), enabled: true },
      { id: 'host-attestation-cli', path: 'bin/sign.mjs', executionClosure: ['bin/sign.mjs'], enabled: false },
    ]);
    assert.deepEqual(descriptor.manifest.entryPoints, [entry()]);
    assert.deepEqual(descriptor.disabledEntryPoints, ['host-attestation-cli']);
    assert.equal('features' in descriptor.manifest, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('rejects missing fields and unsupported protocol version', () => {
  const root = packageRoot();
  try {
    const missing = manifest(); delete missing.entryPoints[0].executionClosure;
    assert.throws(() => parseHostIntegrationManifest(missing, root), /Invalid host-integration manifest/);
    assert.throws(() => parseHostIntegrationManifest({ ...manifest(), format: 'agent-governance-suite.host-integration.v2' }, root));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('rejects relative path escape, symlink escape, and nonexistent entry points', () => {
  const root = packageRoot();
  const outside = mkdtempSync(path.join(tmpdir(), 'ags-host-outside-'));
  try {
    writeFileSync(path.join(outside, 'external.mjs'), '');
    assert.throws(() => parseHostIntegrationManifest({ ...manifest(), entryPoints: [{ ...entry(), path: '../outside.mjs' }] }, root), /Invalid package-relative path/);
    try {
      symlinkSync(path.join(outside, 'external.mjs'), path.join(root, 'bin', 'link.mjs'));
      assert.throws(() => parseHostIntegrationManifest({ ...manifest(), entryPoints: [{ ...entry(), path: 'bin/link.mjs', executionClosure: ['bin/link.mjs'] }] }, root), /escapes root/);
    } catch (error) {
      if (error.code !== 'EPERM') throw error;
    }
    assert.throws(() => parseHostIntegrationManifest({ ...manifest(), entryPoints: [{ ...entry(), path: 'bin/missing.mjs', executionClosure: ['bin/missing.mjs'] }] }, root), /Missing package file/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('builder disables missing entry points and rejects invalid advertised paths', () => {
  const root = packageRoot();
  try {
    const descriptor = buildHostIntegrationDescriptor(root, [
      { ...entry(), enabled: true },
      { id: 'host-attestation-cli', path: 'bin/missing.mjs', executionClosure: ['bin/missing.mjs'], enabled: true },
    ]);
    assert.deepEqual(descriptor.manifest.entryPoints.map((item) => item.id), ['mcp-server']);
    assert.deepEqual(descriptor.disabledEntryPoints, ['host-attestation-cli']);
    assert.throws(() => buildHostIntegrationDescriptor(root, [{ ...entry(), path: '../server.mjs', enabled: true }]), /Invalid package-relative path/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
