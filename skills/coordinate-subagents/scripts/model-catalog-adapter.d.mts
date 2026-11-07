export type CatalogMatchingStrategyV1 = "exact-only";

export interface ProviderCatalogForMatchingV1 {
  readonly matching: CatalogMatchingStrategyV1;
  readonly profile_only_keys?: readonly string[];
  readonly models: Readonly<Record<string, unknown>>;
  readonly aliases?: Readonly<Record<string, string>>;
}

export function resolveCatalogModel(
  catalog: ProviderCatalogForMatchingV1 | undefined,
  rawModel: string,
  options?: { readonly allowProfileKeys?: boolean },
): string | null;
