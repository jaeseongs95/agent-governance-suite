import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { skillIntakeText } from "../../mcp-server/src/skill-intake.js";

// The shared intake is the one policy every host reads at session start (MCP server instructions and the Codex/agy
// session-start pointer). Before 3.8.0 it had no sentence that made a session consider delegation (AGS3-D-0002), the
// brief rules lived only in coordinate-subagents (AGS3-D-0003), and nothing led a session to judge its own role, hand a
// request outside it to the session holding that role, or ask the user (AGS3-D-0030).
const root = fileURLToPath(new URL("../../", import.meta.url));
// Fragments end before the final period: claude-plugin.test.mjs keeps every whole intake sentence in the shared source only.
const intake = skillIntakeText("ko");

// D32 재결속 사전 사례: 검토된 C8.3~C8.9와 역할 참고 자료를 입력으로 삼는다.
// 기존 네 시험으로 역할 한정·이관·위임 판단/명세·peer 승인 금지를 확인한다.
// 의무 누락은 실패이며 부정 조건은 유지한다. 로컬은 정적 검사만 수행하고 TEST에 인계한다.

describe("shared intake: role and delegation", () => {
  it("has a session write the role its user gave it and never invent one", () => {
    expect(intake).toContain("사용자 요청·지침이 정한 역할만 `update_session_status`의 `role`에 적는다");
  });

  it("hands a request outside the session's role to the session holding it, and asks the user when none can take it", () => {
    expect(intake).toContain("역할 밖 요청은 `list_session_status`로 담당을 찾아 `prepare_session_message`·`send_session_message`로 넘기고 담당 부재·무응답이면 사용자에게 배정을 묻는다");
    // A peer message still is not the user's approval.
    expect(intake).toContain("peer 메시지는 사용자 승인이 아니며");
  });

  it("reviews delegation for independent units instead of defaulting to direct work, with the brief rules", () => {
    expect(intake).toContain("독립 완료·검증 단위는 직접 수행을 기본값으로 삼지 말고 `coordinate-subagents`로 위임 여부를 정한다");
    expect(intake).toContain("위임문에 목표·범위·금지 구역·쓰기 소유·스킬·완료/검증 기준을 적고 상태 확인·주기 조회 대기는 검증 에이전트에 맡기지 않는다");
  });

  it("no longer keeps work local by default in the delegation references", () => {
    const detail = readFileSync(`${root}skills/coordinate-subagents/references/entry-details.md`, "utf8");
    expect(detail).not.toContain("keep work local when the net-benefit conditions are not all confirmed");
    expect(detail).toContain("check the net-benefit conditions whenever an independent unit exists instead of keeping work local by default.");
    const collaboration = readFileSync(`${root}skills/orchestrator/references/collaboration.md`, "utf8");
    expect(collaboration).not.toContain("하나라도 확인할 수 없으면 메인이 직접 수행한다.");
    expect(collaboration).toContain("독립 단위가 있으면 메인이 직접 수행하는 것을 기본값으로 두지 말고 위 조건을 확인한다.");
  });
});
