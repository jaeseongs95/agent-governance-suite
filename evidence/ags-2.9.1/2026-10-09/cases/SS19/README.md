SS19 existing evidence publication for AGS 2.9.1. Publication performs no new tests and no JEV/vendor/Claude/Codex model API calls.

Candidate commit: `c6a8019be30e4bf5ee9a36147ca45ae28b0f75b6`  
Candidate tree: `28f2f2ed8a864405320f6d20e7bc5004e8466ad3`  
Fixture SHA256: `17ade7e27cc11ffee8cc0b7b2070785617861d4c3384448cf24fce75f40d87e9`  
Frozen oracle SHA256: `5db1d67cef8719c40b17b0ab07003f01f765746d34ced0b326e59fadb2efe055`

| Existing execution | Actual outcome |
|---|---|
| Existing SS19/39 OFF regression | 1 PASS / 39 skipped, exit 0 |
| Final isolated SS19 offline tests | 14 PASS / 3 FAIL, exit 1 |
| Frozen variants, 4 SS19 subinputs each | 8/8 PASS in mock plumbing scope |
| Hold boundaries | 6/6 PASS |
| Known defect probes | 3 FAIL: valid cost lost with invalid RESP; timeout overflow; pre-dispatch recheck gap |
| Targeted final test TypeScript check | PASS, exit 0 |
| Sensitivity check-proof | INCOMPLETE, exit 1; red/green NOT_RUN |
| Actual host selected/read/applied/verified | NOTRUN; selected IDs=null, hostReceipt=null |
| Live provider semantic quality / full-case acceptance | NOTRUN; SS19 oracle=null, accuracy=null |

Each existing defect reproduction is linked to its prior root cause; new duplicate root-cause count is 0. All original model API/credential calls were 0. Synthetic qualification, credentials, fixed vendor model and golden-shaped responses test routing/plumbing only. SS09 mock advice [] is distinct from unaccepted host selection null. The package includes only SS19 test work; SS03/04/09/10 are its required subinputs. Full frozen fixture bytes are included solely to preserve the assigned immutable fixture hash.

Use SS19.result.public.json and observations.public.json for actual input/expected/observed evidence. logs/ contains redacted copies of existing captures; original stdout/stderr were merged. No log or receipt is generated as a substitute for a missing original. provenance/missing-originals.json lists MISSING_ORIGINAL records, including the absent external TEST-SPEC document, unretained initial/intermediate source, first unmatched filter capture and HTTP wire capture. Embedded source is retained. No original patch exists; none is fabricated.

Reproduction instructions are in reproduce/commands.md and were not executed for publication. Required live inputs remain approved profile/qualification/model options/route/budget or native allowance and actual host task/selection observations. The default server registers native adapters but no remote vendor wire adapter. No live host inference is made from executable presence or repository inventory.

Privacy/provenance: public derivatives redact local absolute paths and remove the environment instance identifier. Test output-directory default is changed to a relative path in the public test copy. Original artifact bytes/SHA256 and public bytes/SHA256 are separately recorded in manifest.json. Original raw 10MB observation captures and personal conversation are not published; normalized observations deduplicate repeated inventory by reference. The full inventory and all original outcome/null/[] fields remain. Existing initial/intermediate logs are retained separately and never treated as final-source sensitivity proof.

manifest.json lists payload files only; it excludes itself and SHA256SUMS to avoid cyclic hashing. SHA256SUMS covers every payload file plus manifest.json and excludes itself. Its own SHA256 is returned in the publication completion report. Publication success and remote byte verification are reported separately outside this immutable evidence package.
