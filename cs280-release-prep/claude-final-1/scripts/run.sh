#!/bin/bash
# usage: run.sh <name> <cwd> -- argv...
source /root/cs2x-final-20261006T054615Z/env.sh
name=$1; cwd=$2; shift 3
L=$ST/out/logs; mkdir -p $L
seqf=$ST/.seq; seq=$(( $(cat $seqf 2>/dev/null || echo 0) + 1 )); echo $seq > $seqf
p=$(printf '%02d' $seq)-$name
st(){ (cd /home/user/repo && echo "$(git rev-parse HEAD) $(git rev-parse HEAD^{tree}) $(git status --porcelain --untracked-files=all | wc -l)"); }
pre=$(st); s=$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)
(cd "$cwd" && "$@") > $L/$p.stdout 2> $L/$p.stderr; ec=$?
e=$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ); post=$(st)
python3 - "$seq" "$name" "$cwd" "$s" "$e" "$ec" "$L/$p.stdout" "$L/$p.stderr" "$pre" "$post" "$@" >> $ST/out/commands.jsonl <<'PY'
import sys,json,hashlib
a=sys.argv[1:]
h=lambda f:hashlib.sha256(open(f,'rb').read()).hexdigest()
sp=lambda x:dict(zip(['head','tree','dirty'],[x.split()[0],x.split()[1],int(x.split()[2])]))
print(json.dumps({"seq":int(a[0]),"name":a[1],"argv":a[10:],"cwd":a[2],"startUtc":a[3],"endUtc":a[4],"exitCode":int(a[5]),"stdout":a[6].split('/out/')[1],"stderr":a[7].split('/out/')[1],"stdoutSha256":h(a[6]),"stderrSha256":h(a[7]),"pre":sp(a[8]),"post":sp(a[9])}))
PY
echo "[$p] exit=$ec pre=($pre) post=($post)"
exit $ec
