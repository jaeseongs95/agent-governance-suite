import assert from 'node:assert/strict';
import path from 'node:path';
import {createHash} from 'node:crypto';

const ordinal = (a,b) => a < b ? -1 : a > b ? 1 : 0;
const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function relativeFile(file, root) {
  assert(typeof file === 'string' && file.length > 0 && !file.includes('\0'));
  const relative = path.relative(root, path.isAbsolute(file) ? file : path.resolve(root,file)).split(path.sep).join('/');
  assert(relative && !relative.includes(':') && !relative.startsWith('/') && relative.split('/').every(part=>part && part!=='.' && part!=='..'));
  return relative;
}
export function parseFileList(text, root, sourcePaths) {
  const files=text.split(/\r?\n/u).filter(line=>line.length>0).map(file=>relativeFile(file,root));
  assert(files.length>0 && new Set(files).size===files.length, 'Empty or duplicate discovery');
  assert(files.every(file=>sourcePaths.has(file)), 'Discovery outside source inventory');
  return files.sort(ordinal);
}
export function bindShardReport(report, allFiles, root, shardIndex, shardCount) {
  assert(Number.isInteger(shardIndex) && shardIndex>=1 && shardIndex<=shardCount && shardCount===4);
  assert(Array.isArray(report.testResults) && report.testResults.length>0);
  const actual=report.testResults.map(row=>relativeFile(row.name,root));
  assert(new Set(actual).size===actual.length,'Duplicate executed module');
  assert(actual.every(file=>allFiles.includes(file)), 'Executed module outside official full discovery');
  const shardFiles = [...actual].sort(ordinal);
  // Vitest 5 list does not partition by --shard; all four official run sets must close the full-discovery union.
  const cases=report.testResults.flatMap(row=>{
    assert(Array.isArray(row.assertionResults));
    return row.assertionResults.map((item,index)=>{
      assert(typeof item.fullName==='string' && ['passed','failed','pending','todo','skipped'].includes(item.status));
      const file=relativeFile(row.name,root);
      return {id:sha([file,index,item.fullName]),file,index,fullName:item.fullName,status:item.status};
    });
  });
  assert(cases.length>0 && cases.length===report.numTotalTests,'Case count differs from full report');
  assert(new Set(cases.map(item=>item.id)).size===cases.length);
  const status=report.success===true && report.numFailedTests===0 && report.numFailedTestSuites===0 ? 'COMPLETE_SHARD_PASS' : 'COMPLETE_SHARD_FAIL';
  return {status,shardIndex,shardCount,allFiles,shardFiles,executedFiles:actual.sort(ordinal),cases,
    counts:{total:report.numTotalTests,passed:report.numPassedTests,failed:report.numFailedTests,pending:report.numPendingTests,todo:report.numTodoTests},
    allFilesDigest:sha(allFiles),shardFilesDigest:sha(shardFiles),wholeSuiteConclusion:'REQUIRES_ALL_FOUR_BOUND_DISJOINT_SHARDS'};
}
export function aggregateShards(rows) {
  assert(rows.length===4 && new Set(rows.map(row=>row.shardIndex)).size===4);
  const allFiles=rows[0].allFiles;
  const files=[],ids=[];
  for(const row of rows){
    assert(row.shardCount===4 && row.shardIndex>=1 && row.shardIndex<=4);
    assert.deepEqual(row.allFiles,allFiles);
    assert.deepEqual(row.executedFiles,row.shardFiles);
    files.push(...row.executedFiles);ids.push(...row.cases.map(item=>item.id));
  }
  assert(new Set(files).size===files.length,'Overlapping shard files');
  assert(new Set(ids).size===ids.length,'Overlapping test IDs');
  assert.deepEqual(files.sort(ordinal),allFiles,'Missing full-discovery files');
  return {status:rows.every(row=>row.status==='COMPLETE_SHARD_PASS')?'COMPLETE_SUITE_PASS':'COMPLETE_SUITE_FAIL',files:files.length,cases:ids.length,
    pending:rows.reduce((n,row)=>n+row.counts.pending,0),wholeAcceptance:'NOT_CLAIMED'};
}
