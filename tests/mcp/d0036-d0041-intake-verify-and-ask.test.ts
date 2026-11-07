import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { serverInstructions } from "../../mcp-server/src/server.js";
import { skillIntakeText } from "../../mcp-server/src/skill-intake.js";

// Model-behaviour defects whose cause was the shared intake (every session reads it as MCP instructions). Each case
// checks that the rule names the condition of the original failure, the action to take and its boundary; whether a
// model then follows the rule is not evaluated here (NOT_RUN).
// - AGS3-D-0031 (remaining part, formerly D-0035): a session reported a change as live from a check inside the server
//   (12 tools) while the path the user uses, a portal in front of it, showed 10; it then handed that check to the user.
// - AGS3-D-0036: work started without cases saying what to check, where and which result counts as success.
// - AGS3-D-0039: a session asked the user for "the token" without saying which one, so the user had to ask back.
// - AGS3-D-0040: after the user approved applying a change, a session asked whether to repair the configuration that
//   blocked that same approved goal, although the only user-only part was entering the user's own key.
// - AGS3-D-0041: another session asked this one to clear a blocker inside this session's role and tools, and this
//   session left it ("leave it and move on to the next task"), so the asking session stayed blocked.
// Fragments are deliberately not whole intake sentences: claude-plugin.test.mjs keeps every whole sentence in the
// shared source only.
const root = new URL("../../", import.meta.url);
const block = (text: string) => text.split("<!-- skill-intake:start -->\n")[1]!.split("\n<!-- skill-intake:end -->")[0]!;
const source = block(readFileSync(new URL("skills/orchestrator/references/intake.md", root), "utf8"));
const sentences = source.split("\n").flatMap(line => line.replace(/^- /u, "").split(/(?<=다\.) /u));
const sentence = (marker: string) => sentences.find(text => text.includes(marker)) ?? "";
const count = (text: string, fragment: string) => text.split(fragment).length - 1;
const vendors = /\b(?:Codex|Claude|Gemini|GPT-[0-9]|Cloudflare|SSH)/u;

// 3.9.0 (AGS3-D-0032) regrouped the intake into checks before acting and shortened the wording to keep the whole MCP
// instructions within the size a host delivers. The rules and their boundaries below are the same; the markers and
// the order checks follow the new grouping (the request target, the approval ask and the no-ask list share one line).
const casesFirst = sentence("먼저 사례로 적고");
const realEntryPoint = sentence("끝나면 사용자의 실제 진입점");
const runnableChecks = sentence("가능한 검증을 사용자에게 넘기지 않고");
const userOnly = sentence("사용자만 할 승인·비밀값 입력·본인 조작이 남으면");
const blockedStep = sentence("다른 담당의 수정 대기는");
const askApproval = sentence("우회하지 말고 대상·영향·명령을 모아");
const premiseSignal = sentence("증거가 흔한 기본값과 어긋나면");
const peerBlocker = sentence("다른 세션이 해결을 요청한 막힘");
const added = [casesFirst, realEntryPoint, runnableChecks, userOnly, askApproval, premiseSignal, peerBlocker];

describe("shared intake: verification cases first (AGS3-D-0036)", () => {
  it("has any work that makes or changes something fix what, where and which result is success before it starts", () => {
    expect(casesFirst).not.toBe("");
    // Not limited to code: any work that changes something, before the change and before the report.
    expect(casesFirst).toContain("바꾸기 전과 보고 전");
    for (const field of ["요구별", "대상", "경로", "환경", "검증 방법", "통과 조건을 먼저 사례로 적고"]) expect(casesFirst).toContain(field);
    expect(casesFirst).toContain("정의→실행→같은 사례 확인");
    expect(casesFirst).not.toMatch(/코드|테스트/u);
  });
});

