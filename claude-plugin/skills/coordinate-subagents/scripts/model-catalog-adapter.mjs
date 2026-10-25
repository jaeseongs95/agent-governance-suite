// Provider catalog boundary shared by routing profiles and runtime observations.
// Pure lookup: no filesystem, policy state, signing, host discovery or CLI effects.
function escapeRegExp(literal) {
  return literal.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function buildClaudeFamilyRegex(keys) {
  if (keys.length === 0) return null;
  const sorted = [...keys].sort((left, right) => right.length - left.length).map(escapeRegExp);
  // Native, Bedrock and Vertex model identifiers use the existing Claude policy.
  return new RegExp(
    `^(?:[a-z]{2,6}(?:-[a-z]{2,4})?\\.)?(?:anthropic\\.)?claude-(?:\\d+(?:-\\d+)?-)?(${sorted.join("|")})(?:[-@:.]|$)`,
    "u",
  );
}

function buildGeminiFamilyRegex(prefixedKeys, bareKeys) {
  if (prefixedKeys.length === 0 && bareKeys.length === 0) return null;
  const sortedPrefixed = [...prefixedKeys].sort((left, right) => right.length - left.length).map(escapeRegExp);
  const sortedBare = [...bareKeys].sort((left, right) => right.length - left.length).map(escapeRegExp);
  const branches = [];
  if (sortedPrefixed.length > 0) {
    branches.push(
      `^(?:[a-z]{2,6}(?:-[a-z]{2,4})?\\.)?(?:google[./-])?(?:models\\/)?(?:gemini-(?:\\d+(?:\\.\\d+)?-)?)`
      + `(${sortedPrefixed.join("|")})(?:[-@:.]|$)`,
    );
  }
  if (sortedBare.length > 0) {
    branches.push(`^(${sortedBare.join("|")})$`);
  }
  return new RegExp(branches.join("|"), "u");
}

export function resolveCatalogModel(catalog, rawModel, { allowProfileKeys = false } = {}) {
  if (typeof rawModel !== "string" || rawModel.length === 0 || !catalog) return null;
  const models = catalog.models ?? {};
  const aliases = catalog.aliases ?? {};
  let matchedToken = null;
  if (allowProfileKeys && ["exact-only", "claude-family-or-exact", "gemini-family-or-exact"].includes(catalog.matching)
    && (Object.hasOwn(models, rawModel) || Object.hasOwn(aliases, rawModel))) {
    matchedToken = rawModel;
  } else if (catalog.matching === "exact-only") {
    if (Object.hasOwn(models, rawModel) || Object.hasOwn(aliases, rawModel)) {
      matchedToken = rawModel;
    }
  } else if (catalog.matching === "claude-family-or-exact") {
    const allKeys = [...new Set([...Object.keys(models), ...Object.keys(aliases)])];
    const familyRegex = buildClaudeFamilyRegex(allKeys);
    // Preserve strict fail-closed Claude runtime observation boundary: only claude-... family IDs are accepted.
    matchedToken = familyRegex?.exec(rawModel)?.[1] ?? null;
  } else if (catalog.matching === "gemini-family-or-exact") {
    const allKeys = [...new Set([...Object.keys(models), ...Object.keys(aliases)])];
    const bareKeys = allKeys.filter((key) => key !== "flash-8b");
    const familyRegex = buildGeminiFamilyRegex(allKeys, bareKeys);
    const match = familyRegex?.exec(rawModel);
    matchedToken = match?.[1] ?? match?.[2] ?? null;
    if (!matchedToken && (Object.hasOwn(models, rawModel) || Object.hasOwn(aliases, rawModel)) && rawModel !== "flash-8b") {
      matchedToken = rawModel;
    }
  }

  if (!matchedToken) return null;
  const canonicalKey = Object.hasOwn(aliases, matchedToken) ? aliases[matchedToken] : matchedToken;
  if (!Object.hasOwn(models, canonicalKey)) return null;
  return canonicalKey;
}
