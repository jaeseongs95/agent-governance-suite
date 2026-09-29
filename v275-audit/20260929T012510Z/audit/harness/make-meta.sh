#!/bin/bash
# Writes meta.json for the evidence tree. Args: <evidence audit dir> <start UTC> <redaction counts JSON>
export PATH=/opt/node24/bin:$PATH
d=$1; start=$2; red=${3:-null}
node -e '
const [d,start,red,node,pnpm,uname,end]=process.argv.slice(1);
const meta={audit:"AGS 2.7.5 independent pre-release audit (L1 ended-birth wake retirement, T-1, I-1)",
 candidate:{branch:"claude/v275-wake-retire",commit:"3501e7c5fe998a554e8fa3e3ab795b469dccf2e8",tree:"b8526aebedd80364f684c6113276fb46d43fc96d"},
 baseline:{ref:"main / tag v2.7.4",commit:"0c8b52d97d1ccdda1768c18422d073d674e2c785"},
 
 writerEvidenceReadForComparisonOnly:"claude/evidence-v275-wake-retire-20260929T010538Z @ 757cae05ccd1bd2a5bc00e6cb6c52332df31c128",
 previousBrokers:{"v2.7.4":"tag v2.7.4 dist","v2.7.3":"tag v2.7.3 dist","v2.7.2":"tag v2.7.2 dist","v2.7.1":"tag v2.7.1 dist","v2.2.6":"tag v2.2.6 dist"},
 node, pnpm, uname, startedAtUtc:start, finishedAtUtc:end, verdict:"PASS_WITH_FINDINGS", releaseBlocking:false,
 findings:["T-2 minor: no test pins the writer counterexample (wake birth A live, later birth B ended); mutant A6 survives"],info:["I-1 same-millisecond instance tie","I-2 release notes could name the sleep/resume case"],
 redaction: red==="null"?null:JSON.parse(red)};
require("fs").writeFileSync(d+"/meta.json", JSON.stringify(meta,null,2)+"\n");
' "$d" "$start" "$red" "$(node --version)" "$(pnpm --version)" "$(uname -r)" "$(date -u +%FT%TZ)"
