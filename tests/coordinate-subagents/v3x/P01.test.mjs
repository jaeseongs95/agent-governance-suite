import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { test } from 'vitest';
import { parseSemanticProviderResultV1 } from '../../../mcp-server/src/semantic/provider-port.ts';

const choice = { kind: 'Choice', selectedOptionIds: ['model-a'], confidence: null };

test('accepts only the six AGS result statuses and a valid Choice', () => {
  assert.deepEqual(parseSemanticProviderResultV1({ status: 'success', choice }), { status: 'success', choice });
  for (const status of ['abstained', 'timeout', 'unavailable', 'invalid', 'uncertain']) {
    assert.deepEqual(parseSemanticProviderResultV1({ status }), { status });
  }
  for (const value of [null, {}, { status: 'unknown' }, { status: 'success' },
    { status: 'success', choice: { ...choice, selectedOptionIds: [] } },
    { status: 'success', choice: { ...choice, confidence: 2 } }]) {
    assert.throws(() => parseSemanticProviderResultV1(value), TypeError);
  }
});

test('rejects authority, credentials, and provider-specific extras in every result', () => {
  for (const value of [
    { status: 'success', choice, admissionAuthorized: true },
    { status: 'success', choice: { ...choice, executionAuthorized: true } },
    { status: 'abstained', credential: 'secret' },
    { status: 'timeout', choice },
  ]) assert.throws(() => parseSemanticProviderResultV1(value), TypeError);
});

test('a fake provider type-checks while unknown status and authority fields do not', () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const virtual = path.join(root, 'contracts', '__p01_virtual.ts');
  const source = `
    import type { SemanticDecisionProviderPort, SemanticProviderResultV1 } from '../mcp-server/src/semantic/provider-port.js';
    const fake: SemanticDecisionProviderPort = {
      async evaluate(request) {
        const id: string = request.evaluationId;
        return id ? { status: 'success', choice: { kind: 'Choice', selectedOptionIds: ['model-a'], confidence: null } }
          : { status: 'abstained' };
      },
    };
    declare const result: Awaited<ReturnType<typeof fake.evaluate>>;
    // @ts-expect-error Provider output cannot grant admission.
    result.admissionAuthorized;
    // @ts-expect-error Provider output cannot grant execution.
    result.executionAuthorized;
    // @ts-expect-error Credentials are not part of the domain result.
    result.credential;
    // @ts-expect-error Unknown result statuses are not in the port contract.
    const unknown: SemanticProviderResultV1 = { status: 'retrying' };
    // @ts-expect-error Extra authority fields are forbidden on result literals.
    const authority: SemanticProviderResultV1 = { status: 'abstained', admissionAuthorized: true };
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
