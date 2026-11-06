#!/bin/bash
# Puts the shared Codex state back to what it was before the test, touching only what this test made.
#   bash cleanup.sh            dry run: removes leftover ags-cue plugins/marketplaces, then shows the config.toml difference
#   APPLY=1 bash cleanup.sh    also writes the config.toml without this test's [projects."<work folder>..."] sections
# Claude Code needs no cleanup: the plugin was only attached with --plugin-dir.
set -u
. "$(dirname "$0")/lib.sh"
for arm in A B; do
  codex plugin remove "agent-governance-suite@ags-cue-$arm" > /dev/null 2>&1 && echo "plugin ags-cue-$arm was still installed and is removed"
  codex plugin marketplace remove "ags-cue-$arm" > /dev/null 2>&1 && echo "marketplace ags-cue-$arm was still registered and is removed"
done
# Empty cache folders that this test's marketplaces left behind (a folder that existed in the pre snapshot stays).
for arm in A B; do
  d=$HOME/.codex/plugins/cache/ags-cue-$arm
  if [ -d "$d" ] && ! grep -qx "ags-cue-$arm" "$B/snapshots/pre/codex-cache-dirs.txt" 2> /dev/null; then
    if [ -z "$(find "$d" -type f 2> /dev/null | head -1)" ]; then rm -r "$d" && echo "removed empty cache folder $d"; else echo "kept $d (still has files)"; fi
  fi
done
if [ -f "$CODEX_CONFIG" ] && [ -f "$B/snapshots/config.toml.pre-cue-ab" ]; then
  # Drop each [projects."<B>/work/..."] section: from its header to the line before the next header.
  awk -v prefix="[projects.\"$B/work/" '
    /^\[/ { skip = (index($0, prefix) == 1) }
    !skip { print }
  ' "$CODEX_CONFIG" > "$B/snapshots/config.toml.cleaned"
  removed=$(( $(wc -l < "$CODEX_CONFIG") - $(wc -l < "$B/snapshots/config.toml.cleaned") ))
  echo "config.toml: $removed lines belong to this test's [projects] sections"
  if cmp -s "$B/snapshots/config.toml.cleaned" "$B/snapshots/config.toml.pre-cue-ab"; then
    echo "CONFIG_IDENTICAL: after cleaning, config.toml equals the pre-test backup byte for byte"
  else
    echo "CONFIG_DIFFERS from the pre-test backup after cleaning (others may have edited it meanwhile). Difference:"
    diff "$B/snapshots/config.toml.pre-cue-ab" "$B/snapshots/config.toml.cleaned" | grep -E '^[<>] \[' | head -40
  fi
  if [ "${APPLY:-0}" = 1 ]; then cp "$B/snapshots/config.toml.cleaned" "$CODEX_CONFIG" && echo "config.toml rewritten"; else echo "dry run: config.toml not changed (APPLY=1 to write)"; fi
fi
bash "$B/snapshot.sh" post > /dev/null
echo "--- pre vs post (versions.txt excluded; the sha256 differs if config.toml differs) ---"
diff -r -x versions.txt "$B/snapshots/pre" "$B/snapshots/post" && echo "no difference in plugin lists / config headers / cache folders"
echo "work folders and results.jsonl are kept as evidence; delete src-A src-B work/ yourself when the report is written"
