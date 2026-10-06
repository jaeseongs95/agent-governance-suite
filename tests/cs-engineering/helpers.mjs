import { readFileSync, cpSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { loadPack, hashJson } from '../../skills/cs-engineering/scripts/core.mjs';
export const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
export const EXAMPLE=path.join(ROOT,'skills/cs-engineering/assets/examples/sqlite-queue');
export const SKILL=path.join(ROOT,'skills/cs-engineering');
export const read=name=>JSON.parse(readFileSync(path.join(EXAMPLE,name+'.json'),'utf8'));
export const fixture=()=>({root:EXAMPLE,pack:loadPack(),request:read('request'),constraint:read('constraints'),binding:read('binding'),task:read('task'),policy:read('policy'),review:read('review'),candidate:read('candidate')});
export function scratch(t,copyExample=false){const root=mkdtempSync(path.join(os.tmpdir(),'cs-engineering-test-'));t.after(()=>rmSync(root,{recursive:true,force:true}));if(copyExample)cpSync(EXAMPLE,root,{recursive:true});return root;}
export const clone=x=>structuredClone(x);
export const reviewOptions=f=>({constraint:f.constraint,candidateDigest:hashJson(f.candidate),pack:f.pack});
export const git=(root,args)=>execFileSync('git',['-C',root,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
export function repositoryFixture(t,branch='codex/cs-engineering-test'){
 const repo=scratch(t);git(repo,['init','--initial-branch',branch]);git(repo,['config','user.name','CS Fixture']);git(repo,['config','user.email','fixture@example.invalid']);
 const put=(p,c)=>{mkdirSync(path.dirname(path.join(repo,p)),{recursive:true});writeFileSync(path.join(repo,p),typeof c==='string'?c:JSON.stringify(c,null,2)+'\n');};
 put('package.json',{name:'agent-governance-suite',version:'2.7.7'});
 put('skills/registry.json',{schemaVersion:'2.0.0',skills:[]});
 put('skills/source-lock.json',{schemaVersion:'3.0.0',sources:[]});
 for(const n of ['README.md','README.en.md'])put(n,'# Fixture\n\n| Skill | Responsibility |\n| --- | --- |\n| [`task-contract`](skills/task-contract/) | Task |\n| [`ponytail`](skills/ponytail/) | Implementation |\n\nOther content.\n');
 put('skills/orchestrator/references/entry-details.md','# Existing orchestration\n\nPreserve original behavior.\n');
 git(repo,['add','.']);git(repo,['commit','-m','fixture: initial']);return {repo,base:git(repo,['rev-parse','HEAD']),put};
}
