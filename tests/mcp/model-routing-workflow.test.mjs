import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContractValidator } from '../../mcp-server/src/schema-validator.js';
import { FileSkillRegistry } from '../../mcp-server/src/registry.js';
import { SqliteWorkflowStore } from '../../mcp-server/src/sqlite-workflow-store.js';
import { openModelRoutingService } from '../../mcp-server/src/model-routing-service.js';
import { RoutingAwareWorkflowService } from '../../mcp-server/src/routing-aware-workflow-service.js';
import { MODEL_APPLICATION_SCHEMA, hasModelRoutingArtifacts } from '../../mcp-server/src/model-routing-workflow.js';
import { MODEL_DECISION_V3_SCHEMA } from '../../mcp-server/src/routing-v3/workflow-binding.js';
import { ModelRoutingStore, RoutingObservationSigner } from '../../skills/coordinate-subagents/scripts/model-routing-store.mjs';
import { ModelRoutingServiceCore } from '../../skills/coordinate-subagents/scripts/model-routing-service-core.mjs';
import { digest, seal, resolveV2 } from '../../skills/coordinate-subagents/scripts/model-routing-core.mjs';
import { request, environment, capability, presence, application, observation, NOW, LATER, END } from '../coordinate-subagents/model-routing-v2/fixtures.mjs';
import { contracts } from '../coordinate-subagents/semantic-decision/fixtures/contracts.mjs';

const disposers = [];
afterEach(() => { vi.restoreAllMocks(); while(disposers.length) disposers.pop()(); });
function data(result) { expect(result.error).toBeNull(); expect(result.ok).toBe(true); return result.data; }

