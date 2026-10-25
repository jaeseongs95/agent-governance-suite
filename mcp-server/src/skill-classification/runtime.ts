import {types as utilTypes} from "node:util";
import {readFile} from "node:fs/promises";
import {z} from "zod";
import {ApprovedRouteClassificationProvider, jevNoulWireAdapter, jevNoulSufficiencyWireAdapter, jevNoulSharedRulesWireAdapter, jevNoulSharedRulesV5LongContextWireAdapter, jevNoulSharedRulesV5WireAdapter, JEV_NOUL_SHARED_RULES_V5_LONG_CONTEXT_ADAPTER_REVISION, type ApprovedClassificationRoute, type ClassificationWireAdapter} from "./providers.js";
import {resolveNativeClassificationAdapter, type NativeClassificationAdapterRegistry} from "./native-adapters.js";
import {InMemoryClassificationBudget} from "./service.js";

const text = z.string().min(1);
const routeBase = {
  routeRef: text, approvalRef: text, approved: z.boolean(), providerKind: z.enum(["jev", "vendor"]), vendorId: text, adapterRevision: text,
  modelIds: z.array(text).min(1), reasoningEfforts: z.array(text.nullable()).min(1), structuredOutput: z.boolean(),
};
const limit = z.strictObject({limitUsd: z.number().finite().nonnegative().nullable(), spentUsd: z.number().finite().nonnegative().nullable()});
export const classificationProviderRuntimeSchema = z.strictObject({
  schemaVersion: z.literal("1.0.0"),
  routes: z.array(z.discriminatedUnion("kind", [
    z.strictObject({...routeBase, kind: z.literal("remote"), endpoint: z.url(), credentialEnvName: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u), wireAdapterRef: text}),
    z.strictObject({...routeBase, kind: z.literal("native"), nativeAdapterRef: text, capabilityEvidenceRef: text, retryPolicyVerified: z.boolean()}),
  ])),
  budget: z.strictObject({jev: limit, vendors: z.record(text, limit), nativeAllowances: z.record(text, z.strictObject({approvalRef: text, remainingCalls: z.number().int().nonnegative().nullable()}))}),
});
export type ClassificationProviderRuntimeConfig = z.infer<typeof classificationProviderRuntimeSchema>;
export interface ClassificationProviderRuntimeOptions {
  fetcher?: typeof fetch;
  getCredentialByEnvName?: (name: string) => Promise<string | null>;
  wireAdapters?: ReadonlyMap<string, ClassificationWireAdapter>;
  nativeAdapters?: NativeClassificationAdapterRegistry;
}

