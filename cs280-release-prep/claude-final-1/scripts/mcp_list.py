import sys,json,subprocess,os,select,time
srv,out=sys.argv[1],sys.argv[2]
env=dict(os.environ)
p=subprocess.Popen(['node',srv],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=open(out+'.stderr','wb'),env=env,cwd=os.environ['MCP_CWD'])
reqs=[{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"cs2x-final-probe","version":"0"}}},
      {"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}]
resp=[]
for r in reqs:
    p.stdin.write((json.dumps(r)+'\n').encode()); p.stdin.flush()
    deadline=time.time()+30
    while time.time()<deadline:
        line=p.stdout.readline()
        if not line: break
        m=json.loads(line); resp.append(m)
        if m.get('id')==r['id']: break
p.stdin.close(); p.wait(timeout=10)
open(out,'w').write(json.dumps(resp,ensure_ascii=False,indent=1))
tools=[m for m in resp if m.get('id')==2][0]['result']['tools']
init=[m for m in resp if m.get('id')==1][0]['result']
def refs(o):
    if isinstance(o,dict): return sum((1 if k=='$ref' else 0)+refs(v) for k,v in o.items())
    if isinstance(o,list): return sum(refs(v) for v in o)
    return 0
tr=sum(refs(t['inputSchema']) for t in tools)
top=[t['name'] for t in tools if any(k in t['inputSchema'] for k in('oneOf','anyOf','allOf'))]
print(json.dumps({"serverInfo":init.get('serverInfo'),"protocolVersion":init.get('protocolVersion'),"toolCount":len(tools),"refCount":tr,"topLevelCombinatorTools":top,"instructionsHasIntake":"agent-governance-suite 접수 안내" in (init.get('instructions') or ''),"exitCode":p.returncode},ensure_ascii=False,indent=1))
