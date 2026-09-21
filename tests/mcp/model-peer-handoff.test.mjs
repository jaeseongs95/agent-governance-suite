import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelPeerPacketSigner, PEER_PACKET_FEATURE, peerMessageId, isModelPeerPacket } from '../../mcp-server/src/model-peer-packet.js';
import { ModelPeerJournal } from '../../mcp-server/src/model-peer-journal.js';
import { ModelRoutingPeerSession } from '../../mcp-server/src/model-routing-peer-session.js';
import { ModelRoutingWorkflowBridge } from '../../mcp-server/src/model-routing-workflow.js';
import { ModelRoutingStore } from '../../skills/coordinate-subagents/scripts/model-routing-store.mjs';
import { SessionMessageStore } from '../../mcp-server/src/session-message-store.js';
import { SessionModelCapabilityStore, capabilitySigner, MODEL_CAPABILITY_FEATURE } from '../../mcp-server/src/session-model-capabilities.js';
import { encodePeerAssignment, acceptPeerAssignment, MODEL_ROUTING_PEER_FEATURE } from '../../skills/coordinate-subagents/scripts/model-routing-peer.mjs';
import { digest, seal, resolveV2 } from '../../skills/coordinate-subagents/scripts/model-routing-core.mjs';
import { createPeerWorkflow, SENDER, RECEIVER, TOKEN } from './peer-handoff-fixtures.mjs';
import { NOW } from '../coordinate-subagents/model-routing-v2/fixtures.mjs';

const cleanups=[];afterEach(()=>{vi.restoreAllMocks();while(cleanups.length)cleanups.pop()();});
function fixture(){
  const directory=mkdtempSync(join(tmpdir(),'ags-peer-unit-'));cleanups.push(()=>rmSync(directory,{recursive:true,force:true}));
  let now=Date.parse(NOW);vi.spyOn(Date,'now').mockImplementation(()=>now);
  const h=createPeerWorkflow(directory,{now});cleanups.push(h.close);
  const sessions=new SessionMessageStore(join(directory,'messages.sqlite3'));cleanups.push(()=>sessions.close());
  for(const identity of [SENDER,RECEIVER])sessions.startPresence({...identity,transport:'fixture',wakeVisibility:'none',canWakeSilently:false},now);
  const caps=new SessionModelCapabilityStore(sessions,capabilitySigner(TOKEN));
  const signer=new ModelPeerPacketSigner(TOKEN);
  const publish=()=>caps.publish(capabilitySigner(TOKEN).issue('capability',{schemaVersion:'1.0.0',identity:RECEIVER,snapshot:h.cap},{issuedAt:h.cap.observedAt,expiresAt:h.cap.expiresAt}),now);
  publish();const calls=[];
  const transport=async(operation,payload)=>{
    calls.push({operation,payload:structuredClone(payload)});
    switch(operation){
      case 'ping':return{protocolVersion:'1.0.0',capabilities:[MODEL_CAPABILITY_FEATURE]};
      case 'list-model-capabilities':return caps.list(payload,now);
      case 'presence':return{presence:sessions.presence(payload.target,now)};
      case 'send':return sessions.send(payload,now);
      case 'status':return{status:sessions.status(payload.sender,payload.messageId,now)};
      default:throw new Error('Unexpected operation: '+operation);
    }
  };
  const sender=h.peer(SENDER,{request:transport,clock:()=>now}),receiver=h.peer(RECEIVER,{request:transport,clock:()=>now});
  const claim=identity=>sessions.claim(identity,now,{maxMessages:10,maxBodyChars:32768});
  const advance=milliseconds=>{now+=milliseconds;};
  return{...h,sessions,caps,signer,transport,calls,sender,receiver,claim,advance,publish,now:()=>now};
}
async function sent(h){const result=await h.sender.send(h.decision.decisionDigest,{delta:'정정: 목표와 소유 파일은 바꾸지 않는다.'});expect(result.handoffState).toBe('sent');return h.claim(RECEIVER)[0];}
function message(h,packet){const body=h.signer.sign(packet);return{messageId:peerMessageId(body),sender:packet.sender,recipient:packet.recipient,body,createdAt:packet.issuedAt,expiresAt:packet.expiresAt,deliveryAttempt:1,firstDeliveredAt:packet.issuedAt};}

