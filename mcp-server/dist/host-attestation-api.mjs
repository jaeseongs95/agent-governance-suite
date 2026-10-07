/* eslint-disable */
import{createHash as oe,createHmac as we,randomBytes as Ae,timingSafeEqual as it}from"node:crypto";var j=["lightweight","general","deep","frontier"],K=["low","medium","high","xhigh","max","ultra"];var l=class extends Error{constructor(t,r,o=null){super(r);this.code=t;this.details=o;this.name="WorkflowContractError"}code;details;toBody(){return{code:this.code,message:this.message,details:this.details}}};import{createHash as he}from"node:crypto";import{existsSync as w,statSync as Q}from"node:fs";import F from"node:path";import E from"node:fs";import g from"node:path";var U=256,C=4096,fe=/^[A-Za-z][A-Za-z0-9+.-]+:\/\//u,Ee=/[*?[\]{}]/u,Re=process.platform==="win32"?/[\\/]/u:/\//u;function M(n){if(fe.test(n))return!0;for(let e=0;e<n.length;e+=1){let t=n.charCodeAt(e);if(t<=31||t===127)return!0}return!1}function me(n){if(M(n))throw new l("INVALID_INPUT","Scope entries must be file system paths without control characters.",{reason:"UNSUPPORTED_SCOPE_ENTRY",entry:n})}function I(n,e){return e===""||n===e||n.startsWith(`${e}/`)}function h(n,e){return new l("INVALID_INPUT",`Workspace identity cannot be resolved for ${n}: ${e}.`,{reason:"WORKSPACE_IDENTITY_UNRESOLVED",path:n,cause:e})}function _(n){return(process.platform==="win32"?n.replaceAll("\\","/").toLowerCase():n).replace(/\/+$/u,"")}function L(n){let e=g.resolve(n),t=[];for(let r=0;r<U;r+=1)try{let o=E.realpathSync.native(e);return{real:g.join(o,...t),existing:o}}catch(o){let s=o.code,i=g.dirname(e);if(s!=="ENOENT"&&s!=="ENOTDIR"||i===e)throw h(n,s??"unreadable");t.unshift(g.basename(e)),e=i}throw h(n,"walk limit reached")}function y(n){return E.statSync(n,{throwIfNoEntry:!1})?.isDirectory()===!0}function D(n){let e=E.openSync(n,"r");try{let t=Buffer.alloc(C+1),r=E.readSync(e,t,0,C+1,0);if(r>C)throw h(n,"pointer file too large");return t.toString("utf8",0,r)}finally{E.closeSync(e)}}function q(n){let e=n.existing;try{let t=y(n.existing)?n.existing:g.dirname(n.existing);for(let r=0;r<U;r+=1){e=g.join(t,".git");let o=E.statSync(e,{throwIfNoEntry:!1});if(o){let i=e;if(!o.isDirectory()){let c=/^gitdir: ([^\r\n]+)/u.exec(D(e))?.[1];if(!c)throw h(e,"missing gitdir line");if(i=g.resolve(t,c),!y(i))throw h(i,"gitdir is not a directory")}let a=i;if(e=g.join(i,"commondir"),E.statSync(e,{throwIfNoEntry:!1})){let c=D(e).trim();if(!c)throw h(e,"empty commondir");if(a=g.resolve(i,c),!y(a))throw h(a,"commondir is not a directory")}return{commonDir:_(E.realpathSync.native(a)),checkoutRoot:_(t),relative:_(g.relative(t,n.real))}}let s=g.dirname(t);if(s===t)return null;t=s}throw h(n.existing,"walk limit reached")}catch(t){throw t instanceof l?t:h(e,t.code??"unreadable")}}function J(n){let e=new Set,t=!1;try{if(!y(n))return{roots:[],complete:!1};g.basename(n)===".git"&&e.add(_(L(g.dirname(n)).real));let r=g.join(n,"worktrees");if(E.statSync(r,{throwIfNoEntry:!1})){let o=E.opendirSync(r);try{for(let s=0;;s+=1){let i=o.readSync()?.name;if(i===void 0||s>=U)break;try{let a=D(g.join(r,i,"gitdir")).trim();if(!a||M(a)||_(g.basename(a))!==".git")continue;e.add(_(L(g.dirname(g.resolve(r,i,a))).real))}catch{}}}finally{o.closeSync()}}}catch{}return{roots:[...e],complete:t}}function Y(n,e){let t=[n],r=new Set,o=0;try{for(;t.length>0;){if(++o>C)return"unknown";let s=E.realpathSync.native(t.pop()),i=_(s);if(r.has(i))continue;if(r.add(i),E.statSync(g.join(s,".git"),{throwIfNoEntry:!1})&&q({real:s,existing:s})?.commonDir===e)return"overlap";let a=E.opendirSync(s);try{for(let c=a.readSync();c;c=a.readSync()){if(++o>C)return"unknown";if(c.name===".git")continue;let p=g.join(s,c.name);if(c.isDirectory())t.push(p);else if(c.isSymbolicLink()){if(y(p))t.push(p);else if(P(p).git?.commonDir===e)return"overlap"}}}finally{a.closeSync()}}return"none"}catch{return"unknown"}}function P(n){let e=L(n);return{physical:_(e.real),git:q(e)}}function $(n,e,t={}){if(!t.legacy)for(let s of e)me(s);let r=P(n),o=e.map(s=>{if(M(s))return{entry:s,...r,conservative:"legacy-unsupported"};let i=s.split(Re),a=i.findIndex(p=>Ee.test(p));if(a===0)return r.git?{entry:s,physical:r.git.checkoutRoot,git:{...r.git,relative:""},conservative:"leading-glob"}:{entry:s,...r,conservative:"leading-glob"};let c=a<0?s:`${i.slice(0,a).join("/")}/`;return{entry:s,...P(g.resolve(n,c)),conservative:a<0?null:"glob-prefix"}});return{version:1,workspacePhysical:r.physical,surfaces:o}}function W(n,e="Convergence input"){if(n===null||typeof n=="boolean"||typeof n=="string")return JSON.stringify(n);if(typeof n=="number"){if(!Number.isFinite(n))throw new l("INVALID_INPUT",`${e} contains a non-finite number.`);return JSON.stringify(n)}if(Array.isArray(n))return`[${n.map(t=>W(t,e)).join(",")}]`;if(n&&typeof n=="object"){let t=n;return`{${Object.keys(t).sort().map(r=>`${JSON.stringify(r)}:${W(t[r],e)}`).join(",")}}`}throw new l("INVALID_INPUT",`${e} contains a non-serializable value.`)}function V(n){return`sha256:${he("sha256").update(W(n),"utf8").digest("hex")}`}function B(n){return[...n.taskEnvelope.scope.included,...n.taskEnvelope.workUnits.flatMap(e=>e.writeTargets),...n.frame.targetArtifacts.map(e=>e.locator)]}function Z(n,e=!1){return $(n.frame.workspace.locator,B(n),{legacy:e})}function ee(n){return V({locator:n.frame.workspace.locator,entries:B(n)})}function z(n,e){let t=F.resolve(e,n).replaceAll("\\","/").replace(/\/+$/u,"");return process.platform==="win32"?t.toLowerCase():t}function _e(n){return n.surfaces.map(e=>!w(e.physical||"/"))}function Te(n,e){return e.git===null?!1:n.git===null?!0:e.git.checkoutRoot!==n.git.checkoutRoot&&I(e.git.checkoutRoot,n.git.checkoutRoot)}function Ie(n,e){let t=e&&n.git===null&&!n.conservative;return w((t?F.posix.dirname(n.physical):n.physical)||"/")}function H(n,e){let t=ee(n),r=e&&e.surfaceDigest===t?e.identity:null,o=u=>r!==null&&e.inferred[u]===!0,s={root:n,legacy:e===null,observedWorkspace:r!==null,surfaceDigest:t};if(r&&r.surfaces.every((u,R)=>u.git!==null&&!o(R)))return{...s,identity:r,resolved:!0,fresh:!1,inferred:e.inferred};let i=null;try{i=Z(n,!0)}catch(u){if(!(u instanceof l))throw u}let a=n.frame.workspace.locator;if(!r&&!i){let u={version:1,workspacePhysical:z(".",a),surfaces:B(n).map(R=>({entry:R,physical:z(R,a),git:null,conservative:null}))};return{...s,identity:u,resolved:!1,fresh:!1,inferred:[]}}let c=w(a),p=!0,f=(r??i).surfaces.map((u,R)=>{let m=i?.surfaces[R];return o(R)?(m||(p=!1),m&&!Te(m,u)?m:u):r&&u.git!==null?u:m&&c&&Ie(m,r!==null)?m:(p=!1,u)}),T={version:1,workspacePhysical:r?.workspacePhysical??i.workspacePhysical,surfaces:f},S=f.map((u,R)=>o(R)&&!w(u.physical||"/")),d=p&&JSON.stringify({identity:T,inferred:S})!==JSON.stringify({identity:r,inferred:e?.inferred});return{...s,identity:T,resolved:p,fresh:d,inferred:S}}var te=["needs-review","needs-user"];function ne(n,e){return I(n,e)||I(e,n)}function re(n,e){return n.git!==null&&e.git!==null&&n.git.commonDir===e.git.commonDir}function Se(n,e){return e.surfaces.some(t=>I(n.physical,t.physical)||re(n,t)&&I(n.git.relative,t.git.relative))}function ve(n,e,t,r){if(re(n,e)&&ne(n.git.relative,e.git.relative))return"overlap";let o=!1;for(let[s,i]of[[n,e],[e,n]]){if(!i.git||s.conservative===null&&Q(s.physical||"/",{throwIfNoEntry:!1})?.isDirectory()!==!0)continue;let a=i.git.commonDir;t.has(a)||t.set(a,J(a));let c=t.get(a);if(c.roots.some(p=>I(p,s.physical)))return"overlap";if(!c.complete){let p=`${a}\0${s.physical}`;r.has(p)||r.set(p,Y(s.physical||"/",a));let f=r.get(p);if(f==="overlap")return"overlap";o||=f==="unknown"}}return o?"unknown":"none"}function Ce(n){return n.git===null&&n.conservative===null&&Q(n.physical||"/",{throwIfNoEntry:!1})?.isDirectory()!==!0}function ye(n,e,t){let r=new Map,o=new Map;for(let s of t)if(s.root.rootId!==n.root.parentRootId){for(let i of n.identity.surfaces)for(let a of s.identity.surfaces)if(ne(i.physical,a.physical))return{root:s.root,kind:"physical",requested:i,existing:a};if(te.includes(s.root.state)){for(let i of n.identity.surfaces)if(!(e&&Se(i,e)))for(let a of s.identity.surfaces){if(!s.resolved){if(Ce(i))continue;return{root:s.root,kind:"lineage-unresolved",requested:i,existing:a}}let c=ve(i,a,r,o);if(c!=="none")return{root:s.root,kind:c==="overlap"?"lineage":"lineage-unresolved",requested:i,existing:a}}}}return null}function Ne(n,e){if(!e.resolved)return e.legacy?e.root.frame.workspace.workspaceId===n.root.frame.workspace.workspaceId&&A(e.root.frame.workspace.locator)===A(n.root.frame.workspace.locator)?"legacy-locator":null:e.observedWorkspace&&n.identity.workspacePhysical===e.identity.workspacePhysical?"physical":null;if(n.identity.workspacePhysical===e.identity.workspacePhysical)return"physical";let t=new Set(e.identity.surfaces.flatMap(o=>o.git?[o.git.commonDir]:[]));return n.identity.surfaces.length>0&&n.identity.surfaces.every(o=>o.git!==null&&t.has(o.git.commonDir))?"lineage":null}function G(n,e){let t=Z(n),r=null,o=null;if(n.parentRootId){if(r=e.find(s=>s.root.rootId===n.parentRootId)??null,!r||!te.includes(r.root.state))throw new l("INVALID_TRANSITION","Only a gated convergence root may be replaced.",{parentRootId:n.parentRootId,parentState:r?.root.state??null});if(o=Ne({root:n,identity:t},r),!o)throw new l("INVALID_INPUT","A replacement root must remain bound to the same workspace.",{parentRootId:n.parentRootId,...r.resolved?{}:{reason:"WORKSPACE_IDENTITY_UNRESOLVED"}})}return{identity:t,surfaceDigest:ee(n),inferred:_e(t),match:o,conflict:ye({root:n,identity:t},r?.identity??null,e)}}function A(n){let e=F.resolve(n);return process.platform==="win32"?e.toLowerCase():e}var se="_hostAttestation",Ve=new Set(["plan_workflow","record_stage_result"]),Oe="host_attestation_key_v1",be="aghs1",ke=300*1e3;function xe(n){return n&&typeof n=="object"&&!Array.isArray(n)?n:null}function O(n){return typeof n=="string"&&n.length>0?n:null}var v=n=>oe("sha256").update(n,"utf8").digest("hex").slice(0,24);function ie(n,e,t=null){return`${n}:session-${v(e)}${t?`:agent-${v(t)}`:""}`}function Le(n){return typeof n=="string"&&K.includes(n)}function ae(n){let e={...n};return delete e[se],e}function De(n,e){if(n==="plan_workflow"){let t=O(xe(e.taskEnvelope)?.taskId)??O(e.taskId);return t?{phase:"bootstrap",taskId:t,runId:null,stageId:null,revision:null}:null}if(n==="record_stage_result"){let t=O(e.runId),r=O(e.stageId),o=e.expectedRevision;return!t||!r||!Number.isSafeInteger(o)?null:{phase:"stage",taskId:null,runId:t,stageId:r,revision:o}}return null}function Pe(n){let e=Buffer.from(n.getOrCreateSecret(Oe,()=>Ae(32).toString("base64url")),"base64url");if(e.length!==32)throw new l("INVALID_INPUT","Stored host attestation key is invalid.");return e}function Ue(n,e){return we("sha256",n).update(e,"utf8").digest("base64url")}function Me(n,e,t){if(!Ve.has(t.tool))return null;let r=ae(t.input),o=De(t.tool,r),s=e.modelClassForModel(t.model);if(!o||!s||!j.includes(s)||!e.host||!Le(t.reasoningEffort)||!t.actorId||!t.sessionId||!t.toolUseId||t.actorId!==ie(e.host,t.sessionId,t.agentId??null))return null;let i=t.now??new Date,a={host:e.host,session:v(t.sessionId),agent:t.agentId?v(t.agentId):null,turn:t.turnId?v(t.turnId):null,call:v(t.toolUseId)},c={v:1,...a,tool:t.tool,inputDigest:V(r),...o,model:t.model,modelClass:s,reasoningEffort:t.reasoningEffort,actorId:t.actorId,observationId:oe("sha256").update(JSON.stringify(a),"utf8").digest("base64url"),observedAt:i.toISOString(),expiresAt:new Date(i.getTime()+ke).toISOString()},p=`${be}.${Buffer.from(JSON.stringify(c),"utf8").toString("base64url")}`;return`${p}.${Ue(Pe(n),p)}`}function ce(n,e,t,r,o,s){let i=ae(r),a=o(),c=a?Me(n,e,{...a,tool:t,input:i}):null;return s({...i,...c?{[se]:c}:{}})}import{chmodSync as Fe,mkdirSync as Be}from"node:fs";import X from"node:path";import{DatabaseSync as pe}from"node:sqlite";function le(n){let e=/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u.exec(n);if(!e)return null;let t=e.slice(1).map(r=>Number.parseInt(r,10));return t.length===3&&t.every(Number.isSafeInteger)?[t[0],t[1],t[2]]:null}function N(n,e){let t=le(n),r=le(e);if(!t||!r)throw new Error("A plugin version is not strict stable SemVer.");for(let o=0;o<t.length;o+=1){if(t[o]<r[o])return-1;if(t[o]>r[o])return 1}return 0}function ue(n){return JSON.parse(JSON.stringify(n))}function b(n){if(n===null)return-1;let e=Date.parse(n);return Number.isFinite(e)?e:-1}function We(n,e){if(!e)return"unknown";let t=N(n,e);return t<0?"update-available":t>0?"ahead-of-stable":"up-to-date"}function de(n,e){if(!n)return ue(e);let t=b(e.lastSuccessfulCheckAt),r=b(n.lastSuccessfulCheckAt),o=e.latestVersion!==null&&(n.latestVersion===null||N(e.latestVersion,n.latestVersion)>=0),s=e.lastSuccessfulCheckAt!==null&&(t>r||t===r&&o),i=b(e.lastAttemptAt)>=b(n.lastAttemptAt),a=s?e.latestVersion:n.latestVersion;return{targetId:e.targetId,currentVersion:e.currentVersion,latestVersion:a,latestTag:s?e.latestTag:n.latestTag,latestCommit:s?e.latestCommit:n.latestCommit,etag:s?e.etag:n.etag,comparison:We(e.currentVersion,a),lastAttemptAt:i?e.lastAttemptAt:n.lastAttemptAt,lastSuccessfulCheckAt:s?e.lastSuccessfulCheckAt:n.lastSuccessfulCheckAt,nextCheckAt:i?e.nextCheckAt:n.nextCheckAt,lastNotifiedVersion:n.lastNotifiedVersion,lastNotifiedAt:n.lastNotifiedAt,lastErrorCode:i?e.lastErrorCode:n.lastErrorCode}}var k=5,x=class{database;shared;databasePath;closed=!1;constructor(e){this.shared=typeof e=="string"?void 0:e,this.databasePath=typeof e=="string"?e:e.databasePath;let t=this.databasePath;if(this.shared){this.database=this.shared.database,this.shared.initialize(()=>this.initializeSchema());return}if(!t.trim())throw new l("INVALID_INPUT","Workflow database path must not be empty.");t!==":memory:"&&Be(X.dirname(X.resolve(t)),{recursive:!0,mode:448});let r=null;try{r=new pe(t),this.database=r,this.database.exec("PRAGMA busy_timeout = 5000;"),this.database.exec("PRAGMA synchronous = FULL;"),t!==":memory:"&&this.database.exec("PRAGMA journal_mode = WAL;"),this.initializeSchema(),t!==":memory:"&&process.platform!=="win32"&&Fe(X.resolve(t),384)}catch(o){try{r?.close()}catch{}throw this.storageError("Cannot initialize the workflow database.",o)}}getOrCreateSecret(e,t){return this.guard("Cannot read or create workflow metadata.",{key:e},()=>this.transaction(()=>{let r=this.database.prepare("SELECT value FROM workflow_metadata WHERE key = ?").get(e);if(r)return r.value;let o=t();return this.database.prepare(`
        INSERT INTO workflow_metadata (key, value, updated_at)
        VALUES (?, ?, ?)
      `).run(e,o,new Date().toISOString()),o}))}claimExecutionObservation(e,t,r){return this.guard("Cannot claim the trusted execution observation.",{observationId:e},()=>this.transaction(()=>{let o=this.database.prepare(`
        INSERT OR IGNORE INTO execution_observation_claims(observation_id, expires_at, consumed_at)
        VALUES (?, ?, ?)
      `).run(e,t,r);return Number(o.changes)===1}))}nextRunSequence(){return this.guard("Cannot reserve the next workflow run sequence.",{},()=>this.transaction(()=>{let e=this.database.prepare("SELECT value FROM workflow_metadata WHERE key = 'run-sequence'").get(),t=!e||/^(0|[1-9][0-9]*)$/.test(e.value),r=e&&t?Number.parseInt(e.value,10):0;if(!t||!Number.isSafeInteger(r)||r<0)throw new l("INVALID_INPUT","Workflow run sequence is invalid.",{value:e?.value??null});let o=r+1;if(!Number.isSafeInteger(o))throw new l("INVALID_INPUT","Workflow run sequence is exhausted.",{value:e?.value??null});return this.database.prepare(`
        INSERT INTO workflow_metadata (key, value, updated_at)
        VALUES ('run-sequence', ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `).run(String(o),new Date().toISOString()),o}))}insertRun(e){let t=new Date().toISOString();this.guard("Cannot persist the workflow run.",{runId:e.runId},()=>this.insertRunRow(e,t))}getRun(e){return this.guard("Cannot read the workflow run.",{runId:e},()=>{let t=this.database.prepare(`
        SELECT revision, receipt_json
        FROM workflow_runs
        WHERE run_id = ?
      `).get(e);if(!t)return null;let r=JSON.parse(t.receipt_json);if(r.runId!==e||r.revision!==t.revision)throw new l("INVALID_INPUT","Stored workflow receipt metadata does not match its payload.",{runId:e,storedRevision:t.revision,receiptRunId:r.runId,receiptRevision:r.revision});return r})}updateRun(e,t,r){return this.guard("Cannot update the workflow run.",{runId:e.runId},()=>this.transaction(()=>{let o=this.database.prepare(`
        UPDATE workflow_runs
        SET revision = ?, state = ?, receipt_json = ?, updated_at = ?
        WHERE run_id = ? AND revision = ?
      `).run(e.revision,e.state,JSON.stringify(e),new Date().toISOString(),e.runId,t);if(Number(o.changes)!==1)return!1;if(!r)return!0;if(!this.casRoot(r.root,r.expectedRootRevision))throw new l("STALE_REVISION","Convergence root changed while recording the workflow outcome.");let s=this.database.prepare(`
        UPDATE convergence_attempts
        SET state = ?, outcome_json = ?, updated_at = ?
        WHERE run_id = ? AND outcome_json IS NULL
      `).run(r.outcome.state,JSON.stringify(r.outcome),r.outcome.recordedAt,e.runId);if(Number(s.changes)!==1)throw new l("LEASE_CONFLICT","Guarded attempt outcome was already recorded or is missing.",{runId:e.runId});return!0}))}insertConvergenceRoot(e){return this.guard("Cannot persist the convergence root.",{rootId:e.rootId},()=>this.transaction(()=>{let t=e.parentRootId?this.rootRow(e.parentRootId):void 0;if(e.parentRootId&&!t)throw new l("INVALID_INPUT","Parent convergence root was not found.",{rootId:e.parentRootId});let o=this.database.prepare(`
        SELECT roots.root_id, roots.root_json, roots.revision, identities.identity_json, identities.surface_digest
        FROM convergence_roots AS roots
        LEFT JOIN convergence_root_identities AS identities ON identities.root_id = roots.root_id
        WHERE roots.state NOT IN ('completed', 'abandoned')
      `).all().map(i=>{let a=H(JSON.parse(i.root_json),i.identity_json&&i.surface_digest?this.storedIdentity(i.identity_json,i.surface_digest):null);return a.fresh&&this.saveRootIdentity(i.root_id,a.identity,a.inferred,a.surfaceDigest,null,e.createdAt),a}),s=G(e,o);if(s.conflict)return s.conflict;if(t){let i=JSON.parse(t.root_json);i.state="abandoned",i.revision+=1,i.updatedAt=e.createdAt,this.casRoot(i,t.revision)}return this.database.prepare(`
        INSERT INTO convergence_roots (root_id, revision, state, workspace_id, workspace_locator, root_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(e.rootId,e.revision,e.state,e.frame.workspace.workspaceId,A(e.frame.workspace.locator),JSON.stringify(e),e.createdAt,e.updatedAt),this.insertEpoch(e,e.createdAt),this.saveRootIdentity(e.rootId,s.identity,s.inferred,s.surfaceDigest,s.match,e.createdAt),null}))}getConvergenceSnapshot(e){return this.guard("Cannot read convergence state.",{rootId:e},()=>this.transaction(()=>{let t=this.rootRow(e);if(!t)return null;let r=this.database.prepare("SELECT lease_json, proposal_json FROM convergence_leases WHERE root_id = ? ORDER BY epoch, ordinal, issued_at").all(e),o=this.database.prepare("SELECT outcome_json FROM convergence_attempts WHERE root_id = ? AND outcome_json IS NOT NULL ORDER BY epoch, ordinal").all(e),s=this.database.prepare("SELECT review_json FROM convergence_reviews WHERE root_id = ? ORDER BY reviewed_at, review_id").all(e),i=this.database.prepare("SELECT run_id FROM workflow_attempt_links WHERE root_id = ? ORDER BY epoch, ordinal").all(e);return{root:JSON.parse(t.root_json),proposals:r.map(a=>JSON.parse(a.proposal_json)),leases:r.map(a=>JSON.parse(a.lease_json)),outcomes:o.map(a=>JSON.parse(a.outcome_json)),reviews:s.map(a=>JSON.parse(a.review_json)),workflowRunIds:i.map(a=>a.run_id)}},"BEGIN;"))}updateConvergenceRoot(e,t,r){return this.guard("Cannot update the convergence root.",{rootId:e.rootId},()=>this.transaction(()=>{let o=this.rootRow(e.rootId);if(!o||o.revision!==t)return!1;let s=JSON.parse(o.root_json);return this.casRoot(e,t)?(e.currentEpoch!==s.currentEpoch&&this.insertEpoch(e,e.updatedAt),r&&this.database.prepare(`
          INSERT INTO convergence_reviews (review_id, root_id, epoch, review_json, reviewed_at)
          VALUES (?, ?, ?, ?, ?)
        `).run(r.reviewId,r.rootId,r.epoch,JSON.stringify(r),r.reviewedAt),!0):!1}))}insertAttemptLease(e,t,r,o){return this.guard("Cannot claim the convergence attempt lease.",{rootId:e.rootId},()=>this.transaction(()=>this.shared&&Date.parse(o.expiresAt)<=this.shared.time(Date.parse(o.issuedAt))||!this.casRoot(e,t)?!1:(this.database.prepare(`
        INSERT INTO convergence_leases (
          lease_id, root_id, root_revision, epoch, ordinal, state, lease_json, proposal_json, issued_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(o.leaseId,o.rootId,o.rootRevision,o.epoch,o.ordinal,o.state,JSON.stringify(o),JSON.stringify(r),o.issuedAt,o.expiresAt),!0)),"The convergence database is busy; read status before retrying the lease claim.")}expireAttemptLease(e){return this.guard("Cannot expire the convergence attempt lease.",{leaseId:e},()=>this.transaction(()=>{let t=this.leaseRow(e);if(!t)return!1;let r=JSON.parse(t.lease_json);if(r.state!=="issued")return!1;r.state="expired";let o=this.database.prepare(`
        UPDATE convergence_leases SET state = 'expired', lease_json = ? WHERE lease_id = ? AND state = 'issued'
      `).run(JSON.stringify(r),e);return Number(o.changes)===1}))}getAttemptLease(e){return this.guard("Cannot read the convergence attempt lease.",{leaseId:e},()=>{let t=this.leaseRow(e);if(!t)return null;let r=JSON.parse(t.lease_json),o=JSON.parse(t.proposal_json),s=this.rootRow(r.rootId);return s?{root:JSON.parse(s.root_json),proposal:o,lease:r}:null})}insertGuardedRun(e,t,r,o){return this.guard("Cannot start the guarded workflow run.",{leaseId:t},()=>this.transaction(()=>{let s=this.leaseRow(t);if(!s)return null;let i=JSON.parse(s.lease_json),a=JSON.parse(s.proposal_json),c=this.shared?this.shared.time(Date.parse(o)):Date.parse(o);if(i.state!=="issued"||i.rootRevision!==r||Date.parse(i.expiresAt)<=c)return null;let p=this.rootRow(i.rootId);if(!p||p.revision!==r)return null;let f=JSON.parse(p.root_json);i.state="consumed";let T=this.database.prepare(`
        UPDATE convergence_leases SET state = 'consumed', lease_json = ?
        WHERE lease_id = ? AND state = 'issued'
      `).run(JSON.stringify(i),t);return Number(T.changes)!==1||(f.revision+=1,f.updatedAt=o,!this.casRoot(f,r))?null:(this.insertRunRow(e,o),this.database.prepare(`
        INSERT INTO convergence_attempts (
          root_id, epoch, ordinal, lease_id, run_id, state, outcome_json, started_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'running', NULL, ?, ?)
      `).run(f.rootId,i.epoch,i.ordinal,i.leaseId,e.runId,o,o),this.database.prepare(`
        INSERT INTO workflow_attempt_links (run_id, root_id, lease_id, epoch, ordinal)
        VALUES (?, ?, ?, ?, ?)
      `).run(e.runId,f.rootId,i.leaseId,i.epoch,i.ordinal),{root:f,proposal:a,lease:i,outcome:null})}),"The convergence database is busy or the lease was consumed concurrently.")}getGuardedRunBinding(e){return this.guard("Cannot read the guarded workflow binding.",{runId:e},()=>{let t=this.database.prepare("SELECT root_id, lease_id FROM workflow_attempt_links WHERE run_id = ?").get(e);if(!t)return null;let r=this.rootRow(t.root_id),o=this.leaseRow(t.lease_id),s=this.database.prepare("SELECT outcome_json FROM convergence_attempts WHERE run_id = ?").get(e);return!r||!o?null:{root:JSON.parse(r.root_json),proposal:JSON.parse(o.proposal_json),lease:JSON.parse(o.lease_json),outcome:s?.outcome_json?JSON.parse(s.outcome_json):null}})}getPluginUpdateState(e){return this.guard("Cannot read plugin update state.",{targetId:e},()=>this.readPluginUpdateStateRow(e))}putPluginUpdateState(e){this.guard("Cannot persist plugin update state.",{targetId:e.targetId},()=>this.transaction(()=>{let t=de(this.readPluginUpdateStateRow(e.targetId),e);this.database.prepare(`
      INSERT INTO plugin_update_state (
        target_id, current_version, latest_version, latest_tag, latest_commit, etag,
        comparison, last_attempt_at, last_successful_check_at, next_check_at,
        last_notified_version, last_notified_at, last_error_code
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(target_id) DO UPDATE SET
        current_version = excluded.current_version,
        latest_version = excluded.latest_version,
        latest_tag = excluded.latest_tag,
        latest_commit = excluded.latest_commit,
        etag = excluded.etag,
        comparison = excluded.comparison,
        last_attempt_at = excluded.last_attempt_at,
        last_successful_check_at = excluded.last_successful_check_at,
        next_check_at = excluded.next_check_at,
        last_notified_version = excluded.last_notified_version,
        last_notified_at = excluded.last_notified_at,
        last_error_code = excluded.last_error_code
      `).run(t.targetId,t.currentVersion,t.latestVersion,t.latestTag,t.latestCommit,t.etag,t.comparison,t.lastAttemptAt,t.lastSuccessfulCheckAt,t.nextCheckAt,t.lastNotifiedVersion,t.lastNotifiedAt,t.lastErrorCode)}))}claimPluginUpdateNotice(e,t,r){return this.guard("Cannot claim plugin update notice.",{targetId:e,latestVersion:t},()=>this.transaction(()=>{let o=this.readPluginUpdateStateRow(e);if(!o||o.latestVersion!==t||o.lastNotifiedVersion!==null&&N(o.lastNotifiedVersion,t)>=0)return!1;let s=this.database.prepare(`
      UPDATE plugin_update_state
      SET last_notified_version = ?, last_notified_at = ?
      WHERE target_id = ?
        AND latest_version = ?
      `).run(t,r,e,t);return Number(s.changes)===1}))}getSchemaVersion(){return this.shared?.getSchemaVersion()??this.database.prepare("PRAGMA user_version").get().user_version}isConvergenceRootActive(e){return!!this.database.prepare(`
      SELECT 1 AS active FROM convergence_roots
      WHERE root_id = ? AND state IN ('open', 'needs-review', 'needs-user')
    `).get(e)}withInactiveRootGuard(e,t){return this.transaction(()=>{let r=this.database.prepare("SELECT state FROM convergence_roots WHERE root_id = ?");for(let o of[...new Set(e)].sort()){let s=r.get(o);if(s&&["open","needs-review","needs-user"].includes(s.state))throw new l("STALE_REVISION","A continuity cleanup root became active after preview.",{rootId:o})}return t()})}previewCleanup(e){let t=this.database.prepare(`
      SELECT root_id, revision, state, updated_at
      FROM convergence_roots
      WHERE state IN ('completed', 'abandoned') AND updated_at <= ?
      ORDER BY root_id
    `).all(e),r=this.database.prepare(`
      SELECT run_id FROM workflow_attempt_links WHERE root_id = ? ORDER BY run_id
    `),o=t.map(a=>({rootId:a.root_id,revision:a.revision,state:a.state,updatedAt:a.updated_at,runIds:r.all(a.root_id).map(c=>c.run_id)})),s=this.database.prepare(`
      SELECT run_id, revision, state, updated_at
      FROM workflow_runs
      WHERE state IN ('failed', 'passed', 'blocked')
        AND updated_at <= ?
        AND NOT EXISTS (SELECT 1 FROM workflow_attempt_links links WHERE links.run_id = workflow_runs.run_id)
      ORDER BY run_id
    `).all(e),i=this.database.prepare(`
      SELECT COUNT(*) AS count FROM convergence_roots
      WHERE state IN ('open', 'needs-review', 'needs-user')
    `).get();return{roots:o,standaloneRuns:s.map(a=>({runId:a.run_id,revision:a.revision,state:a.state,updatedAt:a.updated_at})),protectedActiveRoots:i.count}}claimCleanupPlan(e,t,r){return this.guard("Cannot claim the state cleanup plan.",{planId:e},()=>{let o=this.database.prepare(`
        INSERT OR IGNORE INTO state_cleanup_claims(plan_id, plan_digest, claimed_at)
        VALUES (?, ?, ?)
      `).run(e,t,r);return Number(o.changes)===1})}backupTo(e){if(this.shared)throw new Error("SHARED_BACKUP_OWNER_REQUIRED: a shared database backup requires an explicit owner contract.");if(this.databasePath===":memory:")throw new l("INVALID_INPUT","An in-memory workflow database cannot be cleaned destructively.");this.guard("Cannot create a verified workflow cleanup backup.",{targetPath:e},()=>{this.database.prepare("VACUUM INTO ?").run(e);let t=new pe(e,{readOnly:!0});try{let r=t.prepare("PRAGMA integrity_check").get();if(r.integrity_check!=="ok")throw new Error(`integrity_check returned ${r.integrity_check}`)}finally{t.close()}})}executeCleanup(e){return this.guard("Cannot execute workflow state cleanup.",{},()=>this.transaction(()=>{let t=this.database.prepare(`
        SELECT state, revision, updated_at FROM convergence_roots WHERE root_id = ?
      `),r=this.database.prepare(`
        SELECT state, revision, updated_at FROM workflow_runs WHERE run_id = ?
      `);for(let d of e.roots){let u=t.get(d.rootId);if(!u||u.state!==d.state||u.revision!==d.revision||u.updated_at!==d.updatedAt)throw new l("STALE_REVISION","A cleanup root changed after preview.",{rootId:d.rootId});let R=this.database.prepare(`
          SELECT run_id FROM workflow_attempt_links WHERE root_id = ? ORDER BY run_id
        `).all(d.rootId).map(m=>m.run_id);if(JSON.stringify(R)!==JSON.stringify(d.runIds))throw new l("STALE_REVISION","A cleanup root's linked runs changed after preview.",{rootId:d.rootId})}for(let d of e.standaloneRuns){let u=r.get(d.runId);if(!u||u.state!==d.state||u.revision!==d.revision||u.updated_at!==d.updatedAt)throw new l("STALE_REVISION","A cleanup workflow run changed after preview.",{runId:d.runId})}let o=this.database.prepare("DELETE FROM workflow_attempt_links WHERE root_id = ?"),s=this.database.prepare("DELETE FROM convergence_attempts WHERE root_id = ?"),i=this.database.prepare("DELETE FROM convergence_reviews WHERE root_id = ?"),a=this.database.prepare("DELETE FROM convergence_leases WHERE root_id = ?"),c=this.database.prepare("DELETE FROM convergence_epochs WHERE root_id = ?"),p=this.database.prepare("DELETE FROM convergence_root_identities WHERE root_id = ?"),f=this.database.prepare("DELETE FROM convergence_roots WHERE root_id = ?"),T=this.database.prepare("DELETE FROM workflow_runs WHERE run_id = ?"),S=0;for(let d of e.roots){o.run(d.rootId),s.run(d.rootId),i.run(d.rootId),a.run(d.rootId),c.run(d.rootId),p.run(d.rootId),f.run(d.rootId);for(let u of d.runIds)S+=Number(T.run(u).changes)}for(let d of e.standaloneRuns)S+=Number(T.run(d.runId).changes);return{roots:e.roots.length,runs:S}}))}close(){this.closed||(this.database.close(),this.closed=!0)}initializeSchema(){let e={user_version:this.getSchemaVersion()};if(e.user_version>k)throw new l("INVALID_INPUT","Workflow database schema is newer than this server supports.",{databasePath:this.databasePath,supportedVersion:k,actualVersion:e.user_version});this.transaction(()=>{e.user_version>0&&e.user_version<4&&this.database.exec(`
          ALTER TABLE workflow_runs ADD COLUMN state TEXT;
          ALTER TABLE workflow_runs ADD COLUMN created_at TEXT;
          UPDATE workflow_runs
          SET state = COALESCE(json_extract(receipt_json, '$.state'), 'blocked'),
              created_at = updated_at;
        `),this.database.exec(`
        CREATE TABLE IF NOT EXISTS workflow_metadata (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS workflow_runs (
          run_id TEXT PRIMARY KEY,
          revision INTEGER NOT NULL CHECK (revision >= 0),
          state TEXT NOT NULL CHECK (state IN ('ready', 'running', 'needs-input', 'needs-approval', 'needs-redesign', 'failed', 'passed', 'blocked')),
          receipt_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;
        CREATE INDEX IF NOT EXISTS workflow_runs_cleanup
          ON workflow_runs(state, updated_at);
        CREATE TABLE IF NOT EXISTS plugin_update_state (
          target_id TEXT PRIMARY KEY,
          current_version TEXT NOT NULL,
          latest_version TEXT,
          latest_tag TEXT,
          latest_commit TEXT,
          etag TEXT,
          comparison TEXT NOT NULL CHECK (comparison IN ('unknown', 'up-to-date', 'update-available', 'ahead-of-stable')),
          last_attempt_at TEXT,
          last_successful_check_at TEXT,
          next_check_at TEXT NOT NULL,
          last_notified_version TEXT,
          last_notified_at TEXT,
          last_error_code TEXT CHECK (
            last_error_code IS NULL
            OR last_error_code IN ('TIMEOUT', 'NETWORK', 'HTTP', 'INVALID_RESPONSE', 'NO_STABLE_TAG')
          )
        ) STRICT;
        CREATE TABLE IF NOT EXISTS convergence_roots (
          root_id TEXT PRIMARY KEY,
          revision INTEGER NOT NULL CHECK (revision >= 0),
          state TEXT NOT NULL CHECK (state IN ('open', 'needs-review', 'needs-user', 'completed', 'abandoned')),
          workspace_id TEXT NOT NULL,
          workspace_locator TEXT NOT NULL,
          root_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;
        CREATE INDEX IF NOT EXISTS convergence_active_roots_by_workspace
          ON convergence_roots(workspace_id, state);
        CREATE INDEX IF NOT EXISTS convergence_active_roots_by_locator
          ON convergence_roots(workspace_locator, state);
        CREATE TABLE IF NOT EXISTS convergence_root_identities (
          root_id TEXT PRIMARY KEY,
          identity_json TEXT NOT NULL,
          surface_digest TEXT NOT NULL,
          replacement_match TEXT CHECK (replacement_match IS NULL OR replacement_match IN ('physical', 'lineage', 'legacy-locator')),
          created_at TEXT NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS convergence_epochs (
          root_id TEXT NOT NULL REFERENCES convergence_roots(root_id),
          epoch INTEGER NOT NULL CHECK (epoch >= 1 AND epoch <= 2),
          frame_digest TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (root_id, epoch)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS convergence_leases (
          lease_id TEXT PRIMARY KEY,
          root_id TEXT NOT NULL REFERENCES convergence_roots(root_id),
          root_revision INTEGER NOT NULL CHECK (root_revision >= 0),
          epoch INTEGER NOT NULL CHECK (epoch >= 1 AND epoch <= 2),
          ordinal INTEGER NOT NULL CHECK (ordinal >= 1 AND ordinal <= 3),
          state TEXT NOT NULL CHECK (state IN ('issued', 'consumed', 'expired')),
          lease_json TEXT NOT NULL,
          proposal_json TEXT NOT NULL,
          issued_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          UNIQUE (root_id, epoch, ordinal, lease_id)
        ) STRICT;
        CREATE UNIQUE INDEX IF NOT EXISTS convergence_one_issued_lease
          ON convergence_leases(root_id) WHERE state = 'issued';
        CREATE TABLE IF NOT EXISTS convergence_attempts (
          root_id TEXT NOT NULL REFERENCES convergence_roots(root_id),
          epoch INTEGER NOT NULL CHECK (epoch >= 1 AND epoch <= 2),
          ordinal INTEGER NOT NULL CHECK (ordinal >= 1 AND ordinal <= 3),
          lease_id TEXT NOT NULL UNIQUE REFERENCES convergence_leases(lease_id),
          run_id TEXT NOT NULL UNIQUE REFERENCES workflow_runs(run_id),
          state TEXT NOT NULL CHECK (state IN ('running', 'passed', 'failed', 'aborted')),
          outcome_json TEXT,
          started_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (root_id, epoch, ordinal)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS convergence_reviews (
          review_id TEXT PRIMARY KEY,
          root_id TEXT NOT NULL REFERENCES convergence_roots(root_id),
          epoch INTEGER NOT NULL CHECK (epoch >= 1 AND epoch <= 2),
          review_json TEXT NOT NULL,
          reviewed_at TEXT NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS workflow_attempt_links (
          run_id TEXT PRIMARY KEY REFERENCES workflow_runs(run_id),
          root_id TEXT NOT NULL REFERENCES convergence_roots(root_id),
          lease_id TEXT NOT NULL UNIQUE REFERENCES convergence_leases(lease_id),
          epoch INTEGER NOT NULL CHECK (epoch >= 1 AND epoch <= 2),
          ordinal INTEGER NOT NULL CHECK (ordinal >= 1 AND ordinal <= 3)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS state_cleanup_claims (
          plan_id TEXT PRIMARY KEY,
          plan_digest TEXT NOT NULL,
          claimed_at TEXT NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS execution_observation_claims (
          observation_id TEXT PRIMARY KEY,
          expires_at TEXT NOT NULL,
          consumed_at TEXT NOT NULL
        ) STRICT;

      `),this.shared?this.shared.setSchemaVersion(k):this.database.exec(`PRAGMA user_version = ${k};`)})}rootRow(e){return this.database.prepare("SELECT root_json, revision FROM convergence_roots WHERE root_id = ?").get(e)}leaseRow(e){return this.database.prepare("SELECT lease_json, proposal_json FROM convergence_leases WHERE lease_id = ?").get(e)}casRoot(e,t){let r=this.database.prepare(`
      UPDATE convergence_roots SET revision = ?, state = ?, root_json = ?, updated_at = ?
      WHERE root_id = ? AND revision = ?
    `).run(e.revision,e.state,JSON.stringify(e),e.updatedAt,e.rootId,t);return Number(r.changes)===1}saveRootIdentity(e,t,r,o,s,i){this.database.prepare(`
      INSERT INTO convergence_root_identities (root_id, identity_json, surface_digest, replacement_match, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(root_id) DO UPDATE SET identity_json = excluded.identity_json, surface_digest = excluded.surface_digest
    `).run(e,JSON.stringify({...t,inferred:r}),o,s,i)}storedIdentity(e,t){let{inferred:r=[],...o}=JSON.parse(e);return{identity:o,surfaceDigest:t,inferred:r}}insertEpoch(e,t){this.database.prepare(`
      INSERT INTO convergence_epochs (root_id, epoch, frame_digest, created_at)
      VALUES (?, ?, ?, ?)
    `).run(e.rootId,e.currentEpoch,e.frameDigest,t)}insertRunRow(e,t){this.database.prepare(`
      INSERT INTO workflow_runs (run_id, revision, state, receipt_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(e.runId,e.revision,e.state,JSON.stringify(e),t,t)}readPluginUpdateStateRow(e){let t=this.database.prepare(`
      SELECT target_id, current_version, latest_version, latest_tag, latest_commit, etag,
             comparison, last_attempt_at, last_successful_check_at, next_check_at,
             last_notified_version, last_notified_at, last_error_code
      FROM plugin_update_state
      WHERE target_id = ?
    `).get(e);return t?{targetId:t.target_id,currentVersion:t.current_version,latestVersion:t.latest_version,latestTag:t.latest_tag,latestCommit:t.latest_commit,etag:t.etag,comparison:t.comparison,lastAttemptAt:t.last_attempt_at,lastSuccessfulCheckAt:t.last_successful_check_at,nextCheckAt:t.next_check_at,lastNotifiedVersion:t.last_notified_version,lastNotifiedAt:t.last_notified_at,lastErrorCode:t.last_error_code}:null}transaction(e,t="BEGIN IMMEDIATE;"){if(this.shared)return this.shared.transaction(e);this.database.exec(t);try{let r=e();return this.database.exec("COMMIT;"),r}catch(r){try{this.database.exec("ROLLBACK;")}catch{}throw r}}guard(e,t,r,o){try{return r()}catch(s){throw s instanceof l?s:o&&this.isLeaseContention(s)?new l("LEASE_CONFLICT",o,t):this.storageError(e,s,t)}}isLeaseContention(e){let t=e instanceof Error?e.message:String(e);return/database is locked|SQLITE_BUSY|UNIQUE constraint failed: convergence_leases/iu.test(t)}storageError(e,t,r={}){return new l("INVALID_INPUT",e,{...r,databasePath:this.databasePath,cause:t instanceof Error?t.message:String(t)})}};var He={haiku:"lightweight",sonnet:"general",opus:"deep",fable:"frontier"},Ge=/^(?:[a-z]{2,6}(?:-[a-z]{2,4})?\.)?(?:anthropic\.)?claude-(?:\d+(?:-\d+)?-)?(haiku|sonnet|opus|fable)(?:[-@:.]|$)/u;function Xe(n){let e=Ge.exec(n)?.[1];return e?He[e]??null:null}var ge={"gpt-6-astra":"frontier","gpt-6-sol":"general","gpt-6-luna":"lightweight","gpt-5.6-sol":"deep","gpt-5.6-terra":"general","gpt-5.6-luna":"lightweight"},je={host:"claude-code",modelClassForModel:Xe},Ke={host:"codex",modelClassForModel:n=>Object.hasOwn(ge,n)?ge[n]:null};function At(n,e){let t=new x(n);return{runObserved(r,o,s,i){return ce(t,e,r,o,s,i)},close(){t.close()}}}export{je as claudeCodeExecutionAdapter,Ke as codexExecutionAdapter,ie as hostActorId,At as openHostAttestation};
