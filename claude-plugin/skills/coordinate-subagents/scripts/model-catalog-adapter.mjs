// Provider-neutral catalog lookup. Only declared IDs and aliases are classification evidence.
export function resolveCatalogModel(catalog, rawModel, { allowProfileKeys = false } = {}) {
  if (typeof rawModel !== "string" || rawModel.length === 0 || !catalog) return null;
  if (catalog.matching !== "exact-only") return null;
  const models = catalog.models ?? {};
  const aliases = catalog.aliases ?? {};
  if (!allowProfileKeys && catalog.profile_only_keys?.includes(rawModel)) return null;
  const canonicalKey = Object.hasOwn(aliases, rawModel) ? aliases[rawModel] : rawModel;
  if (!Object.hasOwn(models, canonicalKey)) return null;
  return canonicalKey;
}
