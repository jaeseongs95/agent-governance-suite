import { readFile } from "node:fs/promises";
import {readFileSync, realpathSync, statSync} from "node:fs";
import {createHash} from "node:crypto";
import path from "node:path";
import { z } from "zod";
import type { ExecutionContextV1 } from "../../../contracts/types.js";
import { loadHostObservedInventory, type ObservedHostInventory } from "./host-discovery-adapter.js";
import { createClassificationRequest, digestClassificationValue } from "./request.js";
import {validateProviderProfile} from "./profiles.js";
import { SkillClassificationService, MAX_CLASSIFICATION_TIMEOUT_MS } from "./service.js";
import { decisionSchema, validateDecision } from "./validation.js";
import type { ClassificationConfig, ClassificationResult, ClassificationSnapshot, ProviderProfileRegistry, SkillSelectionDecisionV1, SkillClassificationRequestV1 } from "./types.js";

const strings = z.array(z.string().min(1));
const nullableText = z.string().nullable();
export const classificationInputSchema = z.strictObject({
  schemaVersion: z.literal("1.0.0"), requestId: z.string().min(1), operationId: z.string().min(1), originalPrompt: z.string(),
  confirmedContext: z.strictObject({taskRevision: nullableText, objective: nullableText, actions: strings.nullable(), targets: strings.nullable(), constraints: strings.nullable(), prohibitedActions: strings.nullable(), background: nullableText}),
  contextSources: z.array(z.strictObject({field: z.string().min(1), reference: z.string().min(1)})),
  explicitSkillIds: strings, ruleRequiredSkillIds: strings,
  vendorContext: z.strictObject({vendorId: z.string().min(1), reference: z.string().min(1)}),
  publicSynthetic: z.boolean(),
});
export const selectionInputSchema = z.strictObject({schemaVersion: z.literal("1.0.0"), operationId: z.string().min(1), decision: decisionSchema});
export interface ClassificationRuntimeSnapshot {config: ClassificationConfig; registry: ProviderProfileRegistry; allowRemotePrivateContent: boolean; approvedPublicRequestDigests?: string[]; providerRuntimeRef?: string | null; nativeAdapterDefinitionsRef?: string | null; externalSkillRoots?: string[]; hostDiscoveryRef?: string | null}
export interface CurrentClassificationTask {taskRevision: string | null; requestDigest: string; cancelled: boolean; sourceRef: string}
interface OperationIdentity {intakeDigest: string; runtimeDigest: string; runtimeObservation: string | null; hostDiscoveryDigest: string | null; task: CurrentClassificationTask | null}
interface StoredOperation extends OperationIdentity {result: ClassificationResult; explicit: string[]; required: string[]; decision: SkillSelectionDecisionV1 | null; actorId: string | null}
interface PendingOperation extends OperationIdentity {result: Promise<ClassificationResult>}

/** The loader owns these references. Canonical virtual bytes are fenced by the actual projection reference. */
function sourceFence(root: string, request: SkillClassificationRequestV1, observedSources: ObservedHostInventory["sourceRefs"]): () => boolean {
  try {
    const references = new Map<string, string>();
    for (const source of [...request.skills.flatMap(skill => skill.sourceRefs), ...observedSources]) {
      if (source.path.startsWith("canonical:")) continue;
      const prior = references.get(source.path);
      if (prior !== undefined && prior !== source.digest) return () => false;
      references.set(source.path, source.digest);
    }
    if (references.size > 1024) return () => false;
    const pins = [...references].map(([reference, digest]) => {const file = path.resolve(root, reference); return {file, real: realpathSync(file), digest};});
    return () => {
      try {
        let totalBytes = 0;
        return pins.every(pin => {
          if (realpathSync(pin.file) !== pin.real) return false;
          const status = statSync(pin.real);
          totalBytes += status.size;
          return status.isFile() && totalBytes <= 8 * 1024 * 1024
            && `sha256:${createHash("sha256").update(readFileSync(pin.real)).digest("hex")}` === pin.digest;
        });
      } catch {return false;}
    };
  } catch {return () => false;}
}
export interface SkillClassificationGateway {
  inventory(): Promise<unknown>;
  classify(input: unknown, observation?: ExecutionContextV1 | null): Promise<unknown>;
  accept(input: unknown, observation: ExecutionContextV1 | null): Promise<unknown>;
}

