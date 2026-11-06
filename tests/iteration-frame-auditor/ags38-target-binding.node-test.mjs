import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { artifactDigest, validateRequest } from "../../skills/iteration-frame-auditor/scripts/core.mjs";

const cli = fileURLToPath(new URL("../../skills/iteration-frame-auditor/scripts/digest-request.mjs", import.meta.url));
const locations = ["src/workflow.ts", "artifact://target/candidate"];
function refresh(side) {
  side.contractDigest = artifactDigest(side.contract);
  side.frameDigest = artifactDigest(side.frame);
  side.controlDigest = artifactDigest(side.frame.controlArtifacts);
  side.targetDigest = artifactDigest(side.frame.targetArtifacts);
}
function request() {
  const contract = { objective: "Fix candidate", scope: ["src"], acceptanceCriteria: ["Preserve evaluation"], constraints: [], authorization: ["edit src"], workspace: "workspace://test", targetLocations: [...locations] };
  const frame = {
    schemaVersion: "1.0.0", workspace: { workspaceId: "ws", locator: contract.workspace },
    controlArtifacts: [{ artifactId: "oracle", role: "oracle", locator: "artifact://oracle", digest: artifactDigest("fixed oracle") }],
    targetArtifacts: locations.map((locator, i) => ({ artifactId: `target-${i}`, role: "target", locator, digest: artifactDigest(`target-${i}`) })),
    operationalSettings: { maxAttemptsPerEpoch: 3, maxEpochs: 2, leaseTtlSeconds: 900 },
  };
  const root = { rootId: "root-target-binding", revision: 0, epoch: 1, contract, frame };
  const proposal = { contract: structuredClone(contract), frame: structuredClone(frame), changeSummary: [{ path: "/frame", claimedRole: "target", summary: "Correct target" }], evidenceRefs: ["target-comparison"] };
  refresh(root);
  refresh(proposal);
  return {
    schemaVersion: "1.0.0", root, proposal, attemptHistory: [],
    reviewer: { actorId: "reviewer", freshContext: true, freshContextEvidenceRef: "reviewer-separation", implementationActorIds: [] },
    evidenceInventory: ["contract-comparison", "control-comparison", "target-comparison", "reviewer-separation"].map((kind) => ({ evidenceRef: kind, artifactDigest: artifactDigest(kind), locator: `artifact://${kind}`, kind, verified: true })),
  };
}
function run(input) {
  const output = spawnSync(process.execPath, [cli], { input: JSON.stringify(input), encoding: "utf8" });
  assert.equal(output.error, undefined);
  return { code: output.status, body: JSON.parse(output.stdout) };
}

test("E20-01 same locator set in a different order remains valid", () => {
  const input = request();
  input.root.frame.targetArtifacts.reverse();
  input.proposal.contract.targetLocations.reverse();
  refresh(input.root);
  refresh(input.proposal);
  input.proposal.changeSummary.push({ path: "/contract/targetLocations", claimedRole: "contract", summary: "Reorder the same locations" });
  assert.doesNotThrow(() => validateRequest(input));
  assert.equal(run(input).code, 0);
});

for (const side of ["root", "proposal"]) {
  for (const mutation of ["add", "remove", "replace", "duplicate", "case", "slash", "whitespace"]) {
    test(`E20-02/03/04/05 ${side} rejects ${mutation} even with recomputed valid digests`, () => {
      const input = request();
      const target = input[side].frame.targetArtifacts;
      if (mutation === "add") target.push({ ...target[0], artifactId: "other", locator: "src/extra.ts" });
      if (mutation === "remove") target.pop();
      if (mutation === "replace") target[0].locator = "src/other.ts";
      if (mutation === "duplicate") target.push({ ...target[0], artifactId: "duplicate-locator" });
      if (mutation === "case") target[0].locator = "SRC/workflow.ts";
      if (mutation === "slash") target[0].locator = "src\\workflow.ts";
      if (mutation === "whitespace") target[0].locator += " ";
      refresh(input[side]);
      const output = run(input);
      assert.equal(output.code, 2);
      assert.equal(output.body.error.code, "INVALID_INPUT");
      assert.throws(() => validateRequest(input), (error) => error.name === "InputError");
    });
  }
}