describe('bounded signed handoff packets',()=>{
  it('roundtrips the exact proposal and rejects unsigned or edited body text',async()=>{
    const h=fixture(),m=await sent(h),decoded=h.signer.verifyMessage(m,RECEIVER,h.now());
    expect(decoded.contents.delta).toContain('정정');expect(decoded.feature).toBe(PEER_PACKET_FEATURE);
    expect(isModelPeerPacket(m.body)).toBe(true);expect(isModelPeerPacket('ordinary message')).toBe(false);
    expect(()=>h.signer.verify(m.body.replace('정정','수정'),h.now())).toThrow(/signature/u);
    const raw=JSON.parse(m.body);delete raw.mac;expect(()=>h.signer.verify(JSON.stringify(raw),h.now())).toThrow();
  });
  it.each(['sender','recipient'])('binds the signed %s instance rather than a caller claim',async key=>{
    const h=fixture(),m=await sent(h);m[key]={...m[key],sessionId:'wrong'};
    expect(()=>h.signer.verifyMessage(m,RECEIVER,h.now())).toThrow();
  });
  it('requires a deterministic message ID and the correct local instance',async()=>{
    const h=fixture(),m=await sent(h);expect(()=>h.signer.verifyMessage({...m,messageId:'forged-message'},RECEIVER,h.now())).toThrow();
    expect(()=>h.signer.verifyMessage(m,{...RECEIVER,instanceId:'new-instance'},h.now())).toThrow();
  });
  it('does not elevate a receipt to execution success',()=>{
    const h=fixture(),packet={kind:'receipt',sender:RECEIVER,recipient:SENDER,issuedAt:NOW,expiresAt:new Date(h.now()+60000).toISOString(),
      contents:{proposalId:'ags-peer-'+'a'.repeat(64),decisionDigest:h.decision.decisionDigest,bindingDigest:digest(h.req.binding),disposition:'accepted',reason:'OK',executionStarted:false,completed:true}};
    expect(()=>h.signer.sign(packet)).toThrow(/execution/u);
  });
  it('bounds UTF-8 bytes and rejects hidden fields, future times and excessive lifetimes',async()=>{
    const h=fixture(),m=await sent(h),raw=JSON.parse(m.body);delete raw.mac;
    expect(()=>h.signer.sign({...raw,expiresAt:new Date(h.now()+60001).toISOString()})).toThrow();
    expect(()=>h.signer.verify(m.body,h.now()-1)).toThrow();h.advance(60000);expect(()=>h.signer.verify(m.body,h.now())).toThrow();
    expect(()=>h.signer.sign({...raw,contents:{...raw.contents,delta:'가'.repeat(2000)}})).toThrow();
    expect(()=>h.signer.sign({...raw,extra:'grant'})).toThrow();
  });
});

