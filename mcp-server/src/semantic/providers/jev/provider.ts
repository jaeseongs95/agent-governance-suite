import { createHash } from "node:crypto";

import type { ArtifactRefV1, SemanticDecisionProviderV1, SemanticDecisionRequestV1 } from "../../../../../contracts/types.js";
import { canonical } from "../../../../../skills/coordinate-subagents/scripts/model-routing-core.mjs";
import { ArtifactReferenceAccess } from "../../../artifacts/reference-access.js";
import type { BoundedProviderControl, BoundedSemanticProviderPort } from "../../provider-runner.js";
import type { SemanticProviderResultV1 } from "../../provider-port.js";
import { SEMANTIC_STATE_PROJECTION_VERSION } from "../../state-projection.js";
import { JevHttpClient, JEV_ENDPOINT } from "./http-client.js";
import { checkJevChoiceCardinality } from "./request-limits.js";
import { JEV_MODEL_ID, JEV_REQUEST_PROJECTION_VERSION, projectJevRequest } from "./request-mapper.js";
import { mapJevChoiceResponse } from "./response-mapper.js";

export const JEV_ADAPTER_REVISION = "1.0.0";

export interface JevImplementationIdentity {
  endpoint: string;
  model: string;
  adapterRevision: string;
  projectionVersion: string;
  stateProjectionVersion: string;
}

export const JEV_IMPLEMENTATION_IDENTITY: JevImplementationIdentity = {
  endpoint: JEV_ENDPOINT, model: JEV_MODEL_ID, adapterRevision: JEV_ADAPTER_REVISION,
  projectionVersion: JEV_REQUEST_PROJECTION_VERSION,
  stateProjectionVersion: SEMANTIC_STATE_PROJECTION_VERSION,
};

/** Bind endpoint and projection changes into the provider identity used by adoption. */
export function jevProviderIdentity(parts: Readonly<JevImplementationIdentity> = JEV_IMPLEMENTATION_IDENTITY): SemanticDecisionProviderV1 {
  const hash = createHash("sha256").update(JSON.stringify([
    parts.endpoint, parts.model, parts.adapterRevision, parts.projectionVersion, parts.stateProjectionVersion,
  ])).digest("hex");
  return { id: "jev", model: parts.model, adapterVersion: `jev-adapter-${hash}`,
    providerVersion: null, modelVersion: null };
}

export type JevArtifactInputs = { refs: readonly ArtifactRefV1[]; access: ArtifactReferenceAccess };

export class JevSemanticProvider implements BoundedSemanticProviderPort {
  constructor(
    readonly identity: Readonly<SemanticDecisionProviderV1>,
    private readonly http: JevHttpClient,
    private readonly artifactInputsFor?: (request: Readonly<SemanticDecisionRequestV1>) => JevArtifactInputs,
  ) {}

  async evaluate(request: Readonly<SemanticDecisionRequestV1>, control: BoundedProviderControl): Promise<SemanticProviderResultV1> {
    if (canonical(request.provider) !== canonical(this.identity)
      || checkJevChoiceCardinality(request.options)) return { status: "invalid" };
    const required = request.state.sources.filter(source => source.kind === "artifact" && source.id !== "model-catalog");
    const artifacts = this.artifactInputsFor?.(request);
    if (required.length !== (artifacts?.refs.length ?? 0)
      || required.some(source => !artifacts?.refs.some(ref => ref.id === source.id && ref.digest === source.digest))) {
      return { status: "invalid" };
    }
    let requestText: string;
    try {
      requestText = (await projectJevRequest({ prepared: request,
        ...(artifacts ? { artifactRefs: artifacts.refs, artifactAccess: artifacts.access } : {}) })).requestText;
    } catch { return { status: "invalid" }; }
    const result = await this.http.post(requestText, control);
    switch (result.status) {
      case "response": return mapJevChoiceResponse(result.body, request);
      case "rate-limited": return { status: "unavailable" };
      case "timeout": return { status: "timeout" };
      case "unsupported-bytes": return { status: "invalid" };
      default: return { status: "uncertain" };
    }
  }
}
