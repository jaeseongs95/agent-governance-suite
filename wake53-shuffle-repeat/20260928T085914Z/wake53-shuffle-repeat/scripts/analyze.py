# Aggregates all vitest JSON reports in /tmp/ev/runs: per-run matrix, per-test status set, timing margin vs 30s testTimeout.
import json,glob,re,collections,os
rows=[];stat=collections.defaultdict(lambda: collections.Counter());dur=collections.defaultdict(list)
for f in sorted(glob.glob('/tmp/ev/runs/*.json')):
    L=os.path.basename(f)[:-5]; m=re.match(r'(full|wake)-v(\d+)-(?:(normal|cpu1stress|cpu1|stress)-)?s(\d+)',L)
    kind,tree,cond,seed=m.group(1),m.group(2),m.group(3) or 'normal',m.group(4)
    d=json.load(open(f))
    wall=(max(t["endTime"] for t in d["testResults"])-d["startTime"])/1000
    rows.append((kind,tree,cond,seed,d["numTotalTests"],d["numPassedTests"],d["numFailedTests"],d["numPendingTests"]+d["numTodoTests"],round(wall,1)))
    for t in d["testResults"]:
        fn=t["name"].split(f"/tmp/v{tree}/")[-1]
        for a in t["assertionResults"]:
            k=(tree,fn,a["fullName"]); stat[k][(cond,a["status"])]+=1
            if a.get("duration") is not None: dur[k].append((a["duration"],cond,kind,seed))
json.dump(rows,open('/tmp/ev/matrix.json','w'),indent=0)
print("runs",len(rows))
g=collections.defaultdict(list)
for r in rows: g[(r[0],r[1],r[2])].append(r)
for k,v in sorted(g.items()):
    print(k,"n=",len(v),"totals",sorted({(x[4],x[5],x[6],x[7]) for x in v}),"wall min/max",min(x[8] for x in v),max(x[8] for x in v))
changed=[(k,c) for k,c in stat.items() if len({s for (_,s) in c})>1]
print("tests with >1 status:",len(changed))
for k,c in changed: print(" ",k,dict(c))
print("slowest tests (max duration, ms) top 15:")
for k,v in sorted(dur.items(),key=lambda kv:-max(kv[1])[0])[:15]:
    mx=max(v); print("  %8.0f %s cond=%s kind=%s seed=%s | %s :: %s"%(mx[0],'v'+k[0],mx[1],mx[2],mx[3],k[1],k[2]))
