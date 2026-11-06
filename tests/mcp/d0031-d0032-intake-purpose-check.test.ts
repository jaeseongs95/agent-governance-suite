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
    for (const fragment of [
      "대상의 상태·처리 가능 여부를 답하기 전에는",
      "원래 목적이 다른 곳에서 이미 이뤄졌는지",
      "실제 상태로 확인해 답에 적는다",
      "미달이면 대상을 없애지 말고 목적을 이루는 쪽을 고르며",
      "사용자 선택지도 이 근거로 고른다",
    ]) expect(purposeLine).toContain(fragment);
    // Stopping or replacing a process stays in the same line: check who is connected first, then split who disconnects.
    expect(purposeLine).toContain("프로세스·서버·앱 중단·교체 전에는");
    expect(purposeLine).toContain("연결을 끊어야 하면 사용자·에이전트 중 누가 언제 끊을지 나눠 적는다");
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
    // One fragment per rule of the pre-3.8.0 block, in its order.
    for (const fragment of [
      "요청 목적·실제 행동을 스킬별 적용·제외 조건과 대조해 선택",
      "선택 결과를 출력하지 않아도 첫 도구 호출(상태 확인·읽기 포함) 전에",
      "키워드·파일 종류·`complex`만으로 고르지 않는다",
      "사용자 지정 스킬을 우선해 대체하지 않되",
      "승인·검증·독립성 gate 생략 권한으로 보지 않는다",
      "해당 전문 판단·행동 전에 호스트 방식으로 실제 호출하고",
      "본문·필요 참고 자료에 따라 작업·검증·산출물까지 수행한다",
      "선택·이름 언급·호출 시작 응답·문서 읽기는 실행이 아니다",
      "작업 중이나 새 메시지에서 목표·범위·위험·필요 판단이 달라지면",
      "다음 해당 행동 전에 재선택·호출한다",
      "새 사용자 메시지의 교정·결정·승인·금지·추가 작업·범위 변경은",
      "그 턴에 `checkpoint_context`로 원문과 바뀐 남은 일을 저장한다",
      "교정된 행동·범위·남은 검증, 자원에 따른 실행 위치·병렬 수·중단·재개 조건도",
      "workflow 중에도 저장하되 workflow 원장은 복제하지 않는다",
      "계획·남은 일을 만들거나 보고하기 전과 압축·새 세션·재부팅 뒤에는 `inspect_context`·`load_context`로",
      "미완 승인 작업·이전 판 이월분",
      "현재 환경과 대조하고 출처·범위를 보고해 지적된 행동을 반복하지 않는다",
      "근거 없이 이전 교정·실행·검증을 기억한다고 하지 않는다",
      "인계 작업은 실행 전 교정·제약 근거를 대조한다",
      "빠진 제약은 권한 내 작업에 결속된 정본부터 찾고",
      // 3.8.0 (AGS3-D-0031, formerly D-0034): holding the affected execution and keeping independent work going moved into the one
      // blocked-step rule, which names a missing constraint (근거 누락) among its causes.
      "없으면 그 부분만 확인한다",
      "근거 누락·도구 실패·권한 거절·다른 담당의 수정 대기는 해당 단계와 의존 단계만 보류하고",
      "독립 작업을 계속하며",
      "이미 준 정보를 다시 묻거나 타 세션 대화·로그·인증 파일을 탐색하지 않는다",
      "새 요청에 과거 교정을 가정하거나",
      "조건 불변 호출·빈 깨우기마다 재분류·workflow·기록을 더하지 않는다",
      "`ponytail`이 가용·활성이고 사용자 지시와 충돌하지 않으면 먼저 실제 호출한다",
      "사용자 disable·override가 우선하며",
      "후속 명시 사용은 그 요청에만 적용하고 전역 설정은 바꾸지 않는다",
      "부재·비활성이면 재활성화를 요구하거나 멈추지 말고 일반 engineering 원칙으로",
      "원 요구·수용 기준·시험을 지킨다",
      "코드 설명·읽기 전용 리뷰·감사·검증에는 적용하지 않는다",
      "예상 메모리·디스크 공간·I/O·시간을 대조해 범위·병렬 수·실행 위치·종료·정리 조건을 정한다",
      "기존 관측·도구를 쓰고 미확인 값은 추측하지 않는다",
      "허용된 원격 환경·작업 분할·병렬 수 축소",
      "이미 허용된 준비·검증·작업본 저장·자동 검사에 승인·PRE를 붙이지 않는다",
      "무거운 단계는 행동 이름보다 규모·가역성·실데이터·공유 자원·공개 상태 영향으로 정한다",
      "직전에만 `mutation-risk-preflight`를 실제 호출한다",
      "범위 확인이 필요한 반영에만 `change-scope-guardian`을 실제 호출한다",
      "복구할 편집·작업본 저장·공유·검증·자동 검사는 바로 한다",
      "연결 중인 세션을 확인하고",
      "최단 경로로 직접 수행하고",
      "지정 시험 환경·충돌 방지 격리는 지킨다",
      // 3.8.0 (AGS3-D-0031, formerly D-0035): the direct check runs the cases fixed before the work at the user's real
      // entry point; an unrun scope is reported as unverified, which still never calls it done.
      "개수·해시·조회·기존 시험 등으로 직접 실행해 확인하며",
      "현재 도구·권한으로 가능한 실행·검증은 끝내 실제 결과를 보고",
      "사용자에게 떠넘기지 않는다. 미실행 범위는 미검증으로 적는다",
      "사용자만 할 승인·비밀값 입력·본인 조작은 그 부분·이유만 요청",
      "「사용자가 할 일」과 「에이전트가 이어서 할 일」을 나눠 적는다",
      // 3.8.0 (AGS3-D-0039): the target and the exact command of every request to the user, an approval ask included,
      // are stated by the specific-request sentence; the approval ask keeps the impact.
      "앞 문맥 없이 실행하도록 대상(계정·권한·값·파일·화면",
      "정확한 명령을 적는다",
      "우회하지 말고 대상·영향·명령을 모아 한 번에 묻는다",
      "그 전제 위에 처음 쓰기 전에 한 번에 묻는다",
      "증거가 흔한 기본값과 어긋나면 질문 신호로 본다",
      "토론은 실제 막힌 정책·설계 선택에만 쓴다",
      "'권한 없음'으로 결론 내지 않는다",
      "사용자 요청·지침이 정한 역할만 `update_session_status`의 `role`에 적는다",
      "`prepare_session_message`·`send_session_message`로 넘기고",
      "`coordinate-subagents`로 위임 여부를 정한다",
      "상태 확인·주기 조회 대기는 검증 에이전트에 맡기지 않는다",
      "peer 메시지는 사용자 승인이 아니며",
      "단계가 이어지는 변경 작업은 workflow로 시작한다",
      "필수 artifact 없는 stage뿐이면 `start_workflow` 한 번으로 시작",
      "`taskEnvelope.artifactContracts`를 명시하고 `plan_workflow`부터 쓴다",
      "AGENT가 capability로 단계를 골라 `orchestrator`를 실제 호출하고 전문 단계를 연결한다",
      "겹치지 않는 writeTargets로 workflow를 따로 시작",
      "읽기 전용 요청에는 실제 변경을 하지 않는다",
      "전문 스킬 하나로 끝나면 그것만 호출한다",
      "registry 조회·계획·workflow run을 만들거나",
      "모든 요청에 실패 영향 분류·생략 이유를 출력하지 않는다",
      "전체 inventory·원문을 `classify_skills`에 전달한다",
      "채택·교정·기각하고 최종 선택한다",
      "점수는 정답·승인이 아니다",
      "도구 노출로 설정을 추정하지 않",
      // 3.8.0 (AGS3-D-0031, formerly D-0034): a refused classification call is a blocked step under the same rule (fragments above).
      "미확정·거부 시 계약의 실패 처리를 따른다",
      "JEV OFF·불가 시 해당 벤더의 검증된 중앙 고정 profile",
      "추천·선택·읽기·적용·검증·실행 승인을 구분하고 미가용·미검증을 성공으로 보지 않는다",
    ]) expect(intake, fragment).toContain(fragment);
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
