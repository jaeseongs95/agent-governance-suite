/** Additive tables on a caller-owned SQLite connection. No existing rows or user_version rewritten. */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import v2DecisionSchema from '../../../contracts/model-routing-decision.v2.schema.json' with { type: 'json' };
import v3DecisionSchema from '../../../contracts/model-routing-decision.v3.schema.json' with { type: 'json' };
import { Ajv2020 } from '../../../runtime/schema-validation.mjs';
import { assert, canonical, digest, keys, instant, validateCapabilities, validateBinding, validateTarget, verifySeal, recordV2 } from './model-routing-core.mjs';
import { validateEvaluation } from './model-evaluation.mjs';
import { recordSemanticApplicationV3 } from './semantic/application-record.mjs';

function transaction(db,fn){db.exec('BEGIN IMMEDIATE');try{const result=fn();db.exec('COMMIT');return result;}catch(error){db.exec('ROLLBACK');throw error;}}

const decisionSchemas = new Ajv2020({ allErrors: true, strict: false });
decisionSchemas.addSchema(v2DecisionSchema);
const validateDecisionV3 = decisionSchemas.compile(v3DecisionSchema);
function readDecisionPayload(payload,id){
  const decision=JSON.parse(payload);
  if(decision?.schemaVersion==='2.0.0')return decision;
  assert(decision?.schemaVersion==='3.0.0','UNSUPPORTED_DECISION_VERSION');
  assert(validateDecisionV3(decision),'INVALID_INPUT','Stored v3 decision does not match its contract');
  verifySeal(decision,'decisionDigest');
  assert(decision.decisionDigest===id,'DECISION_DIGEST_MISMATCH');
  return decision;
}

