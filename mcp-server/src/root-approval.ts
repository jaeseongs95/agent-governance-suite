import { randomUUID } from "node:crypto";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CONTRACT_VERSION, WorkflowContractError, type ApiResultV1, type ConvergenceRootV1, type Sha256Digest,
  type OpenConvergenceRootRequestV1 } from "../../contracts/types.js";
import { convergenceDigest, canonicalJson } from "./convergence-logic.js";
import { failureContext } from "./failure-diagnostics.js";
import { msg } from "./i18n.js";
import type { ConvergenceRootReleaseResultV1, RootAccess, WorkflowService } from "./workflow-service.js";

export type RootApprovalAction = "replace-root" | "release-root";
/** One exact authorized tuple. Arrays of independent dimensions would over-authorize their Cartesian product. */
export interface RootApprovalScope {
  action: RootApprovalAction;
  rootId: string;
  actorId: string;
  rootDigest: Sha256Digest;
  replacementDigest: Sha256Digest | null;
}
export interface RootApprovalRecord {
  approvalId: string;
  scope: RootApprovalScope;
  scopeDigest: Sha256Digest;
  source: { kind: "mcp-form"; connectionId: string; requestId: string };
  createdAt: string;
  revokedAt: string | null;
}
export interface PendingRootApproval {
  scope: RootApprovalScope;
  scopeDigest: Sha256Digest;
  rootRevision: number;
  request: unknown;
  message: string;
}
export interface RootApprovalPreparation {
  pending: PendingRootApproval;
  approvalId: string | null;
}
export type RootOperationResult = ConvergenceRootV1 | ConvergenceRootReleaseResultV1;

export function rootApprovalFailure(reason: string, code: "BINDING_INVALID" | "MCP_UNAVAILABLE" | "INVALID_TRANSITION" = "BINDING_INVALID",
  details: Record<string, unknown> = {}): WorkflowContractError {
  return new WorkflowContractError(code, msg("workflow.service.unkeyedFailure", { message: "사용자 승인 결정을 확인할 수 없습니다." }),
    { reason, field: "userApprovalRefs", ...details });
}

function semanticTask(task: ConvergenceRootV1["taskEnvelope"]) {
  // A generated task ID does not change what the user approved. Every substantive task field stays bound.
  const { taskId: _taskId, ...semantic } = task;
  void _taskId;
  return semantic;
}
export function rootApprovalScope(action: RootApprovalAction, root: ConvergenceRootV1, actorId: string | null,
  replacement?: OpenConvergenceRootRequestV1): RootApprovalScope {
  if (!actorId) throw rootApprovalFailure("USER_APPROVAL_ACTOR_UNAVAILABLE");
  return { action, rootId: root.rootId, actorId,
    rootDigest: convergenceDigest({ task: semanticTask(root.taskEnvelope), frame: root.frame }),
    replacementDigest: replacement ? convergenceDigest({ task: semanticTask(replacement.taskEnvelope), frame: replacement.frame }) : null };
}

/** Existing client transport, not tool arguments, supplies the response. Actual host UI/provenance remains host-dependent. */
export function createRootApprovalHandler(server: Pick<Server, "getClientCapabilities" | "elicitInput">, service: WorkflowService) {
  // Source/deduplication identity only; cached approval lookup never requires the same connection or process.
  const connectionId = randomUUID();
  return async (action: RootApprovalAction, request: unknown, access: RootAccess,
    extra: { requestId: string | number; signal: AbortSignal }): Promise<ApiResultV1<RootOperationResult>> => {
    try {
      if (extra.signal.aborted) throw rootApprovalFailure("USER_APPROVAL_CANCELLED", "INVALID_TRANSITION");
      const preparation = service.prepareRootApproval(action, request, access);
      if (!preparation.ok) return { ...preparation, data: null };
      if (preparation.data === null) {
        return action === "replace-root" ? service.openConvergenceRoot(request, access) : service.releaseConvergenceRoot(request, access);
      }
      const { pending, approvalId } = preparation.data;
      if (approvalId === null) {
        if (!server.getClientCapabilities()?.elicitation?.form) {
          throw rootApprovalFailure("USER_APPROVAL_PRODUCER_UNSUPPORTED", "MCP_UNAVAILABLE");
        }
        const response = await server.elicitInput({ mode: "form", message: pending.message,
          requestedSchema: { type: "object", properties: { confirm: { type: "boolean", title: "표시된 범위의 작업을 승인합니다" } }, required: ["confirm"] } },
        { relatedRequestId: extra.requestId, signal: extra.signal });
        if (extra.signal.aborted) throw rootApprovalFailure("USER_APPROVAL_CANCELLED", "INVALID_TRANSITION");
        if (response.action !== "accept" || response.content?.confirm !== true) {
          throw rootApprovalFailure(response.action === "cancel" ? "USER_APPROVAL_CANCELLED" : "USER_APPROVAL_DECLINED", "INVALID_TRANSITION");
        }
        const stored = service.recordRootApproval(pending, { kind: "mcp-form", connectionId, requestId: String(extra.requestId) }, access, extra.signal);
        if (!stored.ok) return { ...stored, data: null };
      }
      return service.executePreparedRootOperation(pending, access, extra.signal);
    } catch (cause) {
      const error = extra.signal.aborted ? rootApprovalFailure("USER_APPROVAL_CANCELLED", "INVALID_TRANSITION")
        : cause instanceof WorkflowContractError ? cause
          : rootApprovalFailure("USER_APPROVAL_PRODUCER_FAILED", "MCP_UNAVAILABLE", { cause: failureContext(cause) });
      return { schemaVersion: CONTRACT_VERSION, ok: false, data: null, error: error.toBody() };
    }
  };
}

export function rootApprovalMessage(scope: RootApprovalScope, root: ConvergenceRootV1, replacement?: OpenConvergenceRootRequestV1): string {
  return ["다음 범위의 작업을 승인하시겠습니까?", `행위: ${scope.action}`, `대상 root: ${scope.rootId}`, `실행 actor: ${scope.actorId}`,
    scope.action === "release-root" ? "이 root를 해제하고 실행 중인 연결 작업이 있으면 blocked로 닫습니다."
      : "이 parent root를 포기하고 아래 작업 범위로 새 root를 엽니다.",
    `현재 범위: ${canonicalJson({ task: semanticTask(root.taskEnvelope), frame: root.frame }, "Root approval display")}`,
    ...(replacement ? [`교체 범위: ${canonicalJson({ task: semanticTask(replacement.taskEnvelope), frame: replacement.frame }, "Replacement approval display")}`] : []),
    "이 결정은 표시된 동일 행위·root·actor·작업 범위에 재사용됩니다. 별도 만료나 일회 소비 조건은 추가하지 않습니다."].join("\n");
}
