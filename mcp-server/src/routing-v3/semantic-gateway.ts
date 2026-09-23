/** Optional MCP boundary for the server-owned semantic routing service. */
import {
  WorkflowContractError, type ApiResultV1,
} from "../../../contracts/types.js";
import { ContractValidator } from "../schema-validator.js";
import type { SemanticRoutingService, SemanticServiceOutcome } from "./semantic-service.js";

export interface SemanticMcpGateway {
  resolve(input: unknown): Promise<ApiResultV1<SemanticServiceOutcome>>;
}

export function createSemanticGateway(service: Pick<SemanticRoutingService, "resolve">): SemanticMcpGateway {
  const validator = new ContractValidator();
  return { async resolve(input) {
    try {
      const assignment = validator.semanticModelAssignmentRequestV1(input);
      const data = await service.resolve(assignment);
      return { schemaVersion: "1.0.0", ok: true, data, error: null };
    } catch (error) {
      const body = error instanceof WorkflowContractError
        ? error.toBody()
        : { code: "MCP_UNAVAILABLE" as const, message: "Semantic routing service is unavailable.", details: null };
      return { schemaVersion: "1.0.0", ok: false, data: null, error: body };
    }
  } };
}
