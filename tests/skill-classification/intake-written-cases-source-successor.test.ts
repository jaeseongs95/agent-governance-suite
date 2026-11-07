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
const file = "tests/skill-classification/fixtures.intake-written-cases-source-successor.json";
const bytes = readFileSync(path.join(root, file));
const manifest = JSON.parse(bytes.toString("utf8"));
const hash = (value: Buffer) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const previous = (file: string) => execFileSync("git", ["show", `${manifest.sourceBaseRevision}:${file}`], {cwd: root});
const deliveryBytes = readFileSync(path.join(root, "tests/skill-classification/fixtures.intake-delivery-source-successor.json"));
const delivery = JSON.parse(deliveryBytes.toString("utf8"));
const d38ReferencesBytes = readFileSync(path.join(root, "tests/skill-classification/fixtures.d38-reference-source-successor.json"));
const d38References = JSON.parse(d38ReferencesBytes.toString("utf8"));
/** Preserve the r35 one-verb oracle at the hash-bound predecessor of r36. */
function writtenCasesSource(file: string): Buffer {
  const binding = delivery.bindings.find((row: {path: string}) => row.path === file);
  if (!binding) return readFileSync(path.join(root, file));
  const source = execFileSync("git", ["show", `${delivery.sourceBaseRevision}:${file}`], {cwd: root});
  expect(hash(source)).toBe(binding.previousDigest);
  return source;
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

it("D36 WR01 changes only the case-recording verb and preserves the exact intake length and budgets", () => {
  const entry = "skills/orchestrator/references/intake.md";
  const before = previous(entry).toString("utf8"), after = writtenCasesSource(entry).toString("utf8");
  expect(before.split("사례를 정한다.")).toHaveLength(2);
  expect(after).toBe(before.replace("사례를 정한다.", "사례를 적는다."));
  expect([after.length, Buffer.byteLength(after)]).toEqual([before.length, Buffer.byteLength(before)]);
  const body = after.slice("<!-- skill-intake:start -->\n".length, -"\n<!-- skill-intake:end -->\n".length);
  expect([body.length, Buffer.byteLength(body)]).toEqual([4315, 9662]);
  expect(body.length).toBeLessThanOrEqual(4344); expect(Buffer.byteLength(body)).toBeLessThanOrEqual(9783);
  expect(hash(Buffer.from(body))).toBe("sha256:8c84dab94af20df4f34a0950a25843c1df2a56baf4e00fab7bcbd8ab30563185");
});

it("D36 WR02-04 appends r35 after frozen r34 and changes only the selected case-recording clause", async () => {
  expect(hash(bytes)).toBe("sha256:a2b55802c29d3c4fab1b7973a814f69294c26a67a442ab622839e5e1d345b4ea");
  expect(manifest).toMatchObject({revision: "intake-written-cases-source-binding-r35", sourceBaseRevision: "e96805c348f5a509a2185898ae517c21e45d3f49",
    fixtureFileRewritten: false, labelChanges: [], priceAndBudgetChanges: [], modelBehavior: "NOT_RUN"});
  execFileSync("git", ["merge-base", "--is-ancestor", manifest.sourceBaseRevision, "HEAD"], {cwd: root});
  const frozen = readFileSync(path.join(root, manifest.frozenPredecessor.path));
  expect([frozen.length, hash(frozen)]).toEqual([17991, "sha256:a101883563f23baf5b05ea336e7289670ea37b94850a807bad7bb58f2732d063"]);
  expect(manifest.frozenPredecessor).toEqual({path: "tests/skill-classification/fixtures.intake-length-source-successor.json", bytes: frozen.length, digest: hash(frozen)});
  expect(manifest.bindings.map((row: {path: string}) => row.path)).toEqual(["skills/orchestrator/classification.json", "skills/orchestrator/references/intake.md"]);
  const current = loadCurrentSourceBindings(root);
  expect(current).toMatchObject({manifest: {revision: d38References.revision}, digest: hash(d38ReferencesBytes)});
  for (const binding of manifest.bindings) {
    expect(hash(previous(binding.path))).toBe(binding.previousDigest);
    const actual = writtenCasesSource(binding.path);
    expect([actual.length, hash(actual)]).toEqual([binding.bytes, binding.digest]);
    const latest = delivery.bindings.find((row: {path: string}) => row.path === binding.path).digest;
    expect(current.resolveDigest(binding.path, binding.previousDigest)).toBe(latest);
    expect(current.resolveDigest(binding.path, binding.digest)).toBe(latest);
    for (const unbound of [latest, `sha256:${"0".repeat(64)}`]) expect(() => current.resolveDigest(binding.path, unbound)).toThrow("SOURCE_BINDING_PREDECESSOR_MISMATCH");
  }
  const descriptor = "skills/orchestrator/classification.json", intake = "skills/orchestrator/references/intake.md";
  const before = JSON.parse(previous(descriptor).toString("utf8")), after = JSON.parse(writtenCasesSource(descriptor).toString("utf8"));
  const digest = manifest.bindings.find((row: {path: string}) => row.path === intake).digest;
  const rebind = (span: Span) => span.path === intake ? {...span, digest} : span;
  expect(after).toEqual({...before, applicability: before.applicability.map(rebind), exclusions: before.exclusions.map(rebind)});
  const inventory = await loadSkillInventory({root}); expect(inventory.issues).toEqual([]);
  const skill = inventory.skills.find(row => row.skillId === "orchestrator")!;
  const changed: string[] = []; let compared = 0, rebound = 0, unchanged = 0;
  for (const group of ["applicability", "exclusions"] as const) for (const [index, span] of (after[group] as Span[]).entries()) {
    const prior = selected(previous(before[group][index].path), before[group][index]);
    const actual = selected(writtenCasesSource(span.path), span);
    const row = manifest.spanPreservation.spans.find((row: {group: string; index: number}) => row.group === group && row.index === index);
    if (span.path === intake) {
      expect(row.previous).toEqual({...before[group][index], selectedBytes: prior.length, selectedDigest: hash(prior)});
      expect(row.current).toEqual({...span, selectedBytes: actual.length, selectedDigest: hash(actual)});
      expect([row.bytes, row.digest]).toEqual([actual.length, hash(actual)]); rebound++;
    } else {
      expect(row).toBeUndefined(); expect(span).toEqual(before[group][index]); unchanged++;
    }
    if (!actual.equals(prior)) {
      changed.push(`orchestrator:${group}[${index}]`);
      expect(actual.toString("utf8")).toBe(prior.toString("utf8").replace("사례를 정한다.", "사례를 적는다."));
      expect(actual.toString("utf8")).toContain("무엇을·어디서·어떤 결과면 성공인지 사례를 적는다.");
    }
    const reboundSpan = delivery.spanPreservation.spans.find((row: {group: string; index: number}) => row.group === group && row.index === index);
    const live = reboundSpan ? selected(readFileSync(path.join(root, reboundSpan.current.path)), reboundSpan.current) : actual;
    expect(skill[group]).toContain(live.toString("utf8").trim()); compared++;
  }
  expect([compared, rebound, unchanged]).toEqual([18, 13, 5]);
  expect(changed).toEqual(["orchestrator:applicability[5]"]);
  expect(manifest.spanPreservation.changedSpans).toEqual(changed); expect(manifest.spanPreservation.comparedSpans).toBe(compared);
  expect(manifest.spanPreservation.spans).toHaveLength(rebound);
});

it("D36 WR03 rejects changed r35 bytes without modifying any frozen predecessor", () => {
  const copy = mkdtempSync(path.join(tmpdir(), "ags35-written-cases-"));
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
