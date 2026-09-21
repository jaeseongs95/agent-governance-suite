import { type ApiResultV1, type WorkflowReceiptV1, WorkflowContractError } from "../../contracts/types.js";
import { hasModelRoutingArtifacts, type ModelRoutingWorkflowBridge } from "./model-routing-workflow.js";
import { ContractValidator } from "./schema-validator.js";
import { WorkflowService } from "./workflow-service.js";

/** Adds optional artifact validation; all existing stage and trusted-execution gates remain authoritative. */
export class RoutingAwareWorkflowService extends WorkflowService {
  private readonly routingValidator = new ContractValidator();

  constructor(private readonly routingBridge: ModelRoutingWorkflowBridge | null, ...args: ConstructorParameters<typeof WorkflowService>) {
    super(...args);
  }

  override recordStageResult(rawResult: unknown, requireTrustedExecutionContext = false): ApiResultV1<WorkflowReceiptV1> {
    if (hasModelRoutingArtifacts(rawResult)) {
      try {
        if (!this.routingBridge) throw new WorkflowContractError("BINDING_REQUIRED", "Model routing evidence storage is unavailable.");
        this.routingBridge.validateStageArtifacts(this.routingValidator.stageResult(rawResult));
      } catch (error) {
        return { schemaVersion: "1.0.0", ok: false, data: null, error: error instanceof WorkflowContractError
          ? error.toBody() : { code: "BINDING_INVALID", message: error instanceof Error ? error.message : "Routing evidence validation failed.", details: null } };
      }
    }
    return super.recordStageResult(rawResult, requireTrustedExecutionContext);
  }
}
