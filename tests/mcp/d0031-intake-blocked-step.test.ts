import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { serverInstructions } from "../../mcp-server/src/server.js";
import { skillIntakeText } from "../../mcp-server/src/skill-intake.js";

// AGS3-D-0031 (formerly AGS3-D-0034, merged into D-0031): when one step was blocked from outside (a tool refusal, a denied permission, waiting for another session
// or owner to fix something), a session stopped all of its assigned work instead of holding only that step. The shared
// intake said to keep independent work going only in three narrow cases (a missing constraint, a user-only action, a
// refused skill classification). One rule now covers every blocked step and those three sentences merge into it.
// Fragments below are deliberately not whole intake sentences: claude-plugin.test.mjs keeps every whole sentence in
// the shared source only.
const root = new URL("../../", import.meta.url);
const block = (text: string) => text.split("<!-- skill-intake:start -->\n")[1]!.split("\n<!-- skill-intake:end -->")[0]!;
const source = block(readFileSync(new URL("skills/orchestrator/references/intake.md", root), "utf8"));
const blockedStep = source.match(/사용자 몫·근거 누락·도구 실패·권한 거절·다른 담당의 수정 대기는 [^.]+\./u)?.[0] ?? "";
const count = (text: string, fragment: string) => text.split(fragment).length - 1;

// D32 재결속 사전 사례: canonical C7.8 다음 C7.9의 부분 차단 절과 ko/en·생성물을 입력으로 삼는다.
// 기존 세 시험으로 모든 차단 원인·의존 단계만 보류·대기 보고·독립 작업 지속·전체 중단 금지를 확인한다.
// 빈 추출·중복·순서 역전·전달 불일치는 실패이다. 부정 조건을 유지하며 로컬은 정적 검사만 한다.

describe("shared intake: a blocked step holds only itself and its dependents (AGS3-D-0031, formerly D-0034)", () => {
  it("names the outside causes, holds only the blocked and dependent steps, reports the wait and keeps the rest going", () => {
    expect(blockedStep).not.toBe("");
    for (const fragment of [
      // Causes: the user-only part named just before, a missing constraint, a tool failure, a denied permission and
      // waiting for another owner's fix (the 11-06 case: an SSH MCP refusal while its owner fixed it).
      "사용자 몫·근거 누락·도구 실패·권한 거절·다른 담당의 수정 대기는",
      // 3.9.0 (AGS3-D-0032) shortened wording of the same rule.
      "그 단계와 의존 단계만 보류하고",
      "막힌 것·기다리는 대상을 적은 뒤",
      "독립 작업을 계속하며",
      "턴·전체 작업을 끝내지 않는다",
    ]) expect(blockedStep).toContain(fragment);
    expect(blockedStep).not.toMatch(/\b(?:Codex|Claude|Gemini|GPT-[0-9]|SSH)/u);
    // It follows the user-only sentence, which keeps its request and split-the-work rules.
    const userOnly = source.indexOf("사용자만 할 승인·비밀값 입력·본인 조작이 남으면 그 턴에 그 부분만");
    expect(userOnly).toBeGreaterThan(-1);
    expect(source.indexOf(blockedStep)).toBeGreaterThan(userOnly);
    expect(source.slice(userOnly, source.indexOf(blockedStep))).toContain("「사용자가 할 일」과 「에이전트가 이어서 할 일」을 나눈다");
  });

  it("states the continue-the-independent-work rule once, in place of the three narrower sentences", () => {
    expect(count(source, "독립 작업을 계속")).toBe(1);
    expect(count(source, "독립적으로 가능한 일은 계속한다")).toBe(0);
    expect(count(source, "독립적인 작업은 계속한다")).toBe(0);
    expect(count(source, "독립적으로 가능한 작업과 막힌 의존 단계를 구분한다")).toBe(0);
    // What each narrower sentence said besides continuing stays where it was.
    expect(source).toContain("빠진 제약은 권한 내 작업에 결속된 정본부터 찾고 없으면 그 부분만 묻는다");
    // 3.9.0 (AGS3-D-0032): the refused-classification handling is read in the classification contract the intake names.
    expect(source).toContain("[공통 분류 지원 계약](references/skill-classification.md)대로 쓴다");
    expect(readFileSync(new URL("skills/orchestrator/references/skill-classification.md", root), "utf8")).toContain("미확정 상태에서");
  });

  it("reaches every host through the MCP server instructions (ko, en) and the generated packages", () => {
    for (const instructions of [skillIntakeText("ko"), skillIntakeText("en"), serverInstructions(), serverInstructions("en")]) {
      expect(count(instructions, blockedStep)).toBe(1);
      expect(count(instructions, "독립적인 작업은 계속한다")).toBe(0);
    }
    for (const pkg of ["claude-plugin", "claude-plugin-en", "codex-plugin-en"]) {
      const installed = block(readFileSync(new URL(`${pkg}/skills/orchestrator/references/intake.md`, root), "utf8"));
      expect(installed, pkg).toBe(source);
    }
  });
});
