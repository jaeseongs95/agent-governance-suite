import {describe, expect, it} from "vitest";
import {access, rm} from "node:fs/promises";
import path from "node:path";
import {analyzeEvaluation} from "../../skills/evaluation-validity-auditor/scripts/core.mjs";
import {makePostFixture} from "./fixture.mjs";

describe("ORIGINAL125 C-44 독립 oracle 누락", () => {
  it("oracle 미공급을 두 검사에서 보류하고 검증된 근거 목록과 품질 증거에서 제외한다", async () => {
    const {root, post, ids} = await makePostFixture();
    try {
      const oracle = post.artifacts.find(item => item.role === "oracle");
      const originalBinding = structuredClone(oracle);
      oracle.locator = "oracle-not-supplied.json";
      // 기존 helper의 다른 파일은 유지하며 이 요청에 결속된 oracle 바이트는 공급하지 않는다.
      await expect(access(path.join(root, oracle.locator))).rejects.toMatchObject({code: "ENOENT"});
      expect({...oracle, locator: originalBinding.locator}).toEqual(originalBinding);
      const report = await analyzeEvaluation(post, {artifactRoot: root});
      for (const checkId of ["ARTIFACT_INTEGRITY", "JUDGMENT_METHOD_VALID"]) {
        expect(report.checks.find(item => item.checkId === checkId)).toMatchObject({status: "BLOCKED", code: "ARTIFACT_MISSING"});
      }
      expect(report.verdict).toBe("BLOCKED");
      expect(report.qualifiesAsQualityOrReleaseEvidence).toBe(false);
      expect(report.blockingCodes).toContain("ARTIFACT_MISSING");
      expect(report.verifiedEvidenceIndex.some(item => item.artifactId === ids.oracle || item.role === "oracle")).toBe(false);
      // 전체 목록을 버리는 구현도 거부한다. 읽을 수 있는 기존 근거는 검증 목록에 남는다.
      expect(report.verifiedEvidenceIndex.some(item => item.artifactId === ids.manifest)).toBe(true);
      expect(report.artifactBindings).toContainEqual({artifactId: ids.oracle, role: "oracle", digest: originalBinding.digest});
    } finally { await rm(root, {recursive: true, force: true, maxRetries: 5}); }
  });
});