describe('existing spool delivery and independent handoff state',()=>{
  it('delivers delta only and keeps ACK, acceptance and execution separate',async()=>{
    const h=fixture(),m=await sent(h),packet=JSON.parse(m.body);
    expect(packet.contents).not.toHaveProperty('request');expect(packet.contents).not.toHaveProperty('environment');
    h.sessions.acknowledge(RECEIVER,[m.messageId],h.now());const before=await h.sender.status(m.messageId);
    expect(before.delivery.status.state).toBe('acknowledged');expect(before.accepted).toBe(false);expect(before.completed).toBe(false);
    const original=h.workflow.getRun(h.run.runId),accepted=await h.receiver.receive(m);
    expect(accepted.handoffState).toBe('accepted');expect(accepted.executionStarted).toBe(false);
    expect(h.workflow.getRun(h.run.runId)).toEqual(original);
    expect(h.routing.dispatch(digest({binding:h.req.binding}))).toMatchObject({state:'accepted',dispatched_at:null});
    const reply=h.claim(SENDER)[0];expect(reply).toBeDefined();await h.sender.receive(reply);
    expect(await h.sender.status(m.messageId)).toMatchObject({accepted:true,completed:false,executionAuthorized:false,executionState:'not-observed'});
  });
  it('retries the same signed bytes and message ID without extending the signature lifetime',async()=>{
    const h=fixture();const first=await h.sender.send(h.decision.decisionDigest);h.advance(1000);
    const second=await h.sender.send(h.decision.decisionDigest);expect(first.packetId).toBe(second.packetId);
    const sends=h.calls.filter(x=>x.operation==='send');expect(sends[0].payload).toEqual(sends[1].payload);
    expect(h.sessions.pendingCount(RECEIVER,h.now())).toBe(1);
    await expect(h.sender.send(h.decision.decisionDigest,{delta:'changed'})).rejects.toThrow(/identical/u);
  });
  it('keeps a lost send response unknown and never rolls back a possibly delivered offer',async()=>{
    const h=fixture();let lose=true;
    const sender=h.peer(SENDER,{clock:h.now,request:async(...args)=>{const result=await h.transport(...args);if(args[0]==='send'&&lose){lose=false;throw new Error('response lost');}return result;}});
    const first=await sender.send(h.decision.decisionDigest);expect(first.handoffState).toBe('unknown');expect(h.claim(RECEIVER)).toHaveLength(1);
    const second=await sender.send(h.decision.decisionDigest);expect(second.packetId).toBe(first.packetId);expect(second.handoffState).toBe('sent');
  });
  it('refuses new writes in the same stage when the earlier handoff is unresolved',async()=>{
    const h=fixture();await sent(h);const req=structuredClone(h.req);req.binding.assignmentId='replacement';
    const decision=resolveV2(req,h.env);h.routing.saveDecision(req,h.env,decision,NOW);
    await expect(h.sender.send(decision.decisionDigest)).rejects.toThrow();
    expect(h.calls.filter(x=>x.operation==='send')).toHaveLength(1);
  });
  it('fails closed when shared capability negotiation is unsupported without sending new commands',async()=>{
    const h=fixture();const sender=h.peer(SENDER,{clock:h.now,request:async(op)=>{expect(op).toBe('ping');return{protocolVersion:'1.0.0',capabilities:[]};}});
    await expect(sender.send(h.decision.decisionDigest)).rejects.toThrow(/unavailable|unsupported/u);
    expect(h.sessions.pendingCount(RECEIVER,h.now())).toBe(0);
  });
  it.each(['ended','instance','snapshot'])('rechecks the target before sending after %s changes',async change=>{
    const h=fixture();
    if(change==='ended')h.sessions.endPresence(RECEIVER,'fixture',RECEIVER.instanceId,h.now());
    if(change==='instance')h.sessions.startPresence({...RECEIVER,instanceId:'next',transport:'fixture',wakeVisibility:'none',canWakeSilently:false},h.now());
    if(change==='snapshot'){h.advance(1);h.cap=seal({...h.cap,observedAt:new Date(h.now()).toISOString(),expiresAt:new Date(h.now()+60000).toISOString()},'snapshotDigest');h.caps.publish(capabilitySigner(TOKEN).issue('capability',{schemaVersion:'1.0.0',identity:RECEIVER,snapshot:h.cap},{issuedAt:h.cap.observedAt,expiresAt:h.cap.expiresAt}),h.now());}
    await expect(h.sender.send(h.decision.decisionDigest)).rejects.toThrow();expect(h.sessions.pendingCount(RECEIVER,h.now())).toBe(0);
  });
  it('does not accept foreign candidate or local-subagent decisions as peer handoffs',async()=>{
    const h=fixture();const bad=seal({...h.decision,invocationSurface:'local-subagent'},'decisionDigest');h.routing.saveDecision(h.req,h.env,bad,NOW);
    await expect(h.sender.send(bad.decisionDigest)).rejects.toThrow(/peer-session/u);
  });
});

