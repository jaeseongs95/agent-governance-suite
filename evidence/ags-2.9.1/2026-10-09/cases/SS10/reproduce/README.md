# SS10 reproduction instructions — not executed during publication

Use a separate checkout of `jaeseongs95/agent-governance-suite` at commit
`c6a8019be30e4bf5ee9a36147ca45ae28b0f75b6`, tree
`28f2f2ed8a864405320f6d20e7bc5004e8466ad3`. Use Node.js 24.19.0 and
the existing project Vitest 5.0.0 dependencies. No install/build command is
part of the recorded SS10 test execution. Preserve any local work.

Copy this directory's `SS10.test.ts` to
`tests/ss10-isolated/SS10.test.ts` in that separate candidate checkout.
From its repository root, the following is reproduction guidance only:

```sh
mkdir -p tests/ss10-isolated/reproduction-output
node node_modules/vitest/vitest.mjs run tests/ss10-isolated/SS10.test.ts --reporter=verbose --reporter=json --outputFile.json=tests/ss10-isolated/reproduction-output/SS10.vitest.json
```

Expected existing candidate outcome: exit 1, 19 passed and 1 failed out of
20 offline assertions. D01 fails `expected true to be false` because direct
inventory observes isolated unsupported code-review=false but gateway
inventory has no corresponding host-state supply and returns true.
This comparison uses a controlled support list, not an observed live host.
The existing R01 SS10 scorer assertions were extracted from
`tests/skill-classification/evaluation.test.ts:80-83`; no multi-case original
test or full suite was run. Synthetic scorer recommendation arrays are not
provider responses or real AGENT selections.

The public reproduction copy changes only output-directory literals from
private absolute paths to the relative directory above. It has not been
executed. Original and public test bytes/SHA256 are separately in manifest.
The original command and exit are in `logs/SS10.test-exit.public.json` with
private path placeholders. Original stdout/stderr were captured as one
combined stream; the separate originals are unavailable.

Do not run live JEV/vendor/Claude/Codex classification as part of this
reproduction. No reviewed patch exists. Real host selected/read/applied/
verified and provider semantic accuracy remain unexecuted.
