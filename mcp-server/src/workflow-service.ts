import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import {
  type ApiResultV1,
  CONTRACT_VERSION,
  type ContractErrorBody,
  type PlannedStageV1,
  POLICY_CAPABILITY,
  type RoutedSkillProviderV2,
  type StateMappingRuleV2,
  type StageResultV1,
  type TaskEnvelopeV1,
  type WorkflowPlanV1,
  type WorkflowReceiptV1,
  WorkflowContractError,
} from "../../contracts/types.js";
import { FileSkillRegistry, selectSkillByCapability } from "./registry.js";
import { validateDecisionRecordSemantics } from "./decision-record-validator.js";
import { ContractValidator } from "./schema-validator.js";

interface StoredRun {
  receipt: WorkflowReceiptV1;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function apiOk<T>(data: T): ApiResultV1<T> {
  return { schemaVersion: CONTRACT_VERSION, ok: true, data, error: null };
}

function apiError<T>(error: ContractErrorBody): ApiResultV1<T> {
  return { schemaVersion: CONTRACT_VERSION, ok: false, data: null, error };
}

function stageId(order: number, capability: string): string {
  return `stage-${String(order).padStart(2, "0")}-${capability}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new WorkflowContractError("INVALID_INPUT", "Plan contains a non-finite number.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  throw new WorkflowContractError("INVALID_INPUT", "Plan contains a non-serializable value.");
}

/**
 * Runtime run state is process-local by design. Planning is read-only: only
 * startWorkflow creates a StoredRun, while specialists remain directly callable.
 */
export class WorkflowService {
  private readonly runs = new Map<string, StoredRun>();
  private readonly planSigningKey = randomBytes(32);
  private runSequence = 0;

  constructor(
    private readonly registry: FileSkillRegistry,
    private readonly validator = new ContractValidator(),
  ) {}

  planWorkflow(rawTask: unknown): ApiResultV1<WorkflowPlanV1> {
    try {
      const task = this.validator.taskEnvelope(rawTask);
      const plan = this.buildPlan(task, this.registry.read(), this.validateWorkUnitGraph(task));
      plan.integrityToken = this.signPlan(plan);
      this.validator.workflowPlan(plan);
      return apiOk(plan);
    } catch (error) {
      return apiError(this.toErrorBody(error));
    }
  }

  startWorkflow(rawPlan: unknown): ApiResultV1<WorkflowReceiptV1> {
    try {
      const plan = clone(this.validator.workflowPlan(rawPlan));
      this.assertPlanIntegrity(plan);
      if (plan.executionMode !== "orchestrated") {
        throw new WorkflowContractError("INVALID_TRANSITION", "Direct skill plans are not started by the MCP orchestrator.");
      }
      if (plan.state !== "ready") {
        const error = plan.errors.find((item) => item.code === "MCP_UNAVAILABLE");
        if (error) throw new WorkflowContractError(error.code, error.message, error.details);
        throw new WorkflowContractError("INVALID_TRANSITION", "Only a ready workflow plan can be started.", {
          planState: plan.state,
        });
      }

      const runId = `run-${plan.taskId}-${++this.runSequence}`;
      plan.state = "running";
      this.setRunningStagePointers(plan);
      const receipt: WorkflowReceiptV1 = {
        schemaVersion: CONTRACT_VERSION,
        runId,
        revision: 0,
        state: "running",
        plan,
        stageResults: [],
        blockers: [],
        unresolved: [],
        error: null,
      };
      this.assertReceipt(receipt);
      this.runs.set(runId, { receipt });
      return apiOk(clone(receipt));
    } catch (error) {
      return apiError(this.toErrorBody(error));
    }
  }

  recordStageResult(rawResult: unknown): ApiResultV1<WorkflowReceiptV1> {
    try {
      const result = this.validator.stageResult(rawResult);
      return this.change(result.runId, result.expectedRevision, (receipt) => {
        if (receipt.state !== "running") {
          throw new WorkflowContractError("INVALID_TRANSITION", "Stage results require a running workflow.", {
            state: receipt.state,
          });
        }
        const target = receipt.plan.stages.find((stage) => stage.stageId === result.stageId);
        if (!target) {
          throw new WorkflowContractError("INVALID_INPUT", "Stage does not belong to this run.", { stageId: result.stageId });
        }
        if (target.state !== "ready") {
          throw new WorkflowContractError("INVALID_TRANSITION", "A stage result may only be recorded once.", {
            stageId: result.stageId,
            stageState: target.state,
          });
        }
        const priorStage = receipt.plan.stages.find(
          (stage) => stage.order < target.order && stage.state !== "passed",
        );
        if (priorStage) {
          throw new WorkflowContractError("INVALID_TRANSITION", "Stages must be recorded in plan order.", {
            requiredStageId: priorStage.stageId,
            requestedStageId: result.stageId,
          });
        }

        this.assertPlannedInputsAvailable(receipt, target);
        this.assertResultSemantics(target, result);
        if (result.state === "passed") {
          this.assertRequiredArtifacts(target, result);
          this.assertDeliberationGate(target, result);
          this.assertMandatoryAuditGate(target, result);
        }
        target.state = result.state;
        receipt.stageResults.push(clone(result));
        this.addUnique(receipt.blockers, result.blockers);
        this.addUnique(receipt.unresolved, result.blockers);
        if (result.state !== "passed") {
          receipt.state = result.state;
          receipt.plan.state = result.state;
          receipt.error = result.error;
          this.addUnique(receipt.unresolved, [`${target.stageId}:${result.state}`]);
          if (result.state === "needs-input" || result.state === "needs-approval" || result.state === "needs-redesign") {
            receipt.plan.currentStageId = target.stageId;
          } else {
            receipt.plan.currentStageId = null;
          }
          receipt.plan.nextStageId = null;
        } else {
          this.setRunningStagePointers(receipt.plan);
        }
      });
    } catch (error) {
      return apiError(this.toErrorBody(error));
    }
  }

  getWorkflowStatus(runId: string): ApiResultV1<WorkflowReceiptV1> {
    try {
      return apiOk(clone(this.requireRun(runId).receipt));
    } catch (error) {
      return apiError(this.toErrorBody(error));
    }
  }

  finalizeWorkflow(runId: string, expectedRevision: number): ApiResultV1<WorkflowReceiptV1> {
    return this.change(runId, expectedRevision, (receipt) => {
      if (receipt.state !== "running") {
        throw new WorkflowContractError("INVALID_TRANSITION", "Only a running workflow can be finalized.", {
          state: receipt.state,
        });
      }
      if (receipt.blockers.length > 0 || receipt.unresolved.length > 0) {
        throw new WorkflowContractError("GATE_FAILED", "Workflow has unresolved blockers or findings.", {
          blockers: receipt.blockers,
          unresolved: receipt.unresolved,
        });
      }

      for (const stage of receipt.plan.stages) {
        const result = receipt.stageResults.find((item) => item.stageId === stage.stageId);
        if (!result || result.state !== "passed") {
          throw new WorkflowContractError("GATE_FAILED", "Every planned stage must pass before finalization.", {
            stageId: stage.stageId,
            stageState: result?.state ?? "ready",
          });
        }
        this.assertRequiredArtifacts(stage, result);
      }

      const mandatoryAudit = receipt.plan.stages.find((stage) => stage.riskGate === "mandatory");
      if (mandatoryAudit && mandatoryAudit.state !== "passed") {
        throw new WorkflowContractError("GATE_FAILED", "Mandatory audit stage did not pass.", {
          stageId: mandatoryAudit.stageId,
        });
      }

      receipt.state = "passed";
      receipt.plan.state = "passed";
      receipt.plan.currentStageId = null;
      receipt.plan.nextStageId = null;
      receipt.error = null;
    });
  }

  abortWorkflow(runId: string, expectedRevision: number): ApiResultV1<WorkflowReceiptV1> {
    return this.change(runId, expectedRevision, (receipt) => {
      if (receipt.state === "passed" || receipt.state === "failed" || receipt.state === "blocked") {
        throw new WorkflowContractError("INVALID_TRANSITION", "A terminal workflow cannot be aborted.", {
          state: receipt.state,
        });
      }
      receipt.state = "blocked";
      receipt.plan.state = "blocked";
      receipt.plan.currentStageId = null;
      receipt.plan.nextStageId = null;
      this.addUnique(receipt.blockers, ["aborted-by-caller"]);
      this.addUnique(receipt.unresolved, ["aborted-by-caller"]);
      receipt.error = null;
    });
  }

  private buildPlan(
    task: TaskEnvelopeV1,
    skills: RoutedSkillProviderV2[],
    dependencyGraph: Map<string, string[]>,
  ): WorkflowPlanV1 {
    const executionMode = task.orchestration.requested ? "orchestrated" : "direct";
    const errors: ContractErrorBody[] = [];
    const stages: PlannedStageV1[] = [];
    const selectedSkills = new Set<string>();
    const selectedProviders = new Map<string, {
      capability: string;
      satisfiedCapabilities: string[];
      provider: RoutedSkillProviderV2;
    }>();

    for (const capability of this.requiredCapabilities(task, dependencyGraph)) {
      const skill = selectSkillByCapability(skills, capability);
      if (!skill) {
        errors.push({
          code: "GATE_FAILED",
          message: `No enabled registry descriptor provides '${capability}'.`,
          details: { capability },
        });
        continue;
      }
      if (skill.executionClass === "bootstrap") {
        errors.push({
          code: "GATE_FAILED",
          message: `Capability '${capability}' is a bootstrap provider and must run before plan_workflow.`,
          details: { capability, providerKey: skill.providerKey },
        });
        continue;
      }
      const selected = selectedProviders.get(skill.providerKey);
      if (selected) {
        if (!selected.satisfiedCapabilities.includes(capability)) selected.satisfiedCapabilities.push(capability);
      } else {
        selectedProviders.set(skill.providerKey, { capability, satisfiedCapabilities: [capability], provider: skill });
      }
    }

    const selectedProviderList = [...selectedProviders.values()];
    const executionClasses = new Set(selectedProviderList.map(({ provider }) => provider.executionClass));
    if (executionClasses.size > 1) {
      errors.push({
        code: "INVALID_TRANSITION",
        message: "Recovery providers must run in a separate workflow.",
        details: { executionClasses: [...executionClasses] },
      });
    }

    for (const { capability, satisfiedCapabilities, provider: skill } of this.orderProviders(selectedProviderList)) {
      // Descriptor requiredArtifacts are inputs/preconditions. Only declared
      // producedArtifacts become evidence obligations for a completed stage.
      const producedArtifacts = skill.producedArtifacts;
      const stageRequiredArtifacts = skill.gate.policy === "mandatory"
        ? [...new Set([...producedArtifacts, "gate-verdict"])]
        : producedArtifacts;
      const order = stages.length + 1;
      stages.push({
        stageId: stageId(order, capability),
        order,
        requiredCapability: capability,
        satisfiedCapabilities,
        skillId: skill.skillId,
        phase: skill.phase,
        selectionReason: `Selected '${skill.skillId}' because provider '${skill.providerKey}' supplies '${satisfiedCapabilities.join("', '")}' at priority ${skill.priority}.`,
        state: "ready",
        requiredArtifacts: stageRequiredArtifacts,
        riskGate: skill.gate.policy,
        providerKey: skill.providerKey,
        executionClass: skill.executionClass as "workflow" | "recovery",
        phaseOrder: skill.phaseOrder,
        requiredInputArtifacts: skill.requiredInputArtifacts,
        inputBindings: skill.inputBindings,
        producedArtifacts: skill.producedArtifacts,
        outputSchema: { path: skill.outputSchema, digest: skill.outputSchemaDigest },
        resultSchema: { path: skill.resultSchema, digest: skill.resultSchemaDigest },
        stateMapping: skill.stateMapping,
        gate: skill.gate,
      });
      selectedSkills.add(skill.skillId);
    }

    if (executionMode === "orchestrated" && !task.orchestration.mcpAvailable) {
      errors.unshift({
        code: "MCP_UNAVAILABLE",
        message: "The orchestrator is blocked because MCP is unavailable.",
        details: null,
      });
    }

    return {
      schemaVersion: CONTRACT_VERSION,
      taskId: task.taskId,
      integrityToken: "pending",
      executionMode,
      state: errors.length > 0 ? "blocked" : "ready",
      selectedSkills: [...selectedSkills],
      stages,
      currentStageId: null,
      nextStageId: errors.length > 0 ? null : stages[0]?.stageId ?? null,
      errors,
    };
  }

  private requiredCapabilities(task: TaskEnvelopeV1, dependencyGraph: Map<string, string[]>): string[] {
    const before: string[] = [];
    const auditRequested = task.requiredCapabilities.includes(POLICY_CAPABILITY.audit)
      || task.riskLevel === "high"
      || task.riskLevel === "critical";
    const work = task.requiredCapabilities.filter((capability) => capability !== POLICY_CAPABILITY.audit);
    const after: string[] = [];
    if (task.orchestration.requested && this.hasIndependentWorkUnitPair(dependencyGraph)) {
      before.push(POLICY_CAPABILITY.coordination);
    }
    if (task.orchestration.requested && (task.decision.complexity === "complex" || task.decision.hasConflicts)) {
      before.push(POLICY_CAPABILITY.deliberation);
    }
    if (task.orchestration.requested && auditRequested) {
      after.push(POLICY_CAPABILITY.audit);
    }
    return [...new Set([...before, ...work, ...after])];
  }

  private orderProviders(
    items: Array<{ capability: string; satisfiedCapabilities: string[]; provider: RoutedSkillProviderV2 }>,
  ): Array<{ capability: string; satisfiedCapabilities: string[]; provider: RoutedSkillProviderV2 }> {
    const producedBy = new Map<string, number>();
    for (const [index, item] of items.entries()) {
      for (const artifact of item.provider.producedArtifacts) {
        const existing = producedBy.get(artifact);
        if (existing !== undefined && items[existing]?.provider.providerKey !== item.provider.providerKey) {
          throw new WorkflowContractError("INVALID_INPUT", "Selected providers produce the same artifact.", {
            artifact,
            providers: [items[existing]?.provider.providerKey, item.provider.providerKey],
          });
        }
        producedBy.set(artifact, index);
      }
    }

    const outgoing = new Map<number, Set<number>>();
    const indegree = items.map(() => 0);
    for (const [consumerIndex, item] of items.entries()) {
      for (const artifact of item.provider.requiredInputArtifacts) {
        const producerIndex = producedBy.get(artifact);
        if (producerIndex === undefined || producerIndex === consumerIndex) continue;
        const edges = outgoing.get(producerIndex) ?? new Set<number>();
        if (!edges.has(consumerIndex)) {
          edges.add(consumerIndex);
          outgoing.set(producerIndex, edges);
          indegree[consumerIndex] = (indegree[consumerIndex] ?? 0) + 1;
        }
      }
    }

    const compare = (left: number, right: number) => (
      items[left]!.provider.phaseOrder - items[right]!.provider.phaseOrder
      || items[left]!.capability.localeCompare(items[right]!.capability)
      || items[left]!.provider.providerKey.localeCompare(items[right]!.provider.providerKey)
    );
    const ready = indegree.map((value, index) => value === 0 ? index : -1).filter((index) => index >= 0).sort(compare);
    const ordered: typeof items = [];
    while (ready.length > 0) {
      const index = ready.shift()!;
      ordered.push(items[index]!);
      for (const next of outgoing.get(index) ?? []) {
        indegree[next]!--;
        if (indegree[next] === 0) {
          ready.push(next);
          ready.sort(compare);
        }
      }
    }
    if (ordered.length !== items.length) {
      throw new WorkflowContractError("INVALID_INPUT", "Selected provider artifact dependencies contain a cycle.");
    }
    return ordered;
  }

  private assertResultSemantics(stage: PlannedStageV1, result: StageResultV1): void {
    const providerResult = this.validator.providerResult(
      this.registry.rootDirectory,
      stage.resultSchema,
      stage.outputSchema,
      result.output,
    );
    const rule = this.mappedState(stage, providerResult);
    if (result.state !== rule.state) {
      throw new WorkflowContractError("INVALID_TRANSITION", "Stage state does not match the provider state mapping.", {
        stageId: result.stageId,
        expectedState: rule.state,
        actualState: result.state,
      });
    }
    const providerError = providerResult.error;
    if (rule.errorRequired !== Boolean(providerError)) {
      throw new WorkflowContractError("INVALID_TRANSITION", "Provider error presence does not match the state mapping.", {
        stageId: result.stageId,
        errorRequired: rule.errorRequired,
      });
    }
    if (providerError && rule.allowedErrorCodes && !rule.allowedErrorCodes.includes(providerError.code)) {
      throw new WorkflowContractError("INVALID_TRANSITION", "Provider error code is not allowed by the state mapping.", {
        stageId: result.stageId,
        errorCode: providerError.code,
      });
    }
    if ((providerError?.code ?? null) !== (result.error?.code ?? null)) {
      throw new WorkflowContractError("INVALID_INPUT", "Stage error must mirror the provider result error.", {
        stageId: result.stageId,
      });
    }
    if (result.state === "passed") {
      if (result.evidence.length === 0 || result.evidence.some((evidence) => !evidence.verified || !evidence.locator)) {
        throw new WorkflowContractError("MISSING_EVIDENCE", "A passed stage requires verified evidence.", {
          stageId: result.stageId,
        });
      }
      if (result.error) {
        throw new WorkflowContractError("INVALID_INPUT", "A passed stage cannot contain an error.");
      }
    }
    if ((result.state === "failed" || result.state === "blocked") && !result.error) {
      throw new WorkflowContractError("INVALID_INPUT", "Failed or blocked stages require an error object.");
    }
  }

  private mappedState(stage: PlannedStageV1, providerResult: StageResultV1["output"]): StateMappingRuleV2 {
    if (providerResult.kind === "adapter-error") {
      const errorCode = providerResult.error?.code;
      if (!errorCode || !stage.stateMapping.adapterErrors.includes(errorCode)) {
        throw new WorkflowContractError("INVALID_TRANSITION", "Adapter error is not allowed by the provider descriptor.", {
          stageId: stage.stageId,
          errorCode: errorCode ?? null,
        });
      }
      return { state: "blocked", errorRequired: true, allowedErrorCodes: stage.stateMapping.adapterErrors };
    }
    let rule: StateMappingRuleV2 | "reject" = stage.stateMapping.default;
    if (stage.stateMapping.selector) {
      const value = this.jsonPointer(providerResult, stage.stateMapping.selector);
      if (typeof value === "string") rule = stage.stateMapping.values?.[value] ?? "reject";
    }
    if (rule === "reject") {
      throw new WorkflowContractError("INVALID_TRANSITION", "Provider verdict is not mapped by the descriptor.", {
        stageId: stage.stageId,
        selector: stage.stateMapping.selector ?? null,
      });
    }
    return rule;
  }

  private jsonPointer(value: unknown, pointer: string): unknown {
    return pointer.split("/").slice(1).reduce<unknown>((current, token) => {
      if (!current || typeof current !== "object") return undefined;
      const key = token.replaceAll("~1", "/").replaceAll("~0", "~");
      return (current as Record<string, unknown>)[key];
    }, value);
  }

  private assertRequiredArtifacts(stage: PlannedStageV1, result: StageResultV1): void {
    const verifiedArtifacts = new Set(
      result.output.artifacts.filter((artifact) => artifact.verified && artifact.locator && artifact.digest && artifact.targetDigest)
        .map((artifact) => artifact.artifactId),
    );
    const missing = stage.requiredArtifacts.filter((artifact) => !verifiedArtifacts.has(artifact));
    if (missing.length > 0) {
      throw new WorkflowContractError("MISSING_EVIDENCE", "Required stage artifacts lack verified evidence.", {
        stageId: stage.stageId,
        missingArtifacts: missing,
      });
    }
  }

  private assertPlannedInputsAvailable(receipt: WorkflowReceiptV1, stage: PlannedStageV1): void {
    const missing: Array<{ artifactId: string; producerStageId: string }> = [];
    for (const artifactId of stage.requiredInputArtifacts) {
      const producer = receipt.plan.stages.find(
        (candidate) => candidate.stageId !== stage.stageId && candidate.producedArtifacts.includes(artifactId),
      );
      if (!producer) continue;
      const producerResult = receipt.stageResults.find((candidate) => candidate.stageId === producer.stageId);
      const verified = producerResult?.state === "passed" && producerResult.output.artifacts.some(
        (artifact) => artifact.artifactId === artifactId
          && artifact.verified
          && Boolean(artifact.locator)
          && Boolean(artifact.digest)
          && Boolean(artifact.targetDigest),
      );
      if (!verified) missing.push({ artifactId, producerStageId: producer.stageId });
    }
    if (missing.length > 0) {
      throw new WorkflowContractError("MISSING_EVIDENCE", "Planned input artifacts are not backed by verified producer results.", {
        stageId: stage.stageId,
        missingInputs: missing,
      });
    }
  }

  private assertDeliberationGate(stage: PlannedStageV1, result: StageResultV1): void {
    if (!stage.requiredArtifacts.includes("decision-record")) return;
    if (!stage.gate.validatorSchema) {
      throw new WorkflowContractError("GATE_FAILED", "Deliberation provider must declare its decision record validator schema.", {
        stageId: stage.stageId,
      });
    }
    let record: Record<string, unknown>;
    try {
      record = this.validator.declaredSchema(
        this.registry.rootDirectory,
        stage.gate.validatorSchema,
        result.output.output?.decisionRecord,
        "deliberation decision record",
      );
    } catch (error) {
      throw new WorkflowContractError("GATE_FAILED", "Deliberation requires a schema-valid DecisionRecord.v1.", {
        stageId: stage.stageId,
        cause: error instanceof Error ? error.message : String(error),
      });
    }
    const semanticErrors = validateDecisionRecordSemantics(record);
    if (semanticErrors.length > 0) {
      throw new WorkflowContractError("GATE_FAILED", "DecisionRecord.v1 failed canonical semantic validation.", {
        stageId: stage.stageId,
        semanticErrors,
      });
    }
    const run = record.run as Record<string, unknown>;
    const proposal = record.consensus_proposal as Record<string, unknown> | null;
    if (
      run.assurance === "provisional"
      || run.capability_shortfall !== false
      || proposal === null
      || proposal.status === "no_consensus"
    ) {
      throw new WorkflowContractError("GATE_FAILED", "Deliberation result is not eligible to advance the workflow.", {
        stageId: stage.stageId,
        assurance: run.assurance,
        capabilityShortfall: run.capability_shortfall,
        consensusStatus: proposal?.status ?? null,
      });
    }
    if ((run.stage === "HIGH" || run.stage === "CRITICAL") && run.strict !== true) {
      throw new WorkflowContractError("GATE_FAILED", "HIGH and CRITICAL deliberation requires strict execution assurance.", {
        stageId: stage.stageId,
        stage: run.stage,
      });
    }
    if (proposal.status === "conditional_consensus" && result.output.output?.conditionsVerified !== true) {
      throw new WorkflowContractError("GATE_FAILED", "Conditional consensus may advance only after its conditions are verified.", {
        stageId: stage.stageId,
      });
    }
  }

  private assertMandatoryAuditGate(stage: PlannedStageV1, result: StageResultV1): void {
    if (stage.riskGate !== "mandatory") return;
    const output = result.output.output;
    const auditorId = output?.auditorId;
    const implementationActorIds = output?.implementationActorIds;
    const auditTarget = output?.auditTarget;
    const currentTarget = output?.currentTarget;
    const blockingFindings = output?.blockingFindings;
    const phase = output?.phase;
    if (
      output?.gateVerdict !== "PASS"
      || typeof auditorId !== "string"
      || auditorId.length === 0
      || !Array.isArray(implementationActorIds)
      || implementationActorIds.length === 0
      || implementationActorIds.some((actorId) => typeof actorId !== "string" || actorId.length === 0)
      || typeof auditTarget !== "string"
      || auditTarget.length === 0
      || typeof currentTarget !== "string"
      || currentTarget !== auditTarget
      || output?.freshContext !== true
      || output?.delegationAllowed !== false
      || !Array.isArray(blockingFindings)
      || blockingFindings.length > 0
      || output?.stale !== false
      || !["pre-execution", "post-execution", "pre-deploy", "post-deploy"].includes(String(phase))
      || typeof output?.postExecutionVerified !== "boolean"
    ) {
      throw new WorkflowContractError("GATE_FAILED", "Mandatory audit requires a current, fresh, non-delegated PASS with no blocking findings.", {
        stageId: stage.stageId,
      });
    }
    if ((phase === "post-execution" || phase === "post-deploy") && output.postExecutionVerified !== true) {
      throw new WorkflowContractError("GATE_FAILED", "Post-execution and post-deploy audits require verified resulting state.", {
        stageId: stage.stageId,
        phase,
      });
    }
    if (implementationActorIds.includes(auditorId)) {
      throw new WorkflowContractError("GATE_FAILED", "Mandatory audit auditor must be independent from implementation actors.", {
        stageId: stage.stageId,
        auditorId,
        implementationActorIds,
      });
    }
  }

  private validateWorkUnitGraph(task: TaskEnvelopeV1): Map<string, string[]> {
    const graph = new Map<string, string[]>();
    for (const unit of task.workUnits) {
      if (graph.has(unit.id)) {
        throw new WorkflowContractError("INVALID_INPUT", "Work unit IDs must be unique.", { workUnitId: unit.id });
      }
      graph.set(unit.id, unit.dependencies);
    }
    for (const unit of task.workUnits) {
      for (const dependencyId of unit.dependencies) {
        if (!graph.has(dependencyId)) {
          throw new WorkflowContractError("INVALID_INPUT", "Work unit dependency does not exist.", {
            workUnitId: unit.id,
            dependencyId,
          });
        }
      }
    }

    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (unitId: string): void => {
      if (visiting.has(unitId)) {
        throw new WorkflowContractError("INVALID_INPUT", "Work unit dependencies must not contain a cycle.", {
          workUnitId: unitId,
        });
      }
      if (visited.has(unitId)) return;
      visiting.add(unitId);
      for (const dependencyId of graph.get(unitId) ?? []) visit(dependencyId);
      visiting.delete(unitId);
      visited.add(unitId);
    };
    for (const unit of task.workUnits) visit(unit.id);
    return graph;
  }

  private hasIndependentWorkUnitPair(graph: Map<string, string[]>): boolean {
    const ids = [...graph.keys()];
    const reaches = (from: string, target: string): boolean => {
      const pending = [...(graph.get(from) ?? [])];
      const visited = new Set<string>();
      while (pending.length > 0) {
        const current = pending.pop()!;
        if (current === target) return true;
        if (visited.has(current)) continue;
        visited.add(current);
        pending.push(...(graph.get(current) ?? []));
      }
      return false;
    };
    for (let index = 0; index < ids.length; index += 1) {
      for (let other = index + 1; other < ids.length; other += 1) {
        if (!reaches(ids[index]!, ids[other]!) && !reaches(ids[other]!, ids[index]!)) return true;
      }
    }
    return false;
  }

  private setRunningStagePointers(plan: WorkflowPlanV1): void {
    const readyStages = plan.stages.filter((stage) => stage.state === "ready");
    plan.currentStageId = readyStages[0]?.stageId ?? null;
    plan.nextStageId = readyStages[1]?.stageId ?? null;
  }

  private addUnique(destination: string[], values: string[]): void {
    for (const value of values) {
      if (!destination.includes(value)) destination.push(value);
    }
  }

  private signPlan(plan: WorkflowPlanV1): string {
    return createHmac("sha256", this.planSigningKey)
      .update(canonicalJson(this.planWithoutIntegrityToken(plan)), "utf8")
      .digest("base64url");
  }

  private assertPlanIntegrity(plan: WorkflowPlanV1): void {
    const expected = Buffer.from(this.signPlan(plan), "base64url");
    const supplied = Buffer.from(plan.integrityToken, "base64url");
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      throw new WorkflowContractError("INVALID_INPUT", "Workflow plan integrity token is missing, modified, or foreign to this MCP process.");
    }
  }

  private planWithoutIntegrityToken(plan: WorkflowPlanV1): Omit<WorkflowPlanV1, "integrityToken"> {
    const unsignedPlan = { ...plan } as Partial<WorkflowPlanV1>;
    delete unsignedPlan.integrityToken;
    return unsignedPlan as Omit<WorkflowPlanV1, "integrityToken">;
  }

  private change(
    runId: string,
    expectedRevision: number,
    mutate: (receipt: WorkflowReceiptV1) => void,
  ): ApiResultV1<WorkflowReceiptV1> {
    try {
      const receipt = this.requireRun(runId).receipt;
      if (!Number.isInteger(expectedRevision) || expectedRevision !== receipt.revision) {
        throw new WorkflowContractError("STALE_REVISION", "expectedRevision does not match the current run revision.", {
          expectedRevision,
          actualRevision: receipt.revision,
        });
      }
      mutate(receipt);
      receipt.revision += 1;
      this.assertReceipt(receipt);
      return apiOk(clone(receipt));
    } catch (error) {
      return apiError(this.toErrorBody(error));
    }
  }

  private requireRun(runId: string): StoredRun {
    const stored = this.runs.get(runId);
    if (!stored) {
      throw new WorkflowContractError("RUN_NOT_FOUND", "Run was not found in this in-memory MCP process.", { runId });
    }
    return stored;
  }

  private assertReceipt(receipt: WorkflowReceiptV1): void {
    this.validator.workflowPlan(receipt.plan);
    this.validator.workflowReceipt(receipt);
  }

  private toErrorBody(error: unknown): ContractErrorBody {
    if (error instanceof WorkflowContractError) return error.toBody();
    return {
      code: "INVALID_INPUT",
      message: "Workflow request could not be processed.",
      details: { cause: error instanceof Error ? error.message : String(error) },
    };
  }
}
