import { SCHEMA_VERSION, sha256, stableJson } from "./lib.mjs";

/**
 * @param {string} source
 * @param {string} candidate
 * @param {any} manifest
 */
export function checkResult(source, candidate, manifest) {
  const warnings = new Set();
  let cursor = 0;
  let valid = true;

  if (manifest?.schemaVersion !== SCHEMA_VERSION) {
    warnings.add("MANIFEST_SCHEMA_VERSION");
    valid = false;
  }
  if (manifest?.sourceDigest !== sha256(source) || manifest?.sourceLength !== source.length) {
    warnings.add("SOURCE_MANIFEST_MISMATCH");
    valid = false;
  }

  const spans = Array.isArray(manifest?.spans) ? manifest.spans : [];
  if (!Array.isArray(manifest?.spans)) {
    warnings.add("MANIFEST_SPANS_INVALID");
    valid = false;
  }

  for (const span of spans) {
    if (
      typeof span?.text !== "string" ||
      span.text.length === 0 ||
      span.digest !== sha256(span.text) ||
      source.slice(span.start, span.end) !== span.text
    ) {
      warnings.add("MANIFEST_SPAN_INVALID");
      valid = false;
      continue;
    }
    const foundAt = candidate.indexOf(span.text, cursor);
    if (foundAt === -1) {
      warnings.add("PROTECTED_SPAN_MISSING_OR_REORDERED");
      valid = false;
      continue;
    }
    cursor = foundAt + span.text.length;
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    digest: {
      source: sha256(source),
      candidate: sha256(candidate),
      manifest: sha256(stableJson(manifest)),
    },
    length: { source: source.length, candidate: candidate.length },
    decisions: { protectedSpansPreserved: valid },
    warnings: [...warnings].sort(),
  };
}
