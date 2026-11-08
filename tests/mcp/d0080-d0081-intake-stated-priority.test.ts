import { describe, expect, it } from "vitest";

import { serverInstructions } from "../../mcp-server/src/server.js";
import { skillIntakeText } from "../../mcp-server/src/skill-intake.js";

// AGS3-D-0080: a user said security came first, and the agent still offered the convenient weaker option (a plaintext
// leg) as the default recommendation, correcting it only after the user objected. The shared purpose check compared the
// design with its effect only, never with the priorities and constraints the user had stated; the rule against shipping
// a reduced substitute lived only in ponytail, which covers code alone.
// AGS3-D-0081: a user pasted another agent's conversation and asked to register a defect; the agent judged the purpose
// by the pasted material's subject (the product it was about) instead of why it was given to this session's role.
// Both rules sit in the shared purpose check, so they reach every host and every kind of task.
const intake = skillIntakeText("ko");
const purposeCheck = intake.split("\n").find(line => line.startsWith("1. 만들거나 ")) ?? "";

describe("shared intake: stated priorities and the reason material was given (AGS3-D-0080, AGS3-D-0081)", () => {
  it("checks a recommendation against the user's stated priorities and constraints and does not default to a weaker option", () => {
    expect(purposeCheck).toContain("사용자가 밝힌 우선순위·제약을 지키는지 대조해");
    expect(purposeCheck).toContain("이를 낮춘 안을 기본으로 내밀지 않는다");
  });

  it("reads pasted material by why it was given to this session's role, not by its subject", () => {
    expect(purposeCheck).toContain("붙인 자료는 소재가 아닌 이 세션 역할에 준 이유로");
  });

  it("delivers both rules to every host in both locales, within the instructions budget", () => {
    for (const locale of ["ko", "en"] as const) {
      const instructions = serverInstructions(locale);
      expect(instructions).toContain(purposeCheck);
      expect([...instructions].length).toBeLessThanOrEqual(4000);
    }
  });
});
