// 5.1.1 independent-audit-gate source successor (r42): the skill states that an audit is an exclusive adversarial review
// (user request 2026-11-13 「독립감사 스킬에 베타적 적대적 검수라는 말을 꼭 넣어줘.」, spelling chosen 「배타적 적대적 검수」).
// R1: the r42 manifest is the pinned chain end, follows frozen r41 byte for byte, cites the user decision at an ancestor
//     commit, and changes no fixture, label or budget.
// R2: each binding moves the exact v5.1.0 bytes (read at the base revision) to the exact current bytes.
// R3: the live inventory reads the new paragraph inside the applicability span, the exclusion text is unchanged, and the
//     frozen corpus is untouched.
// R4: a one-byte change to the r42 manifest is rejected.
// TEST: pnpm exec vitest run tests/skill-classification/v511-independent-audit-source-successor.test.ts
import {execFileSync} from "node:child_process";
import {createHash} from "node:crypto";
import {copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {expect, it} from "vitest";
import {loadSkillInventory} from "../../mcp-server/src/skill-classification/inventory.js";
import {CURRENT_SOURCE_MANIFEST, loadCurrentSourceBindings, oracleDigest, V410_CODE_REVIEW_MANIFEST_DIGEST} from "./evaluation.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const file = "tests/skill-classification/fixtures.v511-independent-audit-source-successor.json";
const bytes = readFileSync(path.join(root, file)), manifest = JSON.parse(bytes.toString("utf8"));
const hash = (value: Buffer) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const git = (...args: string[]) => execFileSync("git", args, {cwd: root, maxBuffer: 4 * 1024 * 1024});
const paragraph = "감사는 배타적 적대적 검수로 한다. 감사자는 작성자의 보고와 판단에 기대지 않고, 대상이 맞다는 생각을 버린 채 결함을 찾는다.";
type Binding = {path: string; previousDigest: string; digest: string; bytes: number};

it("R1 follows frozen r41 and ends the chain", () => {
  expect(hash(bytes)).toBe(CURRENT_SOURCE_MANIFEST.digest);
  expect(CURRENT_SOURCE_MANIFEST.revision).toBe(manifest.revision);
  expect(bytes.includes(Buffer.from("\r\n"))).toBe(false);
  expect(manifest).toMatchObject({schemaVersion: "1.0.0", revision: "v511-independent-audit-source-binding-r42",
    role: "source-binding-only-not-evaluation-or-install-authority", sourceBaseRevision: "c43874c9de7c69163f606ef4c59fcd0822eedeff",
    fixtureFileRewritten: false, labelChanges: [], priceAndBudgetChanges: [], modelBehavior: "NOT_RUN"});
  const frozen = readFileSync(path.join(root, manifest.frozenPredecessor.path));
  expect(manifest.frozenPredecessor).toEqual({path: "tests/skill-classification/fixtures.v410-code-review-source-successor.json", bytes: frozen.length, digest: hash(frozen)});
  expect(hash(frozen)).toBe(V410_CODE_REVIEW_MANIFEST_DIGEST);
  git("merge-base", "--is-ancestor", manifest.sourceBaseRevision, "HEAD");
  expect(manifest.sourceChangeRefs).toHaveLength(1);
  expect(manifest.sourceChangeRefs[0]).toMatchObject({defectIds: [],
    userDecision: {date: "2026-11-13", quote: "독립감사 스킬에 베타적 적대적 검수라는 말을 꼭 넣어줘.", choice: "배타적 적대적 검수"}});
  git("merge-base", "--is-ancestor", manifest.sourceChangeRefs[0].sourceRevision, "HEAD");
  const current = loadCurrentSourceBindings(root);
  expect(current).toMatchObject({manifest: {revision: manifest.revision}, digest: hash(bytes)});
  expect(current.files.map(source => path.relative(root, source).split(path.sep).join("/")).at(-1)).toBe(file);
});

it("R2 moves the exact v5.1.0 bytes to the exact current bytes", () => {
  const current = loadCurrentSourceBindings(root);
  expect((manifest.bindings as Binding[]).map(row => row.path)).toEqual(["skills/independent-audit-gate/classification.json", "skills/independent-audit-gate/SKILL.md"]);
  for (const binding of manifest.bindings as Binding[]) {
    expect(hash(git("show", `${manifest.sourceBaseRevision}:${binding.path}`))).toBe(binding.previousDigest);
    const actual = readFileSync(path.join(root, binding.path));
    expect([actual.length, hash(actual)]).toEqual([binding.bytes, binding.digest]);
    expect(actual.includes(Buffer.from("\r\n"))).toBe(false);
    expect(current.resolveDigest(binding.path, binding.previousDigest)).toBe(binding.digest);
    expect(() => current.resolveDigest(binding.path, binding.digest)).toThrow("SOURCE_BINDING_PREDECESSOR_MISMATCH");
  }
});

it("R3 reads the paragraph in the live inventory, keeps the exclusion text and leaves the frozen corpus alone", async () => {
  const before = git("show", `${manifest.sourceBaseRevision}:skills/independent-audit-gate/SKILL.md`).toString("utf8").split("\n");
  const after = readFileSync(path.join(root, "skills/independent-audit-gate/SKILL.md"), "utf8").split("\n");
  // Only the paragraph and the blank line before it are added after the opening paragraph (line 13).
  expect([...after.slice(0, 13), ...after.slice(15)]).toEqual(before);
  expect(after.slice(13, 15)).toEqual(["", paragraph]);
  const inventory = await loadSkillInventory({root});
  expect(inventory.issues).toEqual([]);
  const skill = inventory.skills.find(row => row.skillId === "independent-audit-gate")!;
  expect(skill.applicability.join("\n")).toContain(paragraph);
  expect(skill.exclusions.join("\n")).toContain(before[30]!.trim());
  const corpus = JSON.parse(readFileSync(path.join(root, "tests/skill-classification/fixtures.json"), "utf8"));
  expect(oracleDigest(corpus)).toBe(corpus.oracleDigest);
});

it("R4 rejects a changed r42 manifest", () => {
  const copy = mkdtempSync(path.join(tmpdir(), "ags511-independent-audit-source-"));
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
