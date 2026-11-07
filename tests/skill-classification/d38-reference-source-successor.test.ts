// D38 r37 cases and CS consistency obligations, written before implementation:
// DR01: frozen r36 bytes/hash and its producer/body/budget expectations remain unchanged.
// DR02: five exact current bindings (four approved references + one descriptor) extend r36 with matching predecessors.
// DR03: all 13 audit spans keep identity/order/line boundaries; eight reference spans rebind, only three excerpts change.
// DR04: full-source digest and UTF-8 byte boundaries match actual selected evidence and the current inventory.
// DR05: one-byte r37 manifest drift and invalid predecessor/terminal digests are rejected without trusted-history fallback.
// DR06: exact context guidance maps current bytes to pinned history; one-byte or unlisted context never maps.
// Identity is (path, full-source digest); the chain must preserve every predecessor edge and selected-span ID.
// TEST: pnpm exec vitest run tests/skill-classification/d38-reference-source-successor.test.ts
// Product/model/host execution NOT_RUN locally; root owns official generation and TEST.
import {execFileSync} from "node:child_process";
import {createHash} from "node:crypto";
import {copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {expect, it} from "vitest";
import {loadSkillInventory} from "../../mcp-server/src/skill-classification/inventory.js";
import {loadCurrentSourceBindings} from "./evaluation.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const file = "tests/skill-classification/fixtures.d38-reference-source-successor.json";
const bytes = readFileSync(path.join(root, file)), manifest = JSON.parse(bytes.toString("utf8"));
const hash = (value: Buffer) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const previous = (file: string) => execFileSync("git", ["show", `${manifest.sourceBaseRevision}:${file}`], {cwd: root});
// The 3.9.0 successor rebinds some r37 sources; r37 is then checked at that successor's base, as each earlier test does.
const v390Bytes = readFileSync(path.join(root, "tests/skill-classification/fixtures.v390-intake-source-successor.json"));
const v390 = JSON.parse(v390Bytes.toString("utf8"));
const laterBinding = (file: string) => v390.bindings.find((row: {path: string}) => row.path === file);
function boundSource(file: string): Buffer {
  const later = laterBinding(file);
  if (!later) return readFileSync(path.join(root, file));
  const bytes = execFileSync("git", ["show", `${v390.sourceBaseRevision}:${file}`], {cwd: root});
  expect(hash(bytes)).toBe(later.previousDigest);
  return bytes;
}
type Span = {path: string; startLine: number; endLine: number; startByte?: number; endByte?: number; digest: string};
function selected(source: Buffer, span: Span): Buffer {
  expect(hash(source)).toBe(span.digest);
  const lines = Buffer.from(source.toString("utf8").split(/\r?\n/u).slice(span.startLine - 1, span.endLine).join("\n"));
  const start = span.startByte ?? 0, end = span.endByte ?? lines.length;
  expect(start).toBeGreaterThanOrEqual(0); expect(end).toBeGreaterThan(start); expect(end).toBeLessThanOrEqual(lines.length);
  const value = lines.subarray(start, end);
  expect(() => new TextDecoder("utf-8", {fatal: true}).decode(value)).not.toThrow();
  return value;
}

it("D38 DR01-04 appends five exact r37 bindings and preserves all audit span identities and r36 producer evidence", async () => {
  expect(hash(bytes)).toBe("sha256:6cbc88426ec49553e19642a10dfa64e490a440fb1fa42b0881bd724abbe64eae");
  expect(manifest).toMatchObject({revision: "d38-reference-source-binding-r37", sourceBaseRevision: "1aed980a829d2328fffe96695d635c0fc058b29a",
    fixtureFileRewritten: false, labelChanges: [], priceAndBudgetChanges: [], modelBehavior: "NOT_RUN"});
  execFileSync("git", ["merge-base", "--is-ancestor", manifest.sourceBaseRevision, "HEAD"], {cwd: root});
  const frozen = readFileSync(path.join(root, manifest.frozenPredecessor.path));
  expect([frozen.length, hash(frozen)]).toEqual([18052, "sha256:6cd7763926ed3305048210a9e8acd40952571bc43bac38375d85b314faa0ef72"]);
  expect(manifest.frozenPredecessor).toEqual({path: "tests/skill-classification/fixtures.intake-delivery-source-successor.json", bytes: frozen.length, digest: hash(frozen)});
  const r36 = JSON.parse(frozen.toString("utf8"));
  const intake = r36.bindings.find((row: {path: string}) => row.path === "skills/orchestrator/references/intake.md");
  const producer = boundSource(intake.path);
  expect([producer.length, hash(producer)]).toEqual([intake.bytes, intake.digest]);
  const descriptor = "skills/independent-audit-gate/classification.json", entry = "skills/independent-audit-gate/references/entry-details.md";
  expect(manifest.bindings.map((row: {path: string}) => row.path)).toEqual([descriptor,
    "skills/task-contract/references/entry-details.md", entry,
    "skills/independent-audit-gate/references/audit-protocol.md", "skills/independent-audit-gate/references/orchestrator-integration.md"]);
  const current = loadCurrentSourceBindings(root);
  expect(current).toMatchObject({manifest: {revision: v390.revision}, digest: hash(v390Bytes)});
  for (const binding of manifest.bindings) {
    expect(hash(previous(binding.path))).toBe(binding.previousDigest);
    const actual = boundSource(binding.path);
    expect([actual.length, hash(actual)]).toEqual([binding.bytes, binding.digest]);
    const later = laterBinding(binding.path);
    expect(later ? later.previousDigest : binding.digest).toBe(binding.digest);
    expect(current.resolveDigest(binding.path, binding.previousDigest)).toBe(later ? later.digest : binding.digest);
    if (later) expect(current.resolveDigest(binding.path, binding.digest)).toBe(later.digest);
    else expect(() => current.resolveDigest(binding.path, binding.digest)).toThrow("SOURCE_BINDING_PREDECESSOR_MISMATCH");
    expect(() => current.resolveDigest(binding.path, `sha256:${"0".repeat(64)}`)).toThrow("SOURCE_BINDING_PREDECESSOR_MISMATCH");
  }
  const before = JSON.parse(previous(descriptor).toString("utf8")), after = JSON.parse(boundSource(descriptor).toString("utf8"));
  const stable = (value: Record<string, unknown>) => Object.fromEntries(Object.entries(value).filter(([key]) => !["applicability", "exclusions"].includes(key)));
  expect(stable(after)).toEqual(stable(before));
  const inventory = await loadSkillInventory({root}); expect(inventory.issues).toEqual([]);
  const skill = inventory.skills.find(row => row.skillId === "independent-audit-gate")!;
  const changed: string[] = []; let compared = 0, rebound = 0, unchanged = 0;
  for (const group of ["applicability", "exclusions"] as const) {
    expect(after[group]).toHaveLength(before[group].length);
    for (const [index, span] of (after[group] as Span[]).entries()) {
      const old = before[group][index];
      const prior = selected(previous(old.path), old), source = boundSource(span.path), actual = selected(source, span);
      expect([span.path, span.startLine, span.endLine, span.startByte]).toEqual([old.path, old.startLine, old.endLine, old.startByte]);
      const row = manifest.spanPreservation.spans.find((row: {group: string; index: number}) => row.group === group && row.index === index);
      if (span.path === entry) {
        expect(span.startLine).toBe(span.endLine); expect(span.startByte).toBe(0);
        expect(span.endByte).toBe(Buffer.byteLength(source.toString("utf8").split(/\r?\n/u)[span.startLine - 1]!));
        expect(row.previous).toEqual({...old, selectedBytes: prior.length, selectedDigest: hash(prior)});
        expect(row.current).toEqual({...span, selectedBytes: actual.length, selectedDigest: hash(actual)});
        expect([row.bytes, row.digest]).toEqual([actual.length, hash(actual)]); rebound++;
      } else {expect(row).toBeUndefined(); expect(span).toEqual(old); unchanged++;}
      if (!actual.equals(prior)) changed.push(`independent-audit-gate:${group}[${index}]`);
      // A source the 3.9.0 successor rebinds is checked against the current inventory in that successor's test.
      if (!laterBinding(span.path)) expect(skill[group]).toContain(actual.toString("utf8").trim());
      compared++;
    }
  }
  expect([compared, rebound, unchanged]).toEqual([13, 8, 5]);
  expect(changed).toEqual(["independent-audit-gate:applicability[4]", "independent-audit-gate:exclusions[4]", "independent-audit-gate:exclusions[7]"]);
  expect(manifest.spanPreservation.changedSpans).toEqual(changed); expect(manifest.spanPreservation.comparedSpans).toBe(compared);
  expect(manifest.spanPreservation.spans).toHaveLength(rebound);
});

it("D38 DR05 rejects a changed r37 manifest and retains every frozen predecessor", () => {
  const copy = mkdtempSync(path.join(tmpdir(), "ags37-d38-reference-"));
  if (path.dirname(path.resolve(copy)) !== path.resolve(tmpdir()) || !path.basename(copy).startsWith("ags37-d38-reference-")) throw new Error("TEMP_SCOPE_MISMATCH");
  try {
    const current = loadCurrentSourceBindings(root);
    for (const source of current.files) {
      const relative = path.relative(root, source); if (path.isAbsolute(relative) || relative.startsWith("..")) throw new Error("MANIFEST_SCOPE_MISMATCH");
      const target = path.join(copy, relative); mkdirSync(path.dirname(target), {recursive: true}); copyFileSync(source, target);
    }
    expect(loadCurrentSourceBindings(copy).digest).toBe(current.digest);
    writeFileSync(path.join(copy, file), Buffer.concat([bytes, Buffer.from("\n")]));
    expect(() => loadCurrentSourceBindings(copy)).toThrow("CURRENT_SOURCE_BINDING_MANIFEST_MISMATCH");
  } finally {rmSync(copy, {recursive: true, force: true});}
});
