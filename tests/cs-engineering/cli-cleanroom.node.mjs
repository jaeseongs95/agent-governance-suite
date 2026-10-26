import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT, SKILL, EXAMPLE, scratch, fixture } from './helpers.mjs';
import { hashJson, hashBytes } from '../../skills/cs-engineering/scripts/core.mjs';
const cli=path.join(SKILL,'scripts/validate.mjs');
const run=(args,script=cli,cwd=ROOT)=>spawnSync(process.execPath,[script,...args],{cwd,encoding:'utf8',timeout:15000,env:{...process.env,NODE_PATH:''}});
const bundleArgs=root=>['check-bundle','--root',root,'--binding','binding.json','--task','task.json','--policy','policy.json','--review','review.json','--candidate','candidate.json'];
test('CLI self-check and defaults are executable without npm dependencies',()=>{const r=run(['self-check']);assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout).rules,40);const c=run(['catalog']);assert.equal(JSON.parse(c.stdout).rules.length,20);});
test('CLI complete example validates actual raw evidence',()=>{const r=run(bundleArgs(EXAMPLE));assert.equal(r.status,0,r.stdout+r.stderr);assert.equal(JSON.parse(r.stdout).verdict,'PASS');});
for(const args of [['not-a-command'],['catalog','--mystery','x'],['catalog','--allow-draft','--allow-draft'],['check-bundle'],['rules','--domain','missing']])test('CLI rejects '+args.join(' '),()=>{const r=run(args);assert.equal(r.status,2);assert.equal(JSON.parse(r.stdout).kind,'adapter-error');});
test('CLI blocked result has nonzero exit code, not silent success',t=>{const root=scratch(t,true),f=fixture();Object.assign(f.review.verificationResults[0],{executionStatus:'NOT_RUN',result:'UNKNOWN',evidenceRefs:[]});Object.assign(f.review.findings[0],{status:'UNVERIFIED',evidenceRefs:[]});f.review.unverifiedRequiredObligationIds=['OB-CLAIM'];f.review.verdict='BLOCKED';writeFileSync(path.join(root,'review.json'),JSON.stringify(f.review));const r=run(bundleArgs(root));assert.equal(r.status,4,r.stdout);assert.equal(JSON.parse(r.stdout).canProceedUnderSuppliedPolicy,false);});
test('observe policy preserves negative verdict while reporting host policy outcome',t=>{const root=scratch(t,true),f=fixture();f.policy.mode='observe';f.binding.mode='observe';f.binding.policyDigest=hashJson(f.policy);f.review.verificationResults[0].result='FAIL';f.review.findings[0].status='VIOLATED';f.review.blockingFindingIds=['F-CLAIM'];f.review.verdict='FAIL';for(const k of ['policy','binding','review'])writeFileSync(path.join(root,k+'.json'),JSON.stringify(f[k]));const r=run(bundleArgs(root));assert.equal(r.status,3,r.stdout);assert.equal(JSON.parse(r.stdout).canProceedUnderSuppliedPolicy,true);assert.equal(JSON.parse(r.stdout).verdict,'FAIL');});
test('skill-only clean-room installation works without repository or node_modules',t=>{const root=scratch(t);cpSync(SKILL,path.join(root,'skills/cs-engineering'),{recursive:true});const script=path.join(root,'skills/cs-engineering/scripts/validate.mjs'),example=path.join(root,'skills/cs-engineering/assets/examples/sqlite-queue');assert.equal(existsSync(path.join(root,'node_modules')),false);let r=run(['self-check'],script,root);assert.equal(r.status,0,r.stdout+r.stderr);assert.equal(JSON.parse(r.stdout).schemaEngine,'standalone-closed-schema-subset');r=run(bundleArgs(example),script,root);assert.equal(r.status,0,r.stdout+r.stderr);});
test('an existing broken AGS runtime never silently falls back',t=>{const root=scratch(t);cpSync(SKILL,path.join(root,'skills/cs-engineering'),{recursive:true});mkdirSync(path.join(root,'runtime'));writeFileSync(path.join(root,'runtime/schema-validation.mjs'),'throw new Error("broken-existing-runtime");\n');const r=run(['self-check'],path.join(root,'skills/cs-engineering/scripts/validate.mjs'),root);assert.notEqual(r.status,0);assert.ok(r.stderr.includes('broken-existing-runtime'));});
test('provider-result command returns the passing AGS result envelope',()=>{const r=run(['provider-result','--root',EXAMPLE,'--input','review.json','--mode','review','--constraint','constraints.json','--candidate','candidate.json']);assert.equal(r.status,0,r.stdout);const o=JSON.parse(r.stdout);assert.equal(o.schemaVersion,'1.0.0');assert.equal(o.kind,'output');assert.equal(o.output.verdict,'PASS');assert.equal(o.error,null);});
test('provider-result command keeps BLOCKED exit status in its nested output',t=>{const root=scratch(t,true),f=fixture();Object.assign(f.review.verificationResults[0],{executionStatus:'NOT_RUN',result:'UNKNOWN',evidenceRefs:[]});Object.assign(f.review.findings[0],{status:'UNVERIFIED',evidenceRefs:[]});f.review.unverifiedRequiredObligationIds=['OB-CLAIM'];f.review.verdict='BLOCKED';writeFileSync(path.join(root,'review.json'),JSON.stringify(f.review));const r=run(['provider-result','--root',root,'--input','review.json','--mode','review','--constraint','constraints.json','--candidate','candidate.json']);assert.equal(r.status,4,r.stdout);assert.equal(JSON.parse(r.stdout).error.code,'MISSING_EVIDENCE');});

