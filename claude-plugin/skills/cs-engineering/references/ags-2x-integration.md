# AGS 2.8.0 integration — skill 0.2.0 / knowledge pack 0.1.0

Activation remains semantic: compare the request's purpose and behavior with the skill's
application/exclusion conditions. `query-registry.mjs --capability cs-constraint-derivation`
exposes bootstrap 25; execute it before task-contract 30. Bootstrap capabilities are
not executable workflow stages. Request only `cs-implementation-review` in the subsequent
TaskEnvelope.requiredCapabilities. Adding both to that list blocks planning as before.

After deriving READY constraints, freeze the request, constraints and supplied policy,
then construct binding.taskDigest from the final unchanged TaskEnvelope.v1 representation.
Run `validate.mjs handoff --root <private-artifact-root> --binding binding.json --task task.json
--policy policy.json`. Give task-contract and the implementation actor its references,
constraint digest and required obligation IDs. The receiver reruns handoff and reads the
actual conditions. This checks accessibility and frozen data; it does not prove that an
actor received or followed semantic instructions. Do not put structured CS data into
TaskEnvelope strings or add undeclared fields. A changed contract needs a new binding.

For the selected review stage, create a CsStageBundle.v1 JSON object:

```json
{
  "schemaVersion": "1.0.0",
  "binding": {"path": "binding.json", "digest": "sha256:<raw-file-hash>"},
  "task": {"path": "task.json", "digest": "sha256:<raw-file-hash>"},
  "policy": {"path": "policy.json", "digest": "sha256:<raw-file-hash>"},
  "review": {"path": "review.json", "digest": "sha256:<raw-file-hash>"},
  "candidate": {"path": "candidate.json", "digest": "sha256:<raw-file-hash>"}
}
```

Paths are relative to the directory containing this manifest. All files, sources,
candidate files and raw evidence stay inside that private root; symlinks, traversal and
network roots are refused. The root is trusted against concurrent ancestor replacement;
this is a bounded local reader, not an OS sandbox. No candidate code is executed.

Record the normal ProviderResult with the review as output and two verified artifacts:
`cs-review-bundle` points to the absolute local manifest path and its raw byte digest;
`cs-review-report` points to the absolute review file path and its raw byte digest.
Both targetDigest values equal the canonical candidate digest. These existing 2.x artifact
fields introduce no new plan/stage wire fields. Adapter errors remain separately reportable.

WorkflowService validates the bundle through the packaged CLI, compares the actual task
with its signed task digest, validates TaskEnvelope.v1 and compares the complete review
with the provider output. It checks every source/candidate/evidence byte digest, state
mapping, missing/duplicate obligations and candidate/environment consistency. Finalize
rereads the recorded manifest and files, including after a SQLite-backed restart.
FAIL and BLOCKED remain non-passing; observe policy cannot turn them into passed stages.
The policy is supplied data: checking it does not establish its operational authority.

Pass the same review, required obligation IDs and raw evidence to acceptance-evidence-validator
under its existing criteria/evidence contract. Keep security audit and independent audit
responsibilities and model/effort requirements. CS validation does not attest execution
truth or reviewer independence and does not approve release.

The binding first becomes pinned in the recorded stage's artifact references. Before
that point, signed plan, claim, guarded start and resume do not carry a CS binding. The
server does not determine CS applicability, require ponytail inputs conditionally, or
force acceptance criteria to equal CS obligations. Those policy/contract changes remain
explicit follow-up work. An unselected CS stage is not a global acceptance gate.
