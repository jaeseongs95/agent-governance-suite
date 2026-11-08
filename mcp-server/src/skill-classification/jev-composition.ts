import type { AdminJevState } from "../admin-log.js";
import { applyAdminJev, jevReadiness, type JevProviderView } from "../admin-settings.js";
import { createJevModelCatalog } from "./jev-model-catalog.js";
import { createJevClassificationProvider, jevProvider, jevTransmittedFields, JEV_PROVIDERS } from "./jev-provider.js";
import type { ClassificationJevSettings } from "./service.js";
import type { ProviderProfileRegistry } from "./types.js";

/**
 * JEV as the MCP server composes it (4.0.0): the providers AGS ships, the settings the user signed on the admin page and
 * the key registered there. Nothing here reads an installation file or an environment variable.
 */
export function composeJev(options: {
  /** The verified signed JEV settings; null when none (JEV off). */
  signed: () => AdminJevState | null;
  /** A key registered on the admin page by name; null when none. */
  pageKey: (name: string) => string | null;
  fetcher?: typeof fetch;
}) {
  const jev = createJevClassificationProvider({ getCredential: async definition => options.pageKey(definition.credentialName),
    ...(options.fetcher ? { fetcher: options.fetcher } : {}) });
  const catalogs = new Map(JEV_PROVIDERS.map(definition => [definition.providerId, createJevModelCatalog({ definition,
    getCredential: async () => options.pageKey(definition.credentialName), ...(options.fetcher ? { fetcher: options.fetcher } : {}) })]));
  const transmitted = new Map(JEV_PROVIDERS.map(definition => [definition.providerId, jevTransmittedFields(definition)]));
  return {
    provider: jev.provider,
    profileFor: jev.profileFor,
    signedLimitUsd: () => options.signed()?.limitUsd ?? null,
    /** The classification runtime with JEV as signed (see applyAdminJev). */
    apply<T extends { config: { jevEnabled: boolean }; registry: ProviderProfileRegistry; jev?: ClassificationJevSettings }>(runtime: T): T & { jev: ClassificationJevSettings } {
      return applyAdminJev(runtime, options.signed(), jev.profileFor);
    },
    /** Whether skill classification can ask JEV now: JEV ready and its preset on. */
    ready(usage: { spentUsd: number | null; reservedUsd: number } | null): boolean {
      const signed = options.signed();
      const definition = signed?.model ? jevProvider(signed.model.providerId) : null;
      return (signed?.presets["skill-classification"] ?? true) && jevReadiness(signed, {
        keyStored: definition !== null && options.pageKey(definition.credentialName) !== null, profileFor: jev.profileFor, usage }).ready;
    },
    /** The providers as the admin page shows them, with each one's current model list. */
    async views(): Promise<JevProviderView[]> {
      return Promise.all(JEV_PROVIDERS.map(async definition => ({ providerId: definition.providerId, label: definition.label,
        endpoint: definition.endpoint, credentialName: definition.credentialName, perCallUsd: definition.maximumCostUsd,
        catalog: await catalogs.get(definition.providerId)!.get(), transmitted: transmitted.get(definition.providerId)! })));
    },
  };
}
