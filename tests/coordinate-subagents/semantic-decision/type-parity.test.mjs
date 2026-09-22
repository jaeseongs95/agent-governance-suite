import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { test } from 'vitest';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const entries = [
  ['semantic-decision-question.v1', 'SemanticDecisionQuestionV1'], ['semantic-decision-request.v1', 'SemanticDecisionRequestV1'],
  ['semantic-decision-advice.v1', 'SemanticDecisionAdviceV1'], ['semantic-decision-policy.v1', 'SemanticDecisionPolicyV1'],
  ['semantic-model-assignment-request.v1', 'SemanticModelAssignmentRequestV1'], ['model-routing-decision.v3', 'ModelRoutingDecisionV3'],
  ['model-application-request.v3', 'ModelApplicationRequestV3'], ['model-application-record.v3', 'ModelApplicationRecordV3'],
];
const schemas = new Map();
function load(name) {
  if (!schemas.has(name)) schemas.set(name, JSON.parse(readFileSync(path.join(root, 'contracts', name), 'utf8')));
  return schemas.get(name);
}
/** Translate only TS-expressible structure. Range, uniqueness and conditional guards are runtime-tested. */
function typeFor(schema, document, documentName) {
  if (schema.$ref) {
    const url = new URL(schema.$ref, `https://skill-suite.local/contracts/${documentName}`);
    const name = path.basename(url.pathname), target = load(name);
    const fragment = url.hash ? url.hash.slice(2).split('/').map(p => p.replaceAll('~1', '/').replaceAll('~0', '~')) : [];
    const pointed = fragment.reduce((node, part) => node[part], target);
    return typeFor(pointed, target, name);
  }
  if (Object.hasOwn(schema, 'const')) return JSON.stringify(schema.const);
  if (schema.enum) return schema.enum.map(value => JSON.stringify(value)).join(' | ');
  if (schema.oneOf || schema.anyOf) return `(${(schema.oneOf ?? schema.anyOf).map(s => typeFor(s, document, documentName)).join(' | ')})`;
  if (schema.type === 'array') return `Array<${typeFor(schema.items, document, documentName)}>`;
  if (schema.type === 'object') return `{${Object.entries(schema.properties).map(([key, value]) => `${JSON.stringify(key)}${schema.required?.includes(key) ? '' : '?'}: ${typeFor(value, document, documentName)}`).join(';')}}`;
  if (schema.type === 'integer' || schema.type === 'number') return 'number';
  if (['string', 'boolean', 'null'].includes(schema.type)) return schema.type;
  throw new Error(`Unsupported parity shape in ${documentName}: ${JSON.stringify(schema)}`);
}

test('all new TS declarations and schemas agree structurally in both directions, recursively', () => {
  // Virtual test module: neither generated TS nor compiler artifacts are written into the checkout.
  const virtual = path.join(root, 'contracts', '__semantic_parity_virtual.ts');
  const source = 'import type * as Actual from "./types.js";\n' + entries.map(([stem, name], index) =>
    `type Actual${index} = Actual.${name};\ntype Expected${index} = ${typeFor(load(`${stem}.schema.json`), load(`${stem}.schema.json`), `${stem}.schema.json`)};`).join('\n');
  const options = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true, exactOptionalPropertyTypes: true, skipLibCheck: true, types: [] };
  const host = ts.createCompilerHost(options);
  const original = host.getSourceFile.bind(host);
  host.getSourceFile = (file, version, onError, shouldCreate) => file === virtual
    ? ts.createSourceFile(file, source, version, true) : original(file, version, onError, shouldCreate);
  const program = ts.createProgram([virtual], options, host), checker = program.getTypeChecker();
  const errors = ts.getPreEmitDiagnostics(program).filter(item => item.category === ts.DiagnosticCategory.Error);
  assert.deepEqual(errors.map(e => ts.flattenDiagnosticMessageText(e.messageText, '\n')), []);
  const types = new Map(program.getSourceFile(virtual).statements.filter(ts.isTypeAliasDeclaration)
    .map(node => [node.name.text, checker.getTypeFromTypeNode(node.type)]));
  for (const [, name] of entries) assert.ok(name);
  entries.forEach(([, name], index) => {
    const actual = types.get(`Actual${index}`), expected = types.get(`Expected${index}`);
    assert.ok(checker.isTypeAssignableTo(actual, expected), `${name}: TS permits a shape excluded by schema`);
    assert.ok(checker.isTypeAssignableTo(expected, actual), `${name}: schema permits a shape excluded by TS`);
  });
}, 30_000);
