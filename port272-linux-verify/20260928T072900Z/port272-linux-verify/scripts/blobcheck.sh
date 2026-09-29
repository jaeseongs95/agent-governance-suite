#!/bin/bash
# NUL-safe blob check: every file in each archived install tree vs its git blob id.
C=2b53e325f549a9ebd32a143d1d11f7b4393355fa; G="git -C /tmp/cand"
for spec in "codex:$C" "claude:$C:claude-plugin"; do t=${spec%%:*}; tree=${spec#*:}
  n=0; nsk=0; bad=0
  while IFS= read -r -d '' rec; do meta=${rec%%$'\t'*}; path=${rec#*$'\t'}; set -- $meta; [ "$2" = blob ] || continue
    n=$((n+1)); case "$path" in skills/*) nsk=$((nsk+1));; esac; f="/tmp/inst/$t/$path"
    if [ "$1" = 120000 ]; then h=$(printf %s "$(readlink "$f")" | git hash-object --stdin); else h=$(git hash-object "$f"); fi
    [ "$h" = "$3" ] || { bad=$((bad+1)); echo "MISMATCH $t $path"; }
  done < <($G ls-tree -r -z $tree)
  extra=$(cd /tmp/inst/$t && find . -type f | wc -l)
  echo "$t: git_blobs=$n skills_blobs=$nsk mismatches=$bad files_on_disk=$extra"
done
