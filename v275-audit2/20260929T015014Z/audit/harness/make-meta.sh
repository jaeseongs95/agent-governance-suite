#!/bin/bash
# Writes meta.json for the evidence tree. Args: <evidence audit dir> <start UTC> <redaction counts JSON>
export PATH=/opt/node24/bin:$PATH
d=$1; start=$2; red=${3:-null}
node -e '
const [d,start,red,node,pnpm,uname,end]=process.argv.slice(1);
const meta={audit:"AGS 2.7.5 re-audit (audit2) of the T-2 and I-2 follow-up commits",
 candidate:{branch:"claude/v275-wake-retire",commit:"44235fb5c0fc7efab69c989df4d8eff3975af26f",tree:"790a117efbf2fb41317c1b23e4abcbad58d95373",previousAuditTarget:"3501e7c5fe998a554e8fa3e3ab795b469dccf2e8",previousAuditEvidence:"claude/evidence-v275-audit-20260929T012510Z @ 2e262f0897eaf2eb3b77daa634ba0ab9223e635c"},
 baseline:{ref:"main / tag v2.7.4",commit:"0c8b52d97d1ccdda1768c18422d073d674e2c785"},
 
 writerEvidenceReadForComparisonOnly:"claude/evidence-v275-wake-retire-fix1-20260929T013606Z @ 7e49707b2bab9f759972ab5b601a2a14a95fd0d9",
 previousBrokers:{"v2.7.4":"tag v2.7.4 dist"},
 node, pnpm, uname, startedAtUtc:start, finishedAtUtc:end, verdict:"PASS_WITH_FINDINGS", releaseBlocking:false,
 findings:["T-3 minor: the reserveManagedWake dispatch:false assertion in live-birth-behind-ended holds without any live relay, so it does not isolate the presence cause"],info:["I-3 release-notes wording: 2.7.4 latch on a same-ms tie is permanent only without later activity or a later live birth"],resolved:["T-2 (A6, A2, A4 now killed)","I-1 wording added","I-2 wording added"],
 redaction: red==="null"?null:JSON.parse(red)};
require("fs").writeFileSync(d+"/meta.json", JSON.stringify(meta,null,2)+"\n");
' "$d" "$start" "$red" "$(node --version)" "$(pnpm --version)" "$(uname -r)" "$(date -u +%FT%TZ)"
