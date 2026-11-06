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

const casesFirst = sentence("시작 전에 확인할 사례");
const realEntryPoint = sentence("사용자가 실제로 쓰는 진입점");
const reportUnrun = sentence("실행하지 않은 범위는 미검증으로");
const userOnly = sentence("사용자만 할 수 있는 승인·비밀값 입력·사용자 본인의 조작은");
const specificRequest = sentence("앞 문맥 없이 바로 할 수 있게");
const askApproval = sentence("우회하지 말고 영향까지 담아");
const noAsk = sentence("증거가 흔한 기본값과 어긋나면");
const handOff = sentence("받은 요청이 이 세션의 역할 밖이면");
const peerBlocker = sentence("다른 세션이 이 세션의 역할·도구로 풀 수 있는 막힘");
const added = [casesFirst, realEntryPoint, reportUnrun, specificRequest, askApproval, noAsk, peerBlocker];

describe("shared intake: verification cases first (AGS3-D-0036)", () => {
  it("has any work that makes or changes something fix what, where and which result is success before it starts", () => {
    expect(casesFirst).not.toBe("");
    // Not limited to code: any work that makes or changes something.
    expect(casesFirst).toContain("무언가를 만들거나 바꾸는 작업은");
    expect(casesFirst).toContain("시작 전에 확인할 사례(무엇을·어디서·어떤 결과면 성공인지)를 먼저 정한다");
    expect(casesFirst).not.toMatch(/코드|테스트/u);
  });
});

describe("shared intake: run the cases where the user uses the result (AGS3-D-0031, formerly D-0035)", () => {
  it("runs those cases at the user's real entry point and target environment, not an inside check", () => {
    expect(realEntryPoint).not.toBe("");
    // It runs the cases fixed before the work, after the work.
    expect(realEntryPoint).toContain("끝나면 그 사례를");
    expect(sentences.indexOf(casesFirst)).toBeLessThan(sentences.indexOf(realEntryPoint));
    expect(realEntryPoint).toContain("사용자가 실제로 쓰는 진입점과 대상 환경");
    // Examples span fields (a public address, an installed app, a published document, an ad console), not only code.
    for (const example of ["공개 주소", "설치된 앱", "게시된 문서", "광고 관리 화면"]) expect(realEntryPoint).toContain(example);
    expect(realEntryPoint).toContain("직접 실행해 확인하고");
    // The case: a check inside the server (12 tools) stood in for the user's path (10 tools).
    expect(realEntryPoint).toContain("내부 점검·일부 시험의 통과로 대신하지 않는다");
  });

  it("finishes the runnable checks itself and reports what was not run as unverified", () => {
    expect(reportUnrun).toContain("현재 도구·권한으로 할 수 있는 실행·검증은 끝내고 실제 결과를 보고");
    // The case: the session asked the user to press sync and look again instead of reading the public tool list itself.
    expect(reportUnrun).toContain("실행 가능한 확인을 사용자에게 떠넘기지 않고");
    expect(reportUnrun).toContain("실행하지 않은 범위는 미검증으로 적는다");
    // The narrower "do not call an unrun step done" wording is replaced, not kept beside it.
    expect(count(source, "미실행을 완료로 표현하지 않는다")).toBe(0);
  });
});

describe("shared intake: name what the user is asked to do (AGS3-D-0039)", () => {
  it("says which value, file or screen, when and from what it came, where, new or reused, and the exact command", () => {
    expect(specificRequest).not.toBe("");
    expect(specificRequest).toContain("사용자에게 요청할 때는");
    expect(specificRequest).toContain("앞 문맥 없이 바로 할 수 있게 대상(어떤 값·파일·화면인지, 언제 무엇으로 받은 것인지, 위치, 새로 필요한지 기존 것을 다시 쓰는지)");
    expect(specificRequest).toContain("실행할 정확한 명령을 적는다");
    // The case: "the token" alone made the user ask which token.
    expect(specificRequest).toContain("「토큰」 대신 어느 계정의 어떤 권한 토큰인지처럼");
    // It opens the asking rules after the user-only and blocked-step sentences; the user-only sentence keeps asking
    // only for the user's part and splitting the work, and the approval ask follows.
    expect(userOnly).toContain("그 부분과 이유만 요청하고");
    expect(sentences.indexOf(userOnly)).toBeGreaterThan(-1);
    expect(sentences.indexOf(specificRequest)).toBe(sentences.indexOf(sentence("턴을 끝내거나 작업 전체를 멈추지 않는다")) + 1);
    expect(sentences.indexOf(askApproval)).toBe(sentences.indexOf(specificRequest) + 1);
  });
});

describe("shared intake: follow-up repairs inside an approved goal (AGS3-D-0040)", () => {
  it("does not ask again for a follow-up fix or repair the approved goal needs, even when the action differs", () => {
    expect(noAsk).toContain("이미 승인된 목표를 이루는 데 필요한 후속 수정·복구(행동이 달라도)는 묻지 않고 진행한다");
    // What it already did not ask about stays.
    expect(noAsk).toContain("되돌릴 수 있는 수행 방식의 선택·관례로 정해지는 값·이미 답한 사항");
  });

  it("still asks for a new high-risk action outside the approval, and the pre-execution check stays", () => {
    expect(askApproval).toContain("현재 권한 밖의 승인이나 받은 승인 밖의 새 고위험 행동(다른 대상의 영구 삭제, 새 공개·배포 등)이 필요하면");
    expect(askApproval).toContain("우회하지 말고 영향까지 담아 한 번에 바로 묻는다");
    expect(source).toContain("직전에만 `mutation-risk-preflight`를 실제 호출한다");
    // The ask comes before the no-ask list in the same line.
    expect(sentences.indexOf(askApproval)).toBeLessThan(sentences.indexOf(noAsk));
  });
});

describe("shared intake: a peer's blocker inside this session's role is handled now (AGS3-D-0041)", () => {
  it("handles or starts it in that turn and answers the asking session instead of holding it as its own blocked step", () => {
    expect(peerBlocker).not.toBe("");
    expect(peerBlocker).toContain("풀어 달라고 하면");
    expect(peerBlocker).toContain("이 세션이 보류할 단계로 미루지 말고");
    expect(peerBlocker).toContain("그 턴에 처리하거나 시작해 요청한 세션에 결과를 답한다");
    // It sits with the role rules, right after handing a request outside the role to the session that holds it.
    expect(sentences.indexOf(peerBlocker)).toBe(sentences.indexOf(handOff) + 1);
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
