# SS04 reproduction instructions — NOT EXECUTED during publication

These instructions reproduce the original offline checks only. They do not authorize provider-live or host-live calls, production DB migration, another case, or replay of the completed 21-request run.

Use a separate checkout of https://github.com/jaeseongs95/agent-governance-suite at commit `c6a8019be30e4bf5ee9a36147ca45ae28b0f75b6`, tree `28f2f2ed8a864405320f6d20e7bc5004e8466ad3`. Read that checkout's AGENTS.md. Original environment: Node v24.19.0 and existing Vitest 5.0.0 dependencies; matching lock SHA256 `00441d0136cbba033c66eeb94dc1bb194d5d98a5ca0a8a843db326969d74402e`.

The commands below are guidance only; no command in this file was executed during publication. `<publication-root>` means this SS04 evidence directory, not a personal machine path. Install the pinned checkout's frozen dependencies if needed. Place the existing public test at the same relative test location and create its output directory:

```sh
mkdir -p tests/ss04-isolated SS04-output
cp <publication-root>/repro/SS04.test.ts tests/ss04-isolated/SS04.test.ts
node node_modules/vitest/vitest.mjs run tests/skill-classification/evaluation.test.ts -t '^.*reports allowed alternatives as disagreement and unmatched as missing coverage$' --reporter=json --outputFile=SS04-output/existing-regression.json
node node_modules/vitest/vitest.mjs run tests/ss04-isolated/SS04.test.ts --reporter=json --outputFile=SS04-output/isolated-tests.json
```

Expected ORIGINAL recorded results: existing regression exit 0, 1 PASS and 14 skipped; isolated check exit 1, 25 PASS and 2 FAIL (27 total). The two red assertions deliberately preserve the existing invalid-RESP cost-loss and pre-dispatch cancellation-gap findings. A product fix was prohibited in the original task; fixed-green comparison remains NOT_RUN.

The only change made to the existing test for public portability is its evidence destination from a private absolute path to `SS04-output/isolated-observations.json`. No existing assertion or semantic input was changed. Original and public test bytes/SHA256 are in manifest.json. These instructions and the portable copy are not evidence of a rerun.

The fixture lists only `base` for SS04. All additional controls are isolated diagnostic checks, not newly frozen fixture variants. Controlled provider judgments are mock inputs, never real AGENT selections. Exact SS04 originalPrompt bytes are in inputs/originalPrompt.txt (no final newline). TEST-SPEC.seq7.ko.md was absent; only the embedded sourceSpec.fields were used.

Actual host selected/read/applied/verified, actual provider semantics and actual SQLite transition behavior remain NOT_RUN. Repository support path is index.ts -> RuntimeSkillClassificationGateway -> provider runtime -> qualified native vendor adapter. CLI presence does not qualify flags, isolation, model, route or zero cost. Missing approved configuration, central qualified model/profile/route and budget, active host inventory and trusted task/actor observation are preserved in the public result. Do not synthesize host receipts.
