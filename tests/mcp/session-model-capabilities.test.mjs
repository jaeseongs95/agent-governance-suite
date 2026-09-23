import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionMessageStore } from '../../mcp-server/src/session-message-store.js';
import { SessionModelCapabilityStore, capabilitySigner, capabilitySlot, MODEL_CAPABILITY_FEATURE } from '../../mcp-server/src/session-model-capabilities.js';
import { readSharedModelCapabilities, publishSharedModelCapability, mergeRoutingCapabilities } from '../../mcp-server/src/model-capability-client.js';
import { dispatchSessionMessageBrokerOperation } from '../../mcp-server/src/session-message-broker.js';
import { SESSION_MESSAGE_PROTOCOL, SESSION_MESSAGE_MAX_RESPONSE_BYTES } from '../../mcp-server/src/session-message-protocol.js';
import { canonicalJson } from '../../mcp-server/src/convergence-logic.js';
import { ModelRoutingServiceCore } from '../../skills/coordinate-subagents/scripts/model-routing-service-core.mjs';
import { loadCatalog } from '../../skills/coordinate-subagents/scripts/model-catalog.mjs';
import { seal, resolveV2 } from '../../skills/coordinate-subagents/scripts/model-routing-core.mjs';
import { capability, request, environment, NOW } from '../coordinate-subagents/model-routing-v2/fixtures.mjs';

const start=Date.parse(NOW),at=delta=>new Date(start+delta).toISOString(),token='K'.repeat(43);
const dispose=[];
afterEach(()=>{while(dispose.length)dispose.pop()();});
function harness(now=NOW){
  const currentStart=Date.parse(now),currentAt=delta=>new Date(currentStart+delta).toISOString();
  const dir=mkdtempSync(join(tmpdir(),'ags-cap-exchange-'));dispose.push(()=>rmSync(dir,{recursive:true,force:true}));
  writeFileSync(join(dir,'broker.token'),token);
  const sessions=new SessionMessageStore(join(dir,'messages.sqlite3'));dispose.push(()=>sessions.close());
  const signer=capabilitySigner(token),store=new SessionModelCapabilityStore(sessions,signer);
  function setup(id='s-1',changes={}){
    const identity={host:'native-adapter',sessionId:id,instanceId:'i-1'};
    sessions.startPresence({...identity,transport:'test',wakeVisibility:'none',canWakeSilently:false},currentStart);
    const snapshot=capability({sessionId:id,instanceId:'i-1',observedAt:now,expiresAt:currentAt(60000),...changes});
    return {schemaVersion:'1.0.0',identity,snapshot};
  }
  const sign=(publication,issuedAt=now)=>signer.issue('capability',publication,{issuedAt,expiresAt:publication.snapshot.expiresAt});
  const wire=async(operation,payload)=>operation==='ping'?{protocolVersion:SESSION_MESSAGE_PROTOCOL,capabilities:[MODEL_CAPABILITY_FEATURE]}:
    operation==='list-model-capabilities'?store.list(payload,currentStart):operation==='publish-model-capability'?store.publish(payload.receipt,currentStart):Promise.reject(new Error('unexpected operation'));
  return{dir,sessions,signer,store,setup,sign,wire};
}
function resign(receipt){const unsigned={...receipt};delete unsigned.mac;return{...unsigned,mac:createHmac('sha256',createHmac('sha256',token).update('ags:session-model-capabilities:v1').digest()).update(canonicalJson(unsigned)).digest('hex')};}

