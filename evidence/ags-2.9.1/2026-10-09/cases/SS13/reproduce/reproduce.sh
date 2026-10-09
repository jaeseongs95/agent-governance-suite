#!/usr/bin/env bash
# Instructions for future SS13-only reproduction. NOT EXECUTED during publication.
set -u
if [ "$#" -ne 2 ]; then
  printf 'Usage: bash reproduce.sh PRODUCT_CHECKOUT OUTPUT_DIRECTORY\n' >&2
  exit 2
fi
ss13_product_root=$(realpath "$1")
ss13_output_root=$(realpath -m "$2")
ss13_script_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
ss13_expected=c6a8019be30e4bf5ee9a36147ca45ae28b0f75b6
if [ "$(git -C "$ss13_product_root" rev-parse HEAD)" != "$ss13_expected" ]; then
  printf 'Refusing another candidate; expected %s\n' "$ss13_expected" >&2
  exit 2
fi
if [ ! -f "$ss13_product_root/node_modules/vitest/vitest.mjs" ]; then
  printf 'Use an already prepared Node 24.19.0/pnpm 11.19.0 product checkout with frozen dependencies.\n' >&2
  exit 2
fi
mkdir -p "$ss13_output_root"
ss13_harness=$(mktemp -d)
trap 'rm -rf -- "$ss13_harness"' EXIT
cp "$ss13_script_root/SS13.test.ts" "$ss13_script_root/vitest.config.mts" "$ss13_harness/"
ln -s "$ss13_product_root/node_modules" "$ss13_harness/node_modules"
export SS13_PRODUCT_ROOT="$ss13_product_root"
export SS13_OUTPUT_ROOT="$ss13_output_root"
cd "$ss13_product_root" || exit 2
node "$ss13_product_root/node_modules/vitest/vitest.mjs" run \
  --config "$ss13_harness/vitest.config.mts" --reporter=verbose --reporter=json \
  --outputFile="$ss13_output_root/recheck.vitest.result.json" > "$ss13_output_root/recheck.combined.log" 2>&1
ss13_exit=$?
printf '%s\n' "$ss13_exit" > "$ss13_output_root/recheck.exit-code.txt"
cat "$ss13_output_root/recheck.combined.log"
exit "$ss13_exit"
