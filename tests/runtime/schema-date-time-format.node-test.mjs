import assert from "node:assert/strict";
import test from "node:test";

import { validateReport } from "../../skills/codex-token-usage-analyzer/scripts/schema-validation.mjs";
import { validateMutationIntent } from "../../skills/mutation-risk-preflight/scripts/schema-validation.mjs";
import { validateWorkspaceProfile } from "../../skills/workspace-convention-profiler/scripts/schema-validation.mjs";

const VALID = ["2026-10-25T00:00:00Z", "2026-10-25T09:00:00.123+09:00"];
const INVALID = ["1", "2026", "Oct 25", "2026-10-25", "2026-10-25 00:00:00", "2026-02-30T00:00:00Z"];

const cases = [
  { name: "workspace-convention-profiler", validate: validateWorkspaceProfile, path: "/observedAt", build: (value) => ({ observedAt: value }) },
  { name: "mutation-risk-preflight", validate: validateMutationIntent, path: "/approvalEvidenceRefs/0/expiresAt", build: (value) => ({ approvalEvidenceRefs: [{ expiresAt: value }] }) },
  { name: "codex-token-usage-analyzer", validate: validateReport, path: "/observedAt/from", build: (value) => ({ observedAt: { from: value, to: null } }) },
];

function formatErrors(validate, data, path) {
  validate(data);
  return (validate.errors ?? []).filter((error) => error.instancePath === path && error.keyword === "format");
}

for (const { name, validate, path, build } of cases) {
  test(`${name}: date-time 필드는 RFC 3339 값만 통과한다`, () => {
    for (const value of VALID) assert.deepEqual(formatErrors(validate, build(value), path), [], value);
    for (const value of INVALID) assert.equal(formatErrors(validate, build(value), path).length, 1, value);
  });
}
