# SS01 existing AGS 2.9.1 development evidence

This directory publishes existing SS01 evidence. Publication ran no tests and made no JEV, vendor, Claude, or Codex model calls. It is not a new qualification run.

Candidate: `c6a8019be30e4bf5ee9a36147ca45ae28b0f75b6`; tree: `28f2f2ed8a864405320f6d20e7bc5004e8466ad3`.
Fixture SHA256: `17ade7e27cc11ffee8cc0b7b2070785617861d4c3384448cf24fce75f40d87e9`.
Frozen oracle SHA256: `5db1d67cef8719c40b17b0ab07003f01f765746d34ced0b326e59fadb2efe055`.

Official variant: `base`. Required recommendation and AGENT selection: `ponytail` only. Lack of an implementation target does not turn this into no-skill. The external `TEST-SPEC.seq7.ko.md` original is **MISSING_ORIGINAL**; only frozen embedded fields were used.

Existing regression: **1 PASS, 14 NOT_RUN (skipped)**, command exit **0**. This was one evaluator guard, not whole-case success.
Existing final isolated run: **20 PASS, 3 FAIL**, command exit **1**, 23 checks. Earlier initial harness errors and corrected 20-check run are explicitly preserved in reports and command history.
Actual provider semantic quality: **NOT_RUN**. Actual host selected/read/applied/verified: **NOT_RUN**; actual selection and host receipt remain `null`. Synthetic labels and signed test observations establish contract behavior only. Formal red/green sensitivity proof remains **INCOMPLETE**; the scope plan was formalized after execution.

The three failures reproduce known root causes, counted once each:

- Independently valid cost `0.1` is lost with invalid RESP: attempt cost `null`, spent `0`.
- Task cancellation during asynchronous acceptance read still permits `valid:true`.
- `timeoutMs=2147483648` overflows to 1ms and times out a synthetic provider delayed by 20ms.

The host installed/supported-state supplier gap was confirmed by source/component comparison; no host-live result is claimed. ON/OFF/key-unavailable/timeout mock transport preserves the original prompt and all 24 skill IDs. Metadata conditional-duplication behavior was not exercised by SS01.

No product patch was created. Original recovery gaps: external `TEST-SPEC.seq7.ko.md`; all locally generated SS01 result, test, command, report, stdout/stderr and observation originals were recovered. Real provider/host observations were never generated and are NOT_RUN, not missing successful receipts.

## Evidence and privacy

`SS01.result.public.json`, `observations.public.json` and reports are explicitly derived public forms. Private absolute paths are replaced with relative paths; duplicated inventory body fields are projected out. Original and public bytes/SHA256 are recorded separately in `original-artifacts.json` and `manifest.json`. No credentials, environment variable values, private conversation, personal local paths, or unnecessary raw archive are published. Zero-length stderr originals are preserved as zero bytes. The prompt file contains exact original UTF-8 bytes with no added newline. `null` and `[]` remain distinct.

`manifest.json` hashes payload files only and excludes itself and `SHA256SUMS`. `SHA256SUMS` hashes payload files and manifest, excluding itself. This avoids a circular digest. Hashes establish packaging integrity, not AGENT execution or oracle correctness.

## Reproduction instructions only — not executed by publisher

Use an isolated scratch folder outside the evidence checkout. Copy `reproduce/SS01.test.ts` and `reproduce/run-SS01.py` into it. Prepare Node 24.19.0 and the existing candidate's pinned dependencies (pnpm 11.19.0, Vitest 5.0.0). Clone the product repository into the scratch folder's `repo/` and detach at the candidate above; install its frozen lockfile only if the operator separately permits preparation. Ensure `repo/node_modules` is populated, and create the scratch folder's `artifacts/` directory.

From that scratch folder, the existing portable runner is:

```sh
python3 run-SS01.py
```

Expected original result: exit `1`, 20 passing and 3 failing checks. The test uses mock provider/signer ports and the actual in-memory MCP transport. It performs no product build, real model call, whole-suite run, or past 21-run replay. The public file is a portability-only derivative; original test SHA is in the manifest. Do not execute the test within the publication checkout.

Actual host verification additionally needs approved classification configuration, current-vendor fixed profile qualification, route/capability/retry/isolation evidence, confirmed budget or native allowance, host discovery state, genuine exact-call signed hook and session-board prompt observation, and separate AGENT/read/applied/verified evidence. None is invented here.
