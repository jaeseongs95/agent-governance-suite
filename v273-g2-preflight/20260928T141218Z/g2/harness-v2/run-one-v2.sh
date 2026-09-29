#!/bin/bash
# usage: run-one-v2.sh <seq> <run_id> <arm> <prompt>; retries infra failures (API 429/5xx, no result) up to 3 times with backoff
SEQ=$1; RID=$2; ARM=$3; PID=$4
echo "$(date -u +%FT%TZ) start seq=$SEQ $RID" >> /tmp/ev/runs/driver-events.log
for att in 0 1 2 3; do
  /tmp/ev/scripts-v2/nl-ab-v2.sh "$RID" "$ARM" "$PID" >> /tmp/ev/runs/driver-events.log 2>&1
  D=/tmp/ev/runs/$RID
  infra=$(node -e '
    const fs=require("fs");const d=process.argv[1];let a={};try{a=JSON.parse(fs.readFileSync(d+"/analysis.json","utf8"))}catch{console.log("no-analysis");process.exit()}
    const t=(a.result?.text||"")+" "+(a.apiErrors||[]).join(" ")+" "+fs.readFileSync(d+"/stderr.log","utf8").slice(-2000);
    if(!a.result) console.log("no-result");
    else if(a.result.is_error && /(API Error|overloaded|rate.?limit|\b429\b|\b5\d\d\b|ECONNRESET|ETIMEDOUT|socket hang up)/i.test(t)) console.log("api-error");
    else console.log("ok");' "$D")
  echo "$(date -u +%FT%TZ) seq=$SEQ $RID attempt=$att infra=$infra" >> /tmp/ev/runs/driver-events.log
  [ "$infra" = ok ] && break
  [ $att -lt 3 ] && { mv "$D" "$D.infra-attempt$att"; sleep $((30 * 2**att)); }
done
