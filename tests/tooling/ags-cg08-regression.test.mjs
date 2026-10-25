import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { analyzeAcceptance, validateReport, sha256 } from "../../skills/acceptance-evidence-validator/scripts/core.mjs";
import { InputError, validateRequest, validateReview } from "../../skills/iteration-frame-auditor/scripts/core.mjs";

const json = async (relative) => JSON.parse(await readFile(new URL(relative, import.meta.url), "utf8"));
const acceptanceFixture = () => json("../acceptance-evidence-validator/fixtures/not-applicable.json");

describe("CG08 iteration and acceptance contract regressions", () => {
  it("AGS-D-0117 preserves nested request schema details through the review boundary", async () => {
    const { review: template } = await json("../iteration-frame-auditor/fixtures/normal-target-only.json");
    const comparison = Object.fromEntries([
      "schemaVersion", "rootId", "reviewedEpoch", "requestArtifactDigest", "reviewer",
      "comparisons", "evidenceRefs", "rationale", "limitations"
    ].map((key) => [key, template[key]]));
    const review = {
      schemaVersion: "1.0.0", reviewId: "cg08-review", rootId: "root-1", rootRevision: 0, epoch: 1,
      reviewerActorId: "auditor-1", implementationActorIds: [],
      freshContext: { confirmed: true, evidenceRef: "evidence-reviewer" },
      classification: "ambiguous", comparability: { comparable: false, rationale: "Invalid request." },
      route: "panel", proposedFrame: null, evidenceRefs: ["evidence-reviewer"], userApprovalRefs: [],
      reviewedAt: "2026-10-25T00:00:00.000Z"
    };
    const request = { schemaVersion: "1.0.0", root: {} };
    let details;
    try { validateRequest(request); }
    catch (error) {
      expect(error).toBeInstanceOf(InputError);
      details = error.details;
    }
    expect(details.errors.some((error) => error.instancePath === "/root")).toBe(true);
    const errors = validateReview(review, comparison, request, comparison.requestArtifactDigest);
    expect(errors[0]).toContain("request cannot substantiate review");
    const detailMessage = errors.find((error) => error.startsWith("request validation details: "));
    expect(detailMessage).toBeDefined();
    expect(JSON.parse(detailMessage.slice("request validation details: ".length))).toEqual(details);
  });

  it("AGS-D-0117 retains non-object request errors without fabricating schema details", async () => {
    const { review: template } = await json("../iteration-frame-auditor/fixtures/normal-target-only.json");
    const comparison = Object.fromEntries([
      "schemaVersion", "rootId", "reviewedEpoch", "requestArtifactDigest", "reviewer",
      "comparisons", "evidenceRefs", "rationale", "limitations"
    ].map((key) => [key, template[key]]));
    const review = {
      schemaVersion: "1.0.0", reviewId: "cg08-review", rootId: "root-1", rootRevision: 0, epoch: 1,
      reviewerActorId: "auditor-1", implementationActorIds: [],
      freshContext: { confirmed: true, evidenceRef: "evidence-reviewer" },
      classification: "ambiguous", comparability: { comparable: false, rationale: "Invalid request." },
      route: "panel", proposedFrame: null, evidenceRefs: ["evidence-reviewer"], userApprovalRefs: [],
      reviewedAt: "2026-10-25T00:00:00.000Z"
    };
    expect(validateReview(review, comparison, [], comparison.requestArtifactDigest)).toEqual([
      "request cannot substantiate review: Request must be an object."
    ]);
  });

  it("AGS-D-0143 keeps valid authority NA when no current counterevidence exists", async () => {
    const report = analyzeAcceptance(await acceptanceFixture());
    expect(report.verdict).toBe("PASS");
    expect(report.criteria[1].status).toBe("not-applicable");
  });

  it("AGS-D-0143 current verified counterevidence outranks valid authority NA", async () => {
    const input = await acceptanceFixture();
    input.evidence.push({
      id: "current-counterevidence", kind: "test", locator: "artifact://cg08/current-failure",
      digest: `sha256:${"a".repeat(64)}`, targetDigest: input.target.digest, verified: true,
      criterionIds: ["AC-002"], direction: "refutes", observedResult: "The current criterion fails."
    });
    const report = analyzeAcceptance(input);
    expect(report.verdict).toBe("FAIL");
    expect(report.criteria[1].status).toBe("unsatisfied");
    expect(report.criteria[1].evidenceRefs).toEqual(["current-counterevidence"]);
  });

  it("AGS-D-0143 current command failure outranks valid authority NA and rejects a forged NA report", async () => {
    const input = await acceptanceFixture();
    input.verificationCommands.push({
      id: "cg08-command", command: "fixture-command", exitCode: 1, locator: "artifact://cg08/command",
      targetDigest: input.target.digest, criterionIds: ["AC-002"]
    });
    const report = analyzeAcceptance(input);
    expect(report.verdict).toBe("FAIL");
    expect(report.criteria[1].status).toBe("unsatisfied");
    expect(report.criteria[1].evidenceRefs).toEqual(["command:cg08-command"]);
    const requestArtifact = {
      artifactId: "cg08-request",
      schemaId: "https://agent-governance-skills.local/acceptance-evidence-validator/contracts/acceptance-evidence-input.v1.schema.json",
      locator: "artifact://cg08/request", digest: sha256(input)
    };
    expect(validateReport({ schemaVersion: "1.0.0", request: input, requestArtifact, report })).toEqual([]);
    report.criteria[1] = {
      ...report.criteria[1], status: "not-applicable", evidenceRefs: ["deployment-exclusion"],
      observedResult: "Excluded by explicit authority.", rationale: input.criterionOverrides[0].rationale
    };
    report.verdict = "PASS";
    expect(validateReport({ schemaVersion: "1.0.0", request: input, requestArtifact, report })
      .some((error) => error.includes("request-derived criteria"))).toBe(true);
  });

  it.each(["stale", "unverified"])("AGS-D-0143 ignores %s counterevidence for authority NA", async (kind) => {
    const input = await acceptanceFixture();
    input.evidence.push({
      id: "ignored-counterevidence", kind: "test", locator: "artifact://cg08/ignored-failure",
      digest: `sha256:${"b".repeat(64)}`,
      targetDigest: kind === "stale" ? `sha256:${"c".repeat(64)}` : input.target.digest,
      verified: kind !== "unverified", criterionIds: ["AC-002"], direction: "refutes",
      observedResult: "This does not substantiate a current verified failure."
    });
    const report = analyzeAcceptance(input);
    expect(report.verdict).toBe("PASS");
    expect(report.criteria[1].status).toBe("not-applicable");
  });

  it("AGS-D-0143 still rejects invalid authority even alongside a current command failure", async () => {
    const input = await acceptanceFixture();
    input.criterionOverrides[0].authorityRef = "unbound-authority";
    input.verificationCommands.push({
      id: "cg08-command", command: "fixture-command", exitCode: 1, locator: "artifact://cg08/command",
      targetDigest: input.target.digest, criterionIds: ["AC-002"]
    });
    expect(() => analyzeAcceptance(input)).toThrow(/verified current authority evidence/u);
  });

  it("AGS-D-0144 aligns direct and registry mappings without passing diagnose or panel", async () => {
    const direct = await json("../../skills/iteration-frame-auditor/integration/skill-descriptor.json");
    const registry = await json("../../skills/registry.json");
    const provider = registry.skills.find((skill) => skill.skillId === "iteration-frame-auditor").providers[0];
    expect(direct.providers[0].stateMapping).toEqual(provider.stateMapping);
    for (const route of ["diagnose", "panel"]) {
      expect(direct.providers[0].stateMapping.values[route]).toEqual({ state: "needs-redesign", errorRequired: false });
    }
  });
});