/** Keeps classification artifacts local to this server lifetime; no new database or daemon. */
export class RuntimeSkillClassificationGateway implements SkillClassificationGateway {
  private readonly operations = new Map<string, StoredOperation>();
  private readonly pendingOperations = new Map<string, PendingOperation>();
  constructor(private readonly options: {
    root: string;
    service: SkillClassificationService;
    readRuntime: () => Promise<ClassificationRuntimeSnapshot>;
    observeTask?: (request: SkillClassificationRequestV1, observation: ExecutionContextV1 | null) => CurrentClassificationTask | null;
    observeRuntime?: () => string | null;
    /** Server-owned observer; callers cannot supply host membership or enablement. */
    observeHostSkills?: () => Promise<unknown>;
    maximumOperations?: number;
    now?: () => Date;
  }) {}
  private loadInventory(runtime: Pick<ClassificationRuntimeSnapshot, "externalSkillRoots" | "hostDiscoveryRef">): Promise<ObservedHostInventory> {
    return loadHostObservedInventory({root: this.options.root, ...(this.options.now ? {now: this.options.now} : {}),
      ...(runtime.externalSkillRoots ? {externalSkillRoots: runtime.externalSkillRoots} : {}),
      ...(runtime.hostDiscoveryRef !== undefined ? {hostDiscoveryRef: runtime.hostDiscoveryRef} : {}),
      ...(this.options.observeHostSkills ? {observeHostSkills: this.options.observeHostSkills} : {})});
  }
  async inventory() {
    try {
      const runtime = structuredClone(await this.options.readRuntime());
      const {inventory, discovery} = await this.loadInventory(runtime);
      return {...inventory, discovery};
    } catch {
      const {inventory, discovery} = await this.loadInventory({});
      inventory.issues.push({skillId: null, code: "CONFIGURED_DISCOVERY_UNAVAILABLE", field: "classificationConfig"});
      inventory.inventoryDigest = digestClassificationValue({inventoryDigest: inventory.inventoryDigest, issues: inventory.issues});
      return {...inventory, discovery: {...discovery, status: discovery.status === "UNAVAILABLE" ? "UNAVAILABLE" as const : "INCOMPLETE" as const}};
    }
  }
  async classify(raw: unknown, observation: ExecutionContextV1 | null = null) {
    const input = classificationInputSchema.parse(raw);
    const runtimeObservation = this.options.observeRuntime?.() ?? null;
    const runtime = structuredClone(await this.options.readRuntime());
    const {inventory, discovery, observationDigest: hostDiscoveryDigest, expiresAt: hostExpiresAt, sourceRefs: hostSourceRefs} = await this.loadInventory(runtime);
    if (inventory.issues.length > 0) return {status: "NEEDS_INPUT", errors: inventory.issues, discovery, response: null, agentSelectedSkillIds: null};
    const request = createClassificationRequest({requestId: input.requestId, operationId: input.operationId, originalPrompt: input.originalPrompt,
      confirmedContext: input.confirmedContext, contextSources: input.contextSources, inventory, classificationCriteriaRef: "skills/orchestrator/references/skill-classification.md"});
    // Approval binds every transmitted context and inventory byte, not just the prompt.
    const publicApproved = input.publicSynthetic && runtime.approvedPublicRequestDigests?.includes(request.requestDigest) === true;
    if (!publicApproved && !runtime.allowRemotePrivateContent && runtime.config.externalClassificationAllowed) {
      return {status: "NEEDS_INPUT", errors: ["REMOTE_CONTENT_NOT_APPROVED"], response: null, agentSelectedSkillIds: null};
    }
    const observedInitialTask = this.options.observeTask?.(request, observation) ?? null;
    const task = observedInitialTask === null ? null : structuredClone(observedInitialTask);
    if (this.options.observeRuntime && (runtimeObservation === null || runtimeObservation !== this.options.observeRuntime())) throw new Error("RUNTIME_SNAPSHOT_CHANGED_DURING_READ");
    const actorId = observation?.actorId ?? null;
    const intakeDigest = digestClassificationValue({requestDigest: request.requestDigest, explicitSkillIds: input.explicitSkillIds,
      ruleRequiredSkillIds: input.ruleRequiredSkillIds, vendorContext: input.vendorContext, actorId});
    const runtimeDigest = digestClassificationValue(runtime);
    const existing = this.operations.get(input.operationId);
    const pending = this.pendingOperations.get(input.operationId);
    const reserved = existing ?? pending;
    if (reserved && reserved.intakeDigest !== intakeDigest) throw new Error("OPERATION_DIGEST_CONFLICT");
    if (reserved && (reserved.runtimeDigest !== runtimeDigest || reserved.runtimeObservation !== runtimeObservation || reserved.hostDiscoveryDigest !== hostDiscoveryDigest
      || (reserved.task && (!task || task.cancelled || reserved.task.sourceRef !== task.sourceRef || reserved.task.taskRevision !== task.taskRevision || reserved.task.requestDigest !== task.requestDigest)))) throw new Error("STALE_CLASSIFICATION_OPERATION");
    if (!reserved && this.operations.size + this.pendingOperations.size >= (this.options.maximumOperations ?? 256)) throw new Error("OPERATION_CAPACITY_EXCEEDED");
    const snapshot: ClassificationSnapshot = {taskRevision: request.confirmedContext.taskRevision, requestDigest: request.requestDigest, inventoryDigest: request.inventoryDigest, configRevision: runtime.config.configRevision, profileRevision: runtime.registry.profileRevision, cancelled: task?.cancelled ?? false};
    const sourcesCurrent = sourceFence(this.options.root, request, hostSourceRefs);
    const invoke = () => this.options.service.classify({request, config: runtime.config, registry: runtime.registry, currentVendorId: input.vendorContext.vendorId,
      getCurrentSnapshot: () => {
        const current = this.options.observeTask?.(request, observation) ?? null;
        const sourcesUnchanged = sourcesCurrent();
        return {...snapshot, cancelled: !sourcesUnchanged || (hostExpiresAt !== null && Date.parse(hostExpiresAt) <= (this.options.now?.() ?? new Date()).getTime())
          || (this.options.observeRuntime !== undefined && runtimeObservation !== this.options.observeRuntime())
          || (task !== null && (current === null || current.cancelled || current.sourceRef !== task.sourceRef || current.requestDigest !== task.requestDigest || current.taskRevision !== task.taskRevision))};
      },
    });
    let result: ClassificationResult;
    if (existing) result = await invoke();
    else if (pending) result = await pending.result;
    else {
      // Reserve synchronously before invoking any asynchronous provider. Followers
      // can join this exact intake but cannot replace its actor/vendor/obligations.
      const flight: PendingOperation = {intakeDigest, runtimeDigest, runtimeObservation, hostDiscoveryDigest, task, result: Promise.resolve().then(invoke).then(value => {
        this.pendingOperations.delete(input.operationId);
        this.operations.set(input.operationId, {result: value, explicit: [...input.explicitSkillIds], required: [...input.ruleRequiredSkillIds],
          decision: null, intakeDigest, runtimeDigest, runtimeObservation, hostDiscoveryDigest, task, actorId});
        return value;
      }).finally(() => { if (this.pendingOperations.get(input.operationId) === flight) this.pendingOperations.delete(input.operationId); })};
      this.pendingOperations.set(input.operationId, flight);
      result = await flight.result;
    }
    const completed = this.operations.get(input.operationId);
    return {result, classificationResponseRef: digestClassificationValue(result.response), agentSelectedSkillIds: completed?.decision?.agentSelectedSkillIds ?? null,
      selectionStatus: completed?.decision?.selectionStatus ?? "PROPOSED", adviceApplied: completed?.decision?.adviceApplied ?? false, discovery};
  }
  async accept(raw: unknown, observation: ExecutionContextV1 | null) {
    const input = selectionInputSchema.parse(raw);
    const operation = this.operations.get(input.operationId);
    if (!operation) throw new Error("UNKNOWN_CLASSIFICATION_OPERATION");
    if (!observation || observation.taskId !== input.decision.requestDigest || observation.source !== "runtime" || !observation.observationId || !observation.actorId) {
      return {valid: false, errors: ["HOST_SELECTION_NOT_OBSERVED"], agentSelectedSkillIds: null};
    }
    const observedTask = this.options.observeTask?.(operation.result.request, observation) ?? null;
    if (!operation.task || !observedTask || observedTask.cancelled || observedTask.taskRevision !== operation.task.taskRevision || observedTask.requestDigest !== operation.task.requestDigest || observedTask.sourceRef !== operation.task.sourceRef || operation.actorId !== observation.actorId) return {valid: false, errors: ["HOST_TASK_CHANGED_OR_NOT_OBSERVED"], agentSelectedSkillIds: null};
    if (!Number.isFinite(Date.parse(observation.expiresAt ?? "")) || Date.parse(observation.expiresAt!) <= (this.options.now?.() ?? new Date()).getTime()) throw new Error("HOST_SELECTION_OBSERVATION_EXPIRED");
    if (input.decision.hostReceipt !== null) throw new Error("CALLER_SELECTION_RECEIPT_REJECTED");
    if (input.decision.agentSelectedSkillIds === null) throw new Error("AGENT_SELECTION_MISSING");
    if (JSON.stringify(operation.explicit) !== JSON.stringify(input.decision.explicitSkillIds) || JSON.stringify(operation.required) !== JSON.stringify(input.decision.ruleRequiredSkillIds)) throw new Error("REQUIRED_SKILL_SNAPSHOT_CHANGED");
    const runtime = structuredClone(await this.options.readRuntime());
    const {inventory, discovery, observationDigest, expiresAt} = await this.loadInventory(runtime);
    const current: ClassificationSnapshot = {...operation.result.snapshot, inventoryDigest: inventory.inventoryDigest, configRevision: runtime.config.configRevision, profileRevision: runtime.registry.profileRevision};
    const decision: SkillSelectionDecisionV1 = {...input.decision, hostReceipt: {
      receiptId: observation.observationId, host: observation.actorId.split(":")[0]!, requestDigest: input.decision.requestDigest,
      inventoryDigest: inventory.inventoryDigest, agentSelectedSkillIds: [...input.decision.agentSelectedSkillIds], acceptedAt: observation.observedAt,
    }};
    const checked = validateDecision(operation.result, decision, current);
    if (this.options.observeRuntime && operation.runtimeObservation !== this.options.observeRuntime()) {checked.valid = false; checked.errors.push("RUNTIME_SOURCE_CHANGED");}
    if (operation.runtimeDigest !== digestClassificationValue(runtime)) {checked.valid = false; checked.errors.push("RUNTIME_SOURCE_CHANGED");}
    if (operation.hostDiscoveryDigest !== observationDigest) {checked.valid = false; checked.errors.push("HOST_DISCOVERY_CHANGED");}
    if (expiresAt !== null && Date.parse(expiresAt) <= (this.options.now?.() ?? new Date()).getTime()) {checked.valid = false; checked.errors.push("HOST_DISCOVERY_EXPIRED");}
    if (inventory.issues.length > 0) {checked.valid = false; checked.errors.push("CURRENT_INVENTORY_INVALID");}
    if (!checked.valid) return {...checked, agentSelectedSkillIds: null};
    if (operation.decision !== null && digestClassificationValue({...operation.decision, hostReceipt: null}) !== digestClassificationValue(input.decision)) throw new Error("SELECTION_ALREADY_RECORDED");
    // No await between this current-task fence and the in-memory selection commit.
    const finalTask = this.options.observeTask?.(operation.result.request, observation) ?? null;
    if (!finalTask || finalTask.cancelled || finalTask.taskRevision !== operation.task.taskRevision || finalTask.requestDigest !== operation.task.requestDigest || finalTask.sourceRef !== operation.task.sourceRef) {
      return {valid: false, errors: ["HOST_TASK_CHANGED_OR_NOT_OBSERVED"], agentSelectedSkillIds: null};
    }
    // Recheck the exact attempted profile after every await and before accepting.
    const successful = operation.result.response.error === null && ["SUCCESS", "PARTIAL", "UNCERTAIN"].includes(operation.result.response.status);
    if (successful) {
      const attempt = operation.result.attempts.at(-1);
      const profile = runtime.registry.profiles.find(profile => profile.profileId === attempt?.profileId);
      const invalid = profile ? validateProviderProfile(profile, operation.result.request, (this.options.now?.() ?? new Date()).getTime()) : "PROFILE_UNAVAILABLE";
      if (invalid) return {valid: false, errors: [invalid], agentSelectedSkillIds: null};
    }
    // The selection observation must still be live at this synchronous commit boundary.
    if (!Number.isFinite(Date.parse(observation.expiresAt ?? "")) || Date.parse(observation.expiresAt!) <= (this.options.now?.() ?? new Date()).getTime()) throw new Error("HOST_SELECTION_OBSERVATION_EXPIRED");
    operation.decision ??= decision;
    return {...checked, decision: operation.decision, discovery, admissionStatus: "NOT_EVALUATED", readStatus: "NOT_OBSERVED", appliedStatus: "NOT_OBSERVED", verifiedStatus: "NOT_RUN"};
  }
}