describe('P5 additive broker capability publication',()=>{
  it('preserves snapshot bytes, configuration source and independent presence expiry',()=>{
    const h=harness(),pub=h.setup('s-1',{source:'configuration'}),receipt=h.sign(pub);
    expect(h.store.publish(receipt,start)).toMatchObject({duplicate:false,revision:1});
    const page=h.store.list({},start);expect(page.entries[0].snapshot).toEqual(pub.snapshot);expect(page.entries[0].snapshot.source).toBe('configuration');
    expect(page.entries[0].presenceLeaseUntil).toBe(at(20000));expect(page.entries[0].snapshot.expiresAt).toBe(at(60000));
    expect(resolveV2({...request(),highRisk:true},environment({capabilities:[page.entries[0].snapshot]})).status).toBe('blocked');
  });
  it('treats exact receipt retries as idempotent but does not refresh their lifetime',()=>{
    const h=harness(),pub=h.setup(),receipt=h.sign(pub);h.store.publish(receipt,start);
    expect(h.store.publish(receipt,start+1000)).toMatchObject({duplicate:true,revision:1});
    expect(h.store.list({},start+1000).entries[0].snapshot.expiresAt).toBe(pub.snapshot.expiresAt);
    expect(h.store.publish(h.sign(pub),start+1000)).toMatchObject({duplicate:true,revision:1});
  });
  it('rejects stale and conflicting publications without replacing the current record',()=>{
    const h=harness(),pub=h.setup();h.store.publish(h.sign(pub),start);
    const fresh={...pub,snapshot:seal({...pub.snapshot,observedAt:at(1000),hostVersion:'next'},'snapshotDigest')};h.store.publish(h.sign(fresh,at(1000)),start+1000);
    expect(()=>h.store.publish(h.sign(pub),start+1001)).toThrow(/stale/u);
    const conflict={...fresh,snapshot:seal({...fresh.snapshot,hostVersion:'conflict'},'snapshotDigest')};
    expect(()=>h.store.publish(h.sign(conflict,at(1000)),start+1001)).toThrow(/conflicts/u);
    expect(h.store.list({},start+1001).entries[0].snapshot.hostVersion).toBe('next');
  });
  it('does not replay a formerly accepted receipt after replacement',()=>{
    const h=harness(),pub=h.setup(),old=h.sign(pub);h.store.publish(old,start);
    const next={...pub,snapshot:seal({...pub.snapshot,observedAt:at(1000)},'snapshotDigest')};h.store.publish(h.sign(next,at(1000)),start+1000);
    expect(()=>h.store.publish(old,start+1001)).toThrow();
  });
  it('detects nonce reuse with different signed content',()=>{
    const h=harness(),pub=h.setup(),first=h.sign(pub);h.store.publish(first,start);
    const next=h.sign({...pub,snapshot:seal({...pub.snapshot,observedAt:at(1000)},'snapshotDigest')},at(1000));
    next.nonce=first.nonce;expect(()=>h.store.publish(resign(next),start+1000)).toThrow(/nonce/u);
  });
  it.each(['mac','payload','kind'])('rejects a forged receipt %s',field=>{
    const h=harness(),pub=h.setup(),receipt=h.sign(pub);
    if(field==='mac')receipt.mac='0'.repeat(64);else if(field==='kind')receipt.kind='observation';else receipt.payload.snapshot.actorId='forged';
    expect(()=>h.store.publish(receipt,start)).toThrow();expect(h.store.list({},start).entries).toEqual([]);
  });
  it('never accepts an unsigned model-authored capability',()=>{
    const h=harness(),pub=h.setup();expect(()=>h.store.publish(pub,start)).toThrow();
    expect(()=>dispatchSessionMessageBrokerOperation(h.sessions,'publish-model-capability',{snapshot:pub.snapshot},h.store)).toThrow();
  });
  it.each(['sessionId','instanceId'])('rejects signed snapshot and transport %s mismatch',field=>{
    const h=harness(),pub=h.setup();pub.snapshot=seal({...pub.snapshot,[field]:'other'},'snapshotDigest');
    expect(()=>h.store.publish(h.sign(pub),start)).toThrow(/mismatch/u);
  });
  it('does not assume the transport host is the model origin or routing host',()=>{
    const h=harness(),pub=h.setup();h.store.publish(h.sign(pub),start);
    const entry=h.store.list({},start).entries[0];expect(entry.identity.host).toBe('native-adapter');expect(entry.snapshot.host).toBe('openai-codex');
  });
  it.each(['ended','expired','replaced'])('excludes %s presence without deleting ordinary messages',state=>{
    const h=harness(),pub=h.setup();h.store.publish(h.sign(pub),start);
    const msg=h.sessions.send({sender:pub.identity,target:pub.identity,body:'ordinary delta'},start);
    let time=start;
    if(state==='ended')h.sessions.endPresence(pub.identity,'done',pub.identity.instanceId,start+1);
    if(state==='expired')time=start+20001;
    if(state==='replaced')h.sessions.startPresence({...pub.identity,instanceId:'i-2',transport:'fixture',wakeVisibility:'none',canWakeSilently:false},start+1);
    expect(h.store.list({},time).entries).toEqual([]);expect(h.sessions.status(pub.identity,msg.messageId,time)).not.toBeNull();
  });
  it('checks current presence at publication, not just at query',()=>{
    const h=harness(),pub=h.setup();h.sessions.endPresence(pub.identity,'done',pub.identity.instanceId,start);
    expect(()=>h.store.publish(h.sign(pub),start)).toThrow(/live/u);
  });
  it('does not prolong model freshness when a session heartbeats',()=>{
    const h=harness(),pub=h.setup();h.store.publish(h.sign(pub),start);h.sessions.heartbeatPresence(pub.identity,'i-1',start+60001);
    expect(h.store.list({},start+60001).entries).toEqual([]);
  });
  it.each([{observedAt:at(1)},{expiresAt:NOW},{expiresAt:at(301000)}])('rejects future, expired and excessive snapshot TTL',changes=>{
    const h=harness(),pub=h.setup('s-1',changes);expect(()=>h.store.publish(h.sign(pub),start)).toThrow();
  });
  it('rejects snapshot lifetime beyond its receipt',()=>{
    const h=harness(),pub=h.setup(),receipt=h.sign(pub);receipt.expiresAt=at(30000);
    expect(()=>h.store.publish(resign(receipt),start)).toThrow(/outlives/u);
  });
  it('rejects noncanonical contents, incorrect digest, additional fields and unbounded size',()=>{
    const h=harness(),pub=h.setup();const corrupted={...pub,snapshot:{...pub.snapshot,snapshotDigest:'sha256:'+'a'.repeat(64)}};
    expect(()=>h.store.publish(h.sign(corrupted),start)).toThrow(/digest/u);
    expect(()=>h.store.publish(h.sign({...pub,authority:true}),start)).toThrow(/fields/u);
    const huge={...pub,snapshot:seal({...pub.snapshot,sourceReference:'x'.repeat(17000)},'snapshotDigest')};expect(()=>h.store.publish(h.sign(huge),start)).toThrow(/limit/u);
  });
  it('retains legacy DB schema/data/version and survives a second connection',()=>{
    const h=harness(),pub=h.setup();h.sessions.database.exec('PRAGMA user_version=17');
    const msg=h.sessions.send({sender:pub.identity,target:pub.identity,body:'legacy'},start);h.store.publish(h.sign(pub),start);
    const second=new SessionMessageStore(join(h.dir,'messages.sqlite3'));
    try{const exchange=new SessionModelCapabilityStore(second,h.signer);expect(exchange.list({},start).entries[0].snapshot).toEqual(pub.snapshot);
      expect(exchange.publish(h.sign(pub),start).duplicate).toBe(true);expect(second.status(pub.identity,msg.messageId,start)).not.toBeNull();
      expect(second.database.prepare('PRAGMA user_version').get().user_version).toBe(17);
    }finally{second.close();}
  });
  it('rejects corrupt stored signed metadata without changing legacy messaging',()=>{
    const h=harness(),pub=h.setup();h.store.publish(h.sign(pub),start);
    h.sessions.database.prepare('UPDATE ags_session_model_capabilities_v1 SET receipt=?').run('{}');expect(()=>h.store.list({},start)).toThrow();
    expect(h.sessions.send({sender:pub.identity,target:pub.identity,body:'still works'},start).messageId).toBeTruthy();
  });
  it('pages within the unchanged 32 KiB limit and invalidates cursors after a new publication',()=>{
    const h=harness();for(let i=0;i<8;i++){const pub=h.setup('s-'+i,{supportedBindings:Array.from({length:12},(_,j)=>({...capability().supportedBindings[0],runtimeMode:'fixture-'+j}))});h.store.publish(h.sign(pub),start);}
    const first=h.store.list({},start);expect(first.nextCursor).not.toBeNull();expect(Buffer.byteLength(JSON.stringify({ok:true,data:first}))+1).toBeLessThanOrEqual(SESSION_MESSAGE_MAX_RESPONSE_BYTES);
    const second=h.store.list({cursor:first.nextCursor},start);expect(second.entries.length).toBeGreaterThan(0);
    expect(second.entries.some(e=>first.entries.some(x=>x.snapshot.snapshotDigest===e.snapshot.snapshotDigest))).toBe(false);
    const pub=h.setup('new');h.store.publish(h.sign(pub),start);expect(()=>h.store.list({cursor:first.nextCursor},start)).toThrow(/changed/u);
  });
  it.each([{cursor:{revision:1,after:'bad'}},{cursor:{revision:-1,after:'a'.repeat(64)}},{cursor:{revision:1,after:'a'.repeat(64),extra:true}},{capabilities:[]}])('rejects malformed cursors and extra arguments',raw=>{
    const h=harness();expect(()=>h.store.list(raw,start)).toThrow();
  });
});

