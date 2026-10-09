# SS06 retained development evidence

This publication packages existing SS06 evidence only. No new environment, test,
prior 21-request run, provider call, or host run was performed for publication.
No patch file exists. Public reproduction code is a portable derivative and is
**NOT_EXECUTED**; its original 18-check test source digest is in manifest.json.

## Preserved result

- Candidate commit: `c6a8019be30e4bf5ee9a36147ca45ae28b0f75b6`
- Candidate tree: `28f2f2ed8a864405320f6d20e7bc5004e8466ad3`
- Frozen fixture SHA256: `17ade7e27cc11ffee8cc0b7b2070785617861d4c3384448cf24fce75f40d87e9`
- Frozen oracle SHA256: `5db1d67cef8719c40b17b0ab07003f01f765746d34ced0b326e59fadb2efe055`
- Frozen SS06 variants: `base` only. Required recommendation: `test-engineering`
  alone; P/CR/SEC/O forbidden. Parser product/test code writing and execution are
  prohibited by the original prompt. The offline tests exercise classification
  packaging/evaluation, not a date parser.
- Final existing isolated run: **18 PASS, 0 FAIL, exit 0**. Existing regression,
  actual live quality, and host selected/read/applied/verified: **NOTRUN**.
- JEV/external-vendor/Claude calls in the existing task: **0**. JEV/vendor/Claude/
  Codex model API calls and new tests during publication: **0**.
- Known host active-state supply gap reproduced for T; linked to the existing
  finding, **not a new root cause**. This does not establish actual host state.
- First 17-check run: only its historical summary remains in the existing result.
  Its stdout, stderr, Vitest JSON, and exit originals are **MISSING_ORIGINAL**.
  Nothing was recreated or promoted to PASS to replace those missing files.

`SS06.result.public.json` preserves variant input/expected/observed status and
limitations. `SS06.observations.json` contains synthetic controls explicitly;
`SS06.vitest.json`, stdout/stderr and exit are retained final-run artifacts.
Host selections remain null; no receipt was generated. Null and [] are distinct.
`TEST-SPEC.seq7.ko.md` was absent; only embedded SS06 sourceSpec was used.

## Public byte provenance

manifest.json records every payload's public bytes/SHA256 and original artifact
bytes/SHA256, including redaction/portability transformations. The complete
original artifact inventory identifies the omitted local report builder.
Local path substrings are replaced with symbolic placeholders; no credentials,
environment values, personal conversations, or personal local paths are included.
Original result supportingFiles hashes describe ORIGINAL artifacts, not these
public derivatives. Use manifest.json and SHA256SUMS for public file integrity.

`SS06.originalPrompt.utf8.txt` is the exact embedded originalPrompt UTF-8 string,
without a trailing newline; commands.json and manifest.json record its digest.
The frozen fixture/oracle digests retain their original whole-corpus meaning.

SHA256SUMS covers all payload files plus manifest.json; it excludes itself.
manifest.json excludes itself and SHA256SUMS to avoid circular hashing. Remote
verification includes both files separately; their hashes are reported by the
publisher, outside this self-referential package.

## Reproduction instructions — not executed during publication

Use a separate checkout at the candidate commit above, with Node 24.19.0 and
the repository's pnpm 11.19.0 / existing pinned dependencies. Copy this SS06
directory into `evidence/ags-2.9.1/2026-10-09/cases/SS06/` in that candidate
checkout. The evidence branch itself is not the product candidate checkout.
From the candidate checkout root, the command is:

```sh
pnpm exec vitest run --config evidence/ags-2.9.1/2026-10-09/cases/SS06/vitest.config.mjs
```

Only SS06.test.ts is included. Imports/root were made repository-relative;
assertions were preserved. A reproduction writes a separate
SS06.reproduced-observations.json so it cannot replace published observations.
The public derivative has not been executed; it does not add another PASS run.
For package integrity alone, from this published directory:

```sh
sha256sum -c SHA256SUMS
```

## Remaining live inputs

The connected pinned AGS MCP tools, approved classification config and fixed
qualified profile/route/current budget or native allowance, actual Codex hook/
task/actor observations, and host-discovered T availability are missing. Parser
API/behavior/grammar/range/invalid-input/regression examples are also absent;
no date-specific expected outputs were invented. The final selector is AGENT;
classification is support. This package grants no live-call authorization.
