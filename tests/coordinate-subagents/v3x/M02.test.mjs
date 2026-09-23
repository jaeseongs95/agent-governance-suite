import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';
import { loadCatalog, queryCatalog, defaultCatalogDirectory } from '../../../skills/coordinate-subagents/scripts/model-catalog.mjs';
import { seal, validateCatalog } from '../../../skills/coordinate-subagents/scripts/model-routing-core.mjs';

const newDigest = 'sha256:da981aa21ace31cf91f09a3e617dbff73458d02228d67a5d0d31d9c801055e81';
const catalog = () => loadCatalog();

test('M02 pins the new Anthropic snapshot to exact documented IDs without claiming live support', () => {
  const current = catalog();
  assert.equal(current.snapshotDate, '2026-09-23T00:00:00.000Z');
  assert.equal(current.catalogDigest, newDigest);
  const opus = current.models.find(model => model.id === 'claude-opus-5-5');
  const fable = current.models.find(model => model.id === 'claude-fable-5-1');
  assert.deepEqual(opus.aliases, []);
  assert.equal(opus.modelClass, 'deep');
  assert.deepEqual(opus.verification, ['documented']);
  assert.equal(opus.abilityScore, null);
  assert.equal(fable.status, 'seed');
  assert.deepEqual(fable.verification, ['baseline-seed', 'documented']);
  assert.equal(fable.modelClass, 'frontier');
  assert.equal(fable.abilityScore, null);
  for (const model of [opus, fable]) {
    assert.equal(model.contextTokens, 1000000);
    assert.equal(model.checkedAt, '2026-09-23T00:00:00.000Z');
    assert.ok(model.recommendationBasis.includes('policy class'));
    assert.ok(!model.verification.includes('live-verified'));
  }
  assert.equal(current.models.find(model => model.aliases.includes('opus')).id, 'claude-opus-5');
  assert.equal(current.models.find(model => model.aliases.includes('fable')).id, 'claude-fable-5');
  const selected = queryCatalog({ provider: 'anthropic', model: opus.id, includeSources: true });
  assert.deepEqual(selected.models.map(model => model.id), [opus.id]);
  assert.deepEqual(selected.sources.map(source => source.id), ['PLAN', 'CLAUDE-OPUS-55']);
  assert.equal(selected.liveVerified, false);
  assert.ok(current.models.every(model => model.modelOrigin !== 'deepseek'));
});

test('M02 rejects duplicate IDs, aliases and missing source IDs', () => {
  const base = catalog();
  const duplicate = structuredClone(base);
  duplicate.models.push(structuredClone(duplicate.models.find(model => model.id === 'claude-opus-5-5')));
  assert.throws(() => validateCatalog(seal(duplicate, 'catalogDigest')), { code: 'INVALID_INPUT' });
  const alias = structuredClone(base);
  alias.models.find(model => model.id === 'claude-opus-5-5').aliases.push('opus');
  assert.throws(() => validateCatalog(seal(alias, 'catalogDigest')), { code: 'INVALID_INPUT' });
  const missing = structuredClone(base);
  missing.models.find(model => model.id === 'claude-opus-5-5').sourceIds.push('MISSING');
  assert.throws(() => validateCatalog(seal(missing, 'catalogDigest')), { code: 'CATALOG_SOURCE_MISSING' });
});

test('M02 rejects provider and source hash mismatches before catalog use', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ags-m02-catalog-'));
  try {
    cpSync(defaultCatalogDirectory, directory, { recursive: true });
    const shard = join(directory, 'models/anthropic.json');
    writeFileSync(shard, `${readFileSync(shard, 'utf8')} `);
    assert.throws(() => loadCatalog({ directory, providers: ['anthropic'] }), { code: 'CATALOG_FILE_DIGEST_MISMATCH' });
    cpSync(join(defaultCatalogDirectory, 'models/anthropic.json'), shard);
    const sources = join(directory, 'sources.json');
    writeFileSync(sources, `${readFileSync(sources, 'utf8')} `);
    assert.throws(() => loadCatalog({ directory, providers: ['anthropic'] }), { code: 'CATALOG_FILE_DIGEST_MISMATCH' });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('M02 leaves the fixed pre-S1a golden snapshot bytes untouched', () => {
  const bytes = readFileSync(new URL('../semantic-decision/fixtures/v2-golden.json', import.meta.url));
  assert.equal(createHash('sha256').update(bytes).digest('hex'),
    '6e6ab050a229b4ae9aeb2e767722f69498a873bed02a3854c4e351c13749d54f');
});