/** Local integrity proof only: a same-OS-user process can read the key. NOT human authorization. */
export class RoutingObservationSigner {
  #key;
  constructor(key){assert(Buffer.isBuffer(key)&&key.length>=32,'INVALID_OBSERVER_KEY');this.#key=Buffer.from(key);}
  issue(kind,payload,{issuedAt,expiresAt}){
    assert(['capability','observation'].includes(kind),'INVALID_INPUT');
    assert(instant(expiresAt,'expiresAt')>instant(issuedAt,'issuedAt')&&Date.parse(expiresAt)-Date.parse(issuedAt)<=300000,'INVALID_RECEIPT_TTL');
    const envelope={version:'1.0.0',kind,nonce:randomBytes(24).toString('hex'),issuedAt,expiresAt,payload:structuredClone(payload)};
    return {...envelope,mac:createHmac('sha256',this.#key).update(canonical(envelope)).digest('hex')};
  }
  verify(receipt,kind,now){
    keys(receipt,['version','kind','nonce','issuedAt','expiresAt','payload','mac']);
    assert(receipt.version==='1.0.0'&&receipt.kind===kind&&/^[a-f0-9]{48}$/u.test(receipt.nonce)&&/^[a-f0-9]{64}$/u.test(receipt.mac),'INVALID_RECEIPT');
    const t=instant(now,'now'),issued=instant(receipt.issuedAt,'issuedAt'),expires=instant(receipt.expiresAt,'expiresAt');
    assert(issued<=t&&t<expires&&expires-issued<=300000,'RECEIPT_EXPIRED');
    const unsigned={...receipt};delete unsigned.mac;
    const expected=createHmac('sha256',this.#key).update(canonical(unsigned)).digest();
    assert(timingSafeEqual(expected,Buffer.from(receipt.mac,'hex')),'INVALID_RECEIPT_MAC');
    return structuredClone(receipt.payload);
  }
}
export class ModelRoutingStore {
  constructor(database){
    assert(database&&typeof database.prepare==='function'&&typeof database.exec==='function','SQLITE_CONNECTION_REQUIRED');this.database=database;
    database.exec(`
      CREATE TABLE IF NOT EXISTS ags_model_capabilities_v1 (
        host TEXT NOT NULL, session_id TEXT NOT NULL, instance_id TEXT NOT NULL,
        observed_at TEXT NOT NULL, expires_at TEXT NOT NULL, snapshot_digest TEXT NOT NULL UNIQUE, payload TEXT NOT NULL,
        PRIMARY KEY(host,session_id,instance_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS ags_model_receipts_v1 (
        nonce TEXT PRIMARY KEY, kind TEXT NOT NULL, binding_digest TEXT, payload TEXT NOT NULL,
        expires_at TEXT NOT NULL, consumed_at TEXT
      ) STRICT;
      CREATE TABLE IF NOT EXISTS ags_model_decisions_v2 (
        decision_digest TEXT PRIMARY KEY, binding_digest TEXT NOT NULL, request_json TEXT NOT NULL,
        environment_json TEXT NOT NULL, payload TEXT NOT NULL, resolved_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS ags_model_decision_refs_v3 (
        decision_digest TEXT PRIMARY KEY, baseline_decision_digest TEXT NOT NULL,
        evaluation_id TEXT NOT NULL UNIQUE, registration_id TEXT NOT NULL UNIQUE,
        advice_digest TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS ags_model_applications_v2 (
        record_digest TEXT PRIMARY KEY, decision_digest TEXT NOT NULL, binding_digest TEXT NOT NULL,
        payload TEXT NOT NULL, recorded_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS ags_model_dispatches_v2 (
        dispatch_key TEXT PRIMARY KEY, assignment_id TEXT NOT NULL, write_key TEXT,
        decision_digest TEXT NOT NULL, state TEXT NOT NULL,
        revision INTEGER NOT NULL, delivery_ack INTEGER NOT NULL DEFAULT 0,
        observation_reference TEXT, dispatched_at TEXT, payload TEXT NOT NULL
      ) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS ags_model_active_write_v2
        ON ags_model_dispatches_v2(write_key)
        WHERE write_key IS NOT NULL AND state IN ('reserved','accepted','running','unknown');
      CREATE TABLE IF NOT EXISTS ags_model_native_hook_receipts_v1 (
        application_digest TEXT PRIMARY KEY, receipt_nonce TEXT NOT NULL UNIQUE
      ) STRICT;
      CREATE TABLE IF NOT EXISTS ags_model_evaluations_v1 (
        record_digest TEXT PRIMARY KEY, payload TEXT NOT NULL
      ) STRICT;
    `);
  }
  publishCapability(receipt,signer,presence,now){
    const snapshot=signer.verify(receipt,'capability',now);validateCapabilities(snapshot);
    assert(presence&&presence.host===snapshot.host&&presence.sessionId===snapshot.sessionId&&presence.instanceId===snapshot.instanceId&&presence.state==='online'&&instant(presence.leaseUntil,'leaseUntil')>instant(now,'now'),'CAPABILITY_PRESENCE_MISMATCH');
    assert(instant(snapshot.observedAt,'observedAt')<=Date.parse(now)&&instant(snapshot.expiresAt,'expiresAt')>Date.parse(now),'CAPABILITY_EXPIRED');
    return transaction(this.database,()=>{
      assert(!this.database.prepare('SELECT nonce FROM ags_model_receipts_v1 WHERE nonce=?').get(receipt.nonce),'RECEIPT_REPLAY');
      const old=this.database.prepare('SELECT observed_at,snapshot_digest FROM ags_model_capabilities_v1 WHERE host=? AND session_id=? AND instance_id=?').get(snapshot.host,snapshot.sessionId,snapshot.instanceId);
      assert(!old||old.observed_at<snapshot.observedAt||old.observed_at===snapshot.observedAt&&old.snapshot_digest===snapshot.snapshotDigest,'CAPABILITY_REVISION_REGRESSION');
      this.database.prepare(`INSERT INTO ags_model_capabilities_v1 VALUES (?,?,?,?,?,?,?) ON CONFLICT(host,session_id,instance_id) DO UPDATE SET observed_at=excluded.observed_at,expires_at=excluded.expires_at,snapshot_digest=excluded.snapshot_digest,payload=excluded.payload`).run(snapshot.host,snapshot.sessionId,snapshot.instanceId,snapshot.observedAt,snapshot.expiresAt,snapshot.snapshotDigest,canonical(snapshot));
      this.database.prepare('INSERT INTO ags_model_receipts_v1 VALUES (?,?,?,?,?,?)').run(receipt.nonce,'capability',null,canonical(snapshot),receipt.expiresAt,now);
      return {snapshotDigest:snapshot.snapshotDigest};
    });
  }
  capabilities(){return this.database.prepare('SELECT payload FROM ags_model_capabilities_v1 ORDER BY host,session_id,instance_id').all().map(r=>JSON.parse(r.payload));}
  saveDecision(request,environment,decision,now){
    assert(decision?.schemaVersion==='2.0.0','V3_WRITER_REQUIRED');
    verifySeal(decision,'decisionDigest');validateBinding(decision.binding);instant(now,'now');
    const payload=canonical(decision);const old=this.database.prepare('SELECT payload FROM ags_model_decisions_v2 WHERE decision_digest=?').get(decision.decisionDigest);
    assert(!old||old.payload===payload,'DECISION_CONFLICT');
    this.database.prepare('INSERT OR IGNORE INTO ags_model_decisions_v2 VALUES (?,?,?,?,?,?)').run(decision.decisionDigest,digest(decision.binding),canonical(request),canonical(environment),payload,now);
    return decision;
  }
  decision(id){const row=this.database.prepare('SELECT * FROM ags_model_decisions_v2 WHERE decision_digest=?').get(id);return row?{request:JSON.parse(row.request_json),environment:JSON.parse(row.environment_json),decision:readDecisionPayload(row.payload,id),resolvedAt:row.resolved_at}:null;}
  publishObservation(receipt,signer,now){
    const observation=signer.verify(receipt,'observation',now);validateBinding(observation.binding);validateTarget(observation.target);
    const entry=this.decision(observation.decisionDigest);assert(entry,'DECISION_UNKNOWN');
    assert(digest(observation.binding)===digest(entry.decision.binding)&&canonical(observation.target)===canonical(entry.decision.target)&&observation.source!=='agent-self-report','OBSERVATION_BINDING_MISMATCH');
    const dispatch = this.dispatch(digest({binding:observation.binding}));
    assert(dispatch && dispatch.decision_digest === observation.decisionDigest && dispatch.dispatched_at && ['running','unknown','succeeded','failed','cancelled'].includes(dispatch.state),'DISPATCH_NOT_OBSERVED');
    assert(instant(observation.observedAt,'observedAt')>=Date.parse(dispatch.dispatched_at),'OBSERVATION_PREDATES_DISPATCH');
    assert(Date.parse(observation.observedAt)<=instant(now,'now'),'OBSERVATION_IN_FUTURE');
    this.database.prepare('INSERT INTO ags_model_receipts_v1 VALUES (?,?,?,?,?,NULL)').run(receipt.nonce,'observation',digest(observation.binding),canonical(observation),receipt.expiresAt);
    return receipt.nonce;
  }
  /** Native hook admission is bound to exact application bytes; a caller cannot move it to another request. */
  bindNativeHookObservation(application,receipt,signer,now){
    return transaction(this.database,()=>{
      const observed=signer.verify(receipt,'observation',now);
      const entry=this.decision(application.decisionDigest);assert(entry,'DECISION_UNKNOWN');
      const dispatch=this.dispatch(digest({binding:application.binding}));
      assert(dispatch&&dispatch.decision_digest===application.decisionDigest&&dispatch.dispatched_at===application.dispatchedAt,'DISPATCH_TIME_MISMATCH');
      assert(instant(application.dispatchedAt,'dispatchedAt')<=instant(now,'now'),'DISPATCH_TIME_IN_FUTURE');
      // Validate with the same pure recorder before persisting any native receipt association.
      const context={...entry.environment,now:application.dispatchedAt,request:entry.request,decision:entry.decision,admittedObservation:observed};
      if(application.schemaVersion==='3.0.0')recordSemanticApplicationV3(application,context);
      else recordV2(application,context);
      const nonce=this.publishObservation(receipt,signer,now);
      this.database.prepare(`INSERT INTO ags_model_native_hook_receipts_v1 VALUES (?,?)
        ON CONFLICT(application_digest) DO UPDATE SET receipt_nonce=excluded.receipt_nonce`).run(digest(application),nonce);
      return {bound:true};
    });
  }
  nativeHookObservationToken(application){
    // Return consumed/expired tokens too: recordApplication must reject replay, never silently downgrade it.
    return this.database.prepare('SELECT receipt_nonce FROM ags_model_native_hook_receipts_v1 WHERE application_digest=?')
      .get(digest(application))?.receipt_nonce??null;
  }
  /** The callback must validate the entire record before token consumption commits. */
  recordApplication(input,observationToken,makeRecord,now){
    instant(now,'now');return transaction(this.database,()=>{
      if(input.schemaVersion==='3.0.0'){
        const dispatch=this.dispatch(digest({binding:input.binding}));
        assert(dispatch&&dispatch.decision_digest===input.decisionDigest&&dispatch.dispatched_at===input.dispatchedAt
          &&['running','unknown','succeeded','failed','cancelled'].includes(dispatch.state),'DISPATCH_TIME_MISMATCH');
      }
      let observation=null;
      if(observationToken!==null){
        const row=this.database.prepare('SELECT * FROM ags_model_receipts_v1 WHERE nonce=? AND kind=?').get(observationToken,'observation');
        assert(row&&!row.consumed_at&&row.expires_at>now,'OBSERVATION_TOKEN_UNAVAILABLE');
        assert(row.binding_digest===digest(input.binding),'OBSERVATION_BINDING_MISMATCH');observation=JSON.parse(row.payload);
        if(input.schemaVersion==='3.0.0'){
          assert(observation.decisionDigest===input.decisionDigest
            &&canonical(observation.target)===canonical(input.target)
            &&observation.source!=='agent-self-report','OBSERVATION_BINDING_MISMATCH');
          assert(instant(observation.observedAt,'observedAt')>=instant(input.dispatchedAt,'dispatchedAt'),
            'OBSERVATION_PREDATES_DISPATCH');
        }
      }
      const record=makeRecord(observation);verifySeal(record,'recordDigest');
      assert(record.schemaVersion===input.schemaVersion,'RECORD_VERSION_MISMATCH');
      const old=this.database.prepare('SELECT payload FROM ags_model_applications_v2 WHERE record_digest=?').get(record.recordDigest);
      assert(!old||old.payload===canonical(record),'RECORD_CONFLICT');
      this.database.prepare('INSERT OR IGNORE INTO ags_model_applications_v2 VALUES (?,?,?,?,?)').run(record.recordDigest,record.decisionDigest,digest(record.binding),canonical(record),now);
      if(observationToken!==null)this.database.prepare('UPDATE ags_model_receipts_v1 SET consumed_at=? WHERE nonce=?').run(now,observationToken);
      return {record,artifact:{kind:`model-application.v${input.schemaVersion[0]}`,uri:`ags-model-record:${record.recordDigest.slice(7)}`,digest:record.recordDigest}};
    });
  }
  application(recordDigest){const row=this.database.prepare('SELECT payload FROM ags_model_applications_v2 WHERE record_digest=?').get(recordDigest);return row?JSON.parse(row.payload):null;}
  reserveDispatch(decision,{write=false}={}){
    verifySeal(decision,'decisionDigest');assert(decision.status==='selected','ASSIGNMENT_BLOCKED');
    const b=decision.binding,key=digest({binding:b});
    // Model replacement cannot clear this active-write exclusion across revisions/attempts.
    const writeKey=write?digest({taskId:b.taskId,runId:b.runId,stageId:b.stageId}):null;
    return transaction(this.database,()=>{
      const old=this.database.prepare('SELECT * FROM ags_model_dispatches_v2 WHERE dispatch_key=?').get(key);
      if(old){assert(old.decision_digest===decision.decisionDigest,'DISPATCH_DECISION_CONFLICT');return {dispatchKey:key,duplicate:true,state:old.state,revision:old.revision};}
      if(writeKey)assert(!this.database.prepare("SELECT dispatch_key FROM ags_model_dispatches_v2 WHERE write_key=? AND state IN ('reserved','accepted','running','unknown')").get(writeKey),'AMBIGUOUS_WRITE_ACTIVE');
      this.database.prepare("INSERT INTO ags_model_dispatches_v2 VALUES (?,?,?,?, 'reserved',0,0,NULL,NULL,?)").run(key,b.assignmentId,writeKey,decision.decisionDigest,canonical(decision));
      return {dispatchKey:key,duplicate:false,state:'reserved',revision:0};
    });
  }
  acknowledgeDelivery(key){const result=this.database.prepare('UPDATE ags_model_dispatches_v2 SET delivery_ack=1 WHERE dispatch_key=?').run(key);assert(result.changes===1,'DISPATCH_UNKNOWN');return {delivered:true,accepted:false,completed:false};}
  dispatch(key){return this.database.prepare('SELECT * FROM ags_model_dispatches_v2 WHERE dispatch_key=?').get(key)??null;}
  transition(key,expectedRevision,state,reference=null,now=null){
    const allowed={reserved:['accepted','unknown','not-started'],accepted:['running','unknown','not-started'],running:['succeeded','failed','cancelled','unknown'],unknown:['succeeded','failed','cancelled','not-started'],succeeded:[],failed:[],cancelled:[],'not-started':[]};
    return transaction(this.database,()=>{
      const row=this.dispatch(key);assert(row&&row.revision===expectedRevision,'DISPATCH_REVISION_CONFLICT');
      assert(allowed[row.state]?.includes(state),'DISPATCH_INVALID_TRANSITION');
      if(['succeeded','failed','cancelled','not-started'].includes(state))assert(typeof reference==='string'&&reference.length>0,'TERMINAL_EVIDENCE_REQUIRED');
      if(state==='running')instant(now,'dispatchedAt');
      const result=this.database.prepare('UPDATE ags_model_dispatches_v2 SET state=?,revision=revision+1,observation_reference=?,dispatched_at=COALESCE(dispatched_at,?) WHERE dispatch_key=? AND revision=?').run(state,reference,state==='running'?now:null,key,expectedRevision);
      assert(result.changes===1,'DISPATCH_REVISION_CONFLICT');return {dispatchKey:key,state,revision:expectedRevision+1};
    });
  }
  /**
   * Internal one-use start primitive, not a bearer permit or human authorization.
   * The native adapter's synchronous callback must re-read local governance under this
   * database's writer lock, after ALL network awaits, and return its current ISO instant.
   * A failed callback/CAS rolls back; a committed claim is never automatically retried.
   */
  claimExecutionStart(key,expectedRevision,decisionDigest,revalidate){
    assert(Number.isSafeInteger(expectedRevision)&&expectedRevision>=1&&expectedRevision<Number.MAX_SAFE_INTEGER,'DISPATCH_REVISION_CONFLICT');
    assert(typeof revalidate==='function','START_REVALIDATION_REQUIRED');
    return transaction(this.database,()=>{
      const row=this.dispatch(key);
      assert(row&&row.revision===expectedRevision,'DISPATCH_REVISION_CONFLICT');
      assert(row.state==='accepted'&&row.dispatched_at===null,'DISPATCH_START_UNAVAILABLE');
      assert(row.decision_digest===decisionDigest,'DISPATCH_DECISION_CONFLICT');
      const now=revalidate();
      assert(typeof now==='string','START_REVALIDATION_MUST_BE_SYNCHRONOUS');
      instant(now,'dispatchedAt');
      // The callback is read-only. Reject same-connection changes as well as a stale caller.
      assert(canonical({...this.dispatch(key)})===canonical({...row}),'DISPATCH_START_CONFLICT');
      const result=this.database.prepare(`UPDATE ags_model_dispatches_v2
        SET state='running',revision=revision+1,dispatched_at=?
        WHERE dispatch_key=? AND revision=? AND state='accepted' AND dispatched_at IS NULL AND decision_digest=?`)
        .run(now,key,expectedRevision,decisionDigest);
      assert(result.changes===1,'DISPATCH_START_CONFLICT');
      return {dispatchKey:key,state:'running',revision:expectedRevision+1,dispatchedAt:now,startClaimAcquired:true};
    });
  }
  saveEvaluation(record){validateEvaluation(record);this.database.prepare('INSERT OR IGNORE INTO ags_model_evaluations_v1 VALUES (?,?)').run(record.recordDigest,canonical(record));return record.recordDigest;}
  evaluations(){return this.database.prepare('SELECT payload FROM ags_model_evaluations_v1 ORDER BY record_digest').all().map(r=>JSON.parse(r.payload));}
}
