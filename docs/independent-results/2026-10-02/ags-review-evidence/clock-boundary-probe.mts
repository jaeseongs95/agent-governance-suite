import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const root = process.argv[2];
const { SessionMessageStore } = await import(`${root}/mcp-server/src/session-message-store.ts`);
const { dispatchSessionMessageBrokerOperation: dispatch } = await import(`${root}/mcp-server/src/session-message-broker.ts`);
const dir = mkdtempSync(join(tmpdir(), 'ags-review-clock-'));
const store = new SessionMessageStore(join(dir, 'messages.sqlite3'));
const orig = Date.now;
try {
  const now = orig();
  const target = {host:'portable', sessionId:'target-1'};
  const actor = {...target,instanceId:'instance-1'};
  const sender = {host:'portable',sessionId:'sender-1'};
  store.startPresence({...target,instanceId:actor.instanceId,transport:'portable',wakeVisibility:'silent',canWakeSilently:true,deliveryCapabilities:{supportedInjection:['tool-boundary'],idleWake:'silent'}},now);
  const event={schemaVersion:'1.0.0',kind:'activity-observation',actor,revision:1,activity:'busy',source:'host-observed',observedAt:new Date(now+1).toISOString(),authorityEffect:'none'};
  const reader={verifyActivityReporter:()=>({authenticatedActor:actor,currentInstanceId:actor.instanceId,verifiedTurnId:'turn-1',verifiedRevision:1,verifiedActivity:'busy',verifiedObservedAt:event.observedAt,observedSource:'host-observed'})};
  store.recordActivity(event,'turn-1','proof',reader,now+1);
  const request={schemaVersion:'1.0.0',kind:'request',requestId:'request-clock-1',taskId:'task-1',sender:{...sender,instanceId:'sender-instance'},recipient:target,callbackTarget:sender,revision:1,requestedAt:new Date(now).toISOString(),expiresAt:new Date(now+3600000).toISOString(),authorityEffect:'none'};
  const input={request,body:'Task body',ttlSeconds:60};
  const reconcileToken=store.prepareTaskRequest(input,now).reconcileToken;
  const payload={...input,reconcileToken,expectedActor:actor,expectedTurnId:'turn-1',expectedRevision:1};
  Date.now=()=>now;
  const before=dispatch(store,'register-contact-task-request',payload,undefined,undefined,reader);
  Date.now=()=>now+2;
  const after=dispatch(store,'register-contact-task-request',payload,undefined,undefined,reader);
  console.log(JSON.stringify({root,before:{state:before.state,reason:before.reason},after:{state:after.state,duplicate:after.duplicate}}));
  if(before.state!=='held'||before.reason!=='activity-unknown'||after.state!=='queued') process.exitCode=1;
} finally {Date.now=orig;store.close();rmSync(dir,{recursive:true,force:true});}
