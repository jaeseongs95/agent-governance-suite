import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { serverInstructions } from "../../mcp-server/src/server.js";
import { skillIntakeText } from "../../mcp-server/src/skill-intake.js";

// AGS3-D-0031: nothing in the shared intake led a session to check whether a target's purpose had already been met
// before closing, deleting, reverting or replacing it. A session moved to close a pull request that was the only path
// of unreleased code to the base branch without checking whether that code had reached the base.
// AGS3-D-0032: the shared intake repeated rules in several places and is loaded in full at every context start.
// Fragments below are deliberately not whole intake sentences: claude-plugin.test.mjs keeps every whole sentence in
// the shared source only.
const intake = skillIntakeText("ko");
const lines = intake.split("\n");
const purposeLine = lines.find(line => line.startsWith("- 닫기·삭제·되돌리기·대체를 고르거나")) ?? "";

// D32 재결속 사전 사례: 독립 검토·63문장 대응표와 canonical intake 및 ko/en MCP 지침을 입력으로 삼는다.
// 기존 다섯 시험으로 목적/실상 확인·미달 대상 보존·연결 해제 주체/시점·모든 기존 규칙을 확인한다.
// 의무 누락·중복·빈 목적 절은 실패이다. 중복 횟수와 5,229자 상한을 유지하며 로컬은 정적 검사만 한다.

describe("shared intake: purpose check before removing a target (AGS3-D-0031)", () => {
  it("checks the target's purpose against the actual state before choosing or answering, and keeps the target when it is unmet", () => {
    expect(purposeLine).not.toBe("");
    // 3.9.0 (AGS3-D-0032) shortened the line; the purpose check, the answer and choices it drives and keeping the
    // target when the purpose is unmet stay.
    for (const fragment of [
      "그 가능 여부를 답하기 전에는",
      "원래 목적이 이미 이뤄졌는지 실제 상태로 확인해",
      "답과 선택지에 반영하고",
      "미달이면 대상을 없애지 말고 목적을 이루는 쪽을 고른다",
    ]) expect(purposeLine).toContain(fragment);
    // Stopping a process stays in the same line: the connected sessions first, then who disconnects and when.
    expect(purposeLine).toContain("프로세스·서버·앱을 멈추기 전에는");
    expect(purposeLine).toContain("연결 중인 세션과 누가 언제 끊을지 적는다");
    expect(purposeLine).not.toMatch(/\b(?:Codex|Claude|Gemini|GPT-[0-9])/u);
  });

  it("reaches every host through the MCP server instructions", () => {
    expect(serverInstructions()).toContain(purposeLine);
    expect(serverInstructions("en")).toContain(purposeLine);
  });
});

