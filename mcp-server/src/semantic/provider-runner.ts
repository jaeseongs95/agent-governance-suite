/** Internal invocation boundary. The owning server supplies authority, budget reservation and port. */
import { randomUUID } from "node:crypto";
import {
  WorkflowContractError, type SemanticDecisionPolicyV1, type SemanticDecisionRequestV1,
  type SemanticEgressConfigV1,
} from "../../../contracts/types.js";
import { digest } from "../../../skills/coordinate-subagents/scripts/model-routing-core.mjs";
import { ContractValidator } from "../schema-validator.js";
import { assertSemanticEgressAllowed, type SemanticEgressContext } from "./egress-guard.js";
import { SemanticEvaluationIntentStore } from "./evaluation-intent.js";
import {
  parseSemanticProviderResultV1, type SemanticProviderResultV1,
} from "./provider-port.js";

export interface BoundedProviderControl {
  signal: AbortSignal;
  endpoint: string;
  redirect: "error";
  /** Adapter reports each emitted output chunk; J05 transport must honor this and signal. */
  onOutput(chunk: Uint8Array | string): void;
}

/** P01 result contract with runner controls required of a bounded transport adapter. */
export interface BoundedSemanticProviderPort {
  evaluate(request: Readonly<SemanticDecisionRequestV1>, control: BoundedProviderControl): Promise<SemanticProviderResultV1>;
}

export type RunnerOutcome =
  | { status: "off" | "busy" | "already-claimed" | "cancelled" | "uncertain" }
  | { status: "recorded"; result: SemanticProviderResultV1 };

export interface RunnerAuthority {
  policy: SemanticDecisionPolicyV1;
  config: SemanticEgressConfigV1;
  context: Readonly<SemanticEgressContext>;
}

export interface RunnerOptions {
  maxConcurrent: number;
  maxOutputBytes: number;
  timeoutMs: number;
}

function positive(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new WorkflowContractError("INVALID_INPUT", `${name} must be a positive safe integer.`);
  }
}

/** Reuse one instance per server to share the concurrency cap. No claim ID enters run() or its result. */
export class SemanticProviderRunner {
  private readonly validator = new ContractValidator();
  private active = 0;

  constructor(
    private readonly intents: SemanticEvaluationIntentStore,
    private readonly provider: BoundedSemanticProviderPort,
    private readonly authorityFor: (request: SemanticDecisionRequestV1) => RunnerAuthority,
    /** This server-owned callback must atomically reserve the approved request/cost budget. */
    private readonly reserveBudget: (request: SemanticDecisionRequestV1, authority: RunnerAuthority) => void,
    private readonly options: Readonly<RunnerOptions>,
  ) {
    positive(options.maxConcurrent, "maxConcurrent");
    positive(options.maxOutputBytes, "maxOutputBytes");
    positive(options.timeoutMs, "timeoutMs");
    if (options.timeoutMs > 2_147_483_647) {
      throw new WorkflowContractError("INVALID_INPUT", "timeoutMs exceeds the timer range.");
    }
  }

