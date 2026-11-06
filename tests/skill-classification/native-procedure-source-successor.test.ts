import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { loadSkillInventory } from "../../mcp-server/src/skill-classification/inventory.js";
import { loadCurrentSourceBindings } from "./evaluation.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const file = "tests/skill-classification/fixtures.native-procedure-source-successor.json";
const bytes = readFileSync(path.join(root, file));
const manifest = JSON.parse(bytes.toString("utf8"));
const cli = JSON.parse(readFileSync(path.join(root, "tests/skill-classification/fixtures.test-engineering-cli-source-successor.json"), "utf8"));
const intakeLength = JSON.parse(readFileSync(path.join(root, "tests/skill-classification/fixtures.intake-length-source-successor.json"), "utf8"));
const writtenCases = JSON.parse(readFileSync(path.join(root, "tests/skill-classification/fixtures.intake-written-cases-source-successor.json"), "utf8"));
const hash = (value: Buffer) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const previous = (file: string) => execFileSync("git", ["show", `${manifest.sourceBaseRevision}:${file}`], { cwd: root });
/** r32 assertions read r32 bytes at the first later binding ancestor, never current successor bytes. */
function nativeProcedureSource(file: string): Buffer {
  const later = [cli, intakeLength, writtenCases].find(manifest => manifest.bindings.some((row: {path: string}) => row.path === file));
  if (!later) return readFileSync(path.join(root, file));
  const binding = later.bindings.find((row: {path: string}) => row.path === file);
  const source = execFileSync("git", ["show", `${later.sourceBaseRevision}:${file}`], {cwd: root});
  expect(hash(source)).toBe(binding.previousDigest);
  return source;
}
type Span = {path: string; startLine: number; endLine: number; startByte?: number; endByte?: number; digest: string};
function selected(source: Buffer, span: Span): Buffer {
  expect(hash(source)).toBe(span.digest);
  const lines = Buffer.from(source.toString("utf8").split(/\r?\n/u).slice(span.startLine - 1, span.endLine).join("\n"));
  return lines.subarray(span.startByte ?? 0, span.endByte ?? lines.length);
}

it("NP04 appends exactly four current sources without rewriting frozen r31 or changing unrelated selected clauses", async () => {
  expect(hash(bytes)).toBe("sha256:4009ff57230ff7587bb4e4053b36f26328b7119708fe40dec301a0d6544e1d08");
  expect(manifest).toMatchObject({ revision: "native-procedure-source-binding-r32",
    sourceBaseRevision: "7652c71037c07c4744b9d8f37f0a327d454d8c53", fixtureFileRewritten: false,
    labelChanges: [], priceAndBudgetChanges: [], modelBehavior: "NOT_RUN" });
  const parent = readFileSync(path.join(root, manifest.frozenPredecessor.path));
  expect([parent.length, hash(parent)]).toEqual([2107, "sha256:0dd7fdf3baa5b12a9cd6d533145acfe8b2b9770453188a327c8b6f2aa5918499"]);
  expect(manifest.frozenPredecessor).toEqual({ path: "tests/skill-classification/fixtures.ags38-contract-docs-source-successor.json", bytes: parent.length, digest: hash(parent) });
  expect(manifest.bindings.map((binding: {path: string}) => binding.path)).toEqual([
    "skills/orchestrator/classification.json", "skills/orchestrator/references/intake.md",
    "skills/test-engineering/classification.json", "skills/test-engineering/SKILL.md",
  ]);
  const current = loadCurrentSourceBindings(root);
  expect(current.manifest).toMatchObject({ revision: writtenCases.revision });
  for (const binding of manifest.bindings) {
    expect(hash(previous(binding.path))).toBe(binding.previousDigest);
    const actual = nativeProcedureSource(binding.path);
    expect([actual.length, hash(actual)]).toEqual([binding.bytes, binding.digest]);
    const later = [...writtenCases.bindings, ...intakeLength.bindings, ...cli.bindings].find((row: {path: string}) => row.path === binding.path);
    const latest = later?.digest ?? binding.digest;
    expect(current.resolveDigest(binding.path, binding.previousDigest)).toBe(latest);
    if (later) expect(current.resolveDigest(binding.path, binding.digest)).toBe(latest);
    for (const unbound of [latest, `sha256:${"0".repeat(64)}`]) {
      expect(() => current.resolveDigest(binding.path, unbound)).toThrow("SOURCE_BINDING_PREDECESSOR_MISMATCH");
    }
  }
  const inventory = await loadSkillInventory({ root });
  expect(inventory.issues).toEqual([]);
  const changed: string[] = [];
  let compared = 0;
  for (const skillId of ["orchestrator", "test-engineering"]) {
    const descriptor = `skills/${skillId}/classification.json`;
    const before = JSON.parse(previous(descriptor).toString("utf8"));
    const after = JSON.parse(nativeProcedureSource(descriptor).toString("utf8"));
    for (const group of ["applicability", "exclusions"] as const) {
      expect(after[group]).toHaveLength(before[group].length);
      for (const [index, span] of (after[group] as Span[]).entries()) {
        const old = before[group][index] as Span;
        const prior = selected(previous(old.path), old);
        const actual = selected(nativeProcedureSource(span.path), span);
        const rebound = [...writtenCases.spanPreservation.spans, ...intakeLength.spanPreservation.spans].find((row: {skillId: string; group: string; index: number}) => row.skillId === skillId && row.group === group && row.index === index);
        const live = rebound ? selected(readFileSync(path.join(root, rebound.current.path)), rebound.current) : actual;
        expect(inventory.skills.find(skill => skill.skillId === skillId)![group]).toContain(live.toString("utf8").trim());
        if (!prior.equals(actual)) changed.push(`${skillId}:${group}[${index}]`);
        compared++;
      }
    }
  }
  expect(compared).toBe(24);
  expect(manifest.spanPreservation.comparedSpans).toBe(compared);
  expect(changed).toEqual(["orchestrator:applicability[4]"]);
  expect(manifest.spanPreservation.changedSpans).toEqual(changed);
});

it("NP04 rejects different current manifest bytes while retaining the original error and frozen files", () => {
  const copy = mkdtempSync(path.join(tmpdir(), "ags32-native-source-"));
  if (path.dirname(path.resolve(copy)) !== path.resolve(tmpdir()) || !path.basename(copy).startsWith("ags32-native-source-")) throw new Error("TEMP_SCOPE_MISMATCH");
  try {
    const current = loadCurrentSourceBindings(root);
    for (const source of current.files) {
      const relative = path.relative(root, source);
      if (path.isAbsolute(relative) || relative.startsWith("..")) throw new Error("MANIFEST_SCOPE_MISMATCH");
      const target = path.join(copy, relative);
      mkdirSync(path.dirname(target), { recursive: true });
      copyFileSync(source, target);
    }
    expect(loadCurrentSourceBindings(copy).digest).toBe(current.digest);
    writeFileSync(path.join(copy, file), Buffer.concat([bytes, Buffer.from("\n")]));
    expect(() => loadCurrentSourceBindings(copy)).toThrow("CURRENT_SOURCE_BINDING_MANIFEST_MISMATCH");
  } finally { rmSync(copy, { recursive: true, force: true }); }
});
