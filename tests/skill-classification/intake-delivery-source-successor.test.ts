// D36 delivery source-binding cases, written before the implementation:
// ID01: retain r35 manifest bytes and evaluate its one-verb/length assertions at the hash-bound r36 base.
// ID02: bind the final intake, entry-details and descriptor bytes after r35; retain fixture labels and budgets.
// ID03: compare all 18 descriptor spans; only applicability[5] changes its selected text and 13 intake spans rebind.
// ID04: current inventory must contain every latest selected span, with UTF-8 boundaries and original intake limits intact.
// ID05: changed r36 manifest bytes must fail CURRENT_SOURCE_BINDING_MANIFEST_MISMATCH; frozen predecessors stay unchanged.
// TEST: pnpm exec vitest run tests/skill-classification/*source-successor.test.ts tests/skill-classification/source-binding-successor.test.ts
// Local product execution and red/green are NOT_RUN; root performs Actions/TEST on the integrated source commits.
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
const file = "tests/skill-classification/fixtures.intake-delivery-source-successor.json";
const bytes = readFileSync(path.join(root, file));
const manifest = JSON.parse(bytes.toString("utf8"));
// The 3.9.0 successor rebinds all three r36 sources; r36 is checked at its base and the live inventory in its own test.
const v390Bytes = readFileSync(path.join(root, "tests/skill-classification/fixtures.v390-intake-source-successor.json"));
const v390 = JSON.parse(v390Bytes.toString("utf8"));
const v390Later = (file: string) => v390.bindings.find((row: {path: string}) => row.path === file);
// The chain end since 3.9.0: 4.0.0 (r39) rebinds the orchestrator descriptor and intake again.
const v400 = JSON.parse(readFileSync(path.join(root, "tests/skill-classification/fixtures.v400-intake-source-successor.json"), "utf8"));
const chainEnd = (file: string) => v400.bindings.find((row: {path: string}) => row.path === file) ?? v390Later(file);
const hash = (value: Buffer) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const previous = (file: string) => execFileSync("git", ["show", `${manifest.sourceBaseRevision}:${file}`], {cwd: root});
/** r36 bytes: the v390 base for a source the 3.9.0 successor rebinds, otherwise the current file. */
function deliverySource(file: string): Buffer {
  const later = v390Later(file);
  if (!later) return readFileSync(path.join(root, file));
  const source = execFileSync("git", ["show", `${v390.sourceBaseRevision}:${file}`], {cwd: root});
  expect(hash(source)).toBe(later.previousDigest);
  return source;
}
const oldCase = "만들거나 바꾸기 전에 무엇을·어디서·어떤 결과면 성공인지 사례를 적는다.";
const currentCase = ["만들거나 바꾸기 전 요구별 대상·경로·환경·검증 방법·통과 조건을 사례로 적고",
  "사례 정의→실행→동일 사례 확인 순으로 한다."].join(" ");
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

