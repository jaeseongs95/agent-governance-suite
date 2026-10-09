The published test is a portable derivative of the recovered final test, not a newly executed test. Its only change is the output-directory declaration. It reads the SS11 fixture from the original candidate; it does not call model APIs. Do not apply a product patch: no product patch exists.

To reproduce later, use a separate checkout of candidate c6a8019be30e4bf5ee9a36147ca45ae28b0f75b6 (tree 28f2f2ed8a864405320f6d20e7bc5004e8466ad3), Node 24.19.0, pnpm 11.19.0 and the repository's locked dependencies. Copy this file to tests/skill-classification/SS11.isolated.test.ts in that checkout, select an existing writable output directory with SS11_EVIDENCE_DIR, then run from the candidate repository root:

```sh
node scripts/run-tests.mjs tests/skill-classification/SS11.isolated.test.ts --reporter=verbose --reporter=json --outputFile.json="$SS11_EVIDENCE_DIR/vitest-isolated.json"
```

Existing expectation at the frozen candidate: 7 PASS and 1 FAIL; exit 1 at the missing-all-provenance hold assertion (expected mock calls 0; observed 1). No new reproduction was run for this publication. The original argv/cwd/exit are retained as sanitized evidence in isolated.command.json. REPO_ROOT and CASE_ARTIFACTS in historical logs are redaction labels, not executed path values.

The existing shared-gateway regression command was:

```sh
node scripts/run-tests.mjs tests/mcp/skill-classification-gateway.test.ts -t 'preserves original negation, provenance, null and known-empty at the real service boundary'
```

Its recovered result is 1 PASS, 37 skipped, exit 0. It is not an SS11 semantic-host pass. No full suite, historical 21-run batch or bootstrap prepare/run is needed for this case reproduction.
