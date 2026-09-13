import { SCHEMA_VERSION, sha256 } from "./lib.mjs";

const FENCE_LINE = /^( {0,3})(`{3,}|~{3,})[^\r\n]*(?:\r?\n|$)/gmu;

/**
 * Split a source into ordered, non-overlapping prose paragraphs and fenced-code units.
 * Blank-line separators and leading/trailing whitespace stay outside prose units.
 * Offsets are UTF-16 code-unit offsets and ranges are half-open.
 *
 * @param {string} source
 * @param {{sourceDigest: string, sourceLength: number, spans: Array<{id: string, start: number, end: number}>}} manifest
 */
export function createSourceUnitManifest(source, manifest) {
  if (typeof source !== "string") throw new TypeError("source must be a string");
  if (manifest?.sourceDigest !== sha256(source) || manifest?.sourceLength !== source.length || !Array.isArray(manifest?.spans)) {
    throw new TypeError("manifest must match source");
  }

  const ranges = fencedRanges(source);
  /** @type {Array<{start: number, end: number, kind: "prose" | "fenced-code"}>} */
  const partitions = [];
  let cursor = 0;
  for (const range of ranges) {
    partitions.push(...proseRanges(source, cursor, range.start));
    partitions.push({ ...range, kind: "fenced-code" });
    cursor = range.end;
  }
  partitions.push(...proseRanges(source, cursor, source.length));

  return {
    schemaVersion: SCHEMA_VERSION,
    sourceDigest: sha256(source),
    sourceLength: source.length,
    units: partitions.map((unit, index) => ({
      unitId: `unit-${String(index + 1).padStart(4, "0")}`,
      start: unit.start,
      end: unit.end,
      kind: unit.kind,
      digest: sha256(source.slice(unit.start, unit.end)),
      protectedSpanIds: manifest.spans
        .filter((span) => unit.start < span.end && span.start < unit.end)
        .map((span) => span.id),
    })),
  };
}

/** @param {string} source @param {number} start @param {number} end */
function proseRanges(source, start, end) {
  const segment = source.slice(start, end);
  const separators = /\r?\n[ \t]*\r?\n(?:[ \t]*\r?\n)*/gu;
  const boundaries = [];
  let cursor = 0;
  for (const match of segment.matchAll(separators)) {
    boundaries.push([cursor, match.index]);
    cursor = match.index + match[0].length;
  }
  boundaries.push([cursor, segment.length]);
  return boundaries.flatMap(([relativeStart, relativeEnd]) => {
    const text = segment.slice(relativeStart, relativeEnd);
    const leading = text.match(/^\s*/u)?.[0].length ?? 0;
    const trailing = text.match(/\s*$/u)?.[0].length ?? 0;
    const unitStart = start + relativeStart + leading;
    const unitEnd = start + relativeEnd - trailing;
    return unitStart < unitEnd ? [{ start: unitStart, end: unitEnd, kind: /** @type {const} */ ("prose") }] : [];
  });
}

/** @param {string} source */
function fencedRanges(source) {
  /** @type {Array<{start: number, end: number}>} */
  const ranges = [];
  FENCE_LINE.lastIndex = 0;
  for (let opening = FENCE_LINE.exec(source); opening !== null; opening = FENCE_LINE.exec(source)) {
    const marker = opening[2];
    const markerCharacter = marker[0];
    const closing = new RegExp(`^ {0,3}${escapeRegex(markerCharacter)}{${marker.length},}[ \\t]*(?:\\r?\\n|$)`, "gmu");
    closing.lastIndex = FENCE_LINE.lastIndex;
    const match = closing.exec(source);
    const end = match ? closing.lastIndex : source.length;
    ranges.push({ start: opening.index, end });
    FENCE_LINE.lastIndex = end;
  }
  return ranges;
}

/** @param {string} value */
function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
