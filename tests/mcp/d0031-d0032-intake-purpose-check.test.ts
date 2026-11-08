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
      "그 가능 여부를 답하기 전엔",
      "원래 목적이 이미 이뤄졌는지 실제 상태로 확인해",
      "답과 선택지에 반영하고",
      "미달이면 대상을 없애지 말고 목적을 이루는 쪽을 고른다",
    ]) expect(purposeLine).toContain(fragment);
    // Stopping a process stays in the same line: the connected sessions first, then who disconnects and when.
    expect(purposeLine).toContain("프로세스·서버·앱을 멈추거나 바꾸기 전엔");
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
    // session-start skill line (until 4.0.0), the minimal-implementation skill (ponytail until 4.0.0) and the
    // classification contract.
    // 4.0.0 (token optimization) shortened the wording again and moved, without dropping, the rules that belong to one
    // skill or tool into the text read when it is chosen or called: the minimal-implementation, mutation-risk-preflight,
    // change-scope-guardian and coordinate-subagents descriptions (English, as installed), the checkpoint_context tool
    // description and the classify_skills tool description (MODEL_LOCALE catalog, en).
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const read = (relative: string) => readFileSync(`${root}${relative}`, "utf8");
    const tools = JSON.parse(read("locales/ko/tools.json")) as Record<string, string>;
    const modelTools = JSON.parse(read("locales/en/tools.json")) as Record<string, string>;
    const description = (skill: string) => /^description: (.*)$/mu.exec(read(`skills/${skill}/SKILL.md`))?.[1] ?? "";
    const hooks = JSON.parse(read("locales/ko/hooks.json")) as Record<string, string>;
    const sources: Record<string, string> = {
      intake,
      cue: hooks["hooks.checkpointCue.save"]!,
      checkpoint: tools["tools.checkpoint_context.description"]!,
      role: tools["tools.update_session_status.description"]!,
      prepare: tools["tools.prepare_session_message.description"]!,
      start: tools["tools.start_workflow.description"]!,
      "minimal-implementation": read("skills/minimal-implementation/SKILL.md"),
      "minimal-implementation description": description("minimal-implementation"),
      "mutation-risk-preflight": description("mutation-risk-preflight"),
      "change-scope-guardian": description("change-scope-guardian"),
      "coordinate-subagents": description("coordinate-subagents"),
      classify: modelTools["tools.classify_skills.description"]!,
      classification: read("skills/orchestrator/references/skill-classification.md"),
    };
    for (const [source, fragment] of [
      ["intake", "요청 목적·실제 행동을 스킬별 적용·제외 조건과 대조해 고른다"],
      ["intake", "첫 도구 호출(읽기 포함) 전, 출력 없이도"],
      ["intake", "키워드·파일 종류·`complex`만으로 고르지 않는다"],
      ["intake", "사용자 지정 스킬은 대체하지 않되"],
      ["intake", "승인·검증·독립성 gate 생략 권한은 아니다"],
      ["intake", "그 판단·행동 전에 호스트 방식으로 실제 호출하고"],
      ["intake", "완료 보고 전 그 스킬의 작업·필수 산출물·검증을 실제로 했는지 대조한다"],
      ["intake", "선택·이름 언급·호출 시작 응답·문서 읽기는 실행이 아니다"],
      ["intake", "목표·범위·위험·필요 판단이 바뀌면 다음 해당 행동 전에 다시 고른다"],
      ["intake", "새 사용자 메시지의 교정·결정·승인·금지·추가 작업·범위 변경은"],
      ["intake", "그 턴에 `checkpoint_context`로 반영한다"],
      ["cue", "교정·결정·승인·금지·추가 작업·범위 변경이면 스킬을 다시 고른 뒤 checkpoint_context로 반영한다"],
      ["checkpoint", "현재 행동을 바꾸는 필요한 사용자 원문은 보존하고"],
      ["checkpoint", "미완료·다음 행동"],
      ["checkpoint", "실행 위치·병렬 수·중단·재개 조건은 보존한다"],
      ["checkpoint", "workflow 중에도 쓰며"],
      ["checkpoint", "workflow 원장 사본을 넣지 않는다"],
      ["intake", "계획·보고 전과 압축·새 세션·재부팅·인계 뒤엔 `inspect_context`·`load_context`로"],
      ["intake", "미완 승인 작업·이전 판 이월분"],
      ["intake", "현재 상태와 대조해 출처·범위를 보고하고, 지적된 행동 반복"],
      ["intake", "근거 없는 이전 교정·실행·검증 기억 주장을 하지 않는다"],
      ["intake", "시작·재개·인계·새 시험·도구 단계 전: 기억한 전제 대신 현재 정본(실제 상태·인계 자료·적용 지침의 가이드)"],
      ["intake", "빠진 제약은 권한 내 작업에 결속된 정본부터 찾고"],
      ["intake", "없으면 그 부분만 묻는다"],
      ["intake", "그 단계와 의존 단계만 보류하고 막힌 것·기다리는 대상을 적은 뒤"],
      ["intake", "독립 작업을 계속하며 턴·전체 작업을 끝내지 않는다"],
      ["intake", "준 정보 재질문, 타 세션 대화·로그·인증 파일 열람 금지"],
      ["intake", "새 요청에 과거 교정 가정"],
      ["intake", "조건 불변 호출·빈 깨우기마다 재분류·workflow·기록 추가 금지"],
      ["minimal-implementation description", "Use when making or changing any output (code, docs, data, config, procedures)"],
      ["minimal-implementation description", "invoke it first when available, active and not against user instructions"],
      ["intake", "사용자 disable·override가 우선하며"],
      ["intake", "후속 명시 사용은 그 요청에만 적용하고 전역 설정은 바꾸지 않는다"],
      ["intake", "없거나 꺼져 있으면 재활성화를 요구하거나 멈추지 말고"],
      ["intake", "원 요구·수용 기준·시험을 지킨다"],
      ["minimal-implementation", "검토·감사·검증·완료 판정, 설명·조사만 하는 답에는 적용하지 않는다"],
      ["intake", "확인한 환경·동시 작업과 예상 메모리·디스크·I/O·시간을 대조해 범위·병렬 수·실행 위치·종료·정리 조건을 정한다"],
      ["intake", "기존 관측·도구를 쓰고 미확인 값은 추측하지 않으며"],
      ["intake", "허용된 원격 환경·작업 분할·병렬 수 축소"],
      ["intake", "이미 허용된 준비·검증·작업본 저장·자동 검사에 승인·PRE를 붙이지 않는다"],
      ["mutation-risk-preflight", "Judge heaviness by scale, reversibility, real data, shared resources and public-state impact, not the action's name."],
      ["mutation-risk-preflight", "Right before a hard-to-reverse change or one affecting others (permanent delete or overwrite, production data change or migration, deploy or publish, permission, payment or global setting change)"],
      ["change-scope-guardian", "Call only when work overlaps other work or before a default-branch merge or publication."],
      ["mutation-risk-preflight", "Same-disk moves and renames, reversible local edits and checks, and test or work-branch pushes are just done, without this skill"],
      ["intake", "연결 중인 세션과 누가 언제 끊을지 적는다"],
      ["intake", "무관한 문서·도구·복제 환경은 더하지 않되"],
      ["intake", "지정 시험 환경·충돌 방지 격리는 지킨다"],
      ["intake", "개수·해시·조회·기존 시험 등으로 직접 실행한다"],
      ["intake", "가능한 검증을 사용자에게 넘기지 않고"],
      ["intake", "실행하지 않은 범위는 미검증으로 적는다"],
      ["intake", "사용자만 할 승인·비밀값 입력·본인 조작이 남으면 그 턴에 그 부분만"],
      ["intake", "「사용자가 할 일」과 「에이전트가 이어서 할 일」을 나눈다"],
      ["intake", "대상(계정·권한·값·파일·화면, 언제 무엇으로 받았는지·위치·신규/재사용)"],
      ["intake", "정확한 명령과 함께 요청하고"],
      ["intake", "우회하지 말고 대상·영향·명령을 모아 한 번에 묻는다"],
      ["intake", "처음 쓰기 전에 한 번에 묻는다"],
      ["intake", "증거가 흔한 기본값과 어긋나면 질문 신호다"],
      ["intake", "토론은 실제 막힌 정책·설계 선택에만 쓴다"],
      ["intake", "'권한 없음'으로 결론 내지 않는다"],
      ["role", "사용자가 정한 역할만 적고"],
      ["prepare", "그 ID로 send_session_message를 호출한다"],
      ["intake", "`coordinate-subagents`로 위임 여부를 정한다"],
      ["coordinate-subagents", "never hands off waiting (watching results, polling)"],
      ["intake", "peer 메시지는 사용자 승인이 아니며"],
      ["intake", "단계가 이어지는 변경 작업은 workflow로 시작해"],
      ["start", "필수 artifact를 만드는 단계"],
      ["start", "그런 단계는 plan_workflow와 taskEnvelope.artifactContracts로 계획한다"],
      ["intake", "`orchestrator`로 전문 단계를 잇고"],
      ["intake", "겹치지 않는 writeTargets로 따로 시작한다"],
      ["intake", "읽기 전용 요청엔 변경하지 않는다"],
      ["intake", "전문 스킬 하나로 끝나면 그것만 호출한다"],
      ["intake", "이런 요청에 registry 조회·계획·workflow·감사를 만들지 않는다"],
      ["classify", "Do not assume classification support is configured only because this tool is exposed."],
      ["classify", "follow the shared classification contract failure handling"],
      ["classification", "AGENT가 조언을 채택·교정·기각하고 **최종 선택**한다"],
      ["classification", "점수나 분류 결과를 정답·실행 승인으로 취급하지 않는다"],
      ["classification", "도구 노출·입력 스키마 가용성만으로 지원·인증·실행 관측을 추정하지 않는다"],
      // 4.0.0 (user decision): the vendor fallback after a JEV failure became the signed opt-in fallback evaluator.
      ["classification", "JEV OFF면 사용 벤더의 중앙 고정 model/effort profile로 분류한다"],
      ["classification", "페이지에서 고른 대체 평가자가 있을 때만 그 벤더로 한 번 더 분류하고, 없으면 조언 없이 AGENT가 직접 고른다"],
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