function harness() {
  const directory = mkdtempSync(join(tmpdir(), 'ags-routing-workflow-'));
  disposers.push(() => rmSync(directory, {recursive:true,force:true}));
  mkdirSync(join(directory,'skills')); mkdirSync(join(directory,'contracts'));
  for (const name of ['freeform-output.v1.schema.json','provider-result.v1.schema.json']) {
    copyFileSync(new URL(`../../contracts/${name}`,import.meta.url), join(directory,'contracts',name));
  }
  const descriptor = { schemaVersion:'2.0.0',skillId:'fixture-editor',version:'1.0.0',path:'./fixture-editor',priority:10,enabled:true,
    providers:[{capabilities:['fixture-editing'],executionClass:'workflow',phase:'execution',phaseOrder:50,
      requiredInputArtifacts:[],inputBindings:[],producedArtifacts:[],outputSchema:'contracts/freeform-output.v1.schema.json',
      resultSchema:'contracts/provider-result.v1.schema.json',stateMapping:{default:{state:'passed',errorRequired:false},adapterErrors:['INVALID_INPUT']},
      selectionCriteria:['fixture'],preconditions:[],failureHandling:'Return evidence.',gate:{kind:'none',policy:'none',validator:null}}] };
  const registryPath=join(directory,'skills','registry.json');
  writeFileSync(registryPath,JSON.stringify({schemaVersion:'2.0.0',skills:[descriptor]}));
  const path=join(directory,'workflow.sqlite3');
  const workflow=new SqliteWorkflowStore(path); disposers.push(()=>workflow.close());
  const opened=openModelRoutingService(path,workflow); disposers.push(()=>opened.close());
  const db=new DatabaseSync(path); disposers.push(()=>db.close());
  const routing=new ModelRoutingStore(db);
  const validator=new ContractValidator();
  const service=new RoutingAwareWorkflowService(opened.bridge,new FileSkillRegistry(registryPath,validator),validator,workflow);
  const task={schemaVersion:'1.0.0',taskId:'task-1',objective:'Verify routing evidence.',scope:{included:['candidate.txt'],excluded:['deploy']},
    acceptanceCriteria:['Evidence remains bound.'],riskLevel:'low',workUnits:[{id:'edit',objective:'Edit candidate.',dependencies:[],writeTargets:['candidate.txt']}],
    requiredCapabilities:['fixture-editing'],constraints:['Keep candidate binding.'],authorization:{allowedActions:['read','write'],prohibitedActions:['deploy'],approvalRequired:[]},
    decision:{complexity:'simple',hasConflicts:false},orchestration:{requested:true,mcpAvailable:true}};
  const frame={schemaVersion:'1.0.0',workspace:{workspaceId:directory,locator:directory},
    controlArtifacts:[{artifactId:'validator',role:'validator',locator:'test',digest:digest('validator')}],
    targetArtifacts:[{artifactId:'candidate',role:'candidate',locator:'candidate.txt',digest:digest('candidate')}],
    operationalSettings:{maxAttemptsPerEpoch:3,maxEpochs:2,leaseTtlSeconds:300}};
  const root=data(service.openConvergenceRoot({schemaVersion:'1.0.0',parentRootId:null,taskEnvelope:task,frame,userApprovalRefs:[]}));
  const plan=data(service.planWorkflow(task));
  const lease=data(service.claimWorkflowAttempt({schemaVersion:'1.0.0',rootId:root.rootId,expectedRevision:root.revision,taskEnvelope:task,frame,plan,
    actorId:'implementer',outputTargets:['candidate.txt'],priorFailure:null}));
  const run=data(service.startGuardedWorkflow({schemaVersion:'1.0.0',leaseId:lease.leaseId,expectedRootRevision:lease.rootRevision,plan}));
  const req=request(); req.binding={...req.binding,taskId:task.taskId,runId:run.runId,stageId:run.plan.currentStageId,revision:run.revision,attemptId:lease.leaseId};
  const env=environment();
  const decision=resolveV2(req,env); routing.saveDecision(req,env,decision,NOW);
  const core=new ModelRoutingServiceCore({store:routing,clock:()=>LATER,historyProvider:opened.bridge.history});
  const record=core.record({application:application(req,decision)}).record;
  const result={schemaVersion:'1.0.0',runId:run.runId,stageId:run.plan.currentStageId,expectedRevision:run.revision,state:'passed',
    output:{schemaVersion:'1.0.0',kind:'output',output:{},artifacts:[{artifactId:'routing-evidence',schemaId:MODEL_APPLICATION_SCHEMA,
      locator:`ags-model-record:${record.recordDigest.slice(7)}`,digest:record.recordDigest,targetDigest:record.binding.candidateDigest,verified:true}],error:null},
    evidence:[{artifactId:'routing-evidence',kind:'tool',locator:`ags-model-record:${record.recordDigest.slice(7)}`,verified:true,note:'Diagnostic reference, not execution authority.'}],
    findings:[],blockers:[],error:null};
  return {path,workflow,routing,opened,service,core,req,env,decision,record,result,root,run,lease};
}
function attach(h,record) {
  const result=structuredClone(h.result),artifact=result.output.artifacts[0];
  artifact.locator=`ags-model-record:${record.recordDigest.slice(7)}`;artifact.digest=record.recordDigest;artifact.targetDigest=record.binding.candidateDigest;
  result.evidence[0].locator=artifact.locator;return result;
}
function admitted(h, overrides={}) {
  const req=request({...h.req,...overrides}),decision=resolveV2(req,h.env);
  h.routing.saveDecision(req,h.env,decision,NOW);
  const reserved=h.routing.reserveDispatch(decision);h.routing.transition(reserved.dispatchKey,0,'accepted');h.routing.transition(reserved.dispatchKey,1,'running',null,NOW);
  const signer=new RoutingObservationSigner(Buffer.alloc(32,4));
  const token=h.routing.publishObservation(signer.issue('observation',observation(req,decision),{issuedAt:NOW,expiresAt:END}),signer,LATER);
  return h.core.record({application:application(req,decision),observationToken:token}).record;
}
function withTaskRisk(h,riskLevel) {
  const original=h.workflow.getGuardedRunBinding.bind(h.workflow);
  vi.spyOn(h.workflow,'getGuardedRunBinding').mockImplementation(runId=>{
    const guarded=structuredClone(original(runId));
    guarded.proposal.taskEnvelope.riskLevel=riskLevel;
    return guarded;
  });
}