function bundleWithRawCandidate(t, size) {
  const root = scratch(t, true), f = fixture(), body = Buffer.alloc(size, 32);
  body.write("// synthetic bounded server bundle\n");
  writeFileSync(path.join(root, 'candidate/server.mjs'), body);
  f.candidate.files = [{path: 'candidate/server.mjs', digest: hashBytes(body)}];
  const targetDigest = hashJson(f.candidate);
  f.review.candidateDigest = targetDigest;
  for (const result of f.review.verificationResults) result.targetDigest = targetDigest;
  for (const evidence of f.review.evidence) evidence.targetDigest = targetDigest;
  for (const name of ['candidate', 'review']) writeFileSync(path.join(root, name + '.json'), JSON.stringify(f[name]));
  return root;
}
for (const size of [1024 * 1024 + 1, 8 * 1024 * 1024]) test('D270 artifact cap CLI accepts raw bundle bytes ' + size, t => {
  const root = bundleWithRawCandidate(t, size), result = run(bundleArgs(root));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stdout).verdict, 'PASS');
});
test('D270 artifact cap CLI rejects raw bundle above 8MiB', t => {
  const root = bundleWithRawCandidate(t, 8 * 1024 * 1024 + 1), result = run(bundleArgs(root));
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stdout).error.message, 'Artifact exceeds the byte limit.');
});
test('D270 artifact cap CLI still rejects tampered digest above 1MiB', t => {
  const root = bundleWithRawCandidate(t, 2 * 1024 * 1024), file = path.join(root, 'candidate/server.mjs');
  const body = readFileSync(file); body[body.length - 1] = 33; writeFileSync(file, body);
  const result = run(bundleArgs(root));
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stdout).error.code, 'INTEGRITY_FAILED');
});
for (const name of ['candidate', 'constraints']) test('D270 artifact cap CLI keeps structured JSON at 1MiB: ' + name, t => {
  const root = bundleWithRawCandidate(t, 32), file = path.join(root, name + '.json'), json = readFileSync(file);
  const body = Buffer.concat([json, Buffer.alloc(1024 * 1024 + 1 - json.length, 32)]); writeFileSync(file, body);
  if (name === 'constraints') {
    const binding = JSON.parse(readFileSync(path.join(root, 'binding.json'), 'utf8'));
    binding.constraintReportRef.digest = hashBytes(body); writeFileSync(path.join(root, 'binding.json'), JSON.stringify(binding));
  }
  const result = run(bundleArgs(root));
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stdout).error.message, 'Artifact exceeds the byte limit.');
});
