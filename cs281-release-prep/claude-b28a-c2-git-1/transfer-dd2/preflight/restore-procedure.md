# Restore procedure (not executed, not tested)
If the published folder must be withdrawn: create a new commit on top of the evidence tip that removes cs281-release-prep/claude-b28a-1/ and push it as a normal fast-forward. History keeps the published blobs; removing them from history would need a force push, which is prohibited, so publication is accepted as irreversible.
Pre-push state: refs/heads/evidence = 023097dfe99e0c99b89dcaab30a7418eb51c59f0 (remains reachable as parent).
