import {it,expect} from 'vitest';
import {build} from 'esbuild';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';

it.each([false,true])('marks loss on exit during close even when record acknowledgement=%s',async acknowledged=>{
  const root=await mkdtemp(path.join(tmpdir(),'ags-logging-close-'));
  await build({entryPoints:[fileURLToPath(new URL('../../mcp-server/src/diagnostics.ts',import.meta.url))],outfile:path.join(root,'diagnostics.mjs'),bundle:true,platform:'node',format:'esm',target:'node24'});
  await writeFile(path.join(root,'diagnostics-worker.mjs'),`process.on('message',m=>{if(m.config)process.send({ready:true});else if(m.close)process.exit(0);else if(${acknowledged}&&m.id)process.send({ack:m.id});});`,'utf8');
  await writeFile(path.join(root,'case.mjs'),`import {createDiagnostics,readDiagnosticConfig} from './diagnostics.mjs';
const log=await createDiagnostics(readDiagnosticConfig(JSON.stringify({level:'INFO',flushDeadlineMs:1000})),new Set(['get_skill_inventory']));
const hold=setTimeout(()=>{throw new Error('READY_TIMEOUT')},2000);await log.ready;clearTimeout(hold);
log.event('request','INFO','request_start',{method:'get_skill_inventory'});await log.close();console.log(JSON.stringify(log.loss));`,'utf8');
  const result=await new Promise<{code:number|null,out:string,err:string}>((resolve,reject)=>{
    const child=spawn(process.execPath,[path.join(root,'case.mjs')],{stdio:['ignore','pipe','pipe'],windowsHide:true});let out='',err='';
    const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('PARENT_EXIT_TIMEOUT'));},3000);
    child.stdout.on('data',data=>{out+=data;});child.stderr.on('data',data=>{err+=data;});child.on('error',reject);child.on('exit',code=>{clearTimeout(timer);resolve({code,out,err});});
  });
  console.log(JSON.stringify({fixture:root,...result}));
  expect(result.code).toBe(0);const loss=JSON.parse(result.out);
  expect(loss.shutdownLossPossible).toBe(true);
  if (acknowledged) {expect(loss.unconfirmedRecords).toBe(0);expect(loss.unconfirmedBytes).toBe(0);}
  else {expect(loss.unconfirmedRecords).toBeGreaterThan(0);expect(loss.unconfirmedBytes).toBeGreaterThan(0);}
});
