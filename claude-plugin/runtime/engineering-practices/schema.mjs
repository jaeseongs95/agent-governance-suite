// Closed bundled contracts only. Reuses the AGS Ajv runtime when installed.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { canonicalJson, requireCondition } from './io.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const agsRuntime = path.resolve(packageRoot, 'runtime/schema-validation.mjs');
let ajv = null;
// Reuse AGS's runtime. An existing but broken runtime must NOT silently fall back.
if (existsSync(agsRuntime)) {
  const { Ajv2020 } = await import(pathToFileURL(agsRuntime).href);
  ajv = new Ajv2020({ strict: true, allErrors: true });
}
export const schemaEngine = ajv ? 'ags-ajv2020' : 'standalone-closed-schema-subset';
const compiled = new Map();
const allowed = new Set(['$schema','$id','title','description','type','properties','additionalProperties','required','items','minItems','maxItems','uniqueItems','minLength','maxLength','pattern','enum','const']);
function auditSchema(s) {
  for (const k of Object.keys(s)) requireCondition(allowed.has(k), 'INVALID_INPUT', `Unsupported standalone schema keyword: ${k}.`);
  if (s.properties) for (const child of Object.values(s.properties)) auditSchema(child);
  if (s.items) auditSchema(s.items);
  if (s.pattern) new RegExp(s.pattern, 'u');
}
function matchesType(v, t) {
  if (t === 'null') return v === null;
  if (t === 'object') return v !== null && typeof v === 'object' && !Array.isArray(v);
  if (t === 'array') return Array.isArray(v);
  if (t === 'integer') return Number.isInteger(v);
  if (t === 'number') return typeof v === 'number' && Number.isFinite(v);
  return typeof v === t;
}
// Deliberately limited to the closed schemas shipped here, not a generic
// JSON Schema implementation. Unsupported keywords fail closed at compile time.
function check(s, v, at, errors) {
  if (s.type && !(Array.isArray(s.type) ? s.type : [s.type]).some(t => matchesType(v, t))) { errors.push(at + ': type'); return; }
  if (Object.hasOwn(s, 'const') && canonicalJson(v) !== canonicalJson(s.const)) errors.push(at + ': const');
  if (s.enum && !s.enum.some(x => canonicalJson(x) === canonicalJson(v))) errors.push(at + ': enum');
  if (typeof v === 'string') {
    const n = [...v].length;
    if (s.minLength !== undefined && n < s.minLength || s.maxLength !== undefined && n > s.maxLength) errors.push(at + ': length');
    if (s.pattern && !new RegExp(s.pattern, 'u').test(v)) errors.push(at + ': pattern');
  }
  if (Array.isArray(v)) {
    if (s.minItems !== undefined && v.length < s.minItems || s.maxItems !== undefined && v.length > s.maxItems) errors.push(at + ': item count');
    if (s.uniqueItems && new Set(v.map(x => canonicalJson(x))).size !== v.length) errors.push(at + ': duplicate');
    if (s.items) v.forEach((x, i) => check(s.items, x, at + '/' + i, errors));
  }
  if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
    for (const k of s.required ?? []) if (!Object.hasOwn(v, k)) errors.push(at + '/' + k + ': required');
    for (const k of Object.keys(v)) {
      if (s.properties && Object.hasOwn(s.properties, k)) check(s.properties[k], v[k], at + '/' + k, errors);
      else if (s.additionalProperties === false) errors.push(at + ': unsupported property');
    }
  }
}
export function validateSchema(name, value) {
  requireCondition(/^[a-z][a-z-]+$/u.test(name), 'INVALID_INPUT', 'Invalid contract name.');
  canonicalJson(value);
  if (!compiled.has(name)) {
    const schema = JSON.parse(readFileSync(path.join(packageRoot, 'contracts', name + '.v1.schema.json'), 'utf8'));
    auditSchema(schema);
    compiled.set(name, ajv ? ajv.compile(schema) : schema);
  }
  const validator = compiled.get(name);
  if (ajv) requireCondition(validator(value), 'INVALID_INPUT', `${name}: schema validation failed.`, { errors: validator.errors });
  else { const errors = []; check(validator, value, '', errors); requireCondition(errors.length === 0, 'INVALID_INPUT', `${name}: schema validation failed.`, { errors: errors.slice(0, 30) }); }
  return value;
}
