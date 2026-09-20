import { digest, digestBytes, targetDigest } from "../../skills/software-security-auditor/scripts/core.mjs";

export const source = "export const value = 'synthetic';\n";
export function fixture() {
  const request = {
    schemaVersion: "1.0.0", target: { identifier: "fixture", baseRef: null, files: [{ path: "target.txt", digest: digestBytes(source) }] },
    mode: "repository", profiles: ["web-api", "cli-mcp"], excluded: [], environment: "isolated synthetic fixture",
    authorization: { localReproduction: false, constraints: ["static only"] }, checks: [{ id: "C1", description: "input reachability" }], providedEvidence: [],
  };
  const report = {
    schemaVersion: "1.0.0", request, requestDigest: digest(request), targetDigest: targetDigest(request), status: "complete",
    threatModel: { assets: ["synthetic data"], actors: ["user"], entrypoints: ["function"], trustBoundaries: ["input to effect"] },
    checks: [{ id: "C1", status: "checked", evidenceRefs: ["E1"], observation: "inspected fixture", method: "static-analysis" }],
    findings: [], evidence: [{ id: "E1", path: "target.txt", digest: digestBytes(source), targetDigest: targetDigest(request), kind: "source", description: "synthetic source" }], limitations: [],
  };
  return { request, report };
}

export function finding() {
  return { id: "F1", status: "confirmed", severity: "high", checkIds: ["C1"], locations: [{ path: "target.txt", line: 1 }], preconditions: "untrusted caller", attackPath: "input to effect", impact: "fixture disclosure", defenseReview: "none in fixture", evidenceRefs: ["E1"], proof: "static-analysis", remediation: "restrict access", retest: "cross-user denial" };
}
