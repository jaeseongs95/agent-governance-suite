import {ApprovedRouteClassificationProvider, bindClassificationRouteTransport, resolveClassificationWireAdapter,
  JEV_SKILL_SELECTION_CHOICE_ADAPTER_REVISION, JEV_SKILL_SELECTION_CHOICE_PROMPT_REVISION, type ApprovedClassificationRoute,
  type ClassificationWireAdapter} from "./providers.js";
import {digestProviderProfileConfiguration} from "./profile-validation.js";
import {createClassificationRequest} from "./request.js";
import type {ProviderConfiguration, ProviderProfile} from "./types.js";

/**
 * A JEV provider AGS ships (4.0.0): where its calls go, the wire it speaks, which models it names and what one call may
 * cost. The MCP server owns these; no installation file or environment variable supplies or changes them. The user picks
 * a provider's model, allows sending, sets the budget and registers the key on the admin page. JEV is an advice layer:
 * there is no qualification gate before a call (the profile says so with qualification NOT_RUN), and when it fails the
 * agent chooses by itself.
 */
export interface JevProviderDefinition {
  readonly providerId: string;
  readonly label: string;
  readonly endpoint: string;
  readonly modelsEndpoint: string;
  /** The admin page key name the calls use (a key registered on the page, never an environment variable). */
  readonly credentialName: string;
  readonly wireAdapterRef: string;
  readonly adapterRevision: string;
  readonly promptRevision: string;
  /** A pinned model name; aliases that move (such as "latest") are not models here. */
  readonly modelPattern: RegExp;
  /** Offered before the first successful list refresh. */
  readonly bundledModels: readonly string[];
  readonly maximumInputBytes: number;
  readonly maximumOutputTokens: number;
  /** Reserved from the signed budget before each call (an upper bound; see the definition). */
  readonly maximumCostUsd: number;
  /** The model names a models-list response carries (unknown fields are dropped). */
  parseModels(body: unknown): string[];
}

const TYPESAFE_INPUT_BYTES = 256 * 1024;
/**
 * TypeSafe JEV. Endpoints: https://docs.typesafe.ai/api; the models list is the account endpoint the ssh_mcp portal uses.
 * Price (docs.typesafe.ai/models, as recorded in tests/skill-classification/live-bootstrap/README.md): input USD 0.042 per
 * million tokens, output free. One UTF-8 byte is counted as one input token, which bounds the token count from above
 * (a token is at least one byte); the provider's own billing rule is not verified here.
 */
export const TYPESAFE_JEV: JevProviderDefinition = Object.freeze({
  providerId: "typesafe",
  label: "TypeSafe",
  endpoint: "https://api.typesafe.ai/v1/systemone",
  modelsEndpoint: "https://api.typesafe.ai/v1/models",
  credentialName: "JEV_API_KEY",
  wireAdapterRef: JEV_SKILL_SELECTION_CHOICE_ADAPTER_REVISION,
  adapterRevision: JEV_SKILL_SELECTION_CHOICE_ADAPTER_REVISION,
  promptRevision: JEV_SKILL_SELECTION_CHOICE_PROMPT_REVISION,
  modelPattern: /^jev-[1-9][0-9]?\.[0-9]{1,2}\.[0-9]{1,2}$/u,
  bundledModels: Object.freeze(["jev-1.14.0", "jev-1.13.0"]),
  maximumInputBytes: TYPESAFE_INPUT_BYTES,
  maximumOutputTokens: 1000,
  maximumCostUsd: TYPESAFE_INPUT_BYTES * 0.042 / 1_000_000,
  parseModels(body: unknown): string[] {
    const models = (body as {models?: unknown} | null)?.models;
    if (!Array.isArray(models) || models.length > 100) throw new Error("JEV_MODELS_INVALID");
    return [...new Set(models.map(item => (item as {name?: unknown} | null)?.name)
      .filter((name): name is string => typeof name === "string" && TYPESAFE_JEV.modelPattern.test(name)))];
  },
});

/** The JEV providers this AGS has; a signed model names one of them. */
export const JEV_PROVIDERS: readonly JevProviderDefinition[] = Object.freeze([TYPESAFE_JEV]);

export function jevProvider(providerId: string): JevProviderDefinition | null {
  return JEV_PROVIDERS.find(definition => definition.providerId === providerId) ?? null;
}

export interface JevModelChoice {providerId: string; modelId: string}

