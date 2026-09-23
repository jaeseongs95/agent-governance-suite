import type { SemanticAdoptionPolicyV1, SemanticDecisionProviderV1, SemanticDecisionRequestV1 } from "../../../contracts/types.js";
import { canonical } from "../../../skills/coordinate-subagents/scripts/model-routing-core.mjs";
import type { BoundedSemanticProviderPort } from "./provider-runner.js";
import { JevHttpClient } from "./providers/jev/http-client.js";
import {
  JevSemanticProvider, jevProviderIdentity, type JevArtifactInputs,
} from "./providers/jev/provider.js";

/** Server-owned registry; merely constructing it neither calls a provider nor admits advice. */
export class SemanticProviderRegistry {
  constructor(private readonly providers: ReadonlyMap<string, BoundedSemanticProviderPort> = new Map()) {}
  get(id: string): BoundedSemanticProviderPort | null { return this.providers.get(id) ?? null; }
  ids(): string[] { return [...this.providers.keys()]; }
}

export type JevRegistryResult = {
  status: "off" | "credential-unavailable" | "registered";
  registry: SemanticProviderRegistry;
  identity: SemanticDecisionProviderV1 | null;
  adoption: "unvalidated" | "drift" | "requires-admission";
  /** Provider registration never grants semantic assist. */
  assistActive: false;
};

type EnabledJev = {
  enabled: true;
  credential?: () => string | null;
  timeoutMs: number;
  maxResponseBytes: number;
  fetcher?: typeof fetch;
  adoption?: SemanticAdoptionPolicyV1;
  artifactInputsFor?: (request: Readonly<SemanticDecisionRequestV1>) => JevArtifactInputs;
};

export function createOptionalJevRegistry(input: { enabled?: false } | EnabledJev = {}): JevRegistryResult {
  const empty = new SemanticProviderRegistry();
  if (!input.enabled) return { status: "off", registry: empty, identity: null,
    adoption: "unvalidated", assistActive: false };
  let available = false;
  try {
    const token = input.credential?.();
    available = typeof token === "string" && token.length > 0 && !/\s/u.test(token);
  } catch { /* A missing credential is not an egress attempt. */ }
  if (!available) return { status: "credential-unavailable", registry: empty, identity: null,
    adoption: "unvalidated", assistActive: false };
  const identity = Object.freeze(jevProviderIdentity());
  const http = new JevHttpClient({ credential: () => {
    const token = input.credential?.();
    if (!token) throw new TypeError("Jev credential is unavailable.");
    return token;
  }, timeoutMs: input.timeoutMs, maxResponseBytes: input.maxResponseBytes,
  ...(input.fetcher ? { fetcher: input.fetcher } : {}) });
  const provider = new JevSemanticProvider(identity, http, input.artifactInputsFor);
  const adoption = input.adoption?.status !== "validated" ? "unvalidated"
    : canonical(input.adoption.provider) === canonical(identity) ? "requires-admission" : "drift";
  return { status: "registered", registry: new SemanticProviderRegistry(new Map([[identity.id, provider]])),
    identity, adoption, assistActive: false };
}
