import type { InputObservation } from "../../mcp-server/src/input-observation.js";
import { SESSION_PROOF_FIELD, SessionActorProofs } from "../../mcp-server/src/session-actor-proof.js";
import { InMemoryWorkflowStore } from "../../mcp-server/src/workflow-store.js";

/** Owned fake core observations only; this helper provides no native identity evidence.
 * Calls remain explicit so missing-proof and caller-binding negative tests stay negative. */
export function createSyntheticRootProofFixture() {
  const store = new InMemoryWorkflowStore();
  const proofs = new SessionActorProofs(store);
  let sequence = 0;
  return {
    proofs,
    argumentsFor(tool: string, args: Record<string, unknown>, identity?: { host: string; sessionId: string }): Record<string, unknown> {
      const observation: InputObservation = {
        host: identity?.host ?? "synthetic-root-host",
        sessionId: identity?.sessionId ?? "synthetic-root-session",
        callId: `synthetic-call-${++sequence}`,
        kind: "tool-boundary",
        boundaryPhase: "before",
        actor: { role: "root", basis: "observed", reasonCode: "SYNTHETIC_TEST_ROOT_OBSERVATION" },
      };
      // The actual issuer rejects legacy caller bindings; none are stripped or trusted.
      return { ...args, [SESSION_PROOF_FIELD]: proofs.issue(observation, tool, args) };
    },
  };
}