/** The trusted installation supplies routes and balances. Requests cannot invent endpoints or keys. */
export function createClassificationProviderRuntime(raw: unknown, options: ClassificationProviderRuntimeOptions = {}) {
  const config = classificationProviderRuntimeSchema.parse(raw);
  if (new Set(config.routes.map(route => route.routeRef)).size !== config.routes.length) throw new Error("DUPLICATE_CLASSIFICATION_ROUTE");
  const routes: ApprovedClassificationRoute[] = [];
  for (const route of config.routes) {
    if (route.kind === "remote") {
      const {credentialEnvName, wireAdapterRef, ...common} = route;
      const jevLongContext = wireAdapterRef === JEV_NOUL_SHARED_RULES_V5_LONG_CONTEXT_ADAPTER_REVISION;
      if (jevLongContext && (route.providerKind !== "jev" || route.adapterRevision !== JEV_NOUL_SHARED_RULES_V5_LONG_CONTEXT_ADAPTER_REVISION)) throw new Error("INVALID_JEV_CONTEXT_ROUTE");
      const endpoint = new URL(route.endpoint);
      if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password) throw new Error("INVALID_APPROVED_ENDPOINT");
      // JEV's public wire contract is the only built-in remote protocol. Vendor adapters are registered explicitly.
      const adapter = route.providerKind === "jev" && wireAdapterRef === "jev-noul-v1" ? jevNoulWireAdapter
        : route.providerKind === "jev" && wireAdapterRef === "jev-noul-sufficiency-v2" ? jevNoulSufficiencyWireAdapter
        : route.providerKind === "jev" && wireAdapterRef === "jev-noul-sufficiency-shared-v4" ? jevNoulSharedRulesWireAdapter
        : route.providerKind === "jev" && wireAdapterRef === "jev-noul-sufficiency-shared-v5" ? jevNoulSharedRulesV5WireAdapter
        : jevLongContext ? jevNoulSharedRulesV5LongContextWireAdapter
        : options.wireAdapters?.get(wireAdapterRef);
      if (!adapter) continue;
      routes.push({...common, ...(jevLongContext ? {jevLongContext: true as const} : {}), adapter, getCredential: () => options.getCredentialByEnvName ? options.getCredentialByEnvName(credentialEnvName) : Promise.resolve(process.env[credentialEnvName] ?? null)});
    } else {
      const {nativeAdapterRef, capabilityEvidenceRef, retryPolicyVerified, ...common} = route;
      const adapter = resolveNativeClassificationAdapter(options.nativeAdapters ?? new Map(), nativeAdapterRef, capabilityEvidenceRef, retryPolicyVerified);
      if (!adapter) continue;
      routes.push({...common, invokeStructured: (request, profile, signal, beforeDispatch) => adapter.invokeStructured(request, profile, signal, beforeDispatch)});
    }
  }
  return {providers: {
    jev: new ApprovedRouteClassificationProvider(routes.filter(route => route.providerKind === "jev"), options.fetcher),
    vendor: new ApprovedRouteClassificationProvider(routes.filter(route => route.providerKind === "vendor"), options.fetcher),
  }, budget: new InMemoryClassificationBudget(config.budget)};
}

export async function loadClassificationProviderRuntime(file: string, options: ClassificationProviderRuntimeOptions = {}) {
  const bytes = await readFile(file);
  if (bytes.length > 1024 * 1024) throw new Error("CLASSIFICATION_RUNTIME_TOO_LARGE");
  return createClassificationProviderRuntime(JSON.parse(bytes.toString("utf8")), options);
}

/** Closed startup reasons only; this is diagnostic classification, not producer authenticity proof.
 * Raw messages, stacks, paths, argv and bodies are never reported. */
export function reportClassificationInitializationFailure(error: unknown,
  report: (record: Readonly<{phase: "classification-initialization"; reason: string}>) => void = record => {
    console.error("[agent-governance-suite] classification-initialization-failed " + JSON.stringify(record));
  }): void {
  let reason = "CLASSIFICATION_CONFIGURATION_UNAVAILABLE";
  try {
    const message: unknown = error && typeof error === "object" && !utilTypes.isProxy(error) ? Object.getOwnPropertyDescriptor(error, "message")?.value : null;
    if (typeof message === "string" && ["INVALID_NATIVE_ADAPTER_DEFINITION", "DUPLICATE_NATIVE_ADAPTER",
      "NATIVE_ADAPTER_BEHAVIOR_UNAVAILABLE", "INVALID_NATIVE_ISOLATION_ARGUMENT", "NATIVE_ISOLATION_VALIDATION_UNAVAILABLE",
      "NATIVE_ADAPTER_DEFINITIONS_TOO_LARGE", "DUPLICATE_CLASSIFICATION_ROUTE", "INVALID_APPROVED_ENDPOINT",
      "CLASSIFICATION_RUNTIME_TOO_LARGE", "INVALID_JEV_CONTEXT_ROUTE"].includes(message)) reason = message;
  } catch { /* Opaque errors remain a fixed unavailable reason. */ }
  try { report(Object.freeze({phase: "classification-initialization", reason})); }
  catch { /* A broken diagnostic sink cannot enable classification or replace the startup failure. */ }
}
