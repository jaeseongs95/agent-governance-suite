import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson, hashJson } from '../../skills/cs-engineering/scripts/primitives.mjs';
// Bounded, deterministic reference witnesses; NOT measurements of an AI model.
function reachable(graph,start) {
  const seen=new Set(),todo=[start];
  while(todo.length){const n=todo.pop();if(seen.has(n))continue;seen.add(n);for(const m of graph.get(n)??[])todo.push(m);}
  return seen;
}
function topo(graph) {
  const degree=new Map([...graph.keys()].map(k=>[k,0]));
  for(const targets of graph.values())for(const t of new Set(targets)){if(!degree.has(t))throw Error('unknown node');degree.set(t,degree.get(t)+1);}
  const q=[...degree].filter(([,d])=>d===0).map(([n])=>n),result=[];
  for(let i=0;i<q.length;i++){const n=q[i];result.push(n);for(const t of new Set(graph.get(n))){degree.set(t,degree.get(t)-1);if(degree.get(t)===0)q.push(t);}}
  if(result.length!==graph.size)throw Error('cycle');return result;
}
test('ALG-TERMINATION-001: cycles, disconnected nodes and deep chain terminate',()=>{
  const graph=new Map([[0,[1]],[1,[2]],[2,[0]],[9,[]]]);assert.deepEqual([...reachable(graph,0)].sort(),[0,1,2]);
  const chain=new Map(Array.from({length:20000},(_,i)=>[i,i===19999?[]:[i+1]]));assert.equal(reachable(chain,0).size,20000);
});
test('ALG-ORDER-002: generated DAG preserves every edge; cycle and unknown node rejected',()=>{
  for(let seed=1;seed<=20;seed++){const g=new Map(Array.from({length:60},(_,i)=>[i,[]]));for(let i=0;i<60;i++)for(let j=i+1;j<60;j++)if((i*31+j*seed)%17===0)g.get(i).push(j);const order=topo(g),pos=new Map(order.map((v,i)=>[v,i]));for(const [u,vs]of g)for(const v of vs)assert.ok(pos.get(u)<pos.get(v));}
  assert.throws(()=>topo(new Map([[1,[2]],[2,[1]]])),/cycle/);assert.throws(()=>topo(new Map([[1,[3]]])),/unknown/);
});
test('ALG-COST-003: linear membership loop exhibits quadratic comparisons',()=>{
  const operations=n=>{const items=[];let comparisons=0;for(let i=0;i<n;i++){for(const x of items){comparisons++;if(x===i)break;}items.push(i);}return comparisons;};
  assert.equal(operations(100),4950);assert.equal(operations(200),19900);assert.ok(operations(200)>3.9*operations(100));
});
test('ALG-KEY-004: semantic version/permission changes affect memoization key',()=>{
  const v={request:'a',version:1,principal:'p1'};assert.notEqual(hashJson(v),hashJson({...v,version:2}));assert.notEqual(hashJson(v),hashJson({...v,principal:'p2'}));assert.equal(hashJson(v),hashJson({principal:'p1',version:1,request:'a'}));
});
test('CONC-LOCK-003: lock-order graph detects circular acquisition',()=>{
  assert.deepEqual(topo(new Map([['a',['b']],['b',[]]])),['a','b']);assert.throws(()=>topo(new Map([['a',['b']],['b',['a']]])),/cycle/);
});
test('CONC-CANCEL-004: cancel and complete interleavings have one terminal winner',()=>{
  for(const order of [['cancel','complete'],['complete','cancel']]){let state='running';const out=order.map(action=>{if(state!=='running')return false;state=action==='cancel'?'cancelled':'done';return true;});assert.equal(out.filter(Boolean).length,1);assert.notEqual(state,'running');}
});
function service() {
  let effects=0;const seen=new Map();
  return {apply(key,payload){if(seen.has(key)){const old=seen.get(key);if(old.payload!==payload)throw Error('key/payload conflict');return old.result;}const result=++effects;seen.set(key,{payload,result});return result;},count:()=>effects};
}
test('DIST-ACK-001: lost ACK can repeat delivery without repeating protected effect',()=>{
  const s=service();s.apply('request-1','payload'); // crash before ACK
  s.apply('request-1','payload');assert.equal(s.count(),1);
  let unprotected=0;for(const delivery of [1,2]){void delivery;unprotected++;}assert.equal(unprotected,2);
});
test('DIST-IDEMPOTENCY-002: same intent key stable, different payload rejected',()=>{
  const s=service();assert.equal(s.apply('k','x'),s.apply('k','x'));assert.throws(()=>s.apply('k','y'),/conflict/);s.apply('k2','x');assert.equal(s.count(),2);
});
test('DIST-RETRY-003: bounded retry stops at total budget and avoids permanent errors',()=>{
  function attempt(f,budget){for(let n=1;n<=budget;n++){try{return f(n);}catch(e){if(e.permanent||n===budget)throw e;}}throw Error('empty budget');}
  let calls=0;assert.throws(()=>attempt(()=>{calls++;throw Error('temporary');},3));assert.equal(calls,3);
  calls=0;assert.throws(()=>attempt(()=>{calls++;throw Object.assign(Error('permanent'),{permanent:true});},3));assert.equal(calls,1);
});
test('DIST-ORDER-004: stale revisions rejected; epochs are not compared as bare numbers',()=>{
  let current={epoch:'e2',revision:4};const apply=event=>{if(event.epoch!==current.epoch||event.revision<=current.revision)return false;current=event;return true;};assert.equal(apply({epoch:'e2',revision:3}),false);assert.equal(apply({epoch:'e1',revision:999}),false);assert.equal(apply({epoch:'e2',revision:5}),true);assert.equal(apply({epoch:'e2',revision:5}),false);
});
test('PERF-MEASURE-001: comparison rejects mismatched workload and cache policy',()=>{
  const comparable=(a,b)=>a.workload===b.workload&&a.cache===b.cache&&a.environment===b.environment;
  const a={workload:'100k-edges',cache:'cold',environment:'local'};assert.equal(comparable(a,{...a}),true);assert.equal(comparable(a,{...a,cache:'warm'}),false);assert.equal(comparable(a,{...a,workload:'10-edges'}),false);
});
test('PERF-BOUND-002: bounded queue never silently exceeds capacity',()=>{
  const q=[];let denied=0;for(let i=0;i<10000;i++){if(q.length<17)q.push(i);else denied++;}assert.equal(q.length,17);assert.equal(denied,9983);q.shift();if(q.length<17)q.push('resume');assert.equal(q.length,17);
});
test('PERF-CACHE-003: TTL and capacity solve different failure paths',()=>{
  const entries=new Map();const put=(k,v,now)=>{for(const [x,record]of entries)if(record.expires<=now)entries.delete(x);if(entries.has(k))entries.delete(k);entries.set(k,{v,expires:now+10});while(entries.size>3)entries.delete(entries.keys().next().value);};
  for(let i=0;i<1000;i++)put(i,i,0);assert.equal(entries.size,3);put('later',1,11);assert.equal(entries.size,1);
});
test('PERF-BATCH-004: partial batch is released at deadline',()=>{
  const batch={items:[],since:null};const push=(x,now)=>{if(!batch.items.length)batch.since=now;batch.items.push(x);};const flush=now=>{if(batch.items.length&&(batch.items.length>=3||now-batch.since>=10)){const out=batch.items.splice(0);batch.since=null;return out;}return [];};push('only-one',0);assert.deepEqual(flush(9),[]);assert.deepEqual(flush(10),['only-one']);assert.deepEqual(flush(100),[]);
});
test('LANG-ALIAS-001: nested snapshot detached from caller mutation',()=>{
  const original={x:[{v:1}]},snapshot=structuredClone(original),before=hashJson(snapshot);original.x[0].v=2;assert.equal(hashJson(snapshot),before);assert.notEqual(hashJson(original),before);
});
test('LANG-NUMERIC-002: unsafe integer and nonfinite serialization witnesses',()=>{
  assert.equal(9007199254740992,Number('9007199254740993'));assert.equal(Number.isSafeInteger(9007199254740992),false);assert.throws(()=>canonicalJson(Infinity));
});
test('DESIGN-STATE-002: NOT_RUN is not empty-success',()=>{
  const ok=r=>r.execution==='EXECUTED'&&r.result==='PASS';assert.equal(ok({execution:'NOT_RUN',result:'PASS'}),false);assert.equal(ok({execution:'EXECUTED',result:'PASS'}),true);
});
