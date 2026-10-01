# Independent AGS results — 2026-10-02 KST

This is an evidence-only results branch based on integration commit `a7c049d5de392651b102840cb7e75243e1afe317`. The work occurred on 2026-10-01 UTC / 2026-10-02 KST. It does not modify product source, generated bundles, canonical task state, or release state.

Read [the review and limits](ags-review-evidence/README.md), [commands](ags-review-evidence/commands.txt), and [artifact manifest](ags-review-evidence/manifest.json).

The exact additional W05 source snapshot examined was `247cfe3a6b6ba0ee4b38b2168930caf2000b3540`. It is not claimed to be the unacquired frozen candidate `fa68c3acd7a7bdcf7a517ab998e2be364268f76a`. Initial failures and reruns are both retained. Passing isolated source tests do not establish packaged-runtime coherence, installed-host behavior, or release qualification.

Only public AGS source-derived findings and sanitized synthetic test evidence are included. References to VM-owned contracts describe public AGS contract files; no private VM repository material is included.

## Reproduction layout

The recorded commands use a disposable workspace containing `ags-review` (the exact integration checkout), `ags-review-r3` (the exact additional snapshot), and this directory copied as `ags-review-evidence`. Set `REVIEW_ROOT` to that parent directory. Restore the locked dependencies as recorded, and run bundle freshness checks before any build. The report probes use synthetic temporary stores; do not point them at operational databases.

Evidence publication is not task acceptance, source integration, approval-authority implementation, or release approval.
