#!/bin/bash
# Writes meta.json for the evidence tree. Args: <evidence audit dir> <start UTC> <redaction counts JSON>
export PATH=/opt/node24/bin:$PATH
d=$1; start=$2; red=${3:-null}
node -e '
const [d,start,red,node,pnpm,uname,end]=process.argv.slice(1);
const meta={audit:"AGS 2.7.3 wake-liveness independent audit",
 candidate:{branch:"claude/v273-wake-liveness",commit:"e739090952710d418a67dae71d76b1f2ef169441",tree:"f3bfdf1be77a6e857c595dacb9231402f86974a9"},
 baseline:{ref:"main / tag v2.7.2",commit:"8763cef2b11f2635d6c9af7861b5bffd496e2a30",tree:"eed08f9675246c8519607f7b945dcd4055a14d92"},
 previousBrokers:{"v2.7.2":"tag v2.7.2 mcp-server/dist","v2.7.1":"tag v2.7.1 (d5c5932) mcp-server/dist","v2.2.6":"tag v2.2.6 (863ed7a) mcp-server/dist"},
 implementationEvidenceReadForComparisonOnly:"claude/evidence-v273-wake-liveness-20260928T141526Z @ 534f52bc738c08f238f1f5c972ba5e36f73bdb25",
 node, pnpm, uname, startedAtUtc:start, finishedAtUtc:end, verdict:"ACCEPT_WITH_FINDINGS",
 redaction: red==="null"?null:JSON.parse(red)};
require("fs").writeFileSync(d+"/meta.json", JSON.stringify(meta,null,2)+"\n");
' "$d" "$start" "$red" "$(node --version)" "$(pnpm --version)" "$(uname -a)" "$(date -u +%FT%TZ)"
