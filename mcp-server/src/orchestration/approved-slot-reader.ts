import type { RoleSlotV1 } from "../../../contracts/types.js";
import { digest } from "../../../skills/coordinate-subagents/scripts/model-routing-core.mjs";
import { projectApprovedRoleSlotsV1 } from "../../../skills/coordinate-subagents/scripts/orchestration/approved-slot-projection.mjs";
import { type ApprovedSlotExpectation, VmApprovedSlotSource } from "../host-integration/vm-approved-slot-source.js";
import { ContractValidator } from "../schema-validator.js";

type JsonObject = Record<string, unknown>;
type CurrentExpectation = ApprovedSlotExpectation & {
  planRevisionId?: string;
  activationId?: string;
  authorizationId?: string;
  sourceRevision?: number;
};

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}
function exact(value: JsonObject | null, fields: string[]): boolean {
  return !!value && Object.keys(value).length === fields.length && fields.every((field) => Object.hasOwn(value, field));
}
function deny(reason: string): never { throw new Error(`VM approved role slots unavailable: ${reason}`); }

export interface ApprovedRoleSlotsV1 {
  authority: {
    owner: "flowmarshal-engine";
    projectId: string;
    taskId: string;
    runId: string;
    planId: string;
    planRevisionId: string;
    revision: number;
    definitionDigest: string;
    activationDigest: string;
    activationId: string;
    activationAuthorizationId: string;
    authorizationId: string;
    authorizationRevision: number;
    vmAuthorizationDigest: string;
    sourceRevision: number;
    snapshotDigest: string;
  };
  projection: { planDigest: string; authorizationDigest: string; participationDigest: string };
  slots: RoleSlotV1[];
}

/** Consumes the signed VM source once; projection digests are structural, never execution authority. */
export class ApprovedSlotReader {
  constructor(private readonly source: VmApprovedSlotSource,
    private readonly validator: ContractValidator = new ContractValidator()) {}

  read(expected: CurrentExpectation): ApprovedRoleSlotsV1 {
    const vm = this.source.consume(expected);
    const participation = object(vm.participation);
    if (vm.owner !== "flowmarshal-engine" || vm.project_id !== expected.projectId
        || vm.task_id !== expected.taskId || vm.revoked !== false
        || (expected.planRevisionId !== undefined && vm.plan_revision_id !== expected.planRevisionId)
        || (expected.activationId !== undefined && vm.activation_id !== expected.activationId)
        || (expected.authorizationId !== undefined && vm.authorization_id !== expected.authorizationId)
        || (expected.sourceRevision !== undefined && vm.source_revision !== expected.sourceRevision)
        || !participation || participation.complete !== true
        || participation.watermark !== vm.source_revision || !Array.isArray(participation.entries)
        || !Array.isArray(vm.stages) || vm.stages.length === 0) deny("approval or participation is stale");

    const stages = vm.stages.map((value) => {
      const stage = object(value);
      if (!exact(stage, ["taskId", "stageId", "assignments"]) || stage!.taskId !== vm.task_id
          || !Array.isArray(stage!.assignments)) deny("stage does not belong to the current task");
      return { stageId: stage!.stageId, state: "approved", assignments: stage!.assignments.map((item: unknown) => {
        const assignment = object(item);
        if (!exact(assignment, ["assignmentId", "purpose", "routingRole", "riskLevel", "highRisk",
          "independenceRequired", "requirements"])) deny("assignment source is malformed");
        return { ...structuredClone(assignment), state: "approved" };
      }) };
    });
    const plan = { schemaVersion: "1.0.0", taskId: vm.task_id, runId: vm.run_id,
      revision: vm.revision_no, state: "approved", stages };
    const planDigest = digest(plan);
    const authorizationDigest = digest({ kind: "approved-plan-authorization", taskId: plan.taskId,
      runId: plan.runId, revision: plan.revision, planDigest });
    const entries = structuredClone(participation.entries);
    const slots = projectApprovedRoleSlotsV1({ approvedPlan: { ...plan, planDigest, authorizationDigest },
      participation: { entries, digest: digest(entries) } });
    for (const slot of slots) this.validator.roleSlotV1(slot, slots, slot.slotId);
    return {
      authority: { owner: "flowmarshal-engine", projectId: vm.project_id as string,
        taskId: vm.task_id as string, runId: vm.run_id as string, planId: vm.plan_id as string,
        planRevisionId: vm.plan_revision_id as string, revision: vm.revision_no as number,
        definitionDigest: vm.definition_digest as string, activationDigest: vm.activation_digest as string,
        activationId: vm.activation_id as string,
        activationAuthorizationId: vm.activation_authorization_id as string,
        authorizationId: vm.authorization_id as string,
        authorizationRevision: vm.authorization_revision_no as number,
        vmAuthorizationDigest: vm.authorization_digest as string,
        sourceRevision: vm.source_revision as number, snapshotDigest: vm.snapshot_digest },
      projection: { planDigest, authorizationDigest, participationDigest: digest(entries) }, slots,
    };
  }
}