describe('receiver admission, local authority and replay',()=>{
  it('admits an identical proposal only once and returns the same immutable receipt',async()=>{
    const h=fixture(),m=await sent(h),spy=vi.spyOn(h.bridge,'validatePeerHandoff');
    await h.receiver.receive(m);const count=spy.mock.calls.length;
    const retry=await h.receiver.receive(m);expect(retry.duplicate).toBe(true);expect(spy.mock.calls).toHaveLength(count);
    const replies=h.calls.filter(x=>x.operation==='send'&&x.payload.sender.sessionId===RECEIVER.sessionId);
    expect(replies).toHaveLength(2);expect(replies[0].payload).toEqual(replies[1].payload);
  });
  it('serializes simultaneous claims on two SQLite connections without an early false refusal',async()=>{
    const h=fixture(),m=await sent(h),db=new DatabaseSync(h.path),store=new ModelRoutingStore(db);
    try{
      const other=new ModelRoutingPeerSession({store,workflowBridge:new ModelRoutingWorkflowBridge(h.workflow,store),identity:RECEIVER,actorId:h.actorId,signer:h.signer,stateDirectory:h.directory,request:h.transport,clock:h.now,timeoutMs:10000});
      const results=await Promise.all([h.receiver.receive(m),other.receive(m)]);
      expect(results.filter(x=>x.handoffState==='accepted')).toHaveLength(1);expect(results.filter(x=>x.handoffState==='unknown')).toHaveLength(1);
      expect(h.receiver.journal.get(m.messageId,'inbound').state).toBe('accepted');expect(h.claim(SENDER)).toHaveLength(1);
    }finally{db.close();}
  });
  it('retains the local admission when the reply response is lost',async()=>{
    const h=fixture(),m=await sent(h);let loses=true;
    const receiver=h.peer(RECEIVER,{clock:h.now,request:async(...args)=>{const result=await h.transport(...args);if(args[0]==='send'&&loses){loses=false;throw new Error('lost reply');}return result;}});
    expect((await receiver.receive(m)).receiptDelivered).toBe(false);
    expect((await receiver.receive(m)).duplicate).toBe(true);expect(h.claim(SENDER)).toHaveLength(1);
    expect(h.routing.dispatch(digest({binding:h.req.binding})).state).toBe('accepted');
  });
  it('does not automatically recover a crashed admission as permission to run twice',async()=>{
    const h=fixture(),m=await sent(h);h.receiver.journal.prepare('inbound',h.decision,m.body,false,JSON.parse(m.body).expiresAt);h.receiver.journal.claimInbound(m.messageId);
    const response=await h.receiver.receive(m);expect(response.handoffState).toBe('unknown');expect(h.claim(SENDER)).toEqual([]);
    expect(h.routing.dispatch(digest({binding:h.req.binding}))).toBeNull();
  });
  it('rejects when a receiver has no matching local workflow, without importing sender state',async()=>{
    const h=fixture(),m=await sent(h),db=new DatabaseSync(':memory:'),store=new ModelRoutingStore(db);
    try{
      const receiver=new ModelRoutingPeerSession({store,workflowBridge:new ModelRoutingWorkflowBridge(h.workflow,store),identity:RECEIVER,actorId:h.actorId,signer:h.signer,stateDirectory:h.directory,request:h.transport,clock:h.now,timeoutMs:10000});
      expect((await receiver.receive(m)).handoffState).toBe('rejected');expect(store.decision(h.decision.decisionDigest)).toBeNull();
      expect(store.dispatch(digest({binding:h.req.binding}))).toBeNull();await h.sender.receive(h.claim(SENDER)[0]);
      expect((await h.sender.status(m.messageId)).handoffState).toBe('rejected');
    }finally{db.close();}
  });
  it('requires the observed actor to own the already-consumed local lease',async()=>{
    const h=fixture(),m=await sent(h),original=h.workflow.getGuardedRunBinding.bind(h.workflow);
    vi.spyOn(h.workflow,'getGuardedRunBinding').mockImplementation(id=>{const binding=original(id);return{...binding,lease:{...binding.lease,actorId:'other'}};});
    const response=await h.receiver.receive(m);expect(response.handoffState).toBe('rejected');
    expect(h.routing.dispatch(digest({binding:h.req.binding})).state).toBe('not-started');
  });
  it('does not treat a peer body as a local actor override',async()=>{
    const h=fixture(),m=await sent(h),receiver=h.peer(RECEIVER,{clock:h.now,request:h.transport,actor:'forged'});
    await expect(receiver.receive(m)).rejects.toThrow(/actor/u);expect(h.routing.dispatch(digest({binding:h.req.binding}))).toBeNull();
  });
  it('rechecks local workflow revision after asynchronous capability refresh',async()=>{
    const h=fixture(),m=await sent(h),original=h.bridge.validatePeerHandoff.bind(h.bridge);let receiverChecks=0;
    vi.spyOn(h.bridge,'validatePeerHandoff').mockImplementation((req,actor)=>{if(actor&&++receiverChecks===2)throw new Error('revision changed');return original(req,actor);});
    const response=await h.receiver.receive(m);expect(response.handoffState).toBe('rejected');
    expect(h.routing.dispatch(digest({binding:h.req.binding})).state).toBe('not-started');
  });
  it('keeps an existing unknown write dispatch unknown instead of declaring non-execution',async()=>{
    const h=fixture(),m=await sent(h),reserved=h.routing.reserveDispatch(h.decision,{write:true});h.routing.transition(reserved.dispatchKey,0,'unknown');
    expect((await h.receiver.receive(m)).handoffState).toBe('unknown');expect(h.routing.dispatch(reserved.dispatchKey).state).toBe('unknown');
  });
  it('does not accept an already expired proposal or a signed reply for another task',async()=>{
    const h=fixture(),m=await sent(h);await h.receiver.receive(m);const reply=h.claim(SENDER)[0],packet=JSON.parse(reply.body);delete packet.mac;
    packet.contents.bindingDigest=digest('another task');await expect(h.sender.receive(message(h,packet))).rejects.toThrow(/Cross-task/u);
    h.advance(60000);await expect(h.receiver.receive(m)).rejects.toThrow(/expired/u);
  });
  it('makes a definitive acceptance immutable against a later signed rejection',async()=>{
    const h=fixture(),m=await sent(h);await h.receiver.receive(m);const reply=h.claim(SENDER)[0];await h.sender.receive(reply);
    const packet=JSON.parse(reply.body);delete packet.mac;packet.contents.disposition='rejected';
    await expect(h.sender.receive(message(h,packet))).rejects.toThrow(/Conflicting/u);
    expect((await h.sender.status(m.messageId)).accepted).toBe(true);
  });
});

