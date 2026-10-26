import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
const candidate = root;
// Config fixture source: 5a86e27c32ef0b3cbd0fffb4becaff95233306c5:.github/ci/ags30-r11/execution-config.json
// Baseline SHA-256: 59e939f742fa72ec4f8cd17baae44a20b6ad86ce5cda4c104d16425ab993daff.
// Consume only the repository's current config bytes so future valid toolchains remain testable.
const configPath = '.github/ci/ags30-r11/execution-config.json';
const configBytes = await fs.readFile(path.join(candidate,configPath));
const config = JSON.parse(configBytes);
const { verifyUpgradeSource } = await import(pathToFileURL(path.join(candidate,'validation/run-upgrade-test.mjs')));
const { assertGenuineUpgradeResult } = await import(pathToFileURL(path.join(candidate,'.github/scripts/ags30-official-source-r11.mjs')));
const source = await fs.readFile(path.join(candidate,'.github/scripts/ags30-official-source-r11.mjs'),'utf8');
const start = source.indexOf('    // The historical service is required once per OS');
const end = source.indexOf("    mustPass(await command('04a-new-test-syntax'",start);
assert.ok(start>=0 && end>start);
const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
// Execute the exact production shard block. Only Git/process/filesystem I/O are replaced;
// shard selection, argv, mustPass and final-result assertions execute unchanged.
const block = new AsyncFunction('context','with(context){'+source.slice(start,end)+'}');
// Historical metadata and result are mock IO fixtures, not a new genuine-service run.
const old = {"head":"b3285616c896afdcbb298e3a08dffd612ddfa7b8","sourceTree":"797ccf5960fea8fcebe16025d7786ca389ab6fbc","files":1733,"rows":[{"relativePath":"mcp-server/src/workflow-service.ts","bytes":86572,"sha256":"93de7c5432d76911260012e4323d2e135c8a79516ecfddca32dcfc9deceda33a"}]};
const current = {"head":"952124af2a896d8df655f69036a271eaa5365bbf","sourceTree":"059cad1d97fdc7109b43198fdc35bd65ca0b2794","files":1735,"rows":[{"relativePath":"mcp-server/src/workflow-service.ts","bytes":87866,"sha256":"9c82353907b483ad32e1ca0ed9058a117c50cae9cca824ed2708911c338fc759"}]};
// Original public result fixture SHA-256: 640021da92f87f1de6567886ada0794ad0ba7e36d1b828e6aa90b87ccc1f6c32.
const outcome = {"passed":true,"genuineOldServiceIssuance":true,"sameSqliteStoreReopened":true,"originalPlanSha256":"2b77e156b0a6ec23abd69d163afc7ad5615424219f2d84806269490ace37b716","genuineMissingPhaseCode":"BINDING_REQUIRED","corruptedCopyCode":"INVALID_INPUT","oldPreResultCode":"BINDING_REQUIRED","historyUnchangedOnRejection":true,"originalHmacNotReissued":true,"originalSigningKeyNotAccessed":true,"sameRootReplanOrdinal":2,"originalHistoryRetained":true,"newExplicitPrePassed":true,"newRootCount":0,"sourceOld":"b3285616c896afdcbb298e3a08dffd612ddfa7b8","sourceCurrent":"952124af2a896d8df655f69036a271eaa5365bbf"};
function context(shardIndex, failure = null) {
  const calls=[]; const writes=[];
  const pass = name => ({receipt:{name,status:name===failure?'FAIL':'PASS'},stdout:Buffer.from('')});
  return {assert,path,process,config,shardIndex,calls,writes,work:'/owned/work',output:'/owned/output',source:'/owned/source',pnpmCli:'/owned/tools/pnpm.cjs',
    head:current.head,sourceTree:current.sourceTree,manifest:current,transport:{sha256:'a'.repeat(64)},record:{},
    sha:b=>createHash('sha256').update(b).digest('hex'),
    git:async(name,args,cwd)=>{calls.push({name,args,cwd}); const p=pass(name);p.stdout=Buffer.from(name==='04u3-old-head'?old.head:name==='04u4-old-tree'?old.sourceTree:'');return p;},
    command:async(name,executable,args,cwd)=>{calls.push({name,executable,args,cwd});const p=pass(name);if(name.startsWith('04u7-'))p.stdout=Buffer.from(config.pnpm+'\n');return p;},
    mustPass:r=>{assert.equal(r.receipt.status,'PASS','Phase failed: '+r.receipt.name);return r;},
    buildHeadManifest:async()=>old,
    fs:{readFile:async name=>Buffer.from(name.endsWith('result.json')?JSON.stringify(outcome):JSON.stringify(old))},
    writeJson:async(name,value)=>writes.push({name,value}),assertGenuineUpgradeResult};
}
test('actual shard block prepares and executes exactly once on shard 1 with externally computed current pin',async()=>{
  for(const os of ['Linux','Windows']) {
    const c=context(1);c.runnerOs=os;await block(c);
    assert.equal(c.calls.filter(r=>r.name==='04u6-old-install').length,1);
    const run=c.calls.filter(r=>r.name==='04u8-genuine-upgrade');assert.equal(run.length,1);
    assert.deepEqual(run[0].args.slice(2,4),[current.head,c.transport.sha256]);
    assert.equal(c.record.genuineLegacyUpgrade.status,'PASS');
    assert.equal(c.writes.filter(r=>r.name==='genuine-upgrade-input.json').length,1);
  }
});
test('actual shard block performs no old-source install or upgrade invocation on shards 2 through 4',async()=>{
  for(const index of [2,3,4]){const c=context(index);await block(c);assert.equal(c.calls.length,0);assert.equal(c.writes.length,0);}
});
test('actual shard block preserves failed old installation and failed upgrade exit even if a good result exists',async()=>{
  for(const failure of ['04u6-old-install','04u8-genuine-upgrade'])await assert.rejects(block(context(1,failure)),/Phase failed/u);
});
test('actual collector rejects absent or false decisive scenario output',()=>{
  assertGenuineUpgradeResult(outcome,current.head);
  for(const key of ['passed','genuineOldServiceIssuance','sameSqliteStoreReopened','historyUnchangedOnRejection','originalHmacNotReissued','originalSigningKeyNotAccessed','originalHistoryRetained','newExplicitPrePassed']) {
    assert.throws(()=>assertGenuineUpgradeResult({...outcome,[key]:false},current.head));
  }
  assert.throws(()=>assertGenuineUpgradeResult(outcome,'f'.repeat(40)));
});
test('real source verifier fails closed for missing pin/source/dependencies and changed source bytes',async()=>{
  const dir=await fs.mkdtemp(path.join(tmpdir(),'al06-d0040-wiring-'));
  const hash=b=>createHash('sha256').update(b).digest('hex');
  try {
    const contents={'package.json':JSON.stringify({packageManager:'pnpm@'+config.pnpm}),'pnpm-lock.yaml':'frozen fixture\n','scripts/run-tests.mjs':'export {};\n','mcp-server/src/workflow-service.ts':'export {};\n',[configPath]:configBytes};
    const rows=[];
    for(const [relativePath,text]of Object.entries(contents)){const file=path.join(dir,relativePath);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,text);rows.push({relativePath,bytes:Buffer.byteLength(text),sha256:hash(text)});}
    const loader=path.join(dir,'node_modules/tsx/dist/loader.mjs');await fs.mkdir(path.dirname(loader),{recursive:true});await fs.writeFile(loader,'');
    const manifest=Buffer.from(JSON.stringify({head:'a'.repeat(40),sourceTree:'b'.repeat(40),files:rows.length,rows}));
    const manifestPath=path.join(dir,'external-manifest.json');await fs.writeFile(manifestPath,manifest);
    const input={directory:dir,commit:'a'.repeat(40),tree:'b'.repeat(40),manifestPath,serviceSha256:hash(contents['mcp-server/src/workflow-service.ts'])};
    await verifyUpgradeSource(input,input.commit,hash(manifest));
    await assert.rejects(verifyUpgradeSource(input,input.commit,'0'.repeat(64)),/Externally verified whole-source manifest differs/u);
    await assert.rejects(verifyUpgradeSource(input,input.commit,undefined));
    await fs.rm(loader);await assert.rejects(verifyUpgradeSource(input,input.commit,hash(manifest)),/ENOENT/u);await fs.writeFile(loader,'');
    await fs.writeFile(path.join(dir,'mcp-server/src/workflow-service.ts'),'corruption\n');
    await assert.rejects(verifyUpgradeSource(input,input.commit,hash(manifest)),/Source (size differs|bytes differ)/u);
    await assert.rejects(verifyUpgradeSource({...input,directory:path.join(dir,'missing')},input.commit,hash(manifest)),/ENOENT/u);
  } finally {await fs.rm(dir,{recursive:true,force:true});}
});
