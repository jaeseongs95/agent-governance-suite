# AGS 2.9.1 — SS10 existing offline evidence

This publication packages existing evidence only. No new tests, model calls,
provider calls, or prior 21-case runs were executed. Product source was not
modified. Publication status and test status are separate.

| Existing evidence | Recorded status |
| --- | --- |
| Fixture variant `base` | Only frozen SS10 variant; offline comparison complete |
| Offline Vitest assertions | 19 PASS, 1 FAIL, total 20, exit 1 |
| R01 pre-existing SS10 scorer excerpt | PASS; no other original case executed |
| Added offline structural/scorer controls | 18 PASS, 1 FAIL |
| D01 known host-state supply gap | Reproduced offline; new root-cause count 0 |
| Host selected/read/applied/verified | Each NOT_RUN (original `NOTRUN` spelling retained in JSON) |
| JEV/vendor/model semantic accuracy | NOT_RUN, accuracy null |
| Original paired sensitivity proof | INCOMPLETE; 20 required proofs NOT_RUN |
| Original plan consistency command | READY, exit 0; schema consistency only |
| Original pnpm runner startup | Exit 1 before tests; ENOENT, dependency subprocess exit 254 |
| New tests / JEV / vendor / Claude / Codex calls for publication | 0 / 0 / 0 / 0 / 0 |

SS10 asks for review of a fixed patch, explicitly prohibits implementation
and refactoring, and explicitly does not request a security audit. Expected
recommendation is code-review alone; ponytail and software-security-auditor
are forbidden. Missing patch holds actual review without erasing the
request-type skill need. No patch existed or was fabricated. AGENT makes the
final selection; classifier output is support only. No host receipt was
created. Observed selected=null is preserved and is distinct from an
accepted empty selection `[]`. Oracle allowed=[] is an expected allowance,
not an observed selection.

D01 compares explicitly controlled inventory support with gateway inventory.
It does not assert that the current real host is unsupported or that a live
wrong selection occurred. It links to the existing host-active-state-supply-gap;
other known cost/timeout/concurrency defects were not dynamically tested by
these SS10 controls. This case is not a full-case or release PASS.

Candidate: `c6a8019be30e4bf5ee9a36147ca45ae28b0f75b6` / tree
`28f2f2ed8a864405320f6d20e7bc5004e8466ad3`.
Fixture file SHA256: `17ade7e27cc11ffee8cc0b7b2070785617861d4c3384448cf24fce75f40d87e9`.
Frozen oracle digest: `5db1d67cef8719c40b17b0ab07003f01f765746d34ced0b326e59fadb2efe055`.
The oracle digest is the existing evaluator's projection digest, not the
byte digest of a standalone oracle file. The full frozen fixture is copied
byte-for-byte; the embedded SS10 fixture and exact prompt UTF8 field bytes
are also included. No missing standalone oracle/source document was created.

See `SS10.result.public.json`, `SS10.offline-checks.public.json` and the
existing redacted logs for inputs, expected values, observations and exits.
Reproduction guidance and the unexecuted portable copy of the existing
test are in `reproduce/`. Combined logs remain combined; the pnpm log is an
explicitly labeled excerpt. Raw private local paths are replaced with
placeholders, and full unnecessary runtime stack frames are omitted.
No credentials, environment values, personal conversation or personal data
are included. Generic public skill metadata describes credentials without
containing actual credential values.

Original recovery gaps: standalone TEST-SPEC.seq7.ko.md, reviewed patch,
and separated stdout/stderr streams are MISSING_ORIGINAL. The existing
result/input/test/combined logs/exit artifacts were all recovered and their
original hashes match the previous private checksum inventory. Live host
artifacts were never run; they are NOT_RUN, not missing executed evidence.

`manifest.json` records public payload bytes/SHA256, original bytes/SHA256,
transformations and intentionally omitted originals. It excludes itself and
SHA256SUMS to avoid a cycle. `SHA256SUMS` covers all public payload files and
manifest.json and excludes itself. Their own final byte hashes are reported
by the publication verifier. Public hashes are not substituted for original
request/candidate/snapshot digests embedded in redacted evidence.
