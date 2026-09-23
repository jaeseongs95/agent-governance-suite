import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { test } from 'vitest';
import {
  canonical, collectEligibleCandidatesV2, getBaselineCandidateMetadataV2, seal,
} from '../../../skills/coordinate-subagents/scripts/model-routing-core.mjs';
import { projectSemanticCandidatesV1 } from '../../../skills/coordinate-subagents/scripts/semantic/candidate-projection.mjs';
import { capability, environment, request } from '../model-routing-v2/fixtures.mjs';

function projection(req, env) {
  const candidates = collectEligibleCandidatesV2(req, env).candidates;
  const metadata = getBaselineCandidateMetadataV2(candidates, req, env);
  return { candidates, metadata, result: projectSemanticCandidatesV1(candidates, metadata) };
}

test('outer permutations preserve the full option mapping and concrete candidate bindings', () => {
  const req = request();
  const env = environment({ capabilities: [
    capability({ actorId: 'actor-a', sessionId: 'session-a' }),
    capability({ actorId: 'actor-b', sessionId: 'session-b', host: 'anthropic-claude-code' }),
    capability({ actorId: 'actor-c', sessionId: 'session-c' }, { model: 'gpt-5.6-sol', resolvedModel: 'gpt-5.6-sol' }),
  ] });
  const { candidates, metadata, result } = projection(req, env);
  assert.equal(candidates.length, 3);
  assert.deepEqual(projectSemanticCandidatesV1([...candidates].reverse(), [...metadata].reverse()), result);
  assert.equal(result.eligibleSet.length, candidates.length);
  assert.equal(result.options.length, 2);
  const terra = result.options.find(option => option.model === 'gpt-5.6-terra');
  assert.equal(terra.optionId, terra.model);
  assert.equal(terra.candidateKeys.length, 2);
  assert.equal(new Set(candidates.filter(c => terra.candidateKeys.includes(c.key)).map(c => c.snapshot.host)).size, 2);
  assert.deepEqual(result.options.flatMap(option => option.candidateKeys).sort(), candidates.map(c => c.key).sort());
  assert.deepEqual(result.eligibleSet.map(c => c.baselineRank), [0, 1, 2]);
});

test('duplicates, partial metadata, and a different model binding are rejected', () => {
  const req = request(), env = environment({ capabilities: [
    capability({ sessionId: 'a' }), capability({ sessionId: 'b' }),
  ] });
  const { candidates, metadata } = projection(req, env);
  const rejects = (cs, ms) => assert.throws(() => projectSemanticCandidatesV1(cs, ms));
  rejects([...candidates, candidates[0]], [...metadata, { ...metadata[0], baselineRank: 2 }]);
  rejects(candidates, [metadata[0]]);
  rejects(candidates, [metadata[0], { ...metadata[0], baselineRank: 1 }]);
  rejects(candidates, [{ ...metadata[0], baselineRank: 2 }, metadata[1]]);
  const wrongModel = structuredClone(candidates);
  wrongModel[0].model.id = 'different-model';
  rejects(wrongModel, metadata);
  const wrongBinding = structuredClone(candidates);
  wrongBinding[0].binding.nativeReasoning.value = 'medium';
  rejects(wrongBinding, metadata);
  const wrongKey = structuredClone(candidates);
  wrongKey[0].key = candidates[1].key;
  rejects(wrongKey, metadata);
});

test('snapshot binding order is sealed, while a resealed change has a new digest', () => {
  const cap = capability();
  cap.supportedBindings.push({ ...cap.supportedBindings[0], nativeReasoning: { kind: 'enum', value: 'medium' } });
  const first = seal(cap, 'snapshotDigest');
  const req = request();
  const original = projection(req, environment({ capabilities: [first] }));
  const tampered = structuredClone(original.candidates);
  tampered[0].snapshot.supportedBindings.reverse();
  assert.throws(() => projectSemanticCandidatesV1(tampered, original.metadata), { code: 'DIGEST_MISMATCH' });

  const changed = structuredClone(first);
  changed.supportedBindings.reverse();
  const second = seal(changed, 'snapshotDigest');
  const updated = projection(req, environment({ capabilities: [second] }));
  assert.notEqual(first.snapshotDigest, second.snapshotDigest);
  assert.notDeepEqual(updated.result, original.result);
  assert.deepEqual(first.supportedBindings.map(b => b.nativeReasoning.value), ['high', 'medium']);
  assert.deepEqual(second.supportedBindings.map(b => b.nativeReasoning.value), ['medium', 'high']);
});

test('empty pool defers to the existing v2 blocked path and output is detached', () => {
  assert.equal(projectSemanticCandidatesV1([], []), null);
  assert.throws(() => projectSemanticCandidatesV1([], [{ candidateKey: 'x', preferenceGroup: 0, baselineRank: 0 }]));
  const req = request(), env = environment();
  const { candidates, metadata } = projection(req, env);
  const before = canonical({ candidates, metadata });
  const result = projectSemanticCandidatesV1(candidates, metadata);
  result.eligibleSet[0].model = 'modified';
  result.options[0].candidateKeys[0] = 'modified';
  assert.equal(canonical({ candidates, metadata }), before);
});

test('projection declaration accepts readonly inputs and exposes only contract data', () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const virtual = path.join(root, 'contracts', '__s02_virtual.ts');
  const source = `
    import { projectSemanticCandidatesV1 } from '../skills/coordinate-subagents/scripts/semantic/candidate-projection.mjs';
    import type { EligibleCandidateV2, BaselineCandidateMetadataV2 } from '../skills/coordinate-subagents/scripts/model-routing-core.mjs';
    import type { SemanticEligibleCandidateV1, SemanticModelOptionV1 } from './types.js';
    declare const candidates: readonly EligibleCandidateV2[];
    declare const metadata: readonly BaselineCandidateMetadataV2[];
    const result = projectSemanticCandidatesV1(candidates, metadata);
    if (result) {
      const eligible: SemanticEligibleCandidateV1 = result.eligibleSet[0]!;
      const option: SemanticModelOptionV1 = result.options[0]!;
      // @ts-expect-error Projection does not authorize execution.
      const authority: true = result.executionAuthorized;
    }
  `;
  const options = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true, noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true, skipLibCheck: true, types: [] };
  const host = ts.createCompilerHost(options);
  const originalGet = host.getSourceFile.bind(host), originalExists = host.fileExists.bind(host);
  host.fileExists = file => path.normalize(file) === virtual || originalExists(file);
  host.getSourceFile = (file, version, onError, shouldCreate) => path.normalize(file) === virtual
    ? ts.createSourceFile(file, source, version, true) : originalGet(file, version, onError, shouldCreate);
  const errors = ts.getPreEmitDiagnostics(ts.createProgram([virtual], options, host))
    .filter(item => item.category === ts.DiagnosticCategory.Error);
  assert.deepEqual(errors.map(error => ts.flattenDiagnosticMessageText(error.messageText, '\n')), []);
});
