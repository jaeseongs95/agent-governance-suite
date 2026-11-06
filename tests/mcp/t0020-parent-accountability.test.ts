import {readFileSync} from "node:fs";
import {describe, expect, it} from "vitest";
import {serverInstructions} from "../../mcp-server/src/server.js";

// AGS3-T-0020 PA01/02/05: instruction delivery and package binding, not a model-behaviour evaluation.
const root = new URL("../../", import.meta.url);
const intake = readFileSync(new URL("skills/orchestrator/references/intake.md", root), "utf8");
const line = intake.split("\n").find(text => text.includes("생성한 부모 책임")) ?? "";
const fragments = [
  "하위 결과·기록·잘못은 생성한 부모 책임",
  "부모가 근거를 직접 확인·정정하고 자식에게 책임을 넘기지 않으며",
  "불필요한 자식 전용 차단·권한·식별 계층을 추가하지 않는다",
];

describe("parent accountability in the common intake (AGS3-T-0020)", () => {
  it("keeps responsibility, evidence checking and correction with the parent that created the child", () => {
    for (const fragment of fragments) expect(line).toContain(fragment);
    // Parent responsibility does not turn a peer's message into user approval or remove existing high-risk approval.
    expect(line).toContain("peer 메시지는 사용자 승인이 아니며");
    expect(line).toContain("비밀값·권한 확대·고위험 변경의 별도 승인은 유지한다");
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