describe('bounded transfer journal and common helper failure boundaries',()=>{
  it('does not delete active write reservations on TTL expiration and preserves user_version',async()=>{
    const h=fixture(),version=h.database.prepare('PRAGMA user_version').get().user_version,m=await sent(h);
    h.sender.journal.unknown(m.messageId);h.advance(60000);new ModelPeerJournal(h.database);
    expect(h.sender.journal.get(m.messageId).state).toBe('unknown');expect(h.database.prepare('PRAGMA user_version').get().user_version).toBe(version);
  });
  it('bounds retained transfer records without pruning another workflow or ordinary messages',()=>{
    const h=fixture();
    for(let i=0;i<256;i++)h.sender.journal.prepare('inbound',{...h.decision,decisionDigest:'sha256:'+i.toString(16).padStart(64,'0')},'packet-'+i,false,NOW);
    expect(()=>h.sender.journal.prepare('inbound',h.decision,'one-too-many',false,NOW)).toThrow(/full/u);
    h.sessions.send({sender:SENDER,target:RECEIVER,body:'ordinary message'},h.now());expect(h.claim(RECEIVER)[0].body).toBe('ordinary message');
  });
  it('keeps external authorization exceptions unknown instead of releasing the write exclusion',async()=>{
    const h=fixture(),body=encodePeerAssignment(h.req,h.decision),environment={...h.env,presence:{host:h.cap.host,sessionId:h.cap.sessionId,instanceId:h.cap.instanceId,state:'online',leaseUntil:h.cap.expiresAt}};
    const result=await acceptPeerAssignment(body,{features:[MODEL_ROUTING_PEER_FEATURE],target:h.decision.target,loadAssignment:async()=>({request:h.req,decision:h.decision}),environment:{...environment,refresh:async()=>environment},store:h.routing,authorizeAndConsume:async()=>{throw new Error('could have consumed');}});
    expect(result.reason).toBe('AUTHORIZATION_OUTCOME_UNKNOWN');expect(result.shouldExecute).toBe(false);expect(h.routing.dispatch(result.dispatchKey).state).toBe('unknown');
  });
  it('cannot encode a request changed after selection',()=>{
    const h=fixture();expect(()=>encodePeerAssignment({...h.req,profile:'quality'},h.decision)).toThrow();
  });
});
