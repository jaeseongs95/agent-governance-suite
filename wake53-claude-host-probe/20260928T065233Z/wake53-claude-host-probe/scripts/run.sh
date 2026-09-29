#!/bin/bash
# usage: run.sh <logname> <prompt>
export PATH=/tmp/node24/bin:$PATH
LOG=/tmp/ev/$1.log
cd /tmp/scratch
timeout 600 claude -p --plugin-dir /home/user/agent-governance-suite/claude-plugin --output-format stream-json --verbose --max-turns 6 "$2" < /dev/null > "$LOG" 2> "/tmp/ev/$1.stderr.log"
echo "EXIT=$?" >> "$LOG"
