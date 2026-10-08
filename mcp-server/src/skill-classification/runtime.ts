import {readFile} from "node:fs/promises";
import {z} from "zod";
import {ApprovedRouteClassificationProvider, jevNoulWireAdapter, type ApprovedClassificationRoute, type ClassificationWireAdapter} from "./providers.js";
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
      const endpoint = new URL(route.endpoint);
      if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password) throw new Error("INVALID_APPROVED_ENDPOINT");
      // JEV's public wire contract is the only built-in remote protocol. Vendor adapters are registered explicitly.
      const adapter = wireAdapterRef === "jev-noul-v1" && route.providerKind === "jev" ? jevNoulWireAdapter : options.wireAdapters?.get(wireAdapterRef);
      if (!adapter) continue;
      routes.push({...common, adapter, getCredential: () => options.getCredentialByEnvName ? options.getCredentialByEnvName(credentialEnvName) : Promise.resolve(process.env[credentialEnvName] ?? null)});
    } else {
      const {nativeAdapterRef, capabilityEvidenceRef, retryPolicyVerified, ...common} = route;
      const adapter = resolveNativeClassificationAdapter(options.nativeAdapters ?? new Map(), nativeAdapterRef, capabilityEvidenceRef, retryPolicyVerified);
      if (!adapter) continue;
      routes.push({...common, invokeStructured: (request, profile, signal) => adapter.invokeStructured(request, profile, signal)});
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
