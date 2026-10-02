# W05 evidence publication

This independent results branch publishes only files under artifacts/verification/w05/20261002-0f1e949d. It preserves the completed bounded campaign and the HOLD verdict. No tests were rerun, source fixes made, generated product paths updated, or release qualification asserted during publication.

The evidence commit has the already-public source snapshot 0f1e949d4ca57fe3cc9aac98767d5c0dade79c61 as its direct parent. That source snapshot tree is 78c4eddb528d851cff295cba2891c2148221a3f1. The generated shipment represented by the patch and archive is a different tree: 56aaea2a1b0509b6d9f9b428228619ded640dc1a. The evidence commit's own tree also differs because it adds this artifact directory; it is neither source qualification nor shipment integration.

Only the public source snapshot was used as ancestry. No private ancestry was fetched or supplied for this publication. Main, source branches, shared evidence refs and previous campaign worktrees are not updated.

[Report](REPORT.md), [source25 comparison](source25-comparison.json), [observed22 closure](generated-closure.json), [reconstruction patch](generated-actual22.patch), [generated archive](generated-actual22.tar), [shipment inventory](shipment-tree-files.json), [complete root copy](codex-complete-copied-installation.json), and [complete Claude copy](claude-code-complete-copied-installation.json) are included. The initial [161-pass/1-fail log](09-scoped-tests.stdout) and [failure detail](09-scoped-tests.stderr) remain separate from all three isolated reruns (13,14,15), each 1 pass/8 skipped. The initial failed suite is not promoted to PASS.

Remaining blockers already read back to the lead are queued/held failure classification and the missing exact expected 15 manifest. Actual generation changed 22 files: 11 root and 11 Claude, totaling 11,001,114 bytes, all observed Git modes 100644. See the report's full 22-row path/byte/SHA table. No membership of an expected 15 set is inferred from filenames or counts. Native installed-host acceptance and release remain outside this evidence.

The frozen campaign metadata records its earlier pre-publication status. campaign-REPORT.md and campaign-transport-manifest.json preserve the reviewed transport snapshot. manifest.json covers the exact published files. sanitization.json records hashes and normalization; raw logs retain synthetic outcomes and timings while private absolute paths use placeholders. Personal credentials, native messages/transcripts/DBs and operating receipts are not published. Generated patch/tar bytes are unchanged from the campaign.

Publication whitespace preflight flags only preserved trailing blank lines in raw logs and blank context markers in the byte-exact reconstruction patch. Those evidence bytes are retained intentionally. The whitespace check passes for all other staged files; the earlier campaign product diff check remains its separate step18 PASS.
