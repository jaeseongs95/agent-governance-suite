#!/bin/bash
# Records the shared plugin state before or after the test: snapshot.sh <label>  (labels used: pre, post)
# Only names, headers and a hash are written. No setting value of config.toml is copied.
set -u
. "$(dirname "$0")/lib.sh"
label=$1
D=$B/snapshots/$label
mkdir -p "$D"
{ echo "claude: $(claude --version 2>&1 | head -1)"; echo "codex: $(codex --version 2>&1 | head -1)"; echo "node: $(node --version)"; echo "LANG=${LANG:-}"; echo "AGENT_GOVERNANCE_LOCALE=${AGENT_GOVERNANCE_LOCALE:-<unset>}"; } > "$D/versions.txt"
codex plugin marketplace list > "$D/codex-marketplaces.txt" 2>&1
claude plugin list > "$D/claude-plugins.txt" 2>&1
if [ -f "$CODEX_CONFIG" ]; then
  grep -n -A1 '^\[plugins\.' "$CODEX_CONFIG" | grep -E '^\S*[0-9]+[:-](\[plugins\.|enabled)' > "$D/codex-config-plugins.txt"
  grep '^\[projects\.' "$CODEX_CONFIG" | sort > "$D/codex-config-projects.txt"
  sha256sum "$CODEX_CONFIG" | cut -d' ' -f1 > "$D/codex-config.sha256"
  # The backup is made once, before the first run. A later `pre` snapshot never overwrites it.
  [ "$label" = pre ] && [ ! -e "$B/snapshots/config.toml.pre-cue-ab" ] && cp -p "$CODEX_CONFIG" "$B/snapshots/config.toml.pre-cue-ab"
else
  echo "no config.toml" > "$D/codex-config-plugins.txt"
fi
ls -1 "$HOME/.codex/plugins/cache" > "$D/codex-cache-dirs.txt" 2>&1
echo "snapshot $label written to $D"
