SS19 reproduction guidance only; none of these commands were run during publication.

Check out candidate c6a8019be30e4bf5ee9a36147ca45ae28b0f75b6 (tree 28f2f2ed8a864405320f6d20e7bc5004e8466ad3) separately from evidence. Use Node v24.19.0 and the repository's pnpm 11.19.0 dependencies. Copy reproduce/SS19.test.ts into candidate tests/ss19-dev/SS19.test.ts. It imports product files at that relative location. The public copy changes only the default output directory; original and public hashes are in manifest.json.

```sh
mkdir -p ss19-evidence
node scripts/run-tests.mjs tests/ss19-dev/SS19.test.ts --reporter=verbose --reporter=json --outputFile=ss19-evidence/vitest.json
```

Recorded final outcome: 14 passed / 3 failed, exit 1. Failures reproduce three known defects; this is not whole-case PASS. Public command uses relative output paths; the original exact command is retained only in the private original result, whose bytes/SHA256 are recorded.

Existing regression guidance:
```sh
node scripts/run-tests.mjs tests/mcp/skill-classification-service.test.ts -t 'SS19/39 OFF'
```
Recorded outcome: 1 passed / 39 skipped, exit 0. A prior nonmatching filter executed 0 and remains NOTRUN.

No product patch exists. Do not create host receipts, call live providers, or rerun historic completed qualification runs from this package.
