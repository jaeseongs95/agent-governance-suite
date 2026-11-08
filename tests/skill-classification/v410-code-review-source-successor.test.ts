// 4.1.0 code-review source successor (r41): AGS3-D-0094 widens code-review to defect searches in existing code.
// R1: the r41 manifest is the pinned chain end, follows frozen r40 byte for byte, cites the user decision and the defect
//     at an ancestor commit, and changes no fixture, label or budget.
// R2: each binding moves the exact r40 bytes (read at the base revision) to the exact current bytes.
// R3: the live inventory holds the widened scope and the frozen corpus is untouched.
// R4: a one-byte change to the r41 manifest is rejected.
// TEST: pnpm exec vitest run tests/skill-classification/v410-code-review-source-successor.test.ts (Linux test server).
import {execFileSync} from "node:child_process";
import {createHash} from "node:crypto";
import {copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {expect, it} from "vitest";
import {loadSkillInventory} from "../../mcp-server/src/skill-classification/inventory.js";
import {CURRENT_SOURCE_MANIFEST, loadCurrentSourceBindings, oracleDigest, V400_MINIMAL_IMPLEMENTATION_MANIFEST_DIGEST} from "./evaluation.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const file = "tests/skill-classification/fixtures.v410-code-review-source-successor.json";
const bytes = readFileSync(path.join(root, file)), manifest = JSON.parse(bytes.toString("utf8"));
const hash = (value: Buffer) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const git = (...args: string[]) => execFileSync("git", args, {cwd: root, maxBuffer: 4 * 1024 * 1024});
type Binding = {path: string; previousDigest: string; digest: string; bytes: number};

it("R1 follows frozen r40 and ends the chain", () => {
  expect(hash(bytes)).toBe(CURRENT_SOURCE_MANIFEST.digest);
  expect(CURRENT_SOURCE_MANIFEST.revision).toBe(manifest.revision);
  expect(bytes.includes(Buffer.from("\r\n"))).toBe(false);
  expect(manifest).toMatchObject({schemaVersion: "1.0.0", revision: "v410-code-review-source-binding-r41",
    role: "source-binding-only-not-evaluation-or-install-authority", fixtureFileRewritten: false, labelChanges: [], priceAndBudgetChanges: [], modelBehavior: "NOT_RUN"});
  const frozen = readFileSync(path.join(root, manifest.frozenPredecessor.path));
  expect(manifest.frozenPredecessor).toEqual({path: "tests/skill-classification/fixtures.v400-minimal-implementation-source-successor.json", bytes: frozen.length, digest: hash(frozen)});
  expect(hash(frozen)).toBe(V400_MINIMAL_IMPLEMENTATION_MANIFEST_DIGEST);
  git("merge-base", "--is-ancestor", manifest.sourceBaseRevision, "HEAD");
  expect(manifest.sourceChangeRefs.flatMap((ref: {defectIds: string[]}) => ref.defectIds)).toEqual(["AGS3-D-0094"]);
  for (const ref of manifest.sourceChangeRefs) git("merge-base", "--is-ancestor", ref.sourceRevision, "HEAD");
  const current = loadCurrentSourceBindings(root);
  expect(current).toMatchObject({manifest: {revision: manifest.revision}, digest: hash(bytes)});
  expect(current.files.map(source => path.relative(root, source).split(path.sep).join("/")).at(-1)).toBe(file);
});

it("R2 moves the exact r40 bytes to the exact current bytes", () => {
  const current = loadCurrentSourceBindings(root);
  const r40 = JSON.parse(readFileSync(path.join(root, manifest.frozenPredecessor.path), "utf8")).bindings as Binding[];
  expect((manifest.bindings as Binding[]).map(row => row.path)).toEqual(["skills/code-review/classification.json", "skills/code-review/SKILL.md"]);
  for (const binding of manifest.bindings as Binding[]) {
    expect(binding.previousDigest).toBe(r40.find(row => row.path === binding.path)!.digest);
    expect(hash(git("show", `${manifest.sourceBaseRevision}:${binding.path}`))).toBe(binding.previousDigest);
    const actual = readFileSync(path.join(root, binding.path));
    expect([actual.length, hash(actual)]).toEqual([binding.bytes, binding.digest]);
    expect(actual.includes(Buffer.from("\r\n"))).toBe(false);
    expect(current.resolveDigest(binding.path, binding.previousDigest)).toBe(binding.digest);
    expect(() => current.resolveDigest(binding.path, binding.digest)).toThrow("SOURCE_BINDING_PREDECESSOR_MISMATCH");
  }
});

it("R3 widens the scope in the live inventory and leaves the frozen corpus alone", async () => {
  const inventory = await loadSkillInventory({root});
  expect(inventory.issues).toEqual([]);
  const skill = inventory.skills.find(row => row.skillId === "code-review")!;
  expect(skill.applicability.join("\n")).toContain("existing code at a fixed revision");
  const corpus = JSON.parse(readFileSync(path.join(root, "tests/skill-classification/fixtures.json"), "utf8"));
  expect(oracleDigest(corpus)).toBe(corpus.oracleDigest);
});

it("R4 rejects a changed r41 manifest", () => {
  const copy = mkdtempSync(path.join(tmpdir(), "ags41-code-review-source-"));
  try {
    const current = loadCurrentSourceBindings(root);
    for (const source of current.files) {
      const relative = path.relative(root, source);
      if (path.isAbsolute(relative) || relative.startsWith("..")) throw new Error("MANIFEST_SCOPE_MISMATCH");
      const target = path.join(copy, relative);
      mkdirSync(path.dirname(target), {recursive: true});
      copyFileSync(source, target);
    }
    expect(loadCurrentSourceBindings(copy).digest).toBe(current.digest);
    writeFileSync(path.join(copy, file), Buffer.concat([bytes, Buffer.from("\n")]));
    expect(() => loadCurrentSourceBindings(copy)).toThrow("CURRENT_SOURCE_BINDING_MANIFEST_MISMATCH");
  } finally { rmSync(copy, {recursive: true, force: true}); }
});
