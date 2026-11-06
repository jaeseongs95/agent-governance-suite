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
const file = "tests/skill-classification/fixtures.intake-length-source-successor.json";
const bytes = readFileSync(path.join(root, file));
const manifest = JSON.parse(bytes.toString("utf8"));
const hash = (value: Buffer) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const previous = (file: string) => execFileSync("git", ["show", `${manifest.sourceBaseRevision}:${file}`], {cwd: root});
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
// The original D32 measurement excludes only the two marker lines and the final body LF.
function body(source: Buffer): Buffer {
  const text = source.toString("utf8");
  expect(text.startsWith("<!-- skill-intake:start -->\n")).toBe(true);
  expect(text.endsWith("\n<!-- skill-intake:end -->\n")).toBe(true);
  return Buffer.from(text.slice("<!-- skill-intake:start -->\n".length, -"\n<!-- skill-intake:end -->\n".length));
}

it("D32 IL01 retains the original over-budget intake and binds the selected shorter body under the unchanged limits", () => {
  const entry = "skills/orchestrator/references/intake.md";
  const was = body(previous(entry)), now = body(readFileSync(path.join(root, entry)));
  expect([was.toString("utf8").length, was.length]).toEqual([5224, 11784]);
  expect(was.toString("utf8").length).toBeGreaterThan(4344); expect(was.length).toBeGreaterThan(9783);
  expect([now.toString("utf8").length, now.length]).toEqual([4314, 9659]);
  expect(now.toString("utf8").length).toBeLessThanOrEqual(4344); expect(now.length).toBeLessThanOrEqual(9783);
  expect(hash(now)).toBe("sha256:b2dc49a7e2b07339a14c9e28acacf465a5824a106f9fe5c9b1362fdeab12e258");
});