describe("shared intake: run the cases where the user uses the result (AGS3-D-0031, formerly D-0035)", () => {
  it("runs those cases at the user's real entry point and target environment, not an inside check", () => {
    expect(realEntryPoint).not.toBe("");
    // It runs the cases fixed before the work, after the work.
    expect(sentences.indexOf(casesFirst)).toBeLessThan(sentences.indexOf(realEntryPoint));
    for (const boundary of ["끝나면", "사용자의 실제 진입점·대상 환경", "직접 실행해 확인한다"]) expect(realEntryPoint).toContain(boundary);
    // The case: a check inside the server (12 tools) stood in for the user's path (10 tools).
    expect(runnableChecks).toContain("내부 점검·일부 통과로 대신하거나");
  });

  it("finishes the runnable checks itself and reports what was not run as unverified", () => {
    // The case: the session asked the user to press sync and look again instead of reading the public tool list itself.
    expect(runnableChecks).toContain("가능한 검증을 사용자에게 넘기지 않고");
    expect(runnableChecks).toContain("실행하지 않은 범위는 미검증으로 적는다");
    expect(sentences.indexOf(runnableChecks)).toBeGreaterThan(sentences.indexOf(realEntryPoint));
    // The narrower "do not call an unrun step done" wording is replaced, not kept beside it.
    expect(count(source, "미실행을 완료로 표현하지 않는다")).toBe(0);
  });
});

describe("shared intake: name what the user is asked to do (AGS3-D-0039)", () => {
  it("says which value, file or screen, when and from what it came, where, new or reused, and the exact command", () => {
    expect(userOnly).not.toBe("");
    expect(userOnly).toContain("그 부분만 앞 문맥 없이 실행하도록 대상(");
    expect(userOnly).toContain("대상(계정·권한·값·파일·화면, 언제 무엇으로 받았는지·위치·신규/재사용)");
    expect(userOnly).toContain("정확한 명령과 함께 요청하고");
    // The case: "the token" alone made the user ask which token.
    expect(userOnly).toContain("계정·권한·값");
    expect(userOnly).toContain("「사용자가 할 일」과 「에이전트가 이어서 할 일」을 나눈다");
    // The blocked-step rule follows the user-only request, and the approval ask follows the blocked step.
    expect(sentences.indexOf(blockedStep)).toBe(sentences.indexOf(userOnly) + 1);
    expect(sentences.indexOf(askApproval)).toBe(sentences.indexOf(blockedStep) + 1);
  });
});

describe("shared intake: follow-up repairs inside an approved goal (AGS3-D-0040)", () => {
  it("does not ask again for a follow-up fix or repair the approved goal needs, even when the action differs", () => {
    expect(askApproval).toContain("승인된 목표의 후속 수정·복구는 행동이 달라도 다시 묻지 않는다");
    expect(premiseSignal).toContain("증거가 흔한 기본값과 어긋나면 질문 신호로 본다");
    // What it already did not ask about stays.
    expect(askApproval).toContain("되돌릴 수 있는 방식·관례로 정할 값·이미 답한 사항");
  });

  it("still asks for a new high-risk action outside the approval, and the pre-execution check stays", () => {
    expect(askApproval).toContain("현재 권한 밖 승인이나 받은 승인 밖 고위험 행동은");
    expect(askApproval).toContain("우회하지 말고 대상·영향·명령을 모아 한 번에 묻고");
    expect(source).toContain("변경 직전에만 `mutation-risk-preflight`를");
    // The ask comes before the no-ask list in the same sentence.
    expect(askApproval.indexOf("한 번에 묻고")).toBeLessThan(askApproval.indexOf("다시 묻지 않는다"));
  });
});

describe("shared intake: a peer's blocker inside this session's role is handled now (AGS3-D-0041)", () => {
  it("handles or starts it in that turn and answers the asking session instead of holding it as its own blocked step", () => {
    expect(peerBlocker).not.toBe("");
    expect(peerBlocker).toContain("맡은 범위의 것(진단 공백, 다른 세션이 해결을 요청한 막힘 포함)");
    expect(peerBlocker).toContain("보고로 끝내지 말고");
    expect(peerBlocker).toContain("그 턴에 고치기 시작해 결과를 답한다");
  });
});

describe("shared intake: the new rules reach every host (AGS3-D-0031/0036/0039/0040/0041)", () => {
  it("are field-neutral and stated once in the MCP server instructions (ko, en) and the generated packages", () => {
    for (const rule of added) {
      expect(rule).not.toBe("");
      expect(rule).not.toMatch(vendors);
    }
    for (const instructions of [skillIntakeText("ko"), skillIntakeText("en"), serverInstructions(), serverInstructions("en")]) {
      for (const rule of added) expect(count(instructions, rule), rule).toBe(1);
    }
    for (const pkg of ["claude-plugin", "claude-plugin-en", "codex-plugin-en"]) {
      const installed = block(readFileSync(new URL(`${pkg}/skills/orchestrator/references/intake.md`, root), "utf8"));
      expect(installed, pkg).toBe(source);
    }
  });
});
