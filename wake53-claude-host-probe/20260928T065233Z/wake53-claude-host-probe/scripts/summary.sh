for n in 07-run-a 08-run-b 09-run-c 10-run-d 11-run-e 12-run-d2; do
  f=/tmp/ev/$n.log
  hr=$(grep -c '"hook_response"' $f)
  sk=$(grep -o '"name":"Skill","input":{"skill":"[^"]*"' $f | sed 's/.*"skill":"//;s/"$//' | tr '\n' ',')
  ac=$(grep -c 'additionalContext' $f)
  echo "$n hook_responses=$hr skills=[$sk] additionalContext_lines=$ac $(tail -1 $f) stderr_bytes=$(wc -c < /tmp/ev/$n.stderr.log)"
done
