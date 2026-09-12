import { SCHEMA_VERSION, sha256 } from "./lib.mjs";

/** @typedef {{kind: string, start: number, end: number, text: string, priority: number}} Candidate */

const PATTERNS = [
  { kind: "fenced-code", priority: 100, regex: /```[^\n]*\n[\s\S]*?```|~~~[^\n]*\n[\s\S]*?~~~/gu },
  { kind: "inline-code", priority: 90, regex: /`[^`\n]+`/gu },
  { kind: "command", priority: 85, regex: /^[ \t]*(?:\$|PS [^>\n]+>)[ \t]+\S[^\n]*/gmu },
  { kind: "url", priority: 70, regex: /https?:\/\/(?:[A-Za-z0-9\-._~:/?#@!$&*+,;=]|%[A-Fa-f0-9]{2})+/gu },
  { kind: "email", priority: 70, regex: /[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}/gu },
  { kind: "path", priority: 65, regex: /(?<![\p{L}\p{N}_:/\\])(?:[A-Za-z]:[\\/]|\\\\|\.{1,2}[\\/]|~\/|\/)[^\s<>"'`()[\]{}，。！？]+/gu },
  { kind: "quotation", priority: 60, regex: /“[^”\n]+”|‘[^’\n]+’|「[^」\n]+」|『[^』\n]+』|《[^》\n]+》|〈[^〉\n]+〉|"[^"\n]+"|'[^'\n]+'/gu },
  { kind: "number-or-date", priority: 55, regex: /(?<![\p{L}\p{N}_])\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:[ \t]*(?:AM|PM))?(?![\d:])/gu },
  { kind: "number-or-date", priority: 55, regex: /(?<![\p{L}\p{N}_])(?:[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?[ \t]*(?:퍼센트포인트|퍼센트|개월|시간|분기|킬로미터|킬로그램|밀리리터|리터|세제곱미터|제곱미터|개|건|명|회|번|대|장|권|곳|개소|년|월|일|시|분|초|주|세|살|원|달러|배|점|쪽|층|도|평|톤|억|만|천|%|℃|°C|kg|km|cm|mm|ms|mL|GB|MB|KB|m|g|L))+/gu },
  { kind: "number-or-date", priority: 50, regex: /(?:\d{4}[./-]\d{1,2}[./-]\d{1,2}(?!\d)|(?<![\p{L}\p{N}_])(?:\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?%?)(?![\p{L}\p{N}_]))/gu },
];

/** @param {string} source @param {string[]} [protectedStrings] */
export function extractProtectedSpans(source, protectedStrings = []) {
  if (typeof source !== "string") throw new TypeError("source must be a string");
  if (!Array.isArray(protectedStrings) || protectedStrings.some((value) => typeof value !== "string" || value.length === 0 || !source.includes(value))) {
    throw new TypeError("protectedStrings must contain nonempty strings present in source");
  }
  /** @type {Candidate[]} */
  const candidates = [];

  for (const pattern of PATTERNS) {
    for (const match of source.matchAll(pattern.regex)) {
      const start = match.index;
      const text = pattern.kind === "url" ? match[0].replace(/[.,;:!?]+$/u, "") : match[0];
      candidates.push({
        kind: pattern.kind,
        start,
        end: start + text.length,
        text,
        priority: pattern.priority,
      });
    }
  }

  for (const match of source.matchAll(/\[[^\]\n]*\]\(([^)\n]+)\)/gu)) {
    const target = match[1];
    const relativeStart = match[0].lastIndexOf(target);
    const start = match.index + relativeStart;
    candidates.push({ kind: "markdown-target", start, end: start + target.length, text: target, priority: 80 });
  }

  for (const value of new Set(protectedStrings)) {
    for (let start = source.indexOf(value); start !== -1; start = source.indexOf(value, start + 1)) {
      candidates.push({ kind: "user-defined", start, end: start + value.length, text: value, priority: 40 });
    }
  }

  candidates.sort((left, right) => right.priority - left.priority || left.start - right.start || right.end - left.end);
  /** @type {Candidate[]} */
  const selected = [];
  for (const candidate of candidates) {
    const overlapping = selected.filter((span) => candidate.start < span.end && span.start < candidate.end);
    if (overlapping.length === 0) {
      selected.push(candidate);
      continue;
    }
    // Preserve the union even when a user string crosses an automatic span boundary.
    const merged = { ...overlapping[0] };
    merged.start = Math.min(candidate.start, ...overlapping.map((span) => span.start));
    merged.end = Math.max(candidate.end, ...overlapping.map((span) => span.end));
    merged.text = source.slice(merged.start, merged.end);
    for (const span of overlapping) selected.splice(selected.indexOf(span), 1);
    selected.push(merged);
  }
  selected.sort((left, right) => left.start - right.start || left.end - right.end);

  return {
    schemaVersion: SCHEMA_VERSION,
    sourceDigest: sha256(source),
    sourceLength: source.length,
    spans: selected.map(({ kind, start, end, text }, index) => ({
      id: `span-${String(index + 1).padStart(4, "0")}`,
      kind,
      start,
      end,
      text,
      digest: sha256(text),
    })),
  };
}

/** @param {number} start @param {number} end @param {{start: number, end: number}[]} spans */
export function overlapsProtectedSpan(start, end, spans) {
  if (start === end) return spans.some((span) => span.start < start && start < span.end);
  return spans.some((span) => start < span.end && span.start < end);
}
