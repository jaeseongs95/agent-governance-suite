#!/bin/bash
# Writes meta.json for the evidence tree. Args: <evidence audit dir> <start UTC> <redaction counts JSON>
export PATH=/opt/node24/bin:$PATH
d=$1; start=$2; red=${3:-null}
node -e '
const [d,start,red,node,pnpm,uname,end]=process.argv.slice(1);
const meta={audit:"AGS 2.7.6 independent pre-release audit (L2 board presence lookup deadline, T-4 fixture transaction)",
 candidate:{branch:"claude/v276-presence-deadline",commit:"93a7e4bc69f556859bc929af1df871dfc74eae68",tree:"90ec390cc6dffdcf34e52960103f71e883833907"},
 baseline:{ref:"main / tag v2.7.5",commit:"3706167d4646c53c8b47510eebda58931cbd1cfe"},
 writerEvidenceReadForComparisonOnly:"evidence @ 4a0bf82a196ea2c4d93f589163a2ac4e05fc2fe8 : v276-presence/20260929T030842Z",
 previousBrokers:{"v2.7.5":"tag v2.7.5 dist","v2.7.4":"tag v2.7.4 dist","v2.7.3":"tag v2.7.3 dist"},
 node, pnpm, uname, startedAtUtc:start, finishedAtUtc:end, verdict:"PASS_WITH_FINDINGS", releaseBlocking:false,
 findings:["L2-1 minor: listPresence deadline uses the wall clock (Date.now); a clock step back lengthens the lookup by the step (probe: 60 s back, 11 -> 43 requests)","T-5 minor: previous-broker retired-row branch is chosen by observed state, not bound to broker version >= 2.7.5"],
 info:["I-4 pre-existing: a batch slower than the 2.5 s per-attempt cap ends the lookup at about 5.5 s with all unknown (same on 3706167d)","I-6 real slow broker test: observed overrun <= 3 ms against the 2 s margin, low flake risk","I-7 writer evidence commit 298ac88 carried the account name before 4a0bf82 masked it; history keeps it"],
 redaction: red==="null"?null:JSON.parse(red)};
require("fs").writeFileSync(d+"/meta.json", JSON.stringify(meta,null,2)+"\n");
' "$d" "$start" "$red" "$(node --version)" "$(pnpm --version)" "$(uname -r)" "$(date -u +%FT%TZ)"
