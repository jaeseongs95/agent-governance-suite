#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPack, selectRules, validateRequest, validateConstraintReport, validateReviewReport, validateCandidate, checkBundle, providerResult, adapterError, schemaEngine } from './core.mjs';
import { parseJson, readBoundedFile, requireCondition as need } from './primitives.mjs';
import { checkHandoff, checkStageBundle } from './ags-adapter.mjs';

export function main(argv) {
  const [command = 'help', ...rest] = argv;
  const flags = Object.create(null);
  for (let i = 0; i < rest.length; i++) {
    const k = rest[i];
    need(/^--[a-z-]+$/u.test(k) && !Object.hasOwn(flags, k), 'INVALID_INPUT', 'Invalid or duplicate command flag.');
    if (k === '--allow-draft') flags[k] = true;
    else { need(rest[i+1] && !rest[i+1].startsWith('--'), 'INVALID_INPUT', 'Flag requires a value.'); flags[k] = rest[++i]; }
  }
  const options = {
    'help':[], 'self-check':[], 'catalog':['--allow-draft'], 'rules':['--domain','--rule','--allow-draft'],
    'handoff':['--root','--binding','--task','--policy'],
    'check-stage-bundle':['--root','--input','--bundle-digest','--task-digest'],
    'validate-request':['--root','--input'], 'validate-constraints':['--root','--input','--request'],
    'validate-review':['--root','--input','--constraint','--candidate'],
    'check-bundle':['--root','--binding','--task','--policy','--review','--candidate'],
    'provider-result':['--root','--input','--mode','--request','--constraint','--candidate']
  };
  need(Object.hasOwn(options, command), 'INVALID_INPUT', 'Unknown command.');
  for (const k of Object.keys(flags)) need(options[command].includes(k), 'INVALID_INPUT', 'Unsupported flag for command.');
  const root = path.resolve(flags['--root'] ?? process.cwd());
  const read = key => { need(flags[key], 'INVALID_INPUT', `Missing ${key}.`); return parseJson(readBoundedFile(root, flags[key])); };
  const pack = command === 'help' ? null : loadPack();
  if (command === 'help') return {commands: options, notes:'All input paths are relative to --root. No command executes a candidate, installs dependencies, fetches URLs, or modifies the repository.'};
  if (command === 'handoff') return checkHandoff({root, pack, binding:read('--binding'), task:read('--task'), policy:read('--policy')});
  if (command === 'check-stage-bundle') return checkStageBundle({root, reference:flags['--input'], expectedBundleDigest:flags['--bundle-digest'], expectedTaskDigest:flags['--task-digest']});
  if (command === 'self-check') return {status:'PASS',scope:'knowledge files, catalogue, rule digests and module structure',schemaEngine,version:pack.version,packDigest:pack.digest,modules:pack.modules.size,rules:pack.rules.size,validatedRules:[...pack.rules.values()].filter(r=>r.status==='validated').length};
  if (command === 'catalog') return { version:pack.version,packDigest:pack.digest,rules:selectRules(pack,{allowDraft:Boolean(flags['--allow-draft'])}).map(r=>({id:r.id,domain:r.domain,title:r.title,status:r.status})),notice:'Draft rules require explicit adoption; selection is not host evaluation.' };
  if (command === 'rules') return { rules:selectRules(pack,{domains:flags['--domain']?.split(',')??[],ruleIds:flags['--rule']?.split(',')??[],allowDraft:Boolean(flags['--allow-draft'])}) };
  if (command === 'validate-request') { validateRequest(read('--input')); return {status:'VALID',scope:'request structure and references',schemaEngine}; }
  if (command === 'validate-constraints') {
    const v = validateConstraintReport(read('--input'),{pack,request:read('--request')});
    return {status:'VALID',scope:'constraint structure, references, selected knowledge and request binding',verdict:v.report.verdict,requiredObligationIds:v.requiredObligationIds,schemaEngine};
  }
  if (command === 'validate-review') return {status:'VALID',scope:'report consistency only; raw evidence NOT read in this command',...validateReviewReport(read('--input'),{pack,constraint:read('--constraint'),candidateDigest:validateCandidate(read('--candidate'))}),schemaEngine};
  if (command === 'check-bundle') return checkBundle({root,pack,binding:read('--binding'),task:read('--task'),policy:read('--policy'),review:read('--review'),candidate:read('--candidate')});
  if (command === 'provider-result') {
    const output = read('--input');
    if (flags['--mode'] === 'derive') validateConstraintReport(output,{pack,request:read('--request')});
    else { need(flags['--mode'] === 'review','INVALID_INPUT','--mode must be derive or review.'); validateReviewReport(output,{pack,constraint:read('--constraint'),candidateDigest:validateCandidate(read('--candidate'))}); }
    return providerResult(output);
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const result=main(process.argv.slice(2)); console.log(JSON.stringify(result,null,2)); const verdict=result.verdict??result.output?.verdict; if (['FAIL','NEEDS_REDESIGN'].includes(verdict)) process.exitCode=3; else if (['BLOCKED','NEEDS_INPUT'].includes(verdict)) process.exitCode=4; }
  catch (error) { console.log(JSON.stringify(adapterError(error),null,2)); process.exitCode = 2; }
}
