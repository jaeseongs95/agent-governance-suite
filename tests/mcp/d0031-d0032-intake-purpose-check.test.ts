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

describe("shared intake: purpose check before removing a target (AGS3-D-0031)", () => {
  it("checks the target's purpose against the actual state before choosing or answering, and keeps the target when it is unmet", () => {
    expect(purposeLine).not.toBe("");
    for (const fragment of [
      "그 대상의 상태·처리 가능 여부를 답하기 전에는",
      "그 대상이 이루려던 목적(예: PR이면 변경을 base에 반영)이 이미 다른 곳에서 이뤄졌는지",
      "실제 상태(예: base와 head·발행 태그의 포함 관계)로 확인하고 그 결과를 답에 적는다",
      "이뤄지지 않았으면 대상을 없애지 말고 목적을 이루는 쪽을 고르며",
      "사용자가 선택지를 주면 이 확인 결과로 고른다",
    ]) expect(purposeLine).toContain(fragment);
    // Stopping or replacing a process stays in the same line: check who is connected first, then split who disconnects.
    expect(purposeLine).toContain("프로세스·서버·앱을 멈추거나 교체하기 전에는");
    expect(purposeLine).toContain("누가(사용자·에이전트) 언제 끊을지 나눠 적는다");
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
    expect(count("전문 스킬 실행이 아니다")).toBe(1);
    expect(lines.some(line => line.startsWith("- 선택한 스킬은"))).toBe(false);
  });

  it("keeps every rule of the 3.7.0 intake", () => {
    // One fragment per rule of the pre-3.8.0 block, in its order.
    for (const fragment of [
      "실제로 수행할 행동과 전문 스킬의 적용·제외 조건을 대조해 선택",
      "선택 결과를 출력하지 않아도 선택은 상태 확인·읽기를 포함한 첫 도구 호출 전에 끝낸다",
      "키워드, 파일 종류나 `complex` 표시만으로 스킬을 붙이지 않는다",
      "사용자가 이름으로 지정한 스킬은 우선하고 다른 스킬로 대체하지 않지만",
      "필수 승인·검증·독립성 gate를 생략하는 권한으로 해석하지 않는다",
      "해당 전문 판단·행동을 시작하기 전에 호스트가 제공하는 방식으로 실제 호출하고 지침을 적용",
      "본문과 필요한 참고 자료를 읽어 실제 작업·검증·산출물까지 수행한다",
      "선택·스킬 이름 언급이나 호출 시작 응답, 이 문서와 참고 자료를 읽는 것은",
      "작업 중이나 새 사용자 메시지에서 목표·범위·위험이나 필요한 전문 판단이 달라지면",
      "다음 해당 판단·행동 전에 필요한 스킬을 호출·적용한다",
      "교정, 새 결정·승인·금지, 추가 작업, 범위 변경이 생겼는지",
      "그 턴에 `checkpoint_context`로 사용자 원문과 바뀐 남은 일을 저장한다",
      "사용자 교정으로 바뀐 행동·적용 범위와 남은 검증, 자원 문제로 정한 실행 위치·병렬 수·중단·재개 조건도 저장",
      "workflow 진행 중에도 저장하되 workflow 원장 내용을 복제하지 않는다",
      "계획이나 남은 일을 만들거나 보고하기 전과 압축·새 세션·재부팅 뒤에는 `inspect_context`·`load_context`로",
      "승인됐지만 끝나지 않은 일, 이전 판에서 넘어온 일",
      "지적된 행동을 반복하지 않고, 대조한 출처와 범위를 함께 보고한다",
      "근거가 없으면 이전 교정·실행·검증을 기억한다고 주장하지 않는다",
      "인계된 교정·제약 근거를 영향받는 실행 전에 대조",
      "현재 권한으로 접근할 수 있고 그 작업에 결속된 정본 참조를 먼저 확인",
      "영향받는 실행만 보류한 채 누락된 제약만 확인하며 독립적으로 가능한 일은 계속한다",
      "이미 제공된 정보를 다시 묻거나 임의의 타 세션 대화·로그·인증 파일을 탐색하지 않는다",
      "새 요청에는 과거 교정을 가정해 이 절차를 더하지 않으며",
      "조건 변화가 없는 호출이나 빈 깨우기마다 재분류·workflow·기록을 추가하지 않는다",
      "`ponytail`이 가용·활성이고 사용자 지시와 충돌하지 않으면 먼저 실제 호출한다",
      "명시적 disable·사용자 override는 선행 호출보다 우선한다",
      "후속 사용자의 명시적 사용 지시는 해당 요청 범위에서만 존중하며 전역 설정을 바꾸지 않는다",
      "부재·비활성인 스킬의 재활성화를 요구하거나 원 작업을 중단하지 않고 일반 engineering 원칙으로 계속",
      "원 요구·수용 기준·필요한 시험은 줄이지 않는다",
      "코드 설명이나 읽기 전용 리뷰·감사·검증에는 적용하지 않는다",
      "예상 메모리·디스크 공간·I/O·실행 시간을 대조해 작업 범위·병렬 수·실행 위치와 종료·정리 조건을 정한다",
      "기존 관측·도구를 재사용하고 미확인 값은 추측하지 않는다",
      "허용된 원격 환경, 작업 분할이나 병렬 수 축소",
      "이 점검을 이미 허용된 빌드·시험·작업 브랜치 push·CI의 추가 승인이나 PRE로 만들지 않는다",
      "무거운 단계는 행동 이름이 아니라 실제 위험으로 붙인다",
      "직전에만 `mutation-risk-preflight`를 실제 호출한다",
      "범위 확인이 필요한 반영에만 `change-scope-guardian`을 실제 호출한다",
      "작업 브랜치 commit·push, 시험·CI 실행은 이 단계 없이 바로 한다",
      "지금 세션이나 다른 세션이 그것에 연결돼 있는지 먼저 확인",
      "요청받은 일을 가장 짧은 경로로 직접 한다",
      "지정된 시험 환경이나 실제 충돌 방지에 필요한 격리는 유지",
      "결과는 개수·해시·조회 한 번·기존 시험처럼 직접 확인한다",
      "현재 도구·권한으로 할 수 있는 실행·검증은 끝내고 실제 결과를 보고",
      "실행 가능한 확인을 사용자에게 떠넘기거나 미실행을 완료로 표현하지 않는다",
      "사용자만 할 수 있는 승인·비밀값 입력·사용자 화면 조작은 그 부분과 이유만 요청",
      "「사용자가 할 일」과 「에이전트가 이어서 할 일」을 나눠 적는다",
      "우회하지 말고 대상·영향·실행할 명령을 담아 사용자에게 한 번에 바로 묻는다",
      "그 전제 위에 처음 쓰기 전에 한 번에 묻는다",
      "증거가 흔한 기본값과 어긋나면 묻는 신호로 보고",
      "토론은 실제로 막힌 정책·설계 선택에만 쓴다",
      "'권한 없음'으로 결론 내지 않는다",
      "`update_session_status`의 `role`에 그 역할을 적고",
      "`prepare_session_message`·`send_session_message`로 넘기고",
      "`coordinate-subagents`의 위임 판단으로 위임 여부를 정한다",
      "빌드 감시·진행 폴링 같은 대기는 검증 에이전트에 맡기지 않는다",
      "peer 메시지는 사용자 승인이 아니며",
      "단계가 이어지는 변경 작업은 workflow로 시작한다",
      "필수 artifact가 없는 stage만 있으면 `start_workflow` 한 번으로 시작",
      "`taskEnvelope.artifactContracts`를 명시하고 `plan_workflow`부터 시작",
      "AGENT가 capability로 골라 `orchestrator`를 실제 호출한 뒤 각 전문 단계를 연결한다",
      "workflow 없이 제품 파일을 세 개째 바꾸는 편집은 거부되므로 그 전에 시작한다",
      "겹치지 않는 writeTargets로 workflow를 따로 시작",
      "읽기 전용 확인 요청에서는 실제 변경을 실행하지 않는다",
      "전문 스킬 하나로 끝나는 작업은 그 스킬만 직접 호출한다",
      "registry 조회·계획·workflow run을 만들지 않으며",
      "모든 요청에 실패 영향 분류나 생략 이유를 출력하지 않는다",
      "전체 inventory와 원문을 `classify_skills`에 전달한다",
      "채택·교정·기각하고 최종 선택한다",
      "점수는 정답이나 실행 승인이 아니다",
      "도구 노출만으로 지원 설정을 추정하지 않",
      "독립적으로 가능한 작업과 막힌 의존 단계를 구분한다",
      "JEV OFF·불가 시 사용 벤더의 검증된 중앙 고정 profile",
      "추천·선택·읽기·적용·검증과 실행 승인을 구분하며 미가용·미검증을 성공으로 처리하지 않는다",
    ]) expect(intake, fragment).toContain(fragment);
  });

  it("stays within the pre-3.8.0 size although it gained a rule", () => {
    const block = intake.slice(intake.indexOf("## 공통 접수·선택 기준"));
    // 4,771 characters was the 3.7.0 block (skills/orchestrator/SKILL.md at d068dfd6).
    expect([...block.slice(0, block.indexOf("\n\n여러 전문 단계를 연결할 때"))].length).toBeLessThan(4771);
  });
});