it("D36 ID01-04 appends exact delivery sources after frozen r35 and rebinds only the intended intake clause", async () => {
  expect(hash(bytes)).toBe("sha256:6cd7763926ed3305048210a9e8acd40952571bc43bac38375d85b314faa0ef72");
  expect(manifest).toMatchObject({revision: "intake-delivery-source-binding-r36", sourceBaseRevision: "14a7278b396542db073e4a48314ab1cec182edf9",
    fixtureFileRewritten: false, labelChanges: [], priceAndBudgetChanges: [], modelBehavior: "NOT_RUN"});
  execFileSync("git", ["merge-base", "--is-ancestor", manifest.sourceBaseRevision, "HEAD"], {cwd: root});
  const frozen = readFileSync(path.join(root, manifest.frozenPredecessor.path));
  expect([frozen.length, hash(frozen)]).toEqual([17611, "sha256:a2b55802c29d3c4fab1b7973a814f69294c26a67a442ab622839e5e1d345b4ea"]);
  expect(manifest.frozenPredecessor).toEqual({path: "tests/skill-classification/fixtures.intake-written-cases-source-successor.json", bytes: frozen.length, digest: hash(frozen)});
  const descriptor = "skills/orchestrator/classification.json", intake = "skills/orchestrator/references/intake.md";
  expect(manifest.bindings.map((row: {path: string}) => row.path)).toEqual([descriptor, intake, "skills/orchestrator/references/entry-details.md"]);
  const current = loadCurrentSourceBindings(root);
  expect(current).toMatchObject({manifest: {revision: CURRENT_SOURCE_MANIFEST.revision}, digest: CURRENT_SOURCE_MANIFEST.digest});
  for (const binding of manifest.bindings) {
    expect(hash(previous(binding.path))).toBe(binding.previousDigest);
    const actual = deliverySource(binding.path);
    expect([actual.length, hash(actual)]).toEqual([binding.bytes, binding.digest]);
    const latest = chainEnd(binding.path)?.digest ?? binding.digest;
    expect(current.resolveDigest(binding.path, binding.previousDigest)).toBe(latest);
    if (latest !== binding.digest) expect(current.resolveDigest(binding.path, binding.digest)).toBe(latest);
    for (const unbound of [latest, `sha256:${"0".repeat(64)}`]) expect(() => current.resolveDigest(binding.path, unbound)).toThrow("SOURCE_BINDING_PREDECESSOR_MISMATCH");
  }
  const beforeIntake = previous(intake).toString("utf8"), afterIntake = deliverySource(intake).toString("utf8");
  expect(beforeIntake.split(oldCase)).toHaveLength(2);
  expect(afterIntake).toBe(beforeIntake.replace(oldCase, currentCase));
  const body = afterIntake.slice("<!-- skill-intake:start -->\n".length, -"\n<!-- skill-intake:end -->\n".length);
  expect([body.length, Buffer.byteLength(body)]).toEqual([4344, 9733]);
  expect(body.length).toBeLessThanOrEqual(4344); expect(Buffer.byteLength(body)).toBeLessThanOrEqual(9783);
  const before = JSON.parse(previous(descriptor).toString("utf8")), after = JSON.parse(deliverySource(descriptor).toString("utf8"));
  const stable = (value: Record<string, unknown>) => Object.fromEntries(Object.entries(value).filter(([key]) => !["applicability", "exclusions"].includes(key)));
  expect(stable(after)).toEqual(stable(before));
  const inventory = await loadSkillInventory({root}); expect(inventory.issues).toEqual([]);
  const skill = inventory.skills.find(row => row.skillId === "orchestrator")!;
  const changed: string[] = []; let compared = 0, rebound = 0, unchanged = 0;
  for (const group of ["applicability", "exclusions"] as const) {
    expect(after[group]).toHaveLength(before[group].length);
    for (const [index, span] of (after[group] as Span[]).entries()) {
      const prior = selected(previous(before[group][index].path), before[group][index]);
      const actual = selected(deliverySource(span.path), span);
      const row = manifest.spanPreservation.spans.find((row: {group: string; index: number}) => row.group === group && row.index === index);
      if (span.path === intake) {
        expect(row.previous).toEqual({...before[group][index], selectedBytes: prior.length, selectedDigest: hash(prior)});
        expect(row.current).toEqual({...span, selectedBytes: actual.length, selectedDigest: hash(actual)});
        expect([row.bytes, row.digest]).toEqual([actual.length, hash(actual)]); rebound++;
      } else {expect(row).toBeUndefined(); expect(span).toEqual(before[group][index]); unchanged++;}
      if (!actual.equals(prior)) {
        changed.push(`orchestrator:${group}[${index}]`);
        expect(actual.toString("utf8")).toBe(prior.toString("utf8").replace(oldCase, currentCase));
      }
      if (!v390Later(span.path)) expect(skill[group]).toContain(actual.toString("utf8").trim());
      compared++;
    }
  }
  expect([compared, rebound, unchanged]).toEqual([18, 13, 5]);
  expect(changed).toEqual(["orchestrator:applicability[5]"]);
  expect(manifest.spanPreservation.changedSpans).toEqual(changed); expect(manifest.spanPreservation.comparedSpans).toBe(compared);
  expect(manifest.spanPreservation.spans).toHaveLength(rebound);
});

it("D36 ID05 rejects changed r36 manifest bytes while preserving the r35 predecessor", () => {
  const copy = mkdtempSync(path.join(tmpdir(), "ags36-intake-delivery-"));
  if (path.dirname(path.resolve(copy)) !== path.resolve(tmpdir()) || !path.basename(copy).startsWith("ags36-intake-delivery-")) throw new Error("TEMP_SCOPE_MISMATCH");
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