/** Configuration is supplied through an approved installation, never inferred from a subscription. */
export async function readClassificationRuntime(file: string | undefined, root: string): Promise<ClassificationRuntimeSnapshot> {
  if (!file) return {config: {jevEnabled: true, mode: "select", providerProfileRegistryRef: "unconfigured", externalClassificationAllowed: false, configRevision: "unconfigured", timeoutMs: 30000},
    registry: {schemaVersion: "1.0.0", profileRevision: "unconfigured", profiles: []}, allowRemotePrivateContent: false};
  const absolute = path.resolve(root, file);
  const bytes = await readFile(absolute);
  if (bytes.length > 1024 * 1024) throw new Error("CLASSIFICATION_CONFIG_TOO_LARGE");
  const raw = z.strictObject({config: z.strictObject({jevEnabled: z.boolean(), mode: z.enum(["shadow", "select"]), providerProfileRegistryRef: z.string().min(1), externalClassificationAllowed: z.boolean(), configRevision: z.string().min(1), timeoutMs: z.number().int().positive().max(MAX_CLASSIFICATION_TIMEOUT_MS)}), allowRemotePrivateContent: z.boolean(), approvedPublicRequestDigests: z.array(z.string().regex(/^sha256:[a-f0-9]{64}$/u)).optional(), providerRuntimeRef: z.string().min(1).nullable().optional(), nativeAdapterDefinitionsRef: z.string().min(1).nullable().optional(), externalSkillRoots: z.array(z.string().min(1)).optional(), hostDiscoveryRef: z.string().min(1).nullable().optional()}).parse(JSON.parse(bytes.toString("utf8")));
  const {loadProviderProfileRegistry} = await import("./profiles.js");
  const registry = await loadProviderProfileRegistry(path.resolve(path.dirname(absolute), raw.config.providerProfileRegistryRef));
  return {config: raw.config, allowRemotePrivateContent: raw.allowRemotePrivateContent, registry,
    ...(raw.approvedPublicRequestDigests ? {approvedPublicRequestDigests: raw.approvedPublicRequestDigests} : {}),
    ...(raw.providerRuntimeRef !== undefined ? {providerRuntimeRef: raw.providerRuntimeRef === null ? null : path.resolve(path.dirname(absolute), raw.providerRuntimeRef)} : {}),
    ...(raw.nativeAdapterDefinitionsRef !== undefined ? {nativeAdapterDefinitionsRef: raw.nativeAdapterDefinitionsRef === null ? null : path.resolve(path.dirname(absolute), raw.nativeAdapterDefinitionsRef)} : {}),
    ...(raw.hostDiscoveryRef !== undefined ? {hostDiscoveryRef: raw.hostDiscoveryRef === null ? null : path.resolve(path.dirname(absolute), raw.hostDiscoveryRef)} : {}),
    ...(raw.externalSkillRoots ? {externalSkillRoots: raw.externalSkillRoots.map(directory => path.resolve(path.dirname(absolute), directory))} : {})};
}
