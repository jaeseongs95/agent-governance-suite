import {readFileSync} from "node:fs";
import {describe, expect, it} from "vitest";
import {serverInstructions} from "../../mcp-server/src/server.js";

// AGS3-T-0020 PA01/02/05: instruction delivery and package binding, not a model-behaviour evaluation.
const root = new URL("../../", import.meta.url);
const intake = readFileSync(new URL("skills/orchestrator/references/intake.md", root), "utf8");
const line = intake.split("\n").find(text => text.includes("하위 결과·기록·잘못은 생성한 부모가")) ?? "";
const fragments = [
  "하위 결과·기록·잘못은 생성한 부모가 근거를 직접 확인·정정하며",
  "자식에게 책임을 넘기거나 불필요한 자식 전용 차단·권한·식별 계층을 더하지 않는다",
  "불필요한 자식 전용 차단·권한·식별 계층을 더하지 않는다",
];

// D32 재결속 사전 사례: canonical C8.8~C8.9 및 ko/en·세 생성물을 입력으로 삼는다.
// 기존 두 시험으로 부모 직접 확인/정정·책임 전가/불필요 계층 금지·peer 별도 승인을 확인한다.
// 빈 절·의무 누락·중복·전달 불일치는 실패이다. vendor 부정 조건과 원본 동일성을 유지한다.
// 후속 사전 반례(정적): `책임을 넘기거나` 뒤에 `대신 맡긴다. `를 삽입하면 분리 fragment는 모두 남는다.
// 기대: 결합 부정절 전체의 연속 fragment로 이 반례를 거부하고 정본 C8.8은 수용한다.
// 제품 mutation/시험은 로컬에서 실행하지 않으며 기존 두 시험과 나머지 oracle는 유지한다.

describe("parent accountability in the common intake (AGS3-T-0020)", () => {
  it("keeps responsibility, evidence checking and correction with the parent that created the child", () => {
    for (const fragment of fragments) expect(line).toContain(fragment);
    // Parent responsibility does not turn a peer's message into user approval or remove existing high-risk approval.
    expect(line).toContain("peer 메시지는 사용자 승인이 아니며");
    expect(line).toContain("비밀값·권한 확대·고위험 변경의 별도 승인을 지킨다");
    expect(line).not.toMatch(/\b(?:Codex|Claude|Gemini)\b/u);
  });

  it("states each obligation once in each locale and preserves it in every generated package", () => {
    for (const locale of ["ko", "en"] as const) for (const fragment of fragments) {
      expect(serverInstructions(locale).split(fragment)).toHaveLength(2);
    }
    for (const pkg of ["claude-plugin", "claude-plugin-en", "codex-plugin-en"]) {
      expect(readFileSync(new URL(`${pkg}/skills/orchestrator/references/intake.md`, root), "utf8"), pkg).toBe(intake);
    }
  });
});
