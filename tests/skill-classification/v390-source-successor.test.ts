// 3.9.0 source successor (r38) cases, written before the binding test was run:
// V1: the r38 manifest is the pinned chain end, follows frozen r37 byte for byte and changes no fixture, label or budget.
// V2: every binding moves its exact predecessor bytes at the v390 base to the exact current bytes, and the chain
//     resolves the predecessor to the current digest while the current digest has no successor.
// V3: outside the reselected orchestrator descriptor, every rebound descriptor keeps its span identities and line
//     bounds; only the reviewed wording spans change their selected text.
// V4: every span of every rebound descriptor selects valid UTF-8 from the current bytes and the live inventory holds it
//     (earlier successor tests leave these live checks to this test). A source a 4.0.0 successor rebinds again is read
//     at that successor's base (its r38 bytes), and its live check moves to that successor's test.
// V5: a one-byte change to the r38 manifest is rejected.
// TEST: pnpm exec vitest run tests/skill-classification/v390-source-successor.test.ts (Linux test server).
import {execFileSync} from "node:child_process";
import {createHash} from "node:crypto";
import {copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {expect, it} from "vitest";
import {loadSkillInventory} from "../../mcp-server/src/skill-classification/inventory.js";
import {CURRENT_SOURCE_MANIFEST, loadCurrentSourceBindings, V390_INTAKE_MANIFEST_DIGEST} from "./evaluation.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const file = "tests/skill-classification/fixtures.v390-intake-source-successor.json";
const bytes = readFileSync(path.join(root, file)), manifest = JSON.parse(bytes.toString("utf8"));
const hash = (value: Buffer) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const atBase = (relative: string) => execFileSync("git", ["show", `${manifest.sourceBaseRevision}:${relative}`], {cwd: root, maxBuffer: 4 * 1024 * 1024});
type Binding = {path: string; previousDigest: string; digest: string; bytes: number};
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

it("V1-V2 binds every 3.9.0 source after frozen r37 and ends the chain at the current bytes", () => {
  expect(hash(bytes)).toBe(V390_INTAKE_MANIFEST_DIGEST);
  expect(manifest).toMatchObject({revision: "v390-intake-source-binding-r38", sourceBaseRevision: "a50fbc2c20c20f52dd59643bb929b5b4c88d6f3a",
    fixtureFileRewritten: false, labelChanges: [], priceAndBudgetChanges: [], modelBehavior: "NOT_RUN"});
  execFileSync("git", ["merge-base", "--is-ancestor", manifest.sourceBaseRevision, "HEAD"], {cwd: root});
  const frozen = readFileSync(path.join(root, manifest.frozenPredecessor.path));
  expect(manifest.frozenPredecessor).toEqual({path: "tests/skill-classification/fixtures.d38-reference-source-successor.json",
    bytes: frozen.length, digest: hash(frozen)});
  expect(hash(frozen)).toBe("sha256:6cbc88426ec49553e19642a10dfa64e490a440fb1fa42b0881bd724abbe64eae");
  for (const ref of manifest.sourceChangeRefs) execFileSync("git", ["merge-base", "--is-ancestor", ref.sourceRevision, "HEAD"], {cwd: root});
  const current = loadCurrentSourceBindings(root);
  // 4.0.0 (r39) follows r38 and rebinds the orchestrator descriptor and intake; r38 is frozen and no longer the chain end.
  expect(current).toMatchObject({manifest: {revision: CURRENT_SOURCE_MANIFEST.revision}, digest: CURRENT_SOURCE_MANIFEST.digest});
  const v400 = JSON.parse(readFileSync(path.join(root, "tests/skill-classification/fixtures.v400-intake-source-successor.json"), "utf8"));
  expect(v400.frozenPredecessor).toEqual({path: file, bytes: bytes.length, digest: hash(bytes)});
  // 4.0.0 r40 follows r39: it rebinds the orchestrator descriptor, intake and entry-details once more.
  const v400Minimal = JSON.parse(readFileSync(path.join(root, "tests/skill-classification/fixtures.v400-minimal-implementation-source-successor.json"), "utf8"));
  const paths = (manifest.bindings as Binding[]).map(row => row.path);
  expect(new Set(paths).size).toBe(paths.length);
  expect(paths).toHaveLength(21);
  for (const binding of manifest.bindings as Binding[]) {
    expect(hash(atBase(binding.path))).toBe(binding.previousDigest);
    const later = (v400.bindings as Binding[]).find(row => row.path === binding.path);
    if (later) expect(later.previousDigest).toBe(binding.digest);
    const afterLater = (v400Minimal.bindings as Binding[]).find(row => row.path === binding.path);
    if (afterLater) expect(afterLater.previousDigest).toBe((later ?? binding).digest);
    const latest = afterLater ?? later ?? binding;
    const actual = readFileSync(path.join(root, binding.path));
    expect([actual.length, hash(actual)]).toEqual([latest.bytes, latest.digest]);
    expect(current.resolveDigest(binding.path, binding.previousDigest)).toBe(latest.digest);
    for (const unbound of [latest.digest, `sha256:${"0".repeat(64)}`]) {
      expect(() => current.resolveDigest(binding.path, unbound)).toThrow("SOURCE_BINDING_PREDECESSOR_MISMATCH");
    }
  }
});

it("V3-V4 keeps rebound span identities and holds every current selection in the live inventory", async () => {
  const descriptors = (manifest.bindings as Binding[]).map(row => row.path).filter(relative => relative.endsWith("/classification.json"));
  expect(descriptors.map(relative => relative.split("/")[1])).toEqual(["acceptance-evidence-validator", "orchestrator",
    "blocker-diagnostician", "evaluation-validity-auditor", "independent-audit-gate", "iteration-frame-auditor",
    "mutation-risk-preflight", "recovery-strategy-selector", "session-board"]);
  // 4.0.0 successors (r39, r40) rebind these descriptors and sources again (r40: one-line English descriptions and the
  // compressed intake). A source they rebind holds its r38 bytes at the first such successor's base, and its live
  // selections are compared with the inventory in that successor's test.
  const later400 = [JSON.parse(readFileSync(path.join(root, "tests/skill-classification/fixtures.v400-intake-source-successor.json"), "utf8")),
    JSON.parse(readFileSync(path.join(root, "tests/skill-classification/fixtures.v400-minimal-implementation-source-successor.json"), "utf8"))];
  const reboundAfter = (relative: string) => later400.find(later => (later.bindings as Binding[]).some(row => row.path === relative));
  const r38Source = (relative: string): Buffer => {
    const later = reboundAfter(relative);
    if (!later) return readFileSync(path.join(root, relative));
    const source = execFileSync("git", ["show", `${later.sourceBaseRevision}:${relative}`], {cwd: root, maxBuffer: 4 * 1024 * 1024});
    expect(hash(source)).toBe((later.bindings as Binding[]).find(row => row.path === relative)!.previousDigest);
    return source;
  };
  const inventory = await loadSkillInventory({root}); expect(inventory.issues).toEqual([]);
  const changed: string[] = []; let compared = 0;
  for (const descriptor of descriptors) {
    const skillId = descriptor.split("/")[1]!;
    const before = JSON.parse(atBase(descriptor).toString("utf8")), after = JSON.parse(r38Source(descriptor).toString("utf8"));
    const skill = inventory.skills.find(row => row.skillId === skillId)!;
    for (const group of ["applicability", "exclusions"] as const) {
      // WP-F reselected the orchestrator spans over the shortened intake (AGS3-D-0032); only their live evidence is compared.
      if (skillId !== "orchestrator") expect(after[group]).toHaveLength(before[group].length);
      for (const [index, span] of (after[group] as Span[]).entries()) {
        const actual = selected(r38Source(span.path), span);
        if (!reboundAfter(descriptor) && !reboundAfter(span.path)) expect(skill[group]).toContain(actual.toString("utf8").trim());
        compared++;
        if (skillId === "orchestrator") continue;
        const old = before[group][index] as Span;
        expect([span.path, span.startLine, span.endLine]).toEqual([old.path, old.startLine, old.endLine]);
        if (!actual.equals(selected(atBase(old.path), old))) changed.push(`${skillId}:${group}[${index}]`);
      }
    }
  }
  expect(compared).toBeGreaterThan(0);
  expect(changed).toEqual(["acceptance-evidence-validator:exclusions[5]", "blocker-diagnostician:exclusions[6]",
    "evaluation-validity-auditor:applicability[2]", "independent-audit-gate:exclusions[6]",
    "iteration-frame-auditor:exclusions[3]", "iteration-frame-auditor:exclusions[4]", "session-board:applicability[3]"]);
});

it("V5 rejects a changed r38 manifest", () => {
  const copy = mkdtempSync(path.join(tmpdir(), "ags39-v390-source-"));
  if (path.dirname(path.resolve(copy)) !== path.resolve(tmpdir()) || !path.basename(copy).startsWith("ags39-v390-source-")) throw new Error("TEMP_SCOPE_MISMATCH");
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
