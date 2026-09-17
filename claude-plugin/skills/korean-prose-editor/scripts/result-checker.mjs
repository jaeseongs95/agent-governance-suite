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

  for (const text of new Set(spans.map((span) => span?.text).filter((text) => typeof text === "string" && text.length > 0))) {
    if (countOccurrences(source, text) !== countOccurrences(candidate, text)) {
      warnings.add("PROTECTED_SPAN_MISSING_OR_REORDERED");
      valid = false;
    }
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

/** @param {string} text @param {string} value */
function countOccurrences(text, value) {
  let count = 0;
  for (let index = text.indexOf(value); index !== -1; index = text.indexOf(value, index + value.length)) count += 1;
  return count;
}
