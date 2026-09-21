// Test process only. Never calls a vendor, authenticates an account or reads user files.
import {createInterface} from 'node:readline';
import {setInterval} from 'node:timers';
const out=x=>process.stdout.write(`${JSON.stringify(x)}\n`);
const mode=process.env.FIXTURE_MODE;
if(mode==='gemini'){
 out({type:'init',session_id:'fixture-session',model:'gemini-2.5-flash-lite'});
 out({type:'message',role:'assistant',content:'한국어 정정 반영'});
 out({type:'result',status:'success',stats:{models:{'gemini-2.5-flash-lite':{input:1,output:1}}}});
}else if(mode==='broken'){process.stdout.write('not json\n');}
else if(mode==='timeout'){setInterval(()=>{},1000);}
else if(mode==='output'){process.stdout.write('x'.repeat(20000));}
else if(mode==='invalid-utf8'){process.stdout.write(Buffer.from([0xff,0x0a]));}
else if(mode==='split-utf8'){
 const bytes=Buffer.from(JSON.stringify({text:'한글🙂'})+'\n');for(const byte of bytes)process.stdout.write(Buffer.from([byte]));
}else if(mode==='argv'){out({argv:process.argv.slice(2),unsafe:process.env.NODE_OPTIONS??null});}
else if(mode==='acp'||mode==='acp-error'||mode==='acp-late-broken'){
 const input=createInterface({input:process.stdin});
 input.on('line',line=>{const q=JSON.parse(line);if(q.method==='initialize')out({jsonrpc:'2.0',id:q.id,result:{protocolVersion:1,authMethods:[{id:'cached_token'},{id:'xai.api_key'}]}});
 else if(q.method==='authenticate')out({jsonrpc:'2.0',id:q.id,result:{}});
 else if(q.method==='session/new')out({jsonrpc:'2.0',id:q.id,result:{sessionId:'grok-fixture-session'}});
 else if(q.method==='session/prompt'){
   out({jsonrpc:'2.0',method:'session/update',params:{sessionId:'grok-fixture-session',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'완료'}}}});
   if(mode==='acp-error')out({jsonrpc:'2.0',id:q.id,error:{code:-32000,message:'fixture failure'}});
   else out({jsonrpc:'2.0',id:q.id,result:{stopReason:'end_turn'}});
   if(mode==='acp-late-broken')process.stdout.write('broken after terminal\n');
 }});
}else {throw new Error('fixture mode not configured');}