describe("shared intake: merged without dropping a rule (AGS3-D-0032)", () => {
  it("states each merged rule once", () => {
    const count = (fragment: string) => intake.split(fragment).length - 1;
    // Before 3.8.0 the single-skill rule sat in both the workflow and the direct-handling lines, and the skill-load
    // line restated the selection paragraph.
    expect(count("전문 스킬 하나로")).toBe(1);
    expect(count("문서 읽기는 실행이 아니다")).toBe(1);
    expect(lines.some(line => line.startsWith("- 선택한 스킬은"))).toBe(false);
  });

  it("keeps every rule of the 3.7.0 intake", () => {
    // One fragment per rule of the pre-3.8.0 block, in its order. 3.9.0 (AGS3-D-0032) shortened the wording to keep the
    // whole MCP instructions under the size a host delivers; the fragments follow it. A rule the intake no longer
    // repeats is checked where it is delivered: the per-message cue, the tool description read at the call, the
    // session-start skill line, the ponytail skill and the classification contract.
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const read = (relative: string) => readFileSync(`${root}${relative}`, "utf8");
    const tools = JSON.parse(read("locales/ko/tools.json")) as Record<string, string>;
    const hooks = JSON.parse(read("locales/ko/hooks.json")) as Record<string, string>;
    const instructions = JSON.parse(read("locales/ko/instructions.json")) as Record<string, string>;
    const sources: Record<string, string> = {
      intake,
      cue: hooks["hooks.checkpointCue.save"]!,
      checkpoint: tools["tools.checkpoint_context.description"]!,
      role: tools["tools.update_session_status.description"]!,
      prepare: tools["tools.prepare_session_message.description"]!,
      start: tools["tools.start_workflow.description"]!,
      skills: instructions["instructions.intake.skills"]!,
      ponytail: read("skills/ponytail/SKILL.md"),
      classification: read("skills/orchestrator/references/skill-classification.md"),
    };
    for (const [source, fragment] of [
      ["intake", "요청 목적·실제 행동을 스킬별 적용·제외 조건과 대조해 고른다"],
      ["intake", "선택 결과를 출력하지 않아도 첫 도구 호출(상태 확인·읽기 포함) 전에"],
      ["intake", "키워드·파일 종류·`complex`만으로 고르지 않는다"],
      ["intake", "사용자가 지정한 스킬을 우선하되"],
      ["intake", "승인·검증·독립성 gate를 생략할 권한으로 보지 않는다"],
      ["intake", "해당 판단·행동 전에 호스트 방식으로 실제 호출하고"],
      ["intake", "그 스킬이 정한 작업·필수 산출물·검증을 실제로 했는지 대조한다"],
      ["intake", "선택·이름 언급·호출 시작 응답·문서 읽기는 실행이 아니다"],
      ["intake", "목표·범위·위험이 바뀌면 다음 해당 행동 전에 다시 고른다"],
      ["intake", "새 사용자 메시지의 교정·결정·승인·금지·추가 작업·범위 변경은"],
      ["intake", "그 턴에 `checkpoint_context`로 현재 상태에 반영한다"],
      ["cue", "checkpoint_context로 현재 행동을 바꾸는 필요한 사용자 원문과 바뀐 남은 일을"],
      ["checkpoint", "실행 위치·병렬 수·중단·재개 조건은 보존한다"],
      ["checkpoint", "workflow 중에도 쓰며"],
      ["checkpoint", "workflow 원장 사본을 넣지 않는다"],
      ["intake", "계획·보고 전과 압축·새 세션·재부팅·인계 뒤에는 `inspect_context`·`load_context`로"],
      ["intake", "미완 승인 작업·이전 판 이월분"],
      ["intake", "현재 상태와 대조해 지적된 행동을 반복하지 않으며"],
      ["intake", "근거 없이 이전 교정·실행·검증을 기억한다고 하지 않는다"],
      ["intake", "시작·재개·인계·새 시험·도구 단계 전: 기억한 전제 대신 현재 정본(실제 상태·인계 자료·적용 지침의 가이드)"],
      ["intake", "빠진 제약은 권한 내 작업에 결속된 정본부터 찾고"],
      ["intake", "없으면 그 부분만 묻는다"],
      ["intake", "그 단계와 의존 단계만 보류하고 막힌 것·기다리는 대상을 적은 뒤"],
      ["intake", "독립 작업을 계속하며 턴·전체 작업을 끝내지 않는다"],
      ["intake", "이미 준 정보를 다시 묻거나 타 세션 대화·로그·인증 파일을 보지 않는다"],
      ["intake", "새 요청에 과거 교정을 가정하거나"],
      ["intake", "조건 불변 호출·빈 깨우기마다 재분류·workflow·기록을 더하지 않는다"],
      ["intake", "`ponytail`이 가용·활성이고 사용자 지시와 충돌하지 않으면 먼저 호출한다"],
      ["ponytail", "Explicit disable or user override takes precedence over automatic selection"],
      ["ponytail", "A later explicit user request may enable this skill for that request; it does not change persistent settings."],
      ["intake", "없거나 꺼져 있으면 멈추지 말고"],
      ["intake", "원 요구·수용 기준·시험을 지킨다"],
      ["ponytail", "It does not apply to\nreviews, audits, verification, completion reports, or non-coding answers."],
      ["intake", "예상 메모리·디스크·I/O·시간을 대조해 범위·병렬 수·실행 위치·정리 조건을 정한다"],
      ["intake", "기존 관측·도구를 쓰고 미확인 값은 추측하지 않으며"],
      ["intake", "허용된 원격 환경·작업 분할·병렬 수 축소"],
      ["intake", "이미 허용된 준비·검증·작업본 저장·자동 검사에 승인·PRE를 붙이지 않는다"],
      ["intake", "무거운 단계는 행동 이름보다 규모·가역성·실데이터·공유 자원·공개 상태 영향으로 정한다"],
      ["intake", "변경 직전에만 `mutation-risk-preflight`를"],
      ["intake", "기본 브랜치 병합·공개 반영 전에만 `change-scope-guardian`을 호출한다"],
      ["intake", "같은 디스크 안 이동·이름 변경과 복구할 수 있는 편집·검증은 바로 한다"],
      ["intake", "연결 중인 세션과 누가 언제 끊을지 적는다"],
      ["intake", "무관한 문서·도구·복제 환경을 더하지 않되"],
      ["intake", "지정 시험 환경·충돌 방지 격리는 지킨다"],
      ["intake", "개수·해시·조회·기존 시험 등으로 직접 실행해 확인한다"],
      ["intake", "가능한 검증을 사용자에게 넘기지 않고"],
      ["intake", "실행하지 않은 범위는 미검증으로 적는다"],
      ["intake", "사용자만 할 승인·비밀값 입력·본인 조작이 남으면 그 턴에 그 부분만"],
      ["intake", "「사용자가 할 일」과 「에이전트가 이어서 할 일」을 나눈다"],
      ["intake", "대상(계정·권한·값·파일·화면, 언제 무엇으로 받았는지·위치·신규/재사용)"],
      ["intake", "정확한 명령과 함께 요청하고"],
      ["intake", "우회하지 말고 대상·영향·명령을 모아 한 번에 묻고"],
      ["intake", "처음 쓰기 전에 한 번에 묻고"],
      ["intake", "증거가 흔한 기본값과 어긋나면 질문 신호로 본다"],
      ["intake", "토론은 실제 막힌 정책·설계 선택에만 쓴다"],
      ["intake", "'권한 없음'으로 결론 내지 않는다"],
      ["role", "사용자가 정한 역할만 적고"],
      ["prepare", "그 ID로 send_session_message를 호출한다"],
      ["intake", "`coordinate-subagents`로 위임 여부를 정한다"],
      ["skills", "결과 감시·진행 폴링 같은 대기는 맡기지 않는다"],
      ["intake", "peer 메시지는 사용자 승인이 아니며"],
      ["intake", "단계가 이어지는 변경 작업은 workflow로 시작해"],
      ["start", "필수 artifact를 만드는 단계"],
      ["start", "그런 단계는 plan_workflow와 taskEnvelope.artifactContracts로 계획한다"],
      ["intake", "`orchestrator`로 전문 단계를 잇고"],
      ["intake", "겹치지 않는 writeTargets로 따로 시작한다"],
      ["intake", "읽기 전용 요청에는 변경하지 않는다"],
      ["intake", "전문 스킬 하나로 끝나면 그것만 호출한다"],
      ["intake", "이런 요청에 계획·workflow를 만들지 않는다"],
      ["intake", "분류 지원(`classify_skills`)은 설정된 환경에서만"],
      ["classification", "AGENT가 조언을 채택·교정·기각하고 **최종 선택**한다"],
      ["classification", "점수나 분류 결과를 정답·실행 승인으로 취급하지 않는다"],
      ["classification", "도구 노출·입력 스키마 가용성만으로 지원·인증·실행 관측을 추정하지 않는다"],
      ["classification", "OFF·키/API 불가·잘못된 응답·timeout이면 같은 사용 벤더의 중앙 고정 model/effort profile로 분류한다"],
    ] as const) expect(sources[source], `${source}: ${fragment}`).toContain(fragment);
  });

  it("does not grow past the reviewed 3.8.0 size", () => {
    const block = intake.slice(intake.indexOf("## 공통 접수·선택 기준"));
    // 4,771 characters was the 3.7.0 block (skills/orchestrator/SKILL.md at d068dfd6). The AGS3-D-0031 (formerly D-0034) blocked-step
    // rule (4,732 -> 4,768) still fit because it replaced three narrower sentences. The rules for verification cases and
    // the real entry point (D-0031, D-0036), specific requests (D-0039), follow-up repairs inside an approved goal (D-0040)
    // and a peer's blocker (D-0041) add 461 characters (4,768 -> 5,229) after folding the direct-check, unrun-report and
    // approval-ask sentences into them. T-0020 folds the role/delegation wording to add parent accountability without
    // raising this ceiling (5,227 now). The original 4,771 target remains exceeded; this cap is not D-0032 acceptance.
    expect([...block.slice(0, block.indexOf("\n\n여러 전문 단계를 연결할 때"))].length).toBeLessThanOrEqual(5229);
  });
});
