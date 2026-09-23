/** Local, explicit governance fixtures. These are not vendor-account executions. */
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ContractValidator } from '../../mcp-server/src/schema-validator.js';
import { FileSkillRegistry } from '../../mcp-server/src/registry.js';
import { WorkflowService } from '../../mcp-server/src/workflow-service.js';
import { SqliteWorkflowStore } from '../../mcp-server/src/sqlite-workflow-store.js';
import { ModelRoutingStore } from '../../skills/coordinate-subagents/scripts/model-routing-store.mjs';
import { ModelRoutingWorkflowBridge } from '../../mcp-server/src/model-routing-workflow.js';
import { ModelPeerPacketSigner } from '../../mcp-server/src/model-peer-packet.js';
import { ModelRoutingPeerSession } from '../../mcp-server/src/model-routing-peer-session.js';
import { nativeRoutingActor } from '../../mcp-server/src/model-routing-host-hook.js';
import { loadCatalog } from '../../skills/coordinate-subagents/scripts/model-catalog.mjs';
import { request, environment, capability } from '../coordinate-subagents/model-routing-v2/fixtures.mjs';
import { digest, resolveV2, seal } from '../../skills/coordinate-subagents/scripts/model-routing-core.mjs';

export const SENDER={host:'codex',sessionId:'peer-source',instanceId:'source-instance'};
export const RECEIVER={host:'codex',sessionId:'peer-target',instanceId:'target-instance'};
export const TOKEN=Buffer.alloc(32,21).toString('base64url');
const PEER_CATALOG=loadCatalog();
export const PEER_NOW=PEER_CATALOG.snapshotDate;
export function must(result){if(!result.ok)throw new Error(JSON.stringify(result.error));return result.data;}
export function createPeerWorkflow(directory,{now=Date.now(),target=RECEIVER,highRisk=false,authorization}={}){
  mkdirSync(join(directory,'skills'),{recursive:true});mkdirSync(join(directory,'contracts'),{recursive:true});
  for(const name of ['freeform-output.v1.schema.json','provider-result.v1.schema.json'])copyFileSync(new URL(`../../contracts/${name}`,import.meta.url),join(directory,'contracts',name));
  const descriptor={schemaVersion:'2.0.0',skillId:'fixture-peer-edit',version:'1.0.0',path:'./fixture-peer-edit',priority:10,enabled:true,
    providers:[{capabilities:['fixture-peer-edit'],executionClass:'workflow',phase:'execution',phaseOrder:50,requiredInputArtifacts:[],inputBindings:[],producedArtifacts:[],
      outputSchema:'contracts/freeform-output.v1.schema.json',resultSchema:'contracts/provider-result.v1.schema.json',stateMapping:{default:{state:'passed',errorRequired:false},adapterErrors:['INVALID_INPUT']},
      selectionCriteria:['fixture'],preconditions:[],failureHandling:'Return evidence.',gate:{kind:'none',policy:'none',validator:null}}]};
  const registry=join(directory,'skills','registry.json');writeFileSync(registry,JSON.stringify({schemaVersion:'2.0.0',skills:[descriptor]}));
  const actorId=nativeRoutingActor(target.host,target.sessionId,null),path=join(directory,'workflows.sqlite3');
  const workflow=new SqliteWorkflowStore(path),database=new DatabaseSync(path),routing=new ModelRoutingStore(database),validator=new ContractValidator();
  const service=new WorkflowService(new FileSkillRegistry(registry,validator),validator,workflow);
  const task={schemaVersion:'1.0.0',taskId:'peer-task',objective:'Verify the approved peer handoff.',scope:{included:['candidate.txt'],excluded:['deployment']},
    acceptanceCriteria:['Handoff is not execution.'],riskLevel:highRisk?'high':'low',workUnits:[{id:'edit',objective:'Handle candidate.',dependencies:[],writeTargets:['candidate.txt']}],
    requiredCapabilities:['fixture-peer-edit'],constraints:['Preserve lease and candidate.'],authorization:authorization??{allowedActions:['read','write'],prohibitedActions:['deploy'],approvalRequired:[]},
    decision:{complexity:'simple',hasConflicts:false},orchestration:{requested:true,mcpAvailable:true}};
  const frame={schemaVersion:'1.0.0',workspace:{workspaceId:directory,locator:directory},controlArtifacts:[{artifactId:'validator',role:'validator',locator:'fixture',digest:digest('validator')}],
    targetArtifacts:[{artifactId:'candidate',role:'candidate',locator:'candidate.txt',digest:digest('candidate')}],operationalSettings:{maxAttemptsPerEpoch:3,maxEpochs:2,leaseTtlSeconds:300}};
  const root=must(service.openConvergenceRoot({schemaVersion:'1.0.0',parentRootId:null,taskEnvelope:task,frame,userApprovalRefs:[]}));
  const plan=must(service.planWorkflow(task));
  const lease=must(service.claimWorkflowAttempt({schemaVersion:'1.0.0',rootId:root.rootId,expectedRevision:root.revision,taskEnvelope:task,frame,plan,actorId,outputTargets:['candidate.txt'],priorFailure:null}));
  const run=must(service.startGuardedWorkflow({schemaVersion:'1.0.0',leaseId:lease.leaseId,expectedRootRevision:lease.rootRevision,plan}));
  let cap=capability({host:target.host==='codex'?'openai-codex':'anthropic-claude-code',actorId,sessionId:target.sessionId,instanceId:target.instanceId,
    observedAt:new Date(now).toISOString(),expiresAt:new Date(now+60000).toISOString()},
    {invocationSurface:'peer-session',...(target.host==='claude-code'?{model:'claude-opus-5',resolvedModel:'claude-opus-5',modelOrigin:'anthropic',servingProvider:'anthropic'}:{})});
  cap=seal({...cap,supportedBindings:cap.supportedBindings.map(item=>({...item,invocationSurface:'peer-session'}))},'snapshotDigest');
  const req=request();req.binding={...req.binding,taskId:task.taskId,runId:run.runId,stageId:run.plan.currentStageId,revision:run.revision,attemptId:lease.leaseId};
  req.requirements.filesystem='write';req.requirements.allowedSurfaces=['peer-session'];
  const env=environment({catalog:structuredClone(PEER_CATALOG),capabilities:[cap],now:new Date(now).toISOString()}),decision=resolveV2(req,env);
  if(decision.status!=='selected')throw new Error(JSON.stringify(decision));routing.saveDecision(req,env,decision,new Date(now).toISOString());
  const bridge=new ModelRoutingWorkflowBridge(workflow,routing);
  function peer(identity,{actor=identity.sessionId===target.sessionId?actorId:nativeRoutingActor(identity.host,identity.sessionId,null),request:transport,clock=Date.now,stateDirectory=directory,timeoutMs=10000}={}){
    return new ModelRoutingPeerSession({store:routing,workflowBridge:bridge,identity,actorId:actor,signer:new ModelPeerPacketSigner(TOKEN),stateDirectory,clock,timeoutMs,...(transport?{request:transport}:{})});
  }
  return {directory,path,database,workflow,routing,bridge,service,task,root,lease,run,cap,req,env,decision,actorId,peer,close:()=>{database.close();workflow.close();}};
}
