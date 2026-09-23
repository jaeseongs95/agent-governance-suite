import { createHash } from "node:crypto";
import type { SemanticDecisionRequestV1 } from "../../../../contracts/types.js";
import type { SemanticDecisionProviderPort, SemanticProviderResultV1 } from "../provider-port.js";

export type FakeSemanticFixture = {
  outcome: "success" | "tie" | "abstain" | "timeout" | "invalid";
  confidence?: number | null;
};

/** Test-only provider. Its marker is never part of advice, observation, or admission evidence. */
export class FakeSemanticDecisionProvider implements SemanticDecisionProviderPort {
  readonly testOnly = "fake" as const;

  constructor(private readonly seed: string, private readonly fixture: FakeSemanticFixture) {}

  async evaluate(request: Readonly<SemanticDecisionRequestV1>): Promise<SemanticProviderResultV1> {
    switch (this.fixture.outcome) {
      case "abstain": return { status: "abstained" };
      case "timeout": return { status: "timeout" };
      case "invalid": return { status: "invalid" };
      case "success":
      case "tie": {
        const options = request.options;
        if (options.length < (this.fixture.outcome === "tie" ? 2 : 1)) return { status: "invalid" };
        const index = createHash("sha256").update(JSON.stringify([this.seed, request.requestDigest]))
          .digest().readUInt32BE(0) % options.length;
        const selectedOptionIds = [options[index]!.optionId];
        if (this.fixture.outcome === "tie") selectedOptionIds.push(options[(index + 1) % options.length]!.optionId);
        return { status: "success", choice: { kind: "Choice", selectedOptionIds, confidence: this.fixture.confidence ?? null } };
      }
    }
  }
}