/** The profile of a chosen model: pinned, no qualification claimed (NOT_RUN), the provider's limits. */
export function jevModelProfile(choice: JevModelChoice): ProviderProfile | null {
  const definition = jevProvider(choice.providerId);
  if (!definition || !definition.modelPattern.test(choice.modelId)) return null;
  const configuration: ProviderConfiguration = {profileId: `jev:${definition.providerId}:${choice.modelId}`, providerKind: "jev",
    vendorId: definition.providerId, modelId: choice.modelId, modelRevision: choice.modelId, reasoningEffort: null,
    supportedOptions: {reasoningEfforts: [null], structuredOutput: true}, approvedRouteRef: `jev:${definition.providerId}:${choice.modelId}`,
    qualificationRevision: "not-run", adapterRevision: definition.adapterRevision, promptRevision: definition.promptRevision,
    maximumInputBytes: definition.maximumInputBytes, maximumOutputTokens: definition.maximumOutputTokens,
    maximumCostUsd: definition.maximumCostUsd, judgmentPolicy: null};
  return {...configuration, qualification: {status: "NOT_RUN", inventoryDigest: "not-run", taxonomyRevision: "not-run",
    modelRevision: choice.modelId, promptRevision: definition.promptRevision, validUntil: "not-run",
    profileConfigurationDigest: digestProviderProfileConfiguration(configuration)}};
}

function wireAdapter(definition: JevProviderDefinition): ClassificationWireAdapter {
  const adapter = resolveClassificationWireAdapter(definition.wireAdapterRef, {providerKind: "jev", adapterRevision: definition.adapterRevision});
  if (!adapter) throw new Error("JEV_WIRE_ADAPTER_UNAVAILABLE");
  return adapter;
}

/**
 * The JEV provider port the classification service calls. A model's route is added the first time its profile is asked
 * for and never changes after that, so the route fences of calls in flight stay valid.
 */
export function createJevClassificationProvider(options: {getCredential: (definition: JevProviderDefinition) => Promise<string | null>; fetcher?: typeof fetch}) {
  const routes: ApprovedClassificationRoute[] = [];
  // ceiling: one route per (provider, model) for the server's lifetime; models are pinned names, so this stays small.
  const provider = new ApprovedRouteClassificationProvider(routes, options.fetcher);
  const profileFor = (choice: JevModelChoice): ProviderProfile | null => {
    const profile = jevModelProfile(choice);
    if (!profile) return null;
    if (!routes.some(route => route.routeRef === profile.approvedRouteRef)) {
      const definition = jevProvider(choice.providerId)!;
      routes.push(bindClassificationRouteTransport({kind: "remote", routeRef: profile.approvedRouteRef, approvalRef: "ags-admin-page:jev",
        approved: true, providerKind: "jev", vendorId: definition.providerId, adapterRevision: definition.adapterRevision,
        modelIds: [choice.modelId], reasoningEfforts: [null], structuredOutput: true, endpoint: definition.endpoint,
        adapter: wireAdapter(definition), getCredential: () => options.getCredential(definition)}));
    }
    return profile;
  };
  return {provider, profileFor};
}

/** What one call sends, read from the provider's actual wire encoding of a sample request (the page lists these). */
export function jevTransmittedFields(definition: JevProviderDefinition): {request: string[]; task: string[]; perSkill: string[]} {
  const skill = {skillId: "sample", version: "1.0.0", description: "sample", enabled: true, installed: true, hostSupported: true,
    capabilities: ["sample"], actions: [], targets: [], constraints: [], applicability: ["sample"], exclusions: ["sample"], dependencies: [], phases: [],
    sourceRefs: [{path: "skills/sample/SKILL.md", digest: `sha256:${"0".repeat(64)}`}]};
  const request = createClassificationRequest({requestId: "sample", operationId: "sample", originalPrompt: "sample",
    confirmedContext: {taskRevision: null, objective: null, actions: null, targets: null, constraints: null, prohibitedActions: null, background: null},
    contextSources: [], inventory: {skills: [skill], inventoryDigest: `sha256:${"0".repeat(64)}`, taxonomyRevision: "sample", issues: []},
    classificationCriteriaRef: "sample"});
  const profile = jevModelProfile({providerId: definition.providerId, modelId: definition.bundledModels[0]!})!;
  const body = wireAdapter(definition).encode(request, profile) as {state?: Record<string, unknown>; questions?: Record<string, {instructions?: {skill?: Record<string, unknown>}}>};
  return {request: Object.keys(body).filter(key => key !== "state" && key !== "questions"), task: Object.keys(body.state ?? {}),
    perSkill: Object.keys(Object.values(body.questions ?? {})[0]?.instructions?.skill ?? {})};
}
