import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Ajv2020 } from "../../runtime/schema-validation.mjs";
import { extractProtectedSpans } from "../../skills/korean-prose-editor/scripts/protected-spans.mjs";
import { checkResult } from "../../skills/korean-prose-editor/scripts/result-checker.mjs";
import { finalizeRequest } from "../../skills/korean-prose-editor/scripts/finalizer-core.mjs";
import { createSourceUnitManifest } from "../../skills/korean-prose-editor/scripts/source-units.mjs";
import { stableJson } from "../../skills/korean-prose-editor/scripts/lib.mjs";

const contracts = new URL("../../skills/korean-prose-editor/contracts/", import.meta.url);
const schemas = readdirSync(contracts).filter(name => name.endsWith(".schema.json"))
  .map(name => JSON.parse(readFileSync(new URL(name, contracts), "utf8")));
const ajv = new Ajv2020({ strict: false, allErrors: true });
for (const schema of schemas) ajv.addSchema(schema);
const validate = name => ajv.getSchema(`https://example.invalid/korean-prose-editor/${name}`);
const digest = value => createHash("sha256").update(value, "utf8").digest("hex");
const actorIds = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333"];

// Synthetic inputs: no provider, glossary database, model or external process.
function requestFor(source, manifest = extractProtectedSpans(source), mode = "direct", status = "no-match") {
  const sourceDigest = digest(source);
  const glossary = ["matched", "no-match"].includes(status) ? { id: "korean-prose-core", version: "1.2.1", contentDigest: "b".repeat(64) } : null;
  const matches = status === "matched" ? [{ start: 0, end: 2, entryId: "synthetic-term", policy: "allow", canonicalForm: "문장", priority: 0 }] : [];
  const warnings = { matched: [], "no-match": [], unavailable: ["GLOSSARY_UNAVAILABLE"], "limit-exceeded": ["GLOSSARY_MATCH_LIMIT_EXCEEDED"], "unsupported-normalization": ["GLOSSARY_UNSUPPORTED_NORMALIZATION"] }[status];
  const matchSetDigest = glossary ? digest(stableJson({ schemaVersion: "1.0.0", sourceDigest, glossary, matches })) : null;
  const glossaryMatchSet = mode === "direct" ? null : { schemaVersion: "1.0.0", status, sourceDigest, glossary, matches, matchSetDigest, warnings };
  const glossaryBinding = mode === "direct" ? { schemaVersion: "1.0.0", mode: "none" }
    : { schemaVersion: "1.0.0", mode: "mcp", status, sourceDigest, glossaryId: glossary?.id ?? null, glossaryVersion: glossary?.version ?? null, glossaryDigest: glossary?.contentDigest ?? null, matchSetDigest, matchCount: matches.length, warnings };
  const sourceUnitManifest = createSourceUnitManifest(source, manifest);
  const selection = { schemaVersion: "1.0.0", actorId: actorIds[0], sourceDigest, glossaryBinding, status: "ready", decisions: sourceUnitManifest.units.map(unit => ({ unitId: unit.unitId, action: "retain", reasonCodes: [], riskFlags: [], additionalProtectedStrings: [], issueRanges: [] })) };
  const editing = { schemaVersion: "1.0.0", actorId: actorIds[1], sourceDigest, glossaryBinding, selectionDigest: digest(stableJson(selection)), edits: [], candidateDigest: sourceDigest };
  const verification = { schemaVersion: "1.0.0", actorId: actorIds[2], sourceDigest, glossaryBinding, editingDigest: digest(stableJson(editing)), rubricDigest: "a".repeat(64), globalDecision: "continue", decisions: [], assessment: { meaningPreservation: "pass", majorMeaningChange: false, registerCompliance: "pass", protectedStrings: "pass", terminologyJudgment: "not-applicable", pairPreference: "original" } };
  const plan = { schemaVersion: "1.0.0", actorIds, providers: { selection: { kind: "agent", actorId: actorIds[0] }, editing: { kind: "agent", actorId: actorIds[1] }, verification: { kind: "agent", actorId: actorIds[2] }, finalization: { kind: "deterministic", entrypoint: "scripts/finalize.mjs" } } };
  return { schemaVersion: "1.0.0", mode, subagentsAvailable: true, plan, source, manifest, sourceUnitManifest, glossaryMatchSet, selection, editing, verification, rubricDigest: "a".repeat(64) };
}

