import { WorkflowContractError } from "../../../../contracts/types.js";
import { type CollectorScopeV1, type ResourceCollectorPortV1, type ResourceCollectorResponseV1,
  validateCollectorResponseV1, validateCollectorScopeV1 } from "../collector-port.js";

/** Offline fixture/operator adapter. Its identity cannot claim provider reporting. */
export class FakeResourceCollectorV1 implements ResourceCollectorPortV1 {
  readonly scope: CollectorScopeV1;
  private readonly responses: ResourceCollectorResponseV1[];

  constructor(scope: CollectorScopeV1, responses: unknown[]) {
    const checked = validateCollectorScopeV1(scope);
    if (checked.source !== "fake" && checked.source !== "operator-configured") {
      throw new WorkflowContractError("INVALID_INPUT", "A fake collector cannot report provider observations.");
    }
    if (!Array.isArray(responses)) throw new WorkflowContractError("INVALID_INPUT", "Fake responses must be an array.");
    this.scope = Object.freeze(structuredClone(checked));
    this.responses = responses.map((response) => validateCollectorResponseV1(response, this.scope));
  }

  async collect(): Promise<ResourceCollectorResponseV1> {
    const response = this.responses.shift();
    if (!response) throw new WorkflowContractError("MCP_UNAVAILABLE", "Fake collector has no queued response.");
    return structuredClone(response);
  }
}