describe('P5 broker negotiation and resolver feed',()=>{
  it('sends only ping to an old broker and preserves generic message handling',async()=>{
    const h=harness(),calls=[],fake=async(op)=>{calls.push(op);return{protocolVersion:'1.0.0',capabilities:['delivery-capabilities']};};
    expect(await readSharedModelCapabilities(h.dir,{request:fake,clock:()=>start})).toEqual({status:'unsupported',entries:[]});
    expect(await publishSharedModelCapability(h.setup().snapshot,h.setup().identity,h.dir,{request:fake,clock:()=>start})).toBe('unsupported');
    expect(calls).toEqual(['ping','ping']);expect(dispatchSessionMessageBrokerOperation(h.sessions,'ping',{}).capabilities).not.toContain(MODEL_CAPABILITY_FEATURE);
    expect(dispatchSessionMessageBrokerOperation(h.sessions,'ping',{},h.store).capabilities).toContain(MODEL_CAPABILITY_FEATURE);
  });
  it('publishes and discovers through the negotiated client with no local import/cache',async()=>{
    const h=harness(),pub=h.setup();expect(await publishSharedModelCapability(pub.snapshot,pub.identity,h.dir,{request:h.wire,clock:()=>start})).toBe('published');
    const result=await readSharedModelCapabilities(h.dir,{request:h.wire,clock:()=>start});expect(result.status).toBe('available');expect(result.entries[0].snapshot).toEqual(pub.snapshot);
  });
  it('collects complete pages and preserves their exact source/digest',async()=>{
    const h=harness();for(let i=0;i<8;i++){const pub=h.setup('s-'+i,{supportedBindings:Array.from({length:12},(_,j)=>({...capability().supportedBindings[0],runtimeMode:'fixture-'+j}))});h.store.publish(h.sign(pub),start);}
    const result=await readSharedModelCapabilities(h.dir,{request:h.wire,clock:()=>start});expect(result.status).toBe('available');expect(result.entries).toHaveLength(8);
  });
  it('discards all pages on revision drift, duplicate slots or nonadvancing cursor',async()=>{
    const h=harness(),pub=h.setup();h.store.publish(h.sign(pub),start);const page=h.store.list({},start),slot=capabilitySlot(pub.identity);
    for(const second of [{...page,revision:page.revision+1},page,{...page,entries:[],nextCursor:{revision:page.revision,presenceDigest:page.presenceDigest,after:slot}}]){
      let n=0;const fake=async op=>op==='ping'?{protocolVersion:'1.0.0',capabilities:[MODEL_CAPABILITY_FEATURE]}:++n===1?{...page,nextCursor:{revision:page.revision,presenceDigest:page.presenceDigest,after:slot}}:second;
      expect(await readSharedModelCapabilities(h.dir,{request:fake,clock:()=>start})).toEqual({status:'unavailable',entries:[]});
    }
  });
  it('rechecks early page leases at the end and discards an expired set',async()=>{
    const h=harness(),pub=h.setup();h.store.publish(h.sign(pub),start);let reads=0;
    expect(await readSharedModelCapabilities(h.dir,{request:h.wire,clock:()=>++reads===1?start:start+21000})).toEqual({status:'unavailable',entries:[]});
  });
  it.each([null,{protocolVersion:'2.0.0',capabilities:[]},{protocolVersion:'1.0.0',capabilities:'anything'}])('rejects malformed negotiation %j',ping=>{
    const h=harness();return expect(readSharedModelCapabilities(h.dir,{request:async()=>ping})).resolves.toEqual({status:'unavailable',entries:[]});
  });
  it('reports unavailable without starting or retrying a disconnected broker',async()=>{
    const h=harness(),calls=[];const fake=async op=>{calls.push(op);throw new Error('offline');};
    expect(await readSharedModelCapabilities(h.dir,{request:fake})).toEqual({status:'unavailable',entries:[]});expect(calls).toEqual(['ping']);
  });
  it('does not resurrect native managed snapshots on old/unavailable/empty shared responses',()=>{
    const local=capability({sourceReference:'native-hook:fixture'}),other=capability({host:'other',sessionId:'other',sourceReference:'fixture:local'});
    for(const status of ['unsupported','unavailable','available'])expect(mergeRoutingCapabilities([local,other],{status,entries:[]})).toEqual([other]);
  });
  it('prefers live shared session instances without mutating or duplicating local snapshots',()=>{
    const old=capability({sourceReference:'fixture:local'}),next=capability({instanceId:'new'}),copy=structuredClone(old);
    const merged=mergeRoutingCapabilities([old],{status:'available',entries:[{snapshot:next}]});expect(merged).toEqual([next]);expect(old).toEqual(copy);
  });
  it('rejects conflicting routing identities instead of depending on packet order',()=>{
    const a=capability(),b=capability({actorId:'different'});
    expect(()=>mergeRoutingCapabilities([],{status:'available',entries:[{snapshot:a},{snapshot:b}]})).toThrow(/Conflicting/u);
  });
  it('invalidates pagination when an earlier session ends without any new publication',async()=>{
    const h=harness();for(let i=0;i<8;i++){const p=h.setup('s-'+i,{supportedBindings:Array.from({length:12},(_,j)=>({...capability().supportedBindings[0],runtimeMode:'fixture-'+j}))});h.store.publish(h.sign(p),start);}
    const page=h.store.list({},start);expect(page.nextCursor).not.toBeNull();const identity=page.entries[0].identity;
    h.sessions.endPresence(identity,'ended-between-pages',identity.instanceId,start+1);
    expect(()=>h.store.list({cursor:page.nextCursor},start+1)).toThrow(/presence changed/u);
  });
  it('bounds slot storage while expired publications free capacity',()=>{
    const h=harness();for(let i=0;i<256;i++){const p=h.setup('slot-'+i);h.store.publish(h.sign(p),start);}
    const overflow=h.setup('overflow');expect(()=>h.store.publish(h.sign(overflow),start)).toThrow(/slot limit/u);
    const late=start+61000;h.sessions.heartbeatPresence(overflow.identity,'i-1',late);
    overflow.snapshot=seal({...overflow.snapshot,observedAt:at(61000),expiresAt:at(121000)},'snapshotDigest');
    expect(h.store.publish(h.sign(overflow,at(61000)),late).duplicate).toBe(false);
    expect(h.store.list({},late).entries).toHaveLength(1);
  });
  it('does not copy caller capabilities into an otherwise valid resolver request',()=>{
    const core=new ModelRoutingServiceCore({clock:()=>NOW});
    expect(core.call('resolve_model_assignment',{...request(),capabilities:[capability()]},[capability()]).ok).toBe(false);
  });
  it('uses explicit shared actor/session relations for independent-audit exclusions',()=>{
    const core=new ModelRoutingServiceCore({clock:()=>NOW,historyProvider:()=>({actors:['implementer'],sessions:[]})});
    const caps=[capability({actorId:'implementer',sessionId:'shared',instanceId:'old'}),capability({actorId:'new-auditor',sessionId:'shared',instanceId:'new'})];
    const input=request({highRisk:true,role:'independent-audit'}),before=structuredClone(input);
    const result=core.call('resolve_model_assignment',input,caps);expect(result.ok).toBe(true);expect(result.data.status).toBe('blocked');expect(input).toEqual(before);
    expect(result.data.rejectedCandidates.every(c=>c.reasonCodes.includes('INDEPENDENCE_CONFLICT'))).toBe(true);
  });
  it('does not confuse a broker publication with task dispatch or completion',()=>{
    const now=loadCatalog().snapshotDate,h=harness(now),pub=h.setup();h.store.publish(h.sign(pub),Date.parse(now));
    expect(h.sessions.database.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'ags_model_dispatch%'").all()).toEqual([]);
    const result=new ModelRoutingServiceCore({clock:()=>now}).call('resolve_model_assignment',request(),[pub.snapshot]);
    expect(result.data).toMatchObject({status:'selected',executionAuthorized:false,trustedGateSatisfied:false});
  });
  it('does not publish with missing or malformed broker credentials',async()=>{
    const h=harness(),pub=h.setup();writeFileSync(join(h.dir,'broker.token'),'malformed');const calls=[];
    const wire=async(op,payload)=>{calls.push(op);return h.wire(op,payload);};
    expect(await publishSharedModelCapability(pub.snapshot,pub.identity,h.dir,{request:wire,clock:()=>start})).toBe('unavailable');expect(calls).toEqual(['ping']);
  });

});