  async run(input: {
    idempotencyKey: string;
    prepared: unknown;
    signal?: AbortSignal;
  }): Promise<RunnerOutcome> {
    const request = this.validator.semanticDecisionRequestV1(input.prepared);
    const authority = this.authorityFor(request);
    const policy = this.validator.semanticDecisionPolicyV1(authority.policy);
    if (policy.mode === "off") return { status: "off" };
    if (input.signal?.aborted) return { status: "cancelled" };
    if (this.active >= this.options.maxConcurrent) return { status: "busy" };

    // Preflight is read-only; it never confers budget reservation or a runner claim.
    assertSemanticEgressAllowed(request, policy, authority.config, authority.context);
    this.active++;
    let released = false;
    const release = () => { if (!released) { released = true; this.active--; } };
    let claimed = false;
    let attempt: Promise<SemanticProviderResultV1> | null = null;
    try {
      const intent = this.intents.begin(input.idempotencyKey, request);
      if (intent.state !== "pending") return { status: "already-claimed" };
      if (input.signal?.aborted) return { status: "cancelled" };
      // Reservation is required before claim. No provider call can follow a failed reservation.
      this.reserveBudget(request, authority);
      const claim = this.intents.claim(request.evaluationId, request.requestDigest, randomUUID());
      claimed = true;
      const claimId = claim.claimId;
      if (!claimId) throw new WorkflowContractError("GATE_FAILED", "Fresh runner claim is missing.");

      const controller = new AbortController();
      let outputBytes = 0;
      const onOutput = (chunk: Uint8Array | string) => {
        if (controller.signal.aborted) return;
        const size = typeof chunk === "string" ? Buffer.byteLength(chunk, "utf8")
          : chunk instanceof Uint8Array ? chunk.byteLength : this.options.maxOutputBytes + 1;
        outputBytes += size;
        if (!Number.isSafeInteger(outputBytes) || outputBytes > this.options.maxOutputBytes) {
          controller.abort(new Error("Semantic provider output limit exceeded."));
        }
      };
      const cancel = () => controller.abort(input.signal?.reason);
      input.signal?.addEventListener("abort", cancel, { once: true });
      const timer = setTimeout(() => controller.abort(new Error("Semantic provider deadline exceeded.")),
        this.options.timeoutMs);
      let onAbort: (() => void) | null = null;
      const aborted = new Promise<{ kind: "aborted" }>((resolve) => {
        onAbort = () => resolve({ kind: "aborted" });
        controller.signal.addEventListener("abort", onAbort, { once: true });
      });
      try {
        if (input.signal?.aborted) {
          controller.abort(input.signal.reason);
        } else {
          // Only this fresh claim path invokes the port. readback claim IDs are never accepted as input.
          const currentAuthority = this.authorityFor(request);
          if (digest(currentAuthority.policy) !== digest(authority.policy)
            || digest(currentAuthority.config) !== digest(authority.config)) {
            throw new WorkflowContractError("GATE_FAILED", "Semantic egress authority changed after reservation.");
          }
          const target = assertSemanticEgressAllowed(request, currentAuthority.policy, currentAuthority.config,
            currentAuthority.context);
          if (!controller.signal.aborted) {
            attempt = Promise.resolve(this.provider.evaluate(request, {
              signal: controller.signal, onOutput, ...target,
            }));
            // Keep the slot occupied if the adapter ignores cancellation and settles late.
            void attempt.then(release, release);
            const outcome = await Promise.race([
              attempt.then(value => ({ kind: "result" as const, value }), () => ({ kind: "failed" as const })),
              aborted,
            ]);
            if (outcome.kind === "result" && !controller.signal.aborted) {
              let result: SemanticProviderResultV1;
              try { result = parseSemanticProviderResultV1(outcome.value); }
              catch { this.intents.resume(request.evaluationId, request.requestDigest); return { status: "uncertain" }; }
              const finalBytes = Buffer.byteLength(JSON.stringify(result), "utf8");
              if (finalBytes > this.options.maxOutputBytes - outputBytes) {
                this.intents.resume(request.evaluationId, request.requestDigest);
                return { status: "uncertain" };
              }
              if (result.status === "timeout" || result.status === "uncertain" || result.status === "unavailable") {
                this.intents.resume(request.evaluationId, request.requestDigest);
                return { status: "uncertain" };
              }
              this.intents.recordResult(request.evaluationId, request.requestDigest, claimId, result);
              return { status: "recorded", result };
            }
          }
        }
        this.intents.resume(request.evaluationId, request.requestDigest);
        return { status: "uncertain" };
      } finally {
        clearTimeout(timer);
        input.signal?.removeEventListener("abort", cancel);
        if (onAbort) controller.signal.removeEventListener("abort", onAbort);
      }
    } catch (error) {
      if (claimed) {
        // A provider may have accepted work despite a local failure. Never create another claim.
        try { this.intents.resume(request.evaluationId, request.requestDigest); } catch { /* preserve original error */ }
      }
      throw error;
    } finally {
      if (attempt === null) release();
    }
  }
}
