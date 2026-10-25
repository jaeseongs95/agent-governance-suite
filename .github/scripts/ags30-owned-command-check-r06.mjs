import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url));
const owner=process.argv[2];
const subreaper=process.argv[3];
const output=process.argv[4];await fs.mkdir(output);
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function run(args, cancel=false) {
  const child=spawn('python',['-B',owner,subreaper,process.execPath,...args],{shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
  const closed=new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',(code,signal)=>resolve({code,signal,stdout,stderr}));});
  if(cancel){
    for(let i=0;i<100;i++) {try {JSON.parse(await fs.readFile(path.join(output,'owned-pids.json'),'utf8'));break;}catch{} await delay(30);}
    child.kill('SIGTERM');
  }
  const guard=setTimeout(()=>child.kill('SIGKILL'),15000);
  try{return await closed;}finally{clearTimeout(guard);}
}
const results=[];
const expected=['a b','한글','quote"value','tail\\'];
let r=await run(['-e','console.log(JSON.stringify(process.argv.slice(1)))',...expected]);
assert.equal(r.code,0,r.stderr);assert.deepEqual(JSON.parse(r.stdout),expected);results.push('argv-and-success');
r=await run(['-e','process.exit(7)']);assert.equal(r.code,7,r.stderr);results.push('failure-code-preserved');
const sentinel=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});
const sentinelClosed=new Promise(resolve=>sentinel.on('close',resolve));
try {
  const file=path.join(output,'owned-pids.json');
  const code='const{spawn}=require("node:child_process");const c=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore",detached:true});require("node:fs").writeFileSync('+JSON.stringify(file)+',JSON.stringify({parent:process.pid,grandchild:c.pid}));setInterval(()=>{},1000);';
  r=await run(['-e',code],true);
  assert.notEqual(r.code,0);const pids=JSON.parse(await fs.readFile(file,'utf8'));
  await delay(300);
  for(const pid of Object.values(pids))assert.throws(()=>process.kill(pid,0),e=>e.code==='ESRCH','Invocation descendant survived');
  assert.equal(process.kill(sentinel.pid,0),true);results.push('cancel-reclaims-detached-descendants-and-preserves-outsider');
}finally{sentinel.kill();await sentinelClosed;}
const result={status:'PASS',platform:process.platform,node:process.version,scope:'SYNTHETIC_INVOCATION_LIFETIME',githubRunId:process.env.GITHUB_RUN_ID??null,checks:results};
await fs.writeFile(path.join(output,'OWNED-COMMAND-CHECK.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(result));
