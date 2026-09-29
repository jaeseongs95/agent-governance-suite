#!/bin/bash
# Runs each tamper case in its own detached worktree under /tmp/ck; original checkout untouched.
. /tmp/ev/scripts/env.sh
SRC=/home/user/agent-governance-suite; C=2b53e325f549a9ebd32a143d1d11f7b4393355fa
OUT=/tmp/ev/23-tamper; mkdir -p $OUT
for case in "$@"; do
  W=/tmp/ck/$case; git -C $SRC worktree add --detach -f $W $C >/dev/null 2>&1 || { echo "$case WORKTREE_FAIL"; continue; }
  ln -s /tmp/cand/node_modules $W/node_modules
  { echo "## case $case"; python3 /tmp/ev/scripts/tamper.py $case $W; echo "## git status"; git -C $W status --porcelain --untracked-files=all | grep -v node_modules; } > $OUT/$case.mutation.log 2>&1
  (cd $W && node scripts/check-skill-context-optimization.mjs > $OUT/$case.cli.json 2> $OUT/$case.cli.stderr; echo $? > $OUT/$case.cli.exit)
  (cd $W && ./node_modules/.bin/vitest run tests/tooling/skill-context-optimization.test.mjs > $OUT/$case.vitest.log 2>&1; echo $? > $OUT/$case.vitest.exit)
  errs=$(node -e 'try{const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(r.pass+" :: "+r.errors.join(" | "))}catch(e){console.log("NO_JSON")}' $OUT/$case.cli.json)
  exc=$(grep -m1 -oE '(Error|ENOENT)[^\n]{0,160}' $OUT/$case.cli.stderr | head -1)
  vt=$(grep -E '^ +Tests ' $OUT/$case.vitest.log | tr -s ' ')
  echo -e "$case\tcli_exit=$(cat $OUT/$case.cli.exit)\tvitest_exit=$(cat $OUT/$case.vitest.exit)\tpass=$errs\texc=$exc\tvitest=$vt"
  git -C $SRC worktree remove --force $W
done