it("D32 IL02-04 appends exact r34 bindings after frozen r33 and reselects only the thirteen intake clauses", async () => {
  expect(hash(bytes)).toBe("sha256:9a1bfca7884cbdc49c44f63b6a18f3e156e720145c216e7535b0292ca15c931a");
  expect(manifest).toMatchObject({revision: "intake-length-source-binding-r34", sourceBaseRevision: "be0a71858068fce5696a11c902ae628512ac4ca9",
    fixtureFileRewritten: false, labelChanges: [], priceAndBudgetChanges: [], modelBehavior: "NOT_RUN"});
  execFileSync("git", ["merge-base", "--is-ancestor", manifest.sourceBaseRevision, "HEAD"], {cwd: root});
  const frozen = readFileSync(path.join(root, manifest.frozenPredecessor.path));
  expect([frozen.length, hash(frozen)]).toEqual([3842, "sha256:b90d799c3eb93212596549c0ac5910c8c3dd6f69e0b3941b3d60bef33b275546"]);
  expect(manifest.frozenPredecessor).toEqual({path: "tests/skill-classification/fixtures.test-engineering-cli-source-successor.json", bytes: frozen.length, digest: hash(frozen)});
  expect(manifest.bindings.map((row: {path: string}) => row.path)).toEqual(["skills/orchestrator/classification.json", "skills/orchestrator/references/intake.md"]);
  const current = loadCurrentSourceBindings(root);
  expect(current).toMatchObject({manifest: {revision: manifest.revision}, digest: hash(bytes)});
  for (const binding of manifest.bindings) {
    expect(hash(previous(binding.path))).toBe(binding.previousDigest);
    const actual = readFileSync(path.join(root, binding.path));
    expect([actual.length, hash(actual)]).toEqual([binding.bytes, binding.digest]);
    expect(current.resolveDigest(binding.path, binding.previousDigest)).toBe(binding.digest);
    for (const unbound of [binding.digest, `sha256:${"0".repeat(64)}`]) expect(() => current.resolveDigest(binding.path, unbound)).toThrow("SOURCE_BINDING_PREDECESSOR_MISMATCH");
  }
  const descriptor = "skills/orchestrator/classification.json";
  const before = JSON.parse(previous(descriptor).toString("utf8")), after = JSON.parse(readFileSync(path.join(root, descriptor), "utf8"));
  const stable = (value: Record<string, unknown>) => Object.fromEntries(Object.entries(value).filter(([key]) => !["applicability", "exclusions"].includes(key)));
  expect(stable(after)).toEqual(stable(before));
  const anchors = new Map([
    ["applicability[2]", "첫 도구 호출(상태 확인·읽기 포함) 전에"], ["applicability[3]", "작업·검증·산출물까지 수행한다."],
    ["applicability[4]", "`checkpoint_context`로 원문과 바뀐 남은 일을 저장한다."], ["applicability[5]", "맡은 범위의 결함·진단 공백은 보고로 끝내지 말고 그 턴에 수정·검증을 시작한다."],
    ["applicability[6]", "다른 범위는 겹치지 않는 writeTargets로 workflow를 따로 시작하며"], ["applicability[7]", "전문 스킬 하나로 끝나면 그것만 호출한다."],
    ["applicability[8]", "조언은 AGENT가 원문과 스킬 적용·제외 조건에 대조해 채택·교정·기각하고 최종 선택한다."],
    ["exclusions[2]", "키워드·파일 종류·`complex`만으로 고르지 않는다."], ["exclusions[3]", "승인·검증·독립성 gate 생략 권한으로 보지 않는다."],
    ["exclusions[4]", "읽기 전용 요청에는 실제 변경을 하지 않는다."], ["exclusions[5]", "선택·이름 언급·호출 시작 응답·문서 읽기는 실행이 아니다."],
    ["exclusions[6]", "실패 영향 분류나 생략 이유를 출력하지 않는다."], ["exclusions[7]", "미가용·미검증을 성공으로 보지 않는다."],
  ]);
  const inventory = await loadSkillInventory({root}); expect(inventory.issues).toEqual([]);
  const skill = inventory.skills.find(row => row.skillId === "orchestrator")!;
  const changed: string[] = []; let compared = 0, unchanged = 0;
  for (const group of ["applicability", "exclusions"] as const) {
    expect(after[group]).toHaveLength(before[group].length);
    for (const [index, span] of (after[group] as Span[]).entries()) {
      const prior = selected(previous(before[group][index].path), before[group][index]);
      const actual = selected(readFileSync(path.join(root, span.path)), span);
      const id = `${group}[${index}]`, row = manifest.spanPreservation.spans.find((row: {group: string; index: number}) => row.group === group && row.index === index);
      if (span.path === "skills/orchestrator/references/intake.md") {
        expect(anchors.has(id)).toBe(true); expect(actual.toString("utf8")).toContain(anchors.get(id));
        expect(row.previous).toEqual({...before[group][index], selectedBytes: prior.length, selectedDigest: hash(prior)});
        expect(row.current).toEqual({...span, selectedBytes: actual.length, selectedDigest: hash(actual)});
        expect([row.bytes, row.digest]).toEqual([actual.length, hash(actual)]);
        expect(actual.equals(prior)).toBe(false); changed.push(`orchestrator:${id}`);
      } else {
        expect(row).toBeUndefined(); expect(span).toEqual(before[group][index]); expect(actual.equals(prior)).toBe(true); unchanged++;
      }
      expect(skill[group]).toContain(actual.toString("utf8").trim()); compared++;
    }
  }
  expect([compared, unchanged, changed.length]).toEqual([18, 5, 13]);
  expect(manifest.spanPreservation.comparedSpans).toBe(compared); expect(manifest.spanPreservation.spans).toHaveLength(13);
  expect(changed).toEqual([...anchors.keys()].map(id => `orchestrator:${id}`));
  expect(manifest.spanPreservation.changedSpans).toEqual(changed);
});

it("D32 IL05 rejects modified r34 bytes while retaining the frozen predecessor chain", () => {
  const copy = mkdtempSync(path.join(tmpdir(), "ags34-intake-binding-"));
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
