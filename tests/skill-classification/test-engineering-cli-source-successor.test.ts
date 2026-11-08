import {execFileSync} from "node:child_process";
import {createHash} from "node:crypto";
import {copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {expect, it} from "vitest";
import {loadSkillInventory} from "../../mcp-server/src/skill-classification/inventory.js";
import {loadCurrentSourceBindings, CURRENT_SOURCE_MANIFEST} from "./evaluation.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const file = "tests/skill-classification/fixtures.test-engineering-cli-source-successor.json";
const bytes = readFileSync(path.join(root, file));
const manifest = JSON.parse(bytes.toString("utf8"));
const hash = (value: Buffer) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const previous = (file: string) => execFileSync("git", ["show", `${manifest.sourceBaseRevision}:${file}`], {cwd: root});
// 4.0.0 r40 rebinds both sources (the hand-off name becomes minimal-implementation, AGS3-D-0083); r33 is read at its base.
const v400Minimal = JSON.parse(readFileSync(path.join(root, "tests/skill-classification/fixtures.v400-minimal-implementation-source-successor.json"), "utf8"));
const laterBinding = (file: string) => v400Minimal.bindings.find((row: {path: string}) => row.path === file);
/** r33 bytes: the r40 base for a source r40 rebinds, otherwise the current file. */
function cliSource(file: string): Buffer {
  const later = laterBinding(file);
  if (!later) return readFileSync(path.join(root, file));
  const source = execFileSync("git", ["show", `${v400Minimal.sourceBaseRevision}:${file}`], {cwd: root});
  expect(hash(source)).toBe(later.previousDigest);
  return source;
}
type Span = {path: string; startLine: number; endLine: number; startByte?: number; endByte?: number; digest: string};
function selected(source: Buffer, span: Span) {
  expect(hash(source)).toBe(span.digest);
  const lines = Buffer.from(source.toString("utf8").split(/\r?\n/u).slice(span.startLine - 1, span.endLine).join("\n"));
  return lines.subarray(span.startByte ?? 0, span.endByte ?? lines.length);
}

it("D36 appends two exact CLI-comment source bindings after frozen r32 and preserves all six selected clauses", async () => {
  expect(manifest).toMatchObject({revision: "test-engineering-cli-source-binding-r33", sourceBaseRevision: "d2ffc9af54cd1cb3f7a85061a3e7788287863654",
    fixtureFileRewritten: false, labelChanges: [], priceAndBudgetChanges: [], modelBehavior: "NOT_RUN"});
  execFileSync("git", ["merge-base", "--is-ancestor", manifest.sourceBaseRevision, "HEAD"], {cwd: root});
  const frozen = readFileSync(path.join(root, manifest.frozenPredecessor.path));
  expect([frozen.length, hash(frozen)]).toEqual([3373, "sha256:4009ff57230ff7587bb4e4053b36f26328b7119708fe40dec301a0d6544e1d08"]);
  expect(manifest.frozenPredecessor).toEqual({path: "tests/skill-classification/fixtures.native-procedure-source-successor.json", bytes: frozen.length, digest: hash(frozen)});
  expect(manifest.bindings.map((binding: {path: string}) => binding.path)).toEqual(["skills/test-engineering/classification.json", "skills/test-engineering/SKILL.md"]);
  const current = loadCurrentSourceBindings(root);
  expect(current).toMatchObject({manifest: {revision: CURRENT_SOURCE_MANIFEST.revision}, digest: CURRENT_SOURCE_MANIFEST.digest});
  for (const binding of manifest.bindings) {
    expect(hash(previous(binding.path))).toBe(binding.previousDigest);
    const actual = cliSource(binding.path);
    expect([actual.length, hash(actual)]).toEqual([binding.bytes, binding.digest]);
    const later = laterBinding(binding.path);
    if (later) expect(later.previousDigest).toBe(binding.digest);
    const latest = later?.digest ?? binding.digest;
    expect(current.resolveDigest(binding.path, binding.previousDigest)).toBe(latest);
    if (later) expect(current.resolveDigest(binding.path, binding.digest)).toBe(latest);
    for (const unbound of [latest, `sha256:${"0".repeat(64)}`]) expect(() => current.resolveDigest(binding.path, unbound)).toThrow("SOURCE_BINDING_PREDECESSOR_MISMATCH");
  }
  const descriptor = "skills/test-engineering/classification.json";
  const before = JSON.parse(previous(descriptor).toString("utf8"));
  const after = JSON.parse(cliSource(descriptor).toString("utf8"));
  const sourceDigest = manifest.bindings.find((binding: {path: string}) => binding.path === "skills/test-engineering/SKILL.md").digest;
  expect(after).toEqual({...before, applicability: before.applicability.map((span: Span) => ({...span, digest: sourceDigest})),
    exclusions: before.exclusions.map((span: Span) => ({...span, digest: sourceDigest}))});
  const inventory = await loadSkillInventory({root}); expect(inventory.issues).toEqual([]);
  let compared = 0;
  for (const group of ["applicability", "exclusions"] as const) for (const [index, span] of (after[group] as Span[]).entries()) {
    const prior = selected(previous(span.path), before[group][index]);
    const actual = selected(cliSource(span.path), span);
    expect(actual.equals(prior)).toBe(true);
    expect(manifest.spanPreservation.spans[compared]).toEqual({skillId: "test-engineering", group, index, path: span.path,
      selectedBytes: actual.length, selectedDigest: hash(actual), previousSelectedDigest: hash(prior)});
    // r40 rebinds both sources (one-line description); their live selections are checked in the r40 test.
    if (!laterBinding(span.path)) expect(inventory.skills.find(skill => skill.skillId === "test-engineering")![group]).toContain(actual.toString("utf8").trim());
    compared++;
  }
  expect(compared).toBe(6); expect(manifest.spanPreservation.comparedSpans).toBe(compared); expect(manifest.spanPreservation.changedSpans).toEqual([]);
  const comments = ["# 요구·case·입력·기대값·판정 조건을 plan.json으로 저장한다.", "# 통과한 계획에 맞춰 첫 시험을 구현한다.",
    "# 동일한 시험 bytes·case·입력·기대값·argv·설정으로 before(RED), fixed(GREEN)를 실행한다.", "# 실제 실행된 사례 집합과 assertion 결과를 대조해 proof.json에 기록한다."];
  const source = "skills/test-engineering/SKILL.md";
  expect(cliSource(source).toString("utf8").split("\n").filter(line => !comments.includes(line)).join("\n")).toBe(previous(source).toString("utf8"));
});

it("D36 rejects changed r33 manifest bytes while retaining all frozen predecessor fixtures", () => {
  const copy = mkdtempSync(path.join(tmpdir(), "ags33-cli-binding-"));
  try {
    const current = loadCurrentSourceBindings(root);
    for (const source of current.files) {
      const relative = path.relative(root, source); if (path.isAbsolute(relative) || relative.startsWith("..")) throw new Error("MANIFEST_SCOPE_MISMATCH");
      const target = path.join(copy, relative); mkdirSync(path.dirname(target), {recursive: true}); copyFileSync(source, target);
    }
    expect(loadCurrentSourceBindings(copy).digest).toBe(current.digest);
    writeFileSync(path.join(copy, file), Buffer.concat([bytes, Buffer.from("\n")]));
    expect(() => loadCurrentSourceBindings(copy)).toThrow("CURRENT_SOURCE_BINDING_MANIFEST_MISMATCH");
  } finally { rmSync(copy, {recursive: true, force: true}); }
});
