# Reproduction instructions only — NOT EXECUTED during publication

The recorded original command was run in the pinned product checkout:

```sh
node scripts/run-tests.mjs tests/skill-classification/ss33-isolated.test.ts
```

Its original final exit was 1 (13 PASS / 3 FAIL). The SS33-only existing regression command was:

```sh
node scripts/run-tests.mjs tests/mcp/skill-classification-service.test.ts tests/mcp/skill-classification-runtime.test.ts -t SS33
```

Its original exit was 0 (9 PASS / 36 SKIPPED); this does not imply whole-case PASS.

For a future explicitly authorized reproduction, use an isolated checkout of product commit `c6a8019be30e4bf5ee9a36147ca45ae28b0f75b6`; retain Node 24.19.0, pnpm 11.19.0, and the recorded lockfile SHA. First verify product commit/tree, fixture bytes and oracle digest. Obtain dependencies under the applicable environment policy; dependency installation is not qualification evidence.

Copy `repro/tests/skill-classification/ss33-isolated.test.ts` from this evidence package to `tests/skill-classification/ss33-isolated.test.ts` in that isolated product checkout. Copy `inputs/input-fixtures.json` to a dedicated disposable evidence output directory. From the product root, point `SS33_EVIDENCE_ROOT` at that directory and run the original SS33 command above. This environment variable contains a directory path only, not a credential. The test writes `isolated-observations.json` there. The public default was changed to `process.cwd()` only to remove the original private path.

The public synthetic marker and public test bytes differ from the executed originals. They are documented substitutes, not a claim that these exact bytes were previously executed. Use manifest original/public bytes and SHA256 to distinguish them. No secret/key, external API, host CLI, selection receipt, bootstrap 21-case run, source fix, or full-suite run is needed by this diagnostic test. All provider transports are mock ports or supplied mock fetch functions. Do not use this instruction to rerun past live runs.

Initial logs are historical evidence of a smaller test file and a different prior-spend counterexample; do not treat the final public test as the initial executed input or combine initial/final into a red/green proof.

Hash check for the published package (not a test run): from the SS33 package directory, use `sha256sum -c SHA256SUMS`. manifest does not self-hash; SHA256SUMS excludes itself. Remote bytes were checked by the publisher after push and the verification record was returned separately.
