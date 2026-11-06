// Shared installation adapter data. Skill references remain the public declarative catalog; no skill code is loaded.
export {default as defaultModelRoutingPresets} from "../skills/coordinate-subagents/references/model-routing-presets.json" with {type: "json"};

// Provider-neutral catalog lookup. Only declared IDs and aliases are classification evidence.
// Legacy strategy labels remain accepted for catalog compatibility; they no longer infer a class from a name.
export function resolveCatalogModel(catalog, rawModel, { allowProfileKeys = false } = {}) {
  if (typeof rawModel !== "string" || rawModel.length === 0 || !catalog) return null;
  if (!["exact-only", "claude-family-or-exact", "gemini-family-or-exact"].includes(catalog.matching)) return null;
  const models = catalog.models ?? {};
  const aliases = catalog.aliases ?? {};
  if (!allowProfileKeys && catalog.profile_only_keys?.includes(rawModel)) return null;
  const canonicalKey = Object.hasOwn(aliases, rawModel) ? aliases[rawModel] : rawModel;
  if (!Object.hasOwn(models, canonicalKey)) return null;
  return canonicalKey;
}
