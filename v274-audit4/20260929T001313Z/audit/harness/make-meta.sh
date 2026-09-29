#!/bin/bash
# Writes meta.json for the evidence tree. Args: <evidence audit dir> <start UTC> <redaction counts JSON>
export PATH=/opt/node24/bin:$PATH
d=$1; start=$2; red=${3:-null}
node -e '
const [d,start,red,node,pnpm,uname,end]=process.argv.slice(1);
const meta={audit:"AGS 2.7.4 re-audit 4 (windows-latest CI test fix)",
 candidate:{branch:"claude/v274-presence",commit:"b31da7789b3f48c548c24d6fb5a6f0b7bfa63f2c",tree:"c846c249dd216ae9115bcbd8c10dd6e915ebd6b0"},
 previousTarget:{commit:"0135326a921cccc7b49b0ad8b605e87893631804",verdict:"PASS",evidence:"claude/evidence-v274-audit3-20260928T233533Z @ 5c758fe"},
 failingCi:{run:36499856828,job:"Node 24 / windows-latest (109187863303)",head:"0135326a",conclusion:"failure"},
 writerEvidenceReadForComparisonOnly:"claude/evidence-v274-presence-fix4-20260928T235902Z @ cb0a9df5276a98722b3aa4cf4db19f10fbc6859a",
 previousBrokers:{"v2.7.3":"tag v2.7.3 mcp-server/dist/session-message-broker.mjs","v2.7.2":"tag v2.7.2 mcp-server/dist/session-message-broker.mjs"},
 node, pnpm, uname, startedAtUtc:start, finishedAtUtc:end, verdict:"PASS_WITH_FINDINGS", releaseBlocking:false,
 findings:["T-1 minor: session-message.test.ts packaged hook test also relies on the 20 s presence lease (outside requested scope)"],
 redaction: red==="null"?null:JSON.parse(red)};
require("fs").writeFileSync(d+"/meta.json", JSON.stringify(meta,null,2)+"\n");
' "$d" "$start" "$red" "$(node --version)" "$(pnpm --version)" "$(uname -r)" "$(date -u +%FT%TZ)"
