# bisect Node 24.x for the packaged broker CLI sequence (uses /tmp/wt/n24.21.0 dist; same commit dist as 24.0.0 worktree)
python3 -c "
import json;d=json.load(open('/tmp/ev/scripts/index.json'))
print(' '.join(sorted([x['version'] for x in d if x['version'].startswith('v24.')], key=lambda v: tuple(map(int,v[1:].split('.'))))))" > /tmp/ev/scripts/v24list
read -a L < /tmp/ev/scripts/v24list
test_v() { local V=$1; [ -x /tmp/nodes/node-$V-linux-x64/bin/node ] || /tmp/ev/scripts/install-node.sh $V >/dev/null 2>&1 || { echo "$V INSTALL_FAIL"; return 2; }
  local out; out=$(/tmp/nodes/node-$V-linux-x64/bin/node /tmp/ev/scripts/cli-seq.mjs /tmp/wt/n24.21.0 2>&1)
  if echo "$out" | grep -q '\[status\] status=0' && ! echo "$out" | grep -q ECONNRESET; then echo "$V PASS"; return 0; else echo "$V FAIL"; echo "$out" | grep -E 'status=1|ECONNRESET' | head -3 | sed 's/^/   /'; return 1; fi; }
lo=0; hi=$((${#L[@]}-1)); echo "versions: ${L[*]}"
test_v ${L[$lo]}; test_v ${L[$hi]}
while [ $((hi-lo)) -gt 1 ]; do mid=$(((lo+hi)/2)); if test_v ${L[$mid]}; then hi=$mid; else lo=$mid; fi; done
echo "LAST_FAIL=${L[$lo]} FIRST_PASS=${L[$hi]}"
# confirm neighbours 3x each for determinism
for i in 1 2 3; do test_v ${L[$lo]}; test_v ${L[$hi]}; done
