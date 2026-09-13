import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { SqliteKoreanProseGlossary } from "../../mcp-server/src/korean-prose-glossary.ts";
import { finalizeRequest } from "../../skills/korean-prose-editor/scripts/finalizer-core.mjs";
import { extractProtectedSpans } from "../../skills/korean-prose-editor/scripts/protected-spans.mjs";
import { createSourceUnitManifest } from "../../skills/korean-prose-editor/scripts/source-units.mjs";
import { stableJson } from "../../skills/korean-prose-editor/scripts/lib.mjs";

const db = fileURLToPath(new URL("../../skills/korean-prose-editor/resources/korean-prose-glossary.sqlite3", import.meta.url));
const actorIds = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333"];
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function plan() {
  return { schemaVersion: "1.0.0", actorIds, providers: { selection: { kind: "agent", actorId: actorIds[0] }, editing: { kind: "agent", actorId: actorIds[1] }, verification: { kind: "agent", actorId: actorIds[2] }, finalization: { kind: "deterministic", entrypoint: "scripts/finalize.mjs" } } };
}

function binding(matchSet) {
  return { schemaVersion: "1.0.0", mode: "mcp", status: matchSet.status, sourceDigest: matchSet.sourceDigest, glossaryId: matchSet.glossary?.id ?? null, glossaryVersion: matchSet.glossary?.version ?? null, glossaryDigest: matchSet.glossary?.contentDigest ?? null, matchSetDigest: matchSet.matchSetDigest, matchCount: matchSet.matches.length, warnings: matchSet.warnings };
}

function requestFor(source, mode = "mcp", matchSetOverride) {
  const sourceDigest = sha256(source);
  const baseManifest = extractProtectedSpans(source);
  const lookup = mode === "mcp" ? new SqliteKoreanProseGlossary(db).lookup({ schemaVersion: "1.0.0", sourceText: source, sourceDigest }) : null;
  const matchSet = matchSetOverride === undefined ? lookup : matchSetOverride;
  const ranges = mode === "mcp" && matchSet?.status === "matched"
    ? [...baseManifest.spans.map(({ start, end }) => ({ start, end })), ...matchSet.matches.filter((item) => item.policy === "protect").map(({ start, end }) => ({ start, end }))]
    : baseManifest.spans.map(({ start, end }) => ({ start, end }));
  ranges.sort((left, right) => left.start - right.start || left.end - right.end);
  const merged = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && range.start < previous.end) previous.end = Math.max(previous.end, range.end);
    else merged.push({ ...range });
  }
  const manifest = { schemaVersion: "1.0.0", sourceDigest, sourceLength: source.length, spans: merged.map((range, index) => { const text = source.slice(range.start, range.end); return { id: `span-${String(index + 1).padStart(4, "0")}`, kind: "glossary", start: range.start, end: range.end, text, digest: sha256(text) }; }) };
  const units = createSourceUnitManifest(source, manifest);
  const glossaryBinding = mode === "mcp" ? binding(matchSet) : { schemaVersion: "1.0.0", mode: "none" };
  const selection = { schemaVersion: "1.0.0", actorId: actorIds[0], sourceDigest, glossaryBinding, status: "ready", decisions: units.units.map((unit) => ({ unitId: unit.unitId, action: "retain", reasonCodes: [], riskFlags: [], additionalProtectedStrings: [], issueRanges: [] })) };
  const editing = { schemaVersion: "1.0.0", actorId: actorIds[1], sourceDigest, glossaryBinding, selectionDigest: sha256(stableJson(selection)), edits: [], candidateDigest: sourceDigest };
  const verification = { schemaVersion: "1.0.0", actorId: actorIds[2], sourceDigest, glossaryBinding, editingDigest: sha256(stableJson(editing)), rubricDigest: "a".repeat(64), globalDecision: "continue", decisions: [], assessment: { meaningPreservation: "pass", majorMeaningChange: false, registerCompliance: "pass", protectedStrings: "pass", terminologyJudgment: "not-applicable", pairPreference: "original" } };
  return { schemaVersion: "1.0.0", mode, subagentsAvailable: true, plan: plan(), source, manifest, sourceUnitManifest: units, glossaryMatchSet: mode === "mcp" ? matchSet : null, selection, editing, verification, rubricDigest: "a".repeat(64) };
}

describe("Korean prose glossary finalizer binding", () => {
  it("accepts one identical MCP binding across all roles", () => {
    const result = finalizeRequest(requestFor("MCP는 SQLite를 사용한다."));
    expect(result.receipt.decisions).toMatchObject({ status: "finalized", fallback: false, assurance: "verified" });
    expect(result.receipt.glossary).toMatchObject({ mode: "mcp", status: "matched", matchCount: 2 });
  });

  it("uses no glossary artifact in direct mode", () => {
    const result = finalizeRequest(requestFor("사전을 사용하지 않는다.", "direct", null));
    expect(result.receipt.glossary).toEqual({ mode: "none", status: "direct", id: null, version: null, contentDigest: null, matchSetDigest: null, matchCount: 0, warnings: [] });
    expect(result.receipt.decisions).toMatchObject({ status: "finalized", fallback: false, assurance: "unverified" });
  });

  it("falls back for role binding differences and match-set tampering", () => {
    const different = requestFor("MCP를 사용한다.");
    different.verification.glossaryBinding = { ...different.verification.glossaryBinding, matchCount: 0 };
    expect(finalizeRequest(different).receipt.warnings).toContain("GLOSSARY_BINDING_MISMATCH");
    const tampered = requestFor("MCP를 사용한다.");
    tampered.glossaryMatchSet.matches[0].end -= 1;
    expect(finalizeRequest(tampered).receipt.warnings).toContain("GLOSSARY_MATCH_SET_INVALID");
  });

  it("falls back when a protect match is absent from the manifest", () => {
    const request = requestFor("MCP를 사용한다.");
    request.manifest.spans = [];
    request.sourceUnitManifest = createSourceUnitManifest(request.source, request.manifest);
    expect(finalizeRequest(request).receipt.warnings).toContain("GLOSSARY_PROTECT_MISSING");
  });

  it("continues without glossary matches when MCP lookup is unavailable", () => {
    const source = "문장을 다듬는다.";
    const unavailable = { schemaVersion: "1.0.0", status: "unavailable", sourceDigest: sha256(source), glossary: null, matches: [], matchSetDigest: null, warnings: ["GLOSSARY_UNAVAILABLE"] };
    const result = finalizeRequest(requestFor(source, "mcp", unavailable));
    expect(result.receipt.decisions.fallback).toBe(false);
    expect(result.receipt.warnings).toContain("GLOSSARY_UNAVAILABLE");
  });
});
