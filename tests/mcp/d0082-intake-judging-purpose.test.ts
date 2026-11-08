import { describe, expect, it } from "vitest";

import { serverInstructions } from "../../mcp-server/src/server.js";
import { skillIntakeText } from "../../mcp-server/src/skill-intake.js";

// AGS3-D-0082: a reviewing agent marked another agent's work VERIFIED because the author's own failure list was closed,
// its completion report said so and its tests passed. Nobody compared the result with what the product was for (the host
// screen, seen and driven as is from a remote or mobile client), so an empty remote workspace, no mobile layout and a
// relay that dropped all terminal output were approved. The shared purpose check ran only before making or recommending,
// and the pre-report comparison covered only the acceptance criteria, which the author had written.
// The rule sits in the shared intake, so it reaches every host and every kind of judged work.
const intake = skillIntakeText("ko");
const lines = intake.split("\n");
const purposeCheck = lines.find(line => line.startsWith("1. ")) ?? "";
const verification = lines.find(line => line.startsWith("3. ")) ?? "";

describe("shared intake: judging someone else's result (AGS3-D-0082)", () => {
  it("sets the purpose sentence before judging, not only before making or recommending", () => {
    expect(purposeCheck.startsWith("1. 만들거나 권고·판정하기 전:")).toBe(true);
  });

  it("treats a received report or pass claim as something to check, against the purpose as well as the criteria", () => {
    expect(verification).toContain("보고·전달·판정(받은 보고·통과 주장 포함)·다음 단계 전에는");
    expect(verification).toContain("1의 효과·수용 기준의 대상과 실제 실행한 대상을 하나씩 대조해");
  });

  it("delivers the rule to every host in both locales, within the instructions budget", () => {
    for (const locale of ["ko", "en"] as const) {
      const instructions = serverInstructions(locale);
      expect(instructions).toContain(purposeCheck);
      expect(instructions).toContain(verification);
      expect([...instructions].length).toBeLessThanOrEqual(4000);
    }
  });
});
