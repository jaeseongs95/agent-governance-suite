/** Private adapter process helper; deliberately NOT exposed as an MCP shell tool. */
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { clearTimeout, setTimeout } from 'node:timers';
import { TextDecoder } from 'node:util';
import { assert, text, validateSelection } from '../model-routing-core.mjs';
import { geminiArguments, GeminiStreamParser } from './gemini-cli.mjs';
import { GrokAcpParser } from './grok-build.mjs';

export function fileSha256(file){return createHash('sha256').update(readFileSync(file)).digest('hex');}
function within(root,file){const rel=path.relative(root,file);return rel===''||!rel.startsWith(`..${path.sep}`)&&rel!=='..'&&!path.isAbsolute(rel);}
export function validateLaunch(configuration,cwd){
  assert(configuration?.enabled===true,'HEADLESS_OPT_IN_REQUIRED');
  assert(Array.isArray(configuration.reviewedHostVersions)&&configuration.reviewedHostVersions.includes(configuration.hostVersion),'HOST_VERSION_NOT_REVIEWED');
  assert(configuration.approvalBoundary==='enforced'&&configuration.isolation!=='unknown'&&['sandbox','process','remote'].includes(configuration.isolation),'EXECUTION_BOUNDARY_UNKNOWN');
  assert(configuration.authenticationReady===true,'AUTHENTICATION_REQUIRED');
  const executable=realpathSync(configuration.executable),root=realpathSync(configuration.allowedCwd),work=realpathSync(cwd);
  assert(path.isAbsolute(executable)&&statSync(executable).isFile(),'INVALID_EXECUTABLE');
  assert(!/\.(?:cmd|bat|ps1)$/iu.test(executable),'SHELL_LAUNCHER_NOT_SUPPORTED','Use the Node executable and the vendor package entrypoint on Windows');
  assert(fileSha256(executable)===configuration.executableSha256,'EXECUTABLE_DIGEST_MISMATCH');
  assert(statSync(work).isDirectory()&&within(root,work),'CWD_OUTSIDE_APPROVED_ROOT');
  let entrypoint=null;
  if(configuration.entrypoint){entrypoint=realpathSync(configuration.entrypoint);assert(statSync(entrypoint).isFile()&&fileSha256(entrypoint)===configuration.entrypointSha256,'ENTRYPOINT_DIGEST_MISMATCH');}
  const env={};
  assert(Array.isArray(configuration.environmentAllowlist),'ENV_ALLOWLIST_REQUIRED');
  for(const key of configuration.environmentAllowlist){
    assert(/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)&&!['NODE_OPTIONS','NODE_PATH','LD_PRELOAD','LD_LIBRARY_PATH','DYLD_INSERT_LIBRARIES','PYTHONPATH','BASH_ENV','ENV'].includes(key),'UNSAFE_ENVIRONMENT_KEY');
    const value=configuration.environment?.[key];if(value!==undefined){assert(typeof value==='string'&&!value.includes('\0'),'INVALID_ENVIRONMENT');env[key]=value;}
  }
  return {executable,cwd:work,entrypoint,env};
}
/** config comes from the adapter owner, never from a model tool's arguments. */
export async function runBoundedProcess(configuration,argv,{cwd,timeoutMs=60000,maxOutputBytes=4*1024*1024,signal,onEvent=()=>{},onStart=null}={}){
  const launch=validateLaunch(configuration,cwd);
  assert(Array.isArray(argv)&&argv.length<=32&&argv.every(a=>typeof a==='string'&&!a.includes('\0')&&Buffer.byteLength(a,'utf8')<=131072),'INVALID_ARGV');
  assert(Number.isSafeInteger(timeoutMs)&&timeoutMs>=10&&timeoutMs<=3600000,'INVALID_TIMEOUT');
  assert(Number.isSafeInteger(maxOutputBytes)&&maxOutputBytes>=128&&maxOutputBytes<=16*1024*1024,'INVALID_OUTPUT_LIMIT');
  if(signal?.aborted)return {started:false,exitCode:null,signal:null,reason:'cancelled-before-start',protocolCompleted:false,stdoutBytes:0,stderrBytes:0,stdoutDigest:null};
  return await new Promise(resolve=>{
    const child=spawn(launch.executable,[...(launch.entrypoint?[launch.entrypoint]:[]),...argv],{cwd:launch.cwd,env:launch.env,shell:false,windowsHide:true,detached:process.platform!=='win32',stdio:['pipe','pipe','pipe']});
    let buffer='',stdoutBytes=0,stderrBytes=0,reason=null,protocolCompleted=false,started=false,killTimer=null,settled=false;
    const decoder=new TextDecoder('utf-8',{fatal:true}),hash=createHash('sha256');
    function killTree(force=false){
      if(!child.pid)return;
      if(process.platform==='win32'){
        const systemRoot=process.env.SystemRoot;
        if(!systemRoot){reason=reason??'windows-tree-termination-unavailable';return;}
        const killer=path.join(systemRoot,'System32','taskkill.exe');
        const result=spawnSync(killer,['/PID',String(child.pid),'/T','/F'],{shell:false,windowsHide:true,timeout:3000,stdio:'ignore'});
        if(result.error)reason=reason??'windows-tree-termination-unconfirmed';
      }else{try{process.kill(-child.pid,force?'SIGKILL':'SIGTERM');}catch(error){if(error.code!=='ESRCH')reason=reason??'process-tree-termination-unconfirmed';}}
    }
    function terminate(why,complete=false){
      if(protocolCompleted&&!complete){protocolCompleted=false;reason=why;if(killTimer)clearTimeout(killTimer);killTree(true);return;}
      if(reason!==null)return;reason=why;protocolCompleted=complete;
      if(complete){child.stdin.end();killTimer=setTimeout(()=>killTree(true),250);}
      else {killTree();killTimer=setTimeout(()=>killTree(true),250);}
    }
    const timer=setTimeout(()=>terminate('timeout'),timeoutMs);
    const abort=()=>terminate('cancelled');signal?.addEventListener('abort',abort,{once:true});
    const send=object=>{assert(!settled&&!child.stdin.destroyed,'STDIN_CLOSED');const line=JSON.stringify(object);assert(Buffer.byteLength(line,'utf8')<=131072,'RPC_INPUT_LIMIT');child.stdin.write(`${line}\n`);};
    function consume(textChunk,final=false){
      buffer+=textChunk;assert(Buffer.byteLength(buffer,'utf8')<=maxOutputBytes,'STREAM_LINE_LIMIT');
      let newline;
      while((newline=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,newline).replace(/\r$/u,'');buffer=buffer.slice(newline+1);if(line.trim())event(line);}
      if(final&&buffer.trim()){event(buffer);buffer='';}
    }
    function event(line){const value=JSON.parse(line);const response=onEvent(value,send);assert(!response||typeof response.then!=='function','ASYNC_STREAM_HANDLER_UNSUPPORTED');if(response?.complete===true)terminate('protocol-complete',true);}
    child.once('spawn',()=>{started=true;try{if(onStart)onStart(send);else child.stdin.end();}catch{terminate('protocol-start-error');}});
    child.stdout.on('data',chunk=>{hash.update(chunk);stdoutBytes+=chunk.length;if(stdoutBytes+stderrBytes>maxOutputBytes){terminate('output-limit');return;}if(reason!==null&&!protocolCompleted)return;try{consume(decoder.decode(chunk,{stream:true}));}catch{terminate('protocol-error');}});
    child.stderr.on('data',chunk=>{stderrBytes+=chunk.length;if(stdoutBytes+stderrBytes>maxOutputBytes)terminate('output-limit');});
    child.stdin.on('error',()=>{if(!protocolCompleted)terminate('stdin-error');});
    child.once('error',()=>{reason='spawn-error';});
    child.once('close',(code,signalName)=>{
      if(settled)return;settled=true;clearTimeout(timer);if(killTimer)clearTimeout(killTimer);signal?.removeEventListener('abort',abort);
      try{consume(decoder.decode(),true);}catch{reason='protocol-error';protocolCompleted=false;}
      if(reason!==null)killTree(true);
      resolve({started,exitCode:code,signal:signalName,reason,protocolCompleted,stdoutBytes,stderrBytes,stdoutDigest:`sha256:${hash.digest('hex')}`});
    });
  });
}
export async function runGeminiHeadless(configuration,selection,prompt,options){
  assert(configuration.host==='gemini-cli','HOST_MISMATCH');const parser=new GeminiStreamParser();
  const execution=await runBoundedProcess(configuration,geminiArguments(selection,prompt),{...options,onEvent:event=>parser.accept(event)});
  return {execution,result:parser.finish({exitCode:execution.exitCode,aborted:execution.reason!==null})};
}
/** ACP is used because Grok's published streaming-json event fields are not specified. */
export async function runGrokAcp(configuration,selection,prompt,options){
  assert(configuration.host==='grok-build','HOST_MISMATCH');validateSelection(selection);text(prompt,'prompt',65536);
  assert(selection.runtimeMode==='standard'&&selection.nativeReasoning.kind==='not-exposed','GROK_NATIVE_CONTROL_NOT_DOCUMENTED');
  const parser=new GrokAcpParser();let next=0;const methods=new Map();
  const execution=await runBoundedProcess(configuration,['--no-auto-update',`--model=${selection.model}`,'agent','stdio'],{...options,
    onStart(send){const id=++next;parser.sent(id,'initialize');methods.set(id,'initialize');send({jsonrpc:'2.0',id,method:'initialize',params:{protocolVersion:1,clientCapabilities:{fs:{readTextFile:false,writeTextFile:false},terminal:false}}});},
    onEvent(event,send){
      const result=parser.accept(event);
      if(result.denyRequest){send(result.denyRequest);return;}
      if(result.error)throw new Error('Grok ACP error');
      if(result.notification)return;
      const previous=methods.get(result.id);
      let method,params;
      if(previous==='initialize'){
        const available=new Set((result.result.authMethods??[]).map(x=>x.id));
        const preferred=selection.accessPath==='api'?'xai.api_key':'cached_token';
        assert(available.has(preferred),'AUTHENTICATION_PATH_UNAVAILABLE');method='authenticate';params={methodId:preferred,_meta:{headless:true}};
      }else if(previous==='authenticate'){method='session/new';params={cwd:options.cwd,mcpServers:[]};}
      else if(previous==='session/new'){method='session/prompt';params={sessionId:parser.sessionId,prompt:[{type:'text',text:prompt}]};}
      else if(previous==='session/prompt')return {complete:true};
      else throw new Error('Unexpected ACP response');
      const id=++next;parser.sent(id,method);methods.set(id,method);send({jsonrpc:'2.0',id,method,params});
    }});
  const result=parser.finish({exitCode:execution.exitCode,aborted:execution.reason!==null&&!execution.protocolCompleted,transportClosedByClient:execution.protocolCompleted});
  return {execution,result};
}
