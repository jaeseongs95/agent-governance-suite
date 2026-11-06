#!/bin/bash
# Shared settings, sourced by the other scripts. B is the folder these files were uploaded to on the test server.
B=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# The node runtime of the test server (same one the skill-ab harness uses); NODE_BIN overrides it.
NODE_BIN=${NODE_BIN:-/home/mcpops/ags-tests/tester-7452-20261028-r01/runtime/node-v24.22.1-linux-x64/bin}
export PATH="$NODE_BIN:$HOME/.local/bin:$PATH"
# Set CLAUDE_HOOK_EVENTS=1 by prepare.sh when this Claude Code lists --include-hook-events in its help.
[ -f "$B/capabilities.env" ] && . "$B/capabilities.env"
TURN_TIMEOUT=${TURN_TIMEOUT:-600}
CODEX_CONFIG=$HOME/.codex/config.toml

# run_locked <command...>: runs under the shared heavy-run lock when HEAVY_LOCK names one (path is not fixed by this harness).
run_locked() {
  if [ -n "${HEAVY_LOCK:-}" ] && command -v flock > /dev/null; then flock "$HEAVY_LOCK" "$@"; else "$@"; fi
}

# codex_off_flags <arm>: NUL-separated `-c plugins.<name>.enabled=false` for every other AGS plugin the shared config.toml lists.
# The key is written without TOML quotes: with quotes Codex 0.166.0 ignored the override silently (dev guide 6.3).
# A name containing a dot cannot be written that way; it is printed as UNDISABLEABLE:<name> on stderr.
codex_off_flags() {
  local me="agent-governance-suite@ags-cue-$1" name
  [ -f "$CODEX_CONFIG" ] || return 0
  grep -o '^\[plugins\.[^]]*\]' "$CODEX_CONFIG" | sed 's/^\[plugins\.//; s/\]$//; s/"//g' | grep '^agent-governance-suite' | grep -vxF "$me" |
    while read -r name; do
      case $name in
        *.*) echo "UNDISABLEABLE:$name" >&2 ;;
        *) printf '%s\0' -c "plugins.$name.enabled=false" ;;
      esac
    done
}