function acceptEdit(request, start, end, replacement) {
  const unit = request.sourceUnitManifest.units.find(item => item.start <= start && end <= item.end);
  const decision = request.selection.decisions.find(item => item.unitId === unit.unitId);
  Object.assign(decision, { action: "edit", reasonCodes: ["REDUNDANCY"], issueRanges: [{ start, end, reasonCode: "REDUNDANCY" }] });
  request.editing.selectionDigest = digest(stableJson(request.selection));
  request.editing.edits = [{ id: "edit-one", unitId: unit.unitId, sourceDigest: digest(request.source), start, end, replacement, actorId: actorIds[1] }];
  request.editing.candidateDigest = digest(request.source.slice(0, start) + replacement + request.source.slice(end));
  request.verification.editingDigest = digest(stableJson(request.editing));
  request.verification.decisions = [{ editId: "edit-one", decision: "accept", reasonCode: "MEANING_PRESERVED", sourceDefect: "REDUNDANCY", invariantDelta: "NONE" }];
  request.verification.assessment.pairPreference = "candidate";
}

describe("CG06 Korean prose source repairs", () => {
  it.each([
    "./docs/tail",
    "https://example.invalid/a(b(c)d)e/tail",
    "./a(b(c)d)e/tail",
    String.raw`./a\(b\)/tail`,
    "<./a(b/tail>",
    " <docs/a(b/tail> ",
    "\t<docs/a(b/tail>\t",
    './a(b)c/tail "제목 (설명"',
  ])("protects the complete Markdown target %s, keeping the label editable", target => {
    const source = `[안내](${target})`;
    const manifest = extractProtectedSpans(source);
    expect(manifest.spans).toEqual([{ id: "span-0001", kind: "markdown-target", start: 5, end: 5 + target.length, text: target, digest: digest(target) }]);
    expect(checkResult(source, source.replace("안내", "설명"), manifest).decisions.protectedSpansPreserved).toBe(true);
    expect(checkResult(source, source.replace("tail", "changed"), manifest).decisions.protectedSpansPreserved).toBe(false);
  });

  it("retains an approved edit in the tail after nested parentheses", () => {
    const source = "[안내](./a(b)c/tail) 문장";
    const request = requestFor(source);
    const start = source.indexOf("tail");
    acceptEdit(request, start, start + 4, "뒤쪽");
    const result = finalizeRequest(request);
    expect(result.output).toBe(source);
    expect(result.receipt.decisions).toMatchObject({ status: "finalized", fallback: false, appliedEditDigests: [], retainedEditDigests: [digest("edit-one")] });
    expect(result.receipt.warnings).toContain("PROTECTED_EDIT_RETAINED");
  });

  it("accepts ordinary prose edits while preserving the complete nested target", () => {
    const source = "[안내](./a(b)c/tail) 불필요한 문장";
    const request = requestFor(source);
    const start = source.indexOf("불필요한 ");
    acceptEdit(request, start, start + "불필요한 ".length, "");
    const result = finalizeRequest(request);
    expect(result.output).toBe("[안내](./a(b)c/tail) 문장");
    expect(result.receipt.decisions).toMatchObject({ status: "finalized", fallback: false, appliedEditDigests: [digest("edit-one")] });
  });

  it("retains an approved target edit after a space-prefixed angle destination", () => {
    const source = "[안내]( <docs/a(b/tail> ) 문장";
    const request = requestFor(source);
    const start = source.indexOf("tail");
    acceptEdit(request, start, start + 4, "뒤쪽");
    const result = finalizeRequest(request);
    expect(result.output).toBe(source);
    expect(result.receipt.decisions).toMatchObject({ status: "finalized", fallback: false, appliedEditDigests: [], retainedEditDigests: [digest("edit-one")] });
    expect(result.receipt.warnings).toContain("PROTECTED_EDIT_RETAINED");
  });

  it("accepts a body edit beside a space-prefixed angle destination", () => {
    const source = "[안내]( <docs/a(b/tail> ) 불필요한 문장";
    const request = requestFor(source);
    const start = source.indexOf("불필요한 ");
    acceptEdit(request, start, start + "불필요한 ".length, "");
    const result = finalizeRequest(request);
    expect(result.output).toBe("[안내]( <docs/a(b/tail> ) 문장");
    expect(result.receipt.decisions).toMatchObject({ status: "finalized", fallback: false, appliedEditDigests: [digest("edit-one")] });
  });

  it("accepts the actual producer's 10,000th span through schema and finalizer", () => {
    const source = Array(10000).fill("1").join(" ");
    const manifest = extractProtectedSpans(source);
    expect(manifest.spans).toHaveLength(10000);
    expect(manifest.spans[9998].id).toBe("span-9999");
    expect(manifest.spans[9999].id).toBe("span-10000");
    expect(validate("protected-manifest.schema.json")(manifest)).toBe(true);
    const request = requestFor(source, manifest);
    expect(validate("finalization-request.schema.json")(request)).toBe(true);
    const result = finalizeRequest(request);
    expect(result.output).toBe(source);
    expect(result.receipt.decisions).toMatchObject({ status: "finalized", fallback: false });
    expect(result.receipt.warnings).not.toContain("SOURCE_MANIFEST_MISMATCH");
    const invalidId = structuredClone(request);
    invalidId.manifest.spans.at(-1).id = "span-1000x";
    expect(validate("protected-manifest.schema.json")(invalidId.manifest)).toBe(false);
    expect(finalizeRequest(invalidId).receipt.warnings).toContain("SOURCE_MANIFEST_MISMATCH");
    const duplicate = structuredClone(request);
    duplicate.manifest.spans.at(-1).id = "span-0001";
    expect(finalizeRequest(duplicate).receipt.warnings).toContain("SOURCE_MANIFEST_MISMATCH");
    const tampered = structuredClone(request);
    tampered.manifest.spans.at(-1).digest = "f".repeat(64);
    expect(finalizeRequest(tampered).receipt.warnings).toContain("SOURCE_MANIFEST_MISMATCH");
  }, 30000);

  it.each(["span-001", "span-10000x", "span--10000"])("still rejects malformed span ID %s", id => {
    const request = requestFor("1");
    request.manifest.spans[0].id = id;
    expect(validate("protected-manifest.schema.json")(request.manifest)).toBe(false);
    expect(finalizeRequest(request).receipt.warnings).toContain("SOURCE_MANIFEST_MISMATCH");
  });

  it.each([["direct", "no-match"], ["mcp", "matched"], ["mcp", "no-match"], ["mcp", "unavailable"], ["mcp", "limit-exceeded"], ["mcp", "unsupported-normalization"]])("accepts %s/%s finalizer receipts in both named schemas", (mode, status) => {
    const result = finalizeRequest(requestFor("문장을 보존한다.", undefined, mode, status));
    expect(result.receipt.decisions).toMatchObject({ status: "finalized", fallback: false, assurance: mode === "mcp" ? "verified" : "unverified" });
    for (const name of ["receipt.schema.json", "final-text-receipt.v1.schema.json"]) {
      const receiptValidator = validate(name);
      expect(receiptValidator(result.receipt)).toBe(true);
      const rawText = structuredClone(result.receipt);
      rawText.source = "PRIVATE_SYNTHETIC_SOURCE";
      expect(receiptValidator(rawText)).toBe(false);
      const glossaryText = structuredClone(result.receipt);
      glossaryText.glossary.surface = "PRIVATE_SYNTHETIC_TERM";
      expect(receiptValidator(glossaryText)).toBe(false);
      const missing = structuredClone(result.receipt);
      delete missing.glossary;
      expect(receiptValidator(missing)).toBe(false);
      const unknownWarning = structuredClone(result.receipt);
      unknownWarning.warnings.push("UNKNOWN_WARNING");
      expect(receiptValidator(unknownWarning)).toBe(false);
    }
  });

  it("accepts a genuine fallback receipt and keeps both receipt contracts aligned", () => {
    const request = requestFor("문장을 보존한다.", undefined, "mcp");
    request.verification.glossaryBinding = { schemaVersion: "1.0.0", mode: "none" };
    const result = finalizeRequest(request);
    expect(result.receipt.decisions).toMatchObject({ status: "fallback", fallback: true, assurance: "unverified" });
    expect(result.receipt.warnings).toContain("GLOSSARY_BINDING_MISMATCH");
    expect(validate("receipt.schema.json")(result.receipt)).toBe(true);
    expect(validate("final-text-receipt.v1.schema.json")(result.receipt)).toBe(true);
    const normalized = name => {
      const schema = structuredClone(schemas.find(item => item.$id.endsWith(`/${name}`)));
      delete schema.$id;
      delete schema.title;
      return schema;
    };
    expect(normalized("receipt.schema.json")).toEqual(normalized("final-text-receipt.v1.schema.json"));
  });
});
