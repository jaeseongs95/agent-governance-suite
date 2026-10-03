/* eslint-disable */
import{createHash as oe,createHmac as ye,randomBytes as Ne,timingSafeEqual as it}from"node:crypto";var j=["lightweight","general","deep","frontier"],X=["low","medium","high","xhigh","max","ultra"];var l=class extends Error{constructor(t,r,o=null){super(r);this.code=t;this.details=o;this.name="WorkflowContractError"}code;details;toBody(){return{code:this.code,message:this.message,details:this.details}}};import{createHash as Te}from"node:crypto";import{existsSync as y,statSync as Q}from"node:fs";import W from"node:path";import f from"node:fs";import g from"node:path";var P=256,C=4096,fe=/^[A-Za-z][A-Za-z0-9+.-]+:\/\//u,me=/[*?[\]{}]/u,Re=process.platform==="win32"?/[\\/]/u:/\//u;function U(n){if(fe.test(n))return!0;for(let e=0;e<n.length;e+=1){let t=n.charCodeAt(e);if(t<=31||t===127)return!0}return!1}function Ee(n){if(U(n))throw new l("INVALID_INPUT","Scope entries must be file system paths without control characters.",{reason:"UNSUPPORTED_SCOPE_ENTRY",entry:n})}function h(n,e){return e===""||n===e||n.startsWith(`${e}/`)}function T(n,e){return new l("INVALID_INPUT",`Workspace identity cannot be resolved for ${n}: ${e}.`,{reason:"WORKSPACE_IDENTITY_UNRESOLVED",path:n,cause:e})}function S(n){return(process.platform==="win32"?n.replaceAll("\\","/").toLowerCase():n).replace(/\/+$/u,"")}function x(n){let e=g.resolve(n),t=[];for(let r=0;r<P;r+=1)try{let o=f.realpathSync.native(e);return{real:g.join(o,...t),existing:o}}catch(o){let s=o.code,i=g.dirname(e);if(s!=="ENOENT"&&s!=="ENOTDIR"||i===e)throw T(n,s??"unreadable");t.unshift(g.basename(e)),e=i}throw T(n,"walk limit reached")}function A(n){return f.statSync(n,{throwIfNoEntry:!1})?.isDirectory()===!0}function D(n){let e=f.openSync(n,"r");try{let t=Buffer.alloc(C+1),r=f.readSync(e,t,0,C+1,0);if(r>C)throw T(n,"pointer file too large");return t.toString("utf8",0,r)}finally{f.closeSync(e)}}function K(n){let e=n.existing;try{let t=A(n.existing)?n.existing:g.dirname(n.existing);for(let r=0;r<P;r+=1){e=g.join(t,".git");let o=f.statSync(e,{throwIfNoEntry:!1});if(o){let i=e;if(!o.isDirectory()){let c=/^gitdir: ([^\r\n]+)/u.exec(D(e))?.[1];if(!c)throw T(e,"missing gitdir line");if(i=g.resolve(t,c),!A(i))throw T(i,"gitdir is not a directory")}let a=i;if(e=g.join(i,"commondir"),f.statSync(e,{throwIfNoEntry:!1})){let c=D(e).trim();if(!c)throw T(e,"empty commondir");if(a=g.resolve(i,c),!A(a))throw T(a,"commondir is not a directory")}return{commonDir:S(f.realpathSync.native(a)),checkoutRoot:S(t),relative:S(g.relative(t,n.real))}}let s=g.dirname(t);if(s===t)return null;t=s}throw T(n.existing,"walk limit reached")}catch(t){throw t instanceof l?t:T(e,t.code??"unreadable")}}function J(n){let e=new Set,t=!1;try{if(!A(n))return{roots:[],complete:!1};g.basename(n)===".git"&&e.add(S(x(g.dirname(n)).real));let r=g.join(n,"worktrees");if(f.statSync(r,{throwIfNoEntry:!1})){let o=f.opendirSync(r);try{for(let s=0;;s+=1){let i=o.readSync()?.name;if(i===void 0||s>=P)break;try{let a=D(g.join(r,i,"gitdir")).trim();if(!a||U(a)||S(g.basename(a))!==".git")continue;e.add(S(x(g.dirname(g.resolve(r,i,a))).real))}catch{}}}finally{o.closeSync()}}}catch{}return{roots:[...e],complete:t}}function Y(n,e){let t=[n],r=new Set,o=0;try{for(;t.length>0;){if(++o>C)return"unknown";let s=f.realpathSync.native(t.pop()),i=S(s);if(r.has(i))continue;if(r.add(i),f.statSync(g.join(s,".git"),{throwIfNoEntry:!1})&&K({real:s,existing:s})?.commonDir===e)return"overlap";let a=f.opendirSync(s);try{for(let c=a.readSync();c;c=a.readSync()){if(++o>C)return"unknown";if(c.name===".git")continue;let u=g.join(s,c.name);if(c.isDirectory())t.push(u);else if(c.isSymbolicLink()){if(A(u))t.push(u);else if(L(u).git?.commonDir===e)return"overlap"}}}finally{a.closeSync()}}return"none"}catch{return"unknown"}}function L(n){let e=x(n);return{physical:S(e.real),git:K(e)}}function $(n,e,t={}){if(!t.legacy)for(let s of e)Ee(s);let r=L(n),o=e.map(s=>{if(U(s))return{entry:s,...r,conservative:"legacy-unsupported"};let i=s.split(Re),a=i.findIndex(u=>me.test(u));if(a===0)return r.git?{entry:s,physical:r.git.checkoutRoot,git:{...r.git,relative:""},conservative:"leading-glob"}:{entry:s,...r,conservative:"leading-glob"};let c=a<0?s:`${i.slice(0,a).join("/")}/`;return{entry:s,...L(g.resolve(n,c)),conservative:a<0?null:"glob-prefix"}});return{version:1,workspacePhysical:r.physical,surfaces:o}}function M(n,e="Convergence input"){if(n===null||typeof n=="boolean"||typeof n=="string")return JSON.stringify(n);if(typeof n=="number"){if(!Number.isFinite(n))throw new l("INVALID_INPUT",`${e} contains a non-finite number.`);return JSON.stringify(n)}if(Array.isArray(n))return`[${n.map(t=>M(t,e)).join(",")}]`;if(n&&typeof n=="object"){let t=n;return`{${Object.keys(t).sort().map(r=>`${JSON.stringify(r)}:${M(t[r],e)}`).join(",")}}`}throw new l("INVALID_INPUT",`${e} contains a non-serializable value.`)}function w(n){return`sha256:${Te("sha256").update(M(n),"utf8").digest("hex")}`}function B(n){return[...n.taskEnvelope.scope.included,...n.taskEnvelope.workUnits.flatMap(e=>e.writeTargets),...n.frame.targetArtifacts.map(e=>e.locator)]}function Z(n,e=!1){return $(n.frame.workspace.locator,B(n),{legacy:e})}function ee(n){return w({locator:n.frame.workspace.locator,entries:B(n)})}function z(n,e){let t=W.resolve(e,n).replaceAll("\\","/").replace(/\/+$/u,"");return process.platform==="win32"?t.toLowerCase():t}function Se(n){return n.surfaces.map(e=>!y(e.physical||"/"))}function he(n,e){return e.git===null?!1:n.git===null?!0:e.git.checkoutRoot!==n.git.checkoutRoot&&h(e.git.checkoutRoot,n.git.checkoutRoot)}function Ie(n,e){let t=e&&n.git===null&&!n.conservative;return y((t?W.posix.dirname(n.physical):n.physical)||"/")}function F(n,e){let t=ee(n),r=e&&e.surfaceDigest===t?e.identity:null,o=d=>r!==null&&e.inferred[d]===!0,s={root:n,legacy:e===null,observedWorkspace:r!==null,surfaceDigest:t};if(r&&r.surfaces.every((d,m)=>d.git!==null&&!o(m)))return{...s,identity:r,resolved:!0,fresh:!1,inferred:e.inferred};let i=null;try{i=Z(n,!0)}catch(d){if(!(d instanceof l))throw d}let a=n.frame.workspace.locator;if(!r&&!i){let d={version:1,workspacePhysical:z(".",a),surfaces:B(n).map(m=>({entry:m,physical:z(m,a),git:null,conservative:null}))};return{...s,identity:d,resolved:!1,fresh:!1,inferred:[]}}let c=y(a),u=!0,R=(r??i).surfaces.map((d,m)=>{let E=i?.surfaces[m];return o(m)?(E||(u=!1),E&&!he(E,d)?E:d):r&&d.git!==null?d:E&&c&&Ie(E,r!==null)?E:(u=!1,d)}),v={version:1,workspacePhysical:r?.workspacePhysical??i.workspacePhysical,surfaces:R},I=R.map((d,m)=>o(m)&&!y(d.physical||"/")),p=u&&JSON.stringify({identity:v,inferred:I})!==JSON.stringify({identity:r,inferred:e?.inferred});return{...s,identity:v,resolved:u,fresh:p,inferred:I}}var te=["needs-review","needs-user"];function ne(n,e){return h(n,e)||h(e,n)}function re(n,e){return n.git!==null&&e.git!==null&&n.git.commonDir===e.git.commonDir}function _e(n,e){return e.surfaces.some(t=>h(n.physical,t.physical)||re(n,t)&&h(n.git.relative,t.git.relative))}function ve(n,e,t,r){if(re(n,e)&&ne(n.git.relative,e.git.relative))return"overlap";let o=!1;for(let[s,i]of[[n,e],[e,n]]){if(!i.git||s.conservative===null&&Q(s.physical||"/",{throwIfNoEntry:!1})?.isDirectory()!==!0)continue;let a=i.git.commonDir;t.has(a)||t.set(a,J(a));let c=t.get(a);if(c.roots.some(u=>h(u,s.physical)))return"overlap";if(!c.complete){let u=`${a}\0${s.physical}`;r.has(u)||r.set(u,Y(s.physical||"/",a));let R=r.get(u);if(R==="overlap")return"overlap";o||=R==="unknown"}}return o?"unknown":"none"}function Ce(n){return n.git===null&&n.conservative===null&&Q(n.physical||"/",{throwIfNoEntry:!1})?.isDirectory()!==!0}function Ae(n,e,t){let r=new Map,o=new Map;for(let s of t)if(s.root.rootId!==n.root.parentRootId){for(let i of n.identity.surfaces)for(let a of s.identity.surfaces)if(ne(i.physical,a.physical))return{root:s.root,kind:"physical",requested:i,existing:a};if(te.includes(s.root.state)){for(let i of n.identity.surfaces)if(!(e&&_e(i,e)))for(let a of s.identity.surfaces){if(!s.resolved){if(Ce(i))continue;return{root:s.root,kind:"lineage-unresolved",requested:i,existing:a}}let c=ve(i,a,r,o);if(c!=="none")return{root:s.root,kind:c==="overlap"?"lineage":"lineage-unresolved",requested:i,existing:a}}}}return null}function Ve(n,e){if(!e.resolved)return e.legacy?e.root.frame.workspace.workspaceId===n.root.frame.workspace.workspaceId&&N(e.root.frame.workspace.locator)===N(n.root.frame.workspace.locator)?"legacy-locator":null:e.observedWorkspace&&n.identity.workspacePhysical===e.identity.workspacePhysical?"physical":null;if(n.identity.workspacePhysical===e.identity.workspacePhysical)return"physical";let t=new Set(e.identity.surfaces.flatMap(o=>o.git?[o.git.commonDir]:[]));return n.identity.surfaces.length>0&&n.identity.surfaces.every(o=>o.git!==null&&t.has(o.git.commonDir))?"lineage":null}function q(n,e){let t=Z(n),r=null,o=null;if(n.parentRootId){if(r=e.find(s=>s.root.rootId===n.parentRootId)??null,!r||!te.includes(r.root.state))throw new l("INVALID_TRANSITION","Only a gated convergence root may be replaced.",{parentRootId:n.parentRootId,parentState:r?.root.state??null});if(o=Ve({root:n,identity:t},r),!o)throw new l("INVALID_INPUT","A replacement root must remain bound to the same workspace.",{parentRootId:n.parentRootId,...r.resolved?{}:{reason:"WORKSPACE_IDENTITY_UNRESOLVED"}})}return{identity:t,surfaceDigest:ee(n),inferred:Se(t),match:o,conflict:Ae({root:n,identity:t},r?.identity??null,e)}}function N(n){let e=W.resolve(n);return process.platform==="win32"?e.toLowerCase():e}var se="_hostAttestation",we=new Set(["plan_workflow","record_stage_result"]),Oe="host_attestation_key_v1",ke="aghs1",be=300*1e3;function xe(n){return n&&typeof n=="object"&&!Array.isArray(n)?n:null}function O(n){return typeof n=="string"&&n.length>0?n:null}var _=n=>oe("sha256").update(n,"utf8").digest("hex").slice(0,24);function ie(n,e,t=null){return`${n}:session-${_(e)}${t?`:agent-${_(t)}`:""}`}function De(n){return typeof n=="string"&&X.includes(n)}function ae(n){let e={...n};return delete e[se],e}function Le(n,e){if(n==="plan_workflow"){let t=O(xe(e.taskEnvelope)?.taskId)??O(e.taskId);return t?{phase:"bootstrap",taskId:t,runId:null,stageId:null,revision:null}:null}if(n==="record_stage_result"){let t=O(e.runId),r=O(e.stageId),o=e.expectedRevision;return!t||!r||!Number.isSafeInteger(o)?null:{phase:"stage",taskId:null,runId:t,stageId:r,revision:o}}return null}function Pe(n){let e=Buffer.from(n.getOrCreateSecret(Oe,()=>Ne(32).toString("base64url")),"base64url");if(e.length!==32)throw new l("INVALID_INPUT","Stored host attestation key is invalid.");return e}function Ue(n,e){return ye("sha256",n).update(e,"utf8").digest("base64url")}function Me(n,e,t){if(!we.has(t.tool))return null;let r=ae(t.input),o=Le(t.tool,r),s=e.modelClassForModel(t.model);if(!o||!s||!j.includes(s)||!e.host||!De(t.reasoningEffort)||!t.actorId||!t.sessionId||!t.toolUseId||t.actorId!==ie(e.host,t.sessionId,t.agentId??null))return null;let i=t.now??new Date,a={host:e.host,session:_(t.sessionId),agent:t.agentId?_(t.agentId):null,turn:t.turnId?_(t.turnId):null,call:_(t.toolUseId)},c={v:1,...a,tool:t.tool,inputDigest:w(r),...o,model:t.model,modelClass:s,reasoningEffort:t.reasoningEffort,actorId:t.actorId,observationId:oe("sha256").update(JSON.stringify(a),"utf8").digest("base64url"),observedAt:i.toISOString(),expiresAt:new Date(i.getTime()+be).toISOString()},u=`${ke}.${Buffer.from(JSON.stringify(c),"utf8").toString("base64url")}`;return`${u}.${Ue(Pe(n),u)}`}function ce(n,e,t,r,o,s){let i=ae(r),a=o(),c=a?Me(n,e,{...a,tool:t,input:i}):null;return s({...i,...c?{[se]:c}:{}})}import{chmodSync as Be,mkdirSync as Fe}from"node:fs";import H from"node:path";import{DatabaseSync as pe}from"node:sqlite";function le(n){let e=/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u.exec(n);if(!e)return null;let t=e.slice(1).map(r=>Number.parseInt(r,10));return t.length===3&&t.every(Number.isSafeInteger)?[t[0],t[1],t[2]]:null}function V(n,e){let t=le(n),r=le(e);if(!t||!r)throw new Error("A plugin version is not strict stable SemVer.");for(let o=0;o<t.length;o+=1){if(t[o]<r[o])return-1;if(t[o]>r[o])return 1}return 0}function ue(n){return JSON.parse(JSON.stringify(n))}function k(n){if(n===null)return-1;let e=Date.parse(n);return Number.isFinite(e)?e:-1}function We(n,e){if(!e)return"unknown";let t=V(n,e);return t<0?"update-available":t>0?"ahead-of-stable":"up-to-date"}function de(n,e){if(!n)return ue(e);let t=k(e.lastSuccessfulCheckAt),r=k(n.lastSuccessfulCheckAt),o=e.latestVersion!==null&&(n.latestVersion===null||V(e.latestVersion,n.latestVersion)>=0),s=e.lastSuccessfulCheckAt!==null&&(t>r||t===r&&o),i=k(e.lastAttemptAt)>=k(n.lastAttemptAt),a=s?e.latestVersion:n.latestVersion;return{targetId:e.targetId,currentVersion:e.currentVersion,latestVersion:a,latestTag:s?e.latestTag:n.latestTag,latestCommit:s?e.latestCommit:n.latestCommit,etag:s?e.etag:n.etag,comparison:We(e.currentVersion,a),lastAttemptAt:i?e.lastAttemptAt:n.lastAttemptAt,lastSuccessfulCheckAt:s?e.lastSuccessfulCheckAt:n.lastSuccessfulCheckAt,nextCheckAt:i?e.nextCheckAt:n.nextCheckAt,lastNotifiedVersion:n.lastNotifiedVersion,lastNotifiedAt:n.lastNotifiedAt,lastErrorCode:i?e.lastErrorCode:n.lastErrorCode}}var G=5,b=class{constructor(e){this.databasePath=e;if(!e.trim())throw new l("INVALID_INPUT","Workflow database path must not be empty.");e!==":memory:"&&Fe(H.dirname(H.resolve(e)),{recursive:!0,mode:448});let t=null;try{t=new pe(e),this.database=t,this.database.exec("PRAGMA busy_timeout = 5000;"),this.database.exec("PRAGMA synchronous = FULL;"),e!==":memory:"&&this.database.exec("PRAGMA journal_mode = WAL;"),this.initializeSchema(),e!==":memory:"&&process.platform!=="win32"&&Be(H.resolve(e),384)}catch(r){try{t?.close()}catch{}throw this.storageError("Cannot initialize the workflow database.",r)}}databasePath;database;closed=!1;getOrCreateSecret(e,t){return this.guard("Cannot read or create workflow metadata.",{key:e},()=>this.transaction(()=>{let r=this.database.prepare("SELECT value FROM workflow_metadata WHERE key = ?").get(e);if(r)return r.value;let o=t();return this.database.prepare(`
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
      `).all().map(i=>{let a=F(JSON.parse(i.root_json),i.identity_json&&i.surface_digest?this.storedIdentity(i.identity_json,i.surface_digest):null);return a.fresh&&this.saveRootIdentity(i.root_id,a.identity,a.inferred,a.surfaceDigest,null,e.createdAt),a}),s=q(e,o);if(s.conflict)return s.conflict;if(t){let i=JSON.parse(t.root_json);i.state="abandoned",i.revision+=1,i.updatedAt=e.createdAt,this.casRoot(i,t.revision)}return this.database.prepare(`
        INSERT INTO convergence_roots (root_id, revision, state, workspace_id, workspace_locator, root_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(e.rootId,e.revision,e.state,e.frame.workspace.workspaceId,N(e.frame.workspace.locator),JSON.stringify(e),e.createdAt,e.updatedAt),this.insertEpoch(e,e.createdAt),this.saveRootIdentity(e.rootId,s.identity,s.inferred,s.surfaceDigest,s.match,e.createdAt),null}))}getConvergenceSnapshot(e){return this.guard("Cannot read convergence state.",{rootId:e},()=>this.transaction(()=>{let t=this.rootRow(e);if(!t)return null;let r=this.database.prepare("SELECT lease_json, proposal_json FROM convergence_leases WHERE root_id = ? ORDER BY epoch, ordinal, issued_at").all(e),o=this.database.prepare("SELECT outcome_json FROM convergence_attempts WHERE root_id = ? AND outcome_json IS NOT NULL ORDER BY epoch, ordinal").all(e),s=this.database.prepare("SELECT review_json FROM convergence_reviews WHERE root_id = ? ORDER BY reviewed_at, review_id").all(e),i=this.database.prepare("SELECT run_id FROM workflow_attempt_links WHERE root_id = ? ORDER BY epoch, ordinal").all(e);return{root:JSON.parse(t.root_json),proposals:r.map(a=>JSON.parse(a.proposal_json)),leases:r.map(a=>JSON.parse(a.lease_json)),outcomes:o.map(a=>JSON.parse(a.outcome_json)),reviews:s.map(a=>JSON.parse(a.review_json)),workflowRunIds:i.map(a=>a.run_id)}},"BEGIN;"))}updateConvergenceRoot(e,t,r){return this.guard("Cannot update the convergence root.",{rootId:e.rootId},()=>this.transaction(()=>{let o=this.rootRow(e.rootId);if(!o||o.revision!==t)return!1;let s=JSON.parse(o.root_json);return this.casRoot(e,t)?(e.currentEpoch!==s.currentEpoch&&this.insertEpoch(e,e.updatedAt),r&&this.database.prepare(`
          INSERT INTO convergence_reviews (review_id, root_id, epoch, review_json, reviewed_at)
          VALUES (?, ?, ?, ?, ?)
        `).run(r.reviewId,r.rootId,r.epoch,JSON.stringify(r),r.reviewedAt),!0):!1}))}insertAttemptLease(e,t,r,o){return this.guard("Cannot claim the convergence attempt lease.",{rootId:e.rootId},()=>this.transaction(()=>this.casRoot(e,t)?(this.database.prepare(`
        INSERT INTO convergence_leases (
          lease_id, root_id, root_revision, epoch, ordinal, state, lease_json, proposal_json, issued_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(o.leaseId,o.rootId,o.rootRevision,o.epoch,o.ordinal,o.state,JSON.stringify(o),JSON.stringify(r),o.issuedAt,o.expiresAt),!0):!1),"The convergence database is busy; read status before retrying the lease claim.")}expireAttemptLease(e){return this.guard("Cannot expire the convergence attempt lease.",{leaseId:e},()=>this.transaction(()=>{let t=this.leaseRow(e);if(!t)return!1;let r=JSON.parse(t.lease_json);if(r.state!=="issued")return!1;r.state="expired";let o=this.database.prepare(`
        UPDATE convergence_leases SET state = 'expired', lease_json = ? WHERE lease_id = ? AND state = 'issued'
      `).run(JSON.stringify(r),e);return Number(o.changes)===1}))}getAttemptLease(e){return this.guard("Cannot read the convergence attempt lease.",{leaseId:e},()=>{let t=this.leaseRow(e);if(!t)return null;let r=JSON.parse(t.lease_json),o=JSON.parse(t.proposal_json),s=this.rootRow(r.rootId);return s?{root:JSON.parse(s.root_json),proposal:o,lease:r}:null})}insertGuardedRun(e,t,r,o){return this.guard("Cannot start the guarded workflow run.",{leaseId:t},()=>this.transaction(()=>{let s=this.leaseRow(t);if(!s)return null;let i=JSON.parse(s.lease_json),a=JSON.parse(s.proposal_json);if(i.state!=="issued"||i.rootRevision!==r||Date.parse(i.expiresAt)<=Date.parse(o))return null;let c=this.rootRow(i.rootId);if(!c||c.revision!==r)return null;let u=JSON.parse(c.root_json);i.state="consumed";let R=this.database.prepare(`
        UPDATE convergence_leases SET state = 'consumed', lease_json = ?
        WHERE lease_id = ? AND state = 'issued'
      `).run(JSON.stringify(i),t);return Number(R.changes)!==1||(u.revision+=1,u.updatedAt=o,!this.casRoot(u,r))?null:(this.insertRunRow(e,o),this.database.prepare(`
        INSERT INTO convergence_attempts (
          root_id, epoch, ordinal, lease_id, run_id, state, outcome_json, started_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'running', NULL, ?, ?)
      `).run(u.rootId,i.epoch,i.ordinal,i.leaseId,e.runId,o,o),this.database.prepare(`
        INSERT INTO workflow_attempt_links (run_id, root_id, lease_id, epoch, ordinal)
        VALUES (?, ?, ?, ?, ?)
      `).run(e.runId,u.rootId,i.leaseId,i.epoch,i.ordinal),{root:u,proposal:a,lease:i,outcome:null})}),"The convergence database is busy or the lease was consumed concurrently.")}getGuardedRunBinding(e){return this.guard("Cannot read the guarded workflow binding.",{runId:e},()=>{let t=this.database.prepare("SELECT root_id, lease_id FROM workflow_attempt_links WHERE run_id = ?").get(e);if(!t)return null;let r=this.rootRow(t.root_id),o=this.leaseRow(t.lease_id),s=this.database.prepare("SELECT outcome_json FROM convergence_attempts WHERE run_id = ?").get(e);return!r||!o?null:{root:JSON.parse(r.root_json),proposal:JSON.parse(o.proposal_json),lease:JSON.parse(o.lease_json),outcome:s?.outcome_json?JSON.parse(s.outcome_json):null}})}getGuardedRunSnapshot(e){return this.guard("Cannot read the guarded workflow snapshot.",{runId:e},()=>{let t=this.database.prepare(`
        SELECT r.revision AS run_revision, r.receipt_json, c.revision AS root_revision, c.root_json,
          l.lease_json, l.proposal_json, a.outcome_json
        FROM workflow_runs AS r
        JOIN workflow_attempt_links AS x ON x.run_id = r.run_id
        JOIN convergence_roots AS c ON c.root_id = x.root_id
        JOIN convergence_leases AS l ON l.lease_id = x.lease_id AND l.root_id = x.root_id
        JOIN convergence_attempts AS a ON a.run_id = r.run_id AND a.lease_id = x.lease_id
        WHERE r.run_id = ?
      `).get(e);if(!t)return null;let r=JSON.parse(t.receipt_json),o=JSON.parse(t.root_json);if(r.runId!==e||r.revision!==t.run_revision||o.revision!==t.root_revision)throw new l("INVALID_INPUT","Stored guarded workflow snapshot metadata does not match its payload.",{runId:e});return{receipt:r,guarded:{root:o,proposal:JSON.parse(t.proposal_json),lease:JSON.parse(t.lease_json),outcome:t.outcome_json?JSON.parse(t.outcome_json):null}}})}getPluginUpdateState(e){return this.guard("Cannot read plugin update state.",{targetId:e},()=>this.readPluginUpdateStateRow(e))}putPluginUpdateState(e){this.guard("Cannot persist plugin update state.",{targetId:e.targetId},()=>this.transaction(()=>{let t=de(this.readPluginUpdateStateRow(e.targetId),e);this.database.prepare(`
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
      `).run(t.targetId,t.currentVersion,t.latestVersion,t.latestTag,t.latestCommit,t.etag,t.comparison,t.lastAttemptAt,t.lastSuccessfulCheckAt,t.nextCheckAt,t.lastNotifiedVersion,t.lastNotifiedAt,t.lastErrorCode)}))}claimPluginUpdateNotice(e,t,r){return this.guard("Cannot claim plugin update notice.",{targetId:e,latestVersion:t},()=>this.transaction(()=>{let o=this.readPluginUpdateStateRow(e);if(!o||o.latestVersion!==t||o.lastNotifiedVersion!==null&&V(o.lastNotifiedVersion,t)>=0)return!1;let s=this.database.prepare(`
      UPDATE plugin_update_state
      SET last_notified_version = ?, last_notified_at = ?
      WHERE target_id = ?
        AND latest_version = ?
      `).run(t,r,e,t);return Number(s.changes)===1}))}getSchemaVersion(){return this.database.prepare("PRAGMA user_version").get().user_version}isConvergenceRootActive(e){return!!this.database.prepare(`
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
      `).run(e,t,r);return Number(o.changes)===1})}backupTo(e){if(this.databasePath===":memory:")throw new l("INVALID_INPUT","An in-memory workflow database cannot be cleaned destructively.");this.guard("Cannot create a verified workflow cleanup backup.",{targetPath:e},()=>{this.database.prepare("VACUUM INTO ?").run(e);let t=new pe(e,{readOnly:!0});try{let r=t.prepare("PRAGMA integrity_check").get();if(r.integrity_check!=="ok")throw new Error(`integrity_check returned ${r.integrity_check}`)}finally{t.close()}})}executeCleanup(e){return this.guard("Cannot execute workflow state cleanup.",{},()=>this.transaction(()=>{let t=this.database.prepare(`
        SELECT state, revision, updated_at FROM convergence_roots WHERE root_id = ?
      `),r=this.database.prepare(`
        SELECT state, revision, updated_at FROM workflow_runs WHERE run_id = ?
      `);for(let p of e.roots){let d=t.get(p.rootId);if(!d||d.state!==p.state||d.revision!==p.revision||d.updated_at!==p.updatedAt)throw new l("STALE_REVISION","A cleanup root changed after preview.",{rootId:p.rootId});let m=this.database.prepare(`
          SELECT run_id FROM workflow_attempt_links WHERE root_id = ? ORDER BY run_id
        `).all(p.rootId).map(E=>E.run_id);if(JSON.stringify(m)!==JSON.stringify(p.runIds))throw new l("STALE_REVISION","A cleanup root's linked runs changed after preview.",{rootId:p.rootId})}for(let p of e.standaloneRuns){let d=r.get(p.runId);if(!d||d.state!==p.state||d.revision!==p.revision||d.updated_at!==p.updatedAt)throw new l("STALE_REVISION","A cleanup workflow run changed after preview.",{runId:p.runId})}let o=this.database.prepare("DELETE FROM workflow_attempt_links WHERE root_id = ?"),s=this.database.prepare("DELETE FROM convergence_attempts WHERE root_id = ?"),i=this.database.prepare("DELETE FROM convergence_reviews WHERE root_id = ?"),a=this.database.prepare("DELETE FROM convergence_leases WHERE root_id = ?"),c=this.database.prepare("DELETE FROM convergence_epochs WHERE root_id = ?"),u=this.database.prepare("DELETE FROM convergence_root_identities WHERE root_id = ?"),R=this.database.prepare("DELETE FROM convergence_roots WHERE root_id = ?"),v=this.database.prepare("DELETE FROM workflow_runs WHERE run_id = ?"),I=0;for(let p of e.roots){o.run(p.rootId),s.run(p.rootId),i.run(p.rootId),a.run(p.rootId),c.run(p.rootId),u.run(p.rootId),R.run(p.rootId);for(let d of p.runIds)I+=Number(v.run(d).changes)}for(let p of e.standaloneRuns)I+=Number(v.run(p.runId).changes);return{roots:e.roots.length,runs:I}}))}close(){this.closed||(this.database.close(),this.closed=!0)}initializeSchema(){let e=this.database.prepare("PRAGMA user_version").get();if(e.user_version>G)throw new l("INVALID_INPUT","Workflow database schema is newer than this server supports.",{databasePath:this.databasePath,supportedVersion:G,actualVersion:e.user_version});this.transaction(()=>{e.user_version>0&&e.user_version<4&&this.database.exec(`
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
        PRAGMA user_version = ${G};
      `)})}rootRow(e){return this.database.prepare("SELECT root_json, revision FROM convergence_roots WHERE root_id = ?").get(e)}leaseRow(e){return this.database.prepare("SELECT lease_json, proposal_json FROM convergence_leases WHERE lease_id = ?").get(e)}casRoot(e,t){let r=this.database.prepare(`
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
    `).get(e);return t?{targetId:t.target_id,currentVersion:t.current_version,latestVersion:t.latest_version,latestTag:t.latest_tag,latestCommit:t.latest_commit,etag:t.etag,comparison:t.comparison,lastAttemptAt:t.last_attempt_at,lastSuccessfulCheckAt:t.last_successful_check_at,nextCheckAt:t.next_check_at,lastNotifiedVersion:t.last_notified_version,lastNotifiedAt:t.last_notified_at,lastErrorCode:t.last_error_code}:null}transaction(e,t="BEGIN IMMEDIATE;"){this.database.exec(t);try{let r=e();return this.database.exec("COMMIT;"),r}catch(r){try{this.database.exec("ROLLBACK;")}catch{}throw r}}guard(e,t,r,o){try{return r()}catch(s){throw s instanceof l?s:o&&this.isLeaseContention(s)?new l("LEASE_CONFLICT",o,t):this.storageError(e,s,t)}}isLeaseContention(e){let t=e instanceof Error?e.message:String(e);return/database is locked|SQLITE_BUSY|UNIQUE constraint failed: convergence_leases/iu.test(t)}storageError(e,t,r={}){return new l("INVALID_INPUT",e,{...r,databasePath:this.databasePath,cause:t instanceof Error?t.message:String(t)})}};var qe={haiku:"lightweight",sonnet:"general",opus:"deep",fable:"frontier"},He=/^(?:[a-z]{2,6}(?:-[a-z]{2,4})?\.)?(?:anthropic\.)?claude-(?:\d+(?:-\d+)?-)?(haiku|sonnet|opus|fable)(?:[-@:.]|$)/u;function Ge(n){let e=He.exec(n)?.[1];return e?qe[e]??null:null}var ge={"gpt-6-astra":"frontier","gpt-6-sol":"general","gpt-6-luna":"lightweight","gpt-5.6-sol":"deep","gpt-5.6-terra":"general","gpt-5.6-luna":"lightweight"},je={host:"claude-code",modelClassForModel:Ge},Xe={host:"codex",modelClassForModel:n=>Object.hasOwn(ge,n)?ge[n]:null};function Nt(n,e){let t=new b(n);return{runObserved(r,o,s,i){return ce(t,e,r,o,s,i)},close(){t.close()}}}export{je as claudeCodeExecutionAdapter,Xe as codexExecutionAdapter,ie as hostActorId,Nt as openHostAttestation};
