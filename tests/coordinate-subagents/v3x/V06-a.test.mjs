import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import {
  buildCurrentHostIntegrationManifest, parseHostIntegrationManifest,
} from '../../../mcp-server/src/host-integration/manifest.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const manifestPath = path.join(root, 'host-integration.json');
const clone = (value) => structuredClone(value);

test('official build regenerates the direct MCP manifest and hashes the fixed candidate root', () => {
  const before = readFileSync(manifestPath);
  const result = spawnSync(process.execPath, ['scripts/build.mjs'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readFileSync(manifestPath), before);

  const manifest = JSON.parse(before.toString('utf8'));
  assert.deepEqual(manifest, buildCurrentHostIntegrationManifest(root));
  assert.deepEqual(manifest.entryPoints.map((entry) => entry.id), ['mcp-server']);
  assert.equal(manifest.entryPoints[0].path, 'mcp-server/dist/server.mjs');
  const plugin = JSON.parse(readFileSync(path.join(root, '.codex-plugin/plugin.json'), 'utf8'));
  assert.deepEqual(manifest.plugin, { id: plugin.id, version: plugin.version });
  assert.deepEqual(
    manifest.artifacts.map((artifact) => artifact.path),
    [...manifest.entryPoints[0].executionClosure].sort(),
  );
  for (const artifact of manifest.artifacts) {
    const bytes = readFileSync(path.join(root, artifact.path));
    assert.equal(artifact.sha256, `sha256:${createHash('sha256').update(bytes).digest('hex')}`);
  }
});

test('fixed candidate rejects tampering, missing artifacts, and relative path escape', () => {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const candidate = mkdtempSync(path.join(tmpdir(), 'ags-v06a-candidate-'));
  try {
    for (const artifact of manifest.artifacts) {
      const target = path.join(candidate, artifact.path);
      mkdirSync(path.dirname(target), { recursive: true });
      copyFileSync(path.join(root, artifact.path), target);
    }
    assert.deepEqual(parseHostIntegrationManifest(manifest, candidate), manifest);
    assert.deepEqual(buildCurrentHostIntegrationManifest(candidate), manifest);

    const server = path.join(candidate, manifest.entryPoints[0].path);
    writeFileSync(server, Buffer.concat([readFileSync(server), Buffer.from('\n// modified')]));
    assert.throws(() => parseHostIntegrationManifest(manifest, candidate), /Artifact hash mismatch/);
    copyFileSync(path.join(root, manifest.entryPoints[0].path), server);

    const missing = path.join(candidate, manifest.artifacts.at(-1).path);
    rmSync(missing);
    assert.throws(() => parseHostIntegrationManifest(manifest, candidate), /Missing package file/);
    assert.throws(() => buildCurrentHostIntegrationManifest(candidate), /Missing package file/);
    copyFileSync(path.join(root, manifest.artifacts.at(-1).path), missing);

    const escaping = clone(manifest);
    escaping.entryPoints[0].executionClosure.push('../outside.mjs');
    assert.throws(() => parseHostIntegrationManifest(escaping, candidate), /Invalid package-relative path/);

    const uncovered = clone(manifest);
    uncovered.artifacts.pop();
    assert.throws(() => parseHostIntegrationManifest(uncovered, candidate), /do not cover/);

    const escapedArtifact = clone(manifest);
    escapedArtifact.artifacts[0].path = '../outside.mjs';
    assert.throws(() => parseHostIntegrationManifest(escapedArtifact, candidate), /Invalid package-relative path/);
  } finally {
    rmSync(candidate, { recursive: true, force: true });
  }
});