describe('workflow-owned model routing bridge',()=>{
  it.each(['high','critical'])('rejects a %s task handoff and artifact with highRisk false',riskLevel=>{
    const h=harness();withTaskRisk(h,riskLevel);
    expect(()=>h.opened.bridge.validatePeerHandoff(h.req)).toThrow(/downgrade/u);
    expect(h.service.recordStageResult(h.result).error.message).toMatch(/downgrade/u);
    expect(h.workflow.getRun(h.run.runId).stageResults).toHaveLength(0);
  });
  it.each(['high','critical'])('admits a %s task with highRisk true when its artifact has host evidence',riskLevel=>{
    const h=harness(),req={...h.req,highRisk:true};withTaskRisk(h,riskLevel);
    expect(()=>h.opened.bridge.validatePeerHandoff(req)).not.toThrow();
    const record=admitted(h,{highRisk:true});
    expect(()=>h.opened.bridge.validateStageArtifacts(attach(h,record))).not.toThrow();
    data(h.service.recordStageResult(attach(h,record)));
    expect(h.workflow.getRun(h.run.runId).stageResults).toHaveLength(1);
  });
  it('keeps a low task handoff and diagnostic artifact available with highRisk false',()=>{
    const h=harness();
    expect(()=>h.opened.bridge.validatePeerHandoff(h.req)).not.toThrow();
    expect(()=>h.opened.bridge.validateStageArtifacts(h.result)).not.toThrow();
  });
  it('connects the production history provider and excludes known implementers',()=>{
    const h=harness(),history=h.opened.bridge.history(h.req.binding);
    expect(history.actors).toContain('implementer');
    const signer=new RoutingObservationSigner(Buffer.alloc(32,7));
    const cap=capability({actorId:'implementer',observedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60000).toISOString()});
    const now=new Date().toISOString(),end=new Date(Date.now()+60000).toISOString();
    h.routing.publishCapability(signer.issue('capability',cap,{issuedAt:now,expiresAt:end}),signer,presence({leaseUntil:end}),now);
    const selected=h.opened.service.call('resolve_model_assignment',{...h.req,role:'independent-audit',highRisk:true});
    expect(selected.ok).toBe(true);expect(selected.data.status).toBe('blocked');
    expect(selected.data.rejectedCandidates.flatMap(x=>x.reasonCodes)).toContain('INDEPENDENCE_CONFLICT');
  });
  it('includes reserved and ambiguous dispatch actors and their exact sessions',()=>{
    const h=harness();const reserved=h.routing.reserveDispatch(h.decision);h.routing.transition(reserved.dispatchKey,0,'unknown');
    expect(h.opened.bridge.history(h.req.binding)).toMatchObject({actors:['actor-1','implementer'],sessions:['openai-codex/session-1']});
  });
  it('does not treat a proposal-only routing decision as execution',()=>{
    const h=harness();expect(h.opened.bridge.history(h.req.binding).actors).not.toContain('actor-1');
  });
  it('ignores an unrelated run when finding audit participants',()=>{
    const h=harness(),other=seal({...h.decision,binding:{...h.decision.binding,runId:'unrelated'},target:{...h.decision.target,actorId:'unrelated'}},'decisionDigest');
    h.routing.reserveDispatch(other);expect(h.opened.bridge.history(h.req.binding).actors).not.toContain('unrelated');
  });
  it('revisits current history instead of caching an earlier result',()=>{
    const h=harness();expect(h.opened.bridge.history(h.req.binding).actors).not.toContain('actor-1');
    h.routing.reserveDispatch(h.decision);expect(h.opened.bridge.history(h.req.binding).actors).toContain('actor-1');
  });
  it.each(['taskId','runId','stageId','attemptId','candidateDigest'])('rejects a mismatched %s binding',key=>{
    const h=harness(),binding={...h.req.binding,[key]:key.endsWith('Digest')?digest('wrong'):'wrong'};
    expect(()=>h.opened.bridge.history(binding)).toThrow();
  });
  it('rejects stale revisions',()=>{const h=harness();expect(()=>h.opened.bridge.history({...h.req.binding,revision:99})).toThrow(/revision/u);});
  it('rejects a missing, cyclic or omitted lineage rather than returning empty history',()=>{
    const h=harness(),original=h.workflow.getConvergenceSnapshot.bind(h.workflow);
    vi.spyOn(h.workflow,'getConvergenceSnapshot').mockReturnValue(null);
    expect(()=>h.opened.bridge.history(h.req.binding)).toThrow();
    vi.spyOn(h.workflow,'getConvergenceSnapshot').mockImplementation(id=>{const s=original(id);s.root.parentRootId=id;return s;});
    expect(()=>h.opened.bridge.history(h.req.binding)).toThrow(/cyclic/u);
    vi.spyOn(h.workflow,'getConvergenceSnapshot').mockImplementation(id=>{const s=original(id);s.workflowRunIds=[];return s;});
    expect(()=>h.opened.bridge.history(h.req.binding)).toThrow(/omits/u);
  });
  it('walks parent roots instead of resetting independence at a replacement root',()=>{
    const h=harness(),original=h.workflow.getConvergenceSnapshot.bind(h.workflow),snapshot=original(h.root.rootId);
    const parent={...structuredClone(snapshot),root:{...snapshot.root,rootId:'parent-root',parentRootId:null},workflowRunIds:[],leases:[],proposals:[{...snapshot.proposals[0],actorId:'previous-implementer'}]};
    vi.spyOn(h.workflow,'getConvergenceSnapshot').mockImplementation(id=>id==='parent-root'?parent:{...original(id),root:{...original(id).root,parentRootId:'parent-root'}});
    expect(h.opened.bridge.history(h.req.binding).actors).toContain('previous-implementer');
  });
  it('accepts a stored diagnostic record without claiming its model was observed',()=>{
    const h=harness();expect(h.record.observationAdmitted).toBe(false);
    expect(()=>h.opened.bridge.validateStageArtifacts(h.result)).not.toThrow();
    data(h.service.recordStageResult(h.result));
    expect(h.workflow.getRun(h.run.runId).stageResults).toHaveLength(1);
  });
  it('keeps existing strict execution gates after a valid diagnostic reference',()=>{
    const h=harness(),result=h.service.recordStageResult(h.result,true);
    expect(result.ok).toBe(false);expect(result.error.code).toBe('BINDING_REQUIRED');
    expect(h.workflow.getRun(h.run.runId).stageResults).toHaveLength(0);
  });
  it('does not let a v3 diagnostic reference satisfy passed evidence or required artifact gates',()=>{
    const h=harness(),semantic={...contracts().decision.semantic,baselineDecisionDigest:h.decision.decisionDigest};
    const decision=seal({...h.decision,schemaVersion:'3.0.0',semantic},'decisionDigest');
    h.routing.database.prepare('INSERT INTO ags_model_decisions_v2 VALUES (?,?,?,?,?,?)').run(
      decision.decisionDigest,digest(decision.binding),JSON.stringify(h.req),JSON.stringify(h.env),JSON.stringify(decision),NOW);
    h.routing.database.prepare('INSERT INTO ags_model_decision_refs_v3 VALUES (?,?,?,?,?)').run(
      decision.decisionDigest,h.decision.decisionDigest,'t06-workflow-evaluation','t06-workflow-registration',semantic.adviceDigest);
    const result=structuredClone(h.result),artifact=result.output.artifacts[0];
    artifact.schemaId=MODEL_DECISION_V3_SCHEMA;
    artifact.locator=`ags-model-decision:${decision.decisionDigest.slice(7)}`;
    artifact.digest=decision.decisionDigest;
    artifact.verified=false;
    result.evidence[0].locator=artifact.locator;
    result.evidence[0].verified=false;
    expect(h.service.recordStageResult(result).error.code).toBe('MISSING_EVIDENCE');
    expect(h.workflow.getRun(h.run.runId).stageResults).toHaveLength(0);
    artifact.verified=true;result.evidence[0].verified=true;
    expect(h.service.recordStageResult(result).error.code).toBe('BINDING_INVALID');
    expect(h.workflow.getRun(h.run.runId).stageResults).toHaveLength(0);
  });
  it('retains v3 dispatch participants in independent-audit history',()=>{
    const h=harness(),semantic={...contracts().decision.semantic,baselineDecisionDigest:h.decision.decisionDigest};
    const decision=seal({...h.decision,schemaVersion:'3.0.0',semantic,
      binding:{...h.decision.binding,assignmentId:'v3-audit-history'}},'decisionDigest');
    h.routing.reserveDispatch(decision);
    expect(h.opened.bridge.history(h.req.binding).actors).toContain(decision.target.actorId);
  });
  it('does not inspect or reject ordinary legacy stage outputs',()=>{
    const h=harness(),result={...h.result,output:{...h.result.output,artifacts:[]},evidence:[{artifactId:'legacy-test',kind:'test',locator:'fixture:legacy',verified:true,note:'Existing legacy evidence.'}]};
    expect(hasModelRoutingArtifacts(result)).toBe(false);data(h.service.recordStageResult(result));
  });
  it.each(['runId','stageId','expectedRevision'])('rejects replay under another stage %s without writing a receipt',key=>{
    const h=harness(),result={...h.result,[key]:key==='expectedRevision'?99:'other'};
    expect(h.service.recordStageResult(result).ok).toBe(false);
    expect(h.workflow.getRun(h.run.runId).stageResults).toHaveLength(0);
  });
  it.each(['digest','targetDigest','schemaId','locator'])('rejects a forged artifact %s',key=>{
    const h=harness(),result=structuredClone(h.result);result.output.artifacts[0][key]=key.endsWith('Digest')||key==='digest'?digest('wrong'):'wrong';
    expect(h.service.recordStageResult(result).ok).toBe(false);
  });
  it('rejects evidence-only and duplicate-ID reference bypasses',()=>{
    const h=harness(),result=structuredClone(h.result);result.output.artifacts=[];
    expect(h.service.recordStageResult(result).ok).toBe(false);
    h.result.output.artifacts.push(h.result.output.artifacts[0]);expect(h.service.recordStageResult(h.result).ok).toBe(false);
  });
  it('rejects an absent or corrupted stored application',()=>{
    const h=harness();h.routing.database.prepare('UPDATE ags_model_applications_v2 SET payload=?').run(JSON.stringify({...h.record,target:{...h.record.target,actorId:'forged'}}));
    expect(h.service.recordStageResult(h.result).ok).toBe(false);
    h.routing.database.prepare('DELETE FROM ags_model_applications_v2').run();expect(h.service.recordStageResult(h.result).ok).toBe(false);
  });
  it('requires host-admitted fields for a passing high-risk artifact',()=>{
    const h=harness(),req={...h.req,highRisk:true},decision=resolveV2(req,h.env);
    h.routing.saveDecision(req,h.env,decision,NOW);
    const record=h.core.record({application:application(req,decision)}).record;
    expect(h.service.recordStageResult(attach(h,record)).ok).toBe(false);
  });
  it('validates all three admitted high-risk fields but does not replace the existing gate',()=>{
    const h=harness(),record=admitted(h,{highRisk:true});
    expect(()=>h.opened.bridge.validateStageArtifacts(attach(h,record))).not.toThrow();
    expect(h.service.recordStageResult(attach(h,record),true).ok).toBe(false);
  });
  it('rechecks independent auditor participation at adoption, excluding only its own dispatch',()=>{
    const h=harness(),record=admitted(h,{highRisk:true,role:'independent-audit'});
    expect(()=>h.opened.bridge.validateStageArtifacts(attach(h,record))).not.toThrow();
    const other=seal({...h.decision,binding:{...h.decision.binding,assignmentId:'another-assignment'}},'decisionDigest');
    h.routing.reserveDispatch(other);
    expect(()=>h.opened.bridge.validateStageArtifacts(attach(h,record))).toThrow(/participated/u);
  });
  it('reopens the actual workflow database with routing tables without rewriting legacy data',()=>{
    const h=harness(),before=h.workflow.getRun(h.run.runId),other=new SqliteWorkflowStore(h.path);
    try{expect(other.getRun(h.run.runId)).toEqual(before);}finally{other.close();}
    expect(h.workflow.getRun(h.run.runId)).toEqual(before);
  });
  it('preserves unverified failure diagnostics instead of imposing a success floor on them',()=>{
    const h=harness(),result={...h.result,state:'failed'};
    expect(()=>h.opened.bridge.validateStageArtifacts(result)).not.toThrow();
  });
});
