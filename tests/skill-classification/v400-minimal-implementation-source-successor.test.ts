// 4.0.0 minimal-implementation source successor (r40) cases, written before the binding test was run:
// MI1: the r40 manifest is the pinned chain end, follows frozen r39 byte for byte, cites the user decisions and
//      AGS3-D-0083/0084 at ancestor commits (the text optimization lands with this manifest: no revision yet), and
//      changes no fixture, label or budget.
// MI2: every binding moves the exact chain-end bytes before r40 (read at the r40 base) to the exact current bytes or
//      to absence; the bound paths are exactly the chain-bound evaluation sources whose bytes changed, apart from the
//      seven approved provider-retention purpose changes.
// MI3: each rebound SKILL.md changes only its description (now one English line) and, for the three specialists, the
//      hand-off name; the intake loses exactly the rules that moved into descriptions or the classification contract.
//      Every rebound descriptor keeps its non-span fields and span counts and points each span at the same rule:
//      description spans split the new line into its applicability and exclusion clauses, body spans move only by the
//      description's line delta with identical bytes (one hand-off name aside), intake spans select the reviewed
//      sentences, and the live inventory holds every current selection.
// MI4: ponytail retires (both sources absent, its seven spans gone from the live inventory) and minimal-implementation
//      succeeds it with a changed purpose: its pinned sources are the current bytes and the live inventory holds its
//      spans, while the frozen corpus still names ponytail at its original digest.
// MI5: a one-byte change to the r40 manifest is rejected.
// TEST: pnpm exec vitest run tests/skill-classification/v400-minimal-implementation-source-successor.test.ts (Linux test server).
import {execFileSync} from "node:child_process";
import {createHash} from "node:crypto";
import {copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {expect, it} from "vitest";
import {loadSkillInventory} from "../../mcp-server/src/skill-classification/inventory.js";
import {CURRENT_SOURCE_MANIFEST, loadCurrentSourceBindings, oracleDigest, V400_INTAKE_MANIFEST_DIGEST, V400_MINIMAL_IMPLEMENTATION_MANIFEST_DIGEST} from "./evaluation.js";
import {PROVIDER_RETENTION_SOURCE_CHANGES} from "./live-bootstrap/provider-retention-sources.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const file = "tests/skill-classification/fixtures.v400-minimal-implementation-source-successor.json";
const bytes = readFileSync(path.join(root, file)), manifest = JSON.parse(bytes.toString("utf8"));
const hash = (value: Buffer) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const atBase = (relative: string) => execFileSync("git", ["show", `${manifest.sourceBaseRevision}:${relative}`], {cwd: root, maxBuffer: 4 * 1024 * 1024});
const v410 = JSON.parse(readFileSync(path.join(root, "tests/skill-classification/fixtures.v410-code-review-source-successor.json"), "utf8"));
const rebound = (relative: string) => (v410.bindings as Binding[]).find(row => row.path === relative);
/** r41 moves code-review on (AGS3-D-0094); this file keeps judging r40 against the bytes r41 started from. */
// 5.0.0 rewords coordinate-subagents (AGS3-D-0095), a purpose change outside this chain; it too is judged at the bytes before.
const v500Reworded = (relative: string) => ["skills/coordinate-subagents/SKILL.md", "skills/coordinate-subagents/classification.json"].includes(relative);
const r40Base = (relative: string) => rebound(relative) ? v410.sourceBaseRevision as string : v500Reworded(relative) ? "e67caf843ae94b752def7d0cf4a1f8fb66c2b208" : null;
const r40Source = (relative: string) => {
  const base = r40Base(relative);
  return base ? execFileSync("git", ["show", `${base}:${relative}`], {cwd: root, maxBuffer: 4 * 1024 * 1024}) : readFileSync(path.join(root, relative));
};
const liveOrNull = (relative: string) => existsSync(path.join(root, relative)) ? r40Source(relative) : null;
type Binding = {path: string; previousDigest: string; digest: string | null; bytes: number};
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
// The text optimization rebinds every other bound description and its descriptor; the two purpose-change skills
// (coordinate-subagents, model-effort-advisor) are bound by provider retention instead.
const optimizedSkills = ["acceptance-evidence-validator", "blocker-diagnostician", "change-scope-guardian", "evaluation-validity-auditor",
  "independent-audit-gate", "independent-deliberation-panel", "instruction-scope-resolver", "iteration-frame-auditor", "korean-prose-editor",
  "mutation-risk-preflight", "prompt-engineering", "recovery-strategy-selector", "session-board", "software-security-auditor", "solid-design",
  "task-contract", "workspace-convention-profiler"];
const boundPaths = ["skills/orchestrator/classification.json", "skills/orchestrator/references/intake.md", "skills/orchestrator/references/entry-details.md",
  "skills/code-review/classification.json", "skills/code-review/SKILL.md", "skills/cs-engineering/classification.json", "skills/cs-engineering/SKILL.md",
  "skills/test-engineering/classification.json", "skills/test-engineering/SKILL.md", "skills/ponytail/SKILL.md", "skills/ponytail/classification.json",
  "skills/orchestrator/SKILL.md", ...optimizedSkills.flatMap(id => [`skills/${id}/SKILL.md`, `skills/${id}/classification.json`])];
const retiredPaths = ["skills/ponytail/SKILL.md", "skills/ponytail/classification.json"];
const d0083 = "모의·고정값·자리 채움·조용한 대체 경로·삼킨 오류가 낸 통과는 근거로 세지 않고, 남은 대체물은 위치와 함께 미검증으로 적는다.";

it("MI1-MI2 binds every changed 4.0.0 evaluation source after frozen r39 and ends the chain at the current bytes", () => {
  expect(hash(bytes)).toBe(V400_MINIMAL_IMPLEMENTATION_MANIFEST_DIGEST);
  expect(bytes.includes(Buffer.from("\r\n"))).toBe(false);
  expect(manifest).toMatchObject({schemaVersion: "1.0.0", revision: "v400-minimal-implementation-source-binding-r40",
    role: "source-binding-only-not-evaluation-or-install-authority", sourceBaseRevision: "24c241d28e130912a0606090727b2b964c811757",
    fixtureFileRewritten: false, labelChanges: [], priceAndBudgetChanges: [], modelBehavior: "NOT_RUN"});
  execFileSync("git", ["merge-base", "--is-ancestor", manifest.sourceBaseRevision, "HEAD"], {cwd: root});
  const frozen = readFileSync(path.join(root, manifest.frozenPredecessor.path));
  expect(manifest.frozenPredecessor).toEqual({path: "tests/skill-classification/fixtures.v400-intake-source-successor.json",
    bytes: frozen.length, digest: hash(frozen)});
  expect(hash(frozen)).toBe(V400_INTAKE_MANIFEST_DIGEST);
  // The text optimization is committed together with this manifest, so its row has no revision to cite yet.
  expect(manifest.sourceChangeRefs.map((ref: {sourceRevision: string | null}) => ref.sourceRevision)).toEqual([
    "22c512ddbe95cfcd07b8543c65a573139b52f18f", "86d3469a7ed2c74ca79c25c47bcd552558791cf5", null]);
  for (const ref of manifest.sourceChangeRefs) if (ref.sourceRevision !== null) execFileSync("git", ["merge-base", "--is-ancestor", ref.sourceRevision, "HEAD"], {cwd: root});
  expect([...new Set(manifest.sourceChangeRefs.flatMap((ref: {defectIds: string[]}) => ref.defectIds))].sort()).toEqual(["AGS3-D-0083", "AGS3-D-0084"]);
  expect(manifest.sourceChangeRefs[0].userDecision).toEqual({date: "2026-11-08", quote: "걍 ponytail 스킬을 빼고 AGS용으로 전면 재개편하자."});
  expect(manifest.sourceChangeRefs[1].observation).toContain(d0083);
  expect(manifest.sourceChangeRefs[2]).toMatchObject({defectIds: [],
    userDecision: {date: "2026-11-08", quote: "intake 뿐만이겠냐?", choice: "겹침 제거 + 턴·도구 큐까지"}});

  const current = loadCurrentSourceBindings(root);
  expect(current).toMatchObject({manifest: {revision: CURRENT_SOURCE_MANIFEST.revision}, digest: CURRENT_SOURCE_MANIFEST.digest});
  expect(current.files.map(source => path.relative(root, source).split(path.sep).join("/")).at(-2)).toBe(file);
  // The chain end before r40, folded from every earlier successor the loader reads. The frozen fixture and the frozen
  // sidecars (fixtures.source-successor.json; field-neutral-wording, the integrated successor's sidecar) are not in its chain.
  const unavailable = JSON.parse(readFileSync(current.files[0]!, "utf8"));
  const sidecars = current.files.flatMap(source => {
    const sidecar = (JSON.parse(readFileSync(source, "utf8")) as {frozenSidecar?: {path: string}}).frozenSidecar;
    return sidecar ? [sidecar.path] : [];
  });
  expect(sidecars).toEqual(["tests/skill-classification/fixtures.source-successor.json", "tests/skill-classification/fixtures.field-neutral-wording-source-successor.json"]);
  const notChain = new Set([unavailable.frozenFixture.path, ...sidecars, file, "tests/skill-classification/fixtures.v410-code-review-source-successor.json"].map(relative => path.resolve(root, relative)));
  const beforeR40 = new Map<string, string | null>();
  for (const source of current.files.filter(item => !notChain.has(path.resolve(item)))) {
    for (const row of JSON.parse(readFileSync(source, "utf8")).bindings as Binding[]) {
      if (beforeR40.has(row.path)) expect(row.previousDigest).toBe(beforeR40.get(row.path));
      beforeR40.set(row.path, row.digest);
    }
  }
  const bindings = manifest.bindings as Binding[];
  expect(bindings.map(row => row.path)).toEqual(boundPaths);
  for (const binding of bindings) {
    expect(beforeR40.get(binding.path)).toBe(binding.previousDigest);
    expect(hash(atBase(binding.path))).toBe(binding.previousDigest);
    const actual = liveOrNull(binding.path);
    if (binding.digest === null) {
      expect(retiredPaths).toContain(binding.path);
      expect([actual, binding.bytes]).toEqual([null, 0]);
    } else {
      expect(actual).not.toBeNull();
      expect([actual!.length, hash(actual!)]).toEqual([binding.bytes, binding.digest]);
      expect(actual!.includes(Buffer.from("\r\n"))).toBe(false);
      if (!rebound(binding.path)) expect(() => current.resolveDigest(binding.path, binding.digest!)).toThrow("SOURCE_BINDING_PREDECESSOR_MISMATCH");
    }
    expect(binding.digest).not.toBe(binding.previousDigest);
    expect(current.resolveDigest(binding.path, binding.previousDigest)).toBe(rebound(binding.path)?.digest ?? binding.digest);
    expect(() => current.resolveDigest(binding.path, `sha256:${"0".repeat(64)}`)).toThrow("SOURCE_BINDING_PREDECESSOR_MISMATCH");
  }
  // Completeness: outside the approved purpose changes, a chain-bound or corpus source differs from the chain end
  // before r40 exactly when r40 rebinds it.
  const corpus = JSON.parse(readFileSync(path.join(root, "tests/skill-classification/fixtures.json"), "utf8"));
  const purposePaths = new Set(PROVIDER_RETENTION_SOURCE_CHANGES.map(source => source.path));
  const changed: string[] = [];
  for (const sourcePath of new Set([...beforeR40.keys(), ...corpus.sourceSkills.map((source: {path: string}) => source.path)])) {
    if (purposePaths.has(sourcePath)) continue;
    const expected = beforeR40.has(sourcePath) ? beforeR40.get(sourcePath)
      : corpus.sourceSkills.find((source: {path: string}) => source.path === sourcePath).digest;
    const actual = liveOrNull(sourcePath);
    if ((actual === null ? null : hash(actual)) !== expected) changed.push(sourcePath);
  }
  expect(changed.sort()).toEqual([...boundPaths].sort());
});

/** 1-based first and last line of the frontmatter description field, folded YAML blocks included. */
function descriptionLines(text: string): [number, number] {
  const lines = text.split("\n"), end = lines.indexOf("---", 1);
  const start = lines.findIndex((line, index) => index > 0 && index < end && line.startsWith("description:"));
  expect(start).toBeGreaterThan(0);
  let stop = start + 1;
  while (stop < end && (/^\s/u.test(lines[stop]!) || lines[stop] === "")) stop++;
  return [start + 1, stop];
}

it("MI3 changes only the reviewed text and points every rebound span at the same rule in the live inventory", async () => {
  const before = (relative: string) => atBase(relative).toString("utf8");
  const live = (relative: string) => r40Source(relative).toString("utf8");
  const handOff = new Set(["code-review", "cs-engineering", "test-engineering"]);
  const skillIds = ["orchestrator", "code-review", "cs-engineering", "test-engineering", ...optimizedSkills, "coordinate-subagents", "model-effort-advisor"];
  // Each SKILL.md changes only its description, now one quoted English line, and for the three specialists the hand-off name.
  const lineDelta = new Map<string, number>();
  for (const skillId of skillIds) {
    const source = `skills/${skillId}/SKILL.md`;
    if (handOff.has(skillId)) expect(before(source).split("ponytail")).toHaveLength(2);
    const was = handOff.has(skillId) ? before(source).replace("ponytail", "minimal-implementation") : before(source), now = live(source);
    const [oldStart, oldEnd] = descriptionLines(was), [newStart, newEnd] = descriptionLines(now);
    expect([newStart, newEnd]).toEqual([oldStart, oldStart]);
    const wasLines = was.split("\n"), nowLines = now.split("\n"), line = nowLines[newStart - 1]!;
    expect(nowLines.slice(0, newStart - 1)).toEqual(wasLines.slice(0, oldStart - 1));
    expect(nowLines.slice(newEnd)).toEqual(wasLines.slice(oldEnd));
    expect(line).toMatch(/^description: "[\x20-\x7e]+"$/u);
    expect(line).not.toBe(wasLines.slice(oldStart - 1, oldEnd).join("\n"));
    lineDelta.set(source, newEnd - oldEnd);
  }
  expect(Object.fromEntries([...lineDelta].filter(([, delta]) => delta !== 0))).toEqual({
    "skills/cs-engineering/SKILL.md": -6, "skills/prompt-engineering/SKILL.md": -3, "skills/solid-design/SKILL.md": -3});
  const entry = "skills/orchestrator/references/entry-details.md";
  expect(before(entry).split("ponytail").length - 1).toBe(3);
  expect(live(entry)).not.toContain("ponytail");
  expect(live(entry).split("`minimal-implementation`").length - 1).toBeGreaterThanOrEqual(4);
  // The intake keeps one block; the rules that moved leave it and stand in their new places (user decision in ref 2).
  const intake = "skills/orchestrator/references/intake.md", contract = "skills/orchestrator/references/skill-classification.md";
  const description = (skillId: string) => JSON.parse(live(`skills/${skillId}/SKILL.md`).split("\n")[2]!.slice("description: ".length)) as string;
  const movedLines = ["- 코드 작성·수정·설계·라이브러리·의존성 선택에는 `ponytail`이", "- 무거운 단계는", "- 분류 지원(`classify_skills`)은"];
  for (const prefix of movedLines) {
    expect(before(intake).split("\n").filter(line => line.startsWith(prefix))).toHaveLength(1);
    expect(live(intake)).not.toContain(prefix.slice(2));
  }
  expect(live(intake)).not.toContain("`minimal-implementation`");
  expect(live(intake).split("\n")[3]).toContain("사용자 disable·override가 우선하며");
  expect(description("minimal-implementation")).toContain("invoke it first when available, active and not against user instructions");
  expect(description("mutation-risk-preflight")).toContain("Judge heaviness by scale, reversibility, real data, shared resources and public-state impact");
  expect(description("change-scope-guardian")).toContain("Call only when work overlaps other work or before a default-branch merge or publication.");
  expect(live(contract).split("\n")[2]).toMatch(/^이 절의 분류 호출은 기존 승인된 설치 설정과 호스트 호출 경로에서 지원이 확인된 경우에 적용한다\. /u);
  // The whole D-0083 sentence, held as its two clauses: a common intake sentence lives only in intake.md (claude-plugin test).
  expect(live(intake)).toContain(["모의·고정값·자리 채움·조용한 대체 경로·삼킨 오류가 낸 통과는 근거가 아니며",
    "남은 대체물은 위치와 함께 미검증으로 적는다."].join(" "));
  expect(live(intake)).not.toContain("ponytail");
  // Intake spans (24c241d2 index) -> the reviewed sentence they select now: [path, lines, first words, last words].
  const intakeSpans = new Map<string, [string, number, number, string, string]>([
    ["applicability[2]", [intake, 1, 4, "<!-- skill-intake:start -->\n## 공통 접수·선택 기준\n\n첫 도구 호출(읽기 포함) 전", "제외 조건과 대조해 고른다."]],
    ["applicability[3]", [intake, 4, 4, "그 판단·행동 전에 호스트 방식으로", "검증을 실제로 했는지 대조한다."]],
    ["applicability[4]", [intake, 4, 6, "목표·범위·위험·필요 판단이 바뀌면", "재분류·workflow·기록 추가 금지."]],
    ["applicability[5]", [intake, 8, 13, "행동 전 확인:\n1. ", "검증을 완료 조건에 넣는다."]],
    ["applicability[6]", [intake, 15, 18, "- 사용자만 할 승인·비밀값 입력", "고위험 변경의 별도 승인을 지킨다."]],
    ["applicability[7]", [intake, 19, 19, "- 단계가 이어지는 변경 작업은", "writeTargets로 따로 시작한다."]],
    ["applicability[8]", [intake, 20, 20, "- 질문·설명·인사·한 줄 수정은", "그것만 호출한다."]],
    ["applicability[9]", [contract, 3, 3, "이 절의 분류 호출은", "지원이 확인된 경우에 적용한다."]],
    ["exclusions[2]", [intake, 4, 4, "키워드·파일 종류·`complex`만으로", "고르지 않는다."]],
    ["exclusions[3]", [intake, 4, 4, "사용자 지정 스킬은 대체하지 않되", "생략 권한은 아니다."]],
    ["exclusions[4]", [intake, 19, 19, "읽기 전용 요청엔", "변경하지 않는다."]],
    ["exclusions[5]", [intake, 4, 4, "선택·이름 언급·호출 시작 응답", "실행이 아니다."]],
    ["exclusions[6]", [intake, 20, 20, "이런 요청에 registry 조회", "출력하지 않는다."]],
  ]);

  const inventory = await loadSkillInventory({root}); expect(inventory.issues).toEqual([]);
  const stable = (value: Record<string, unknown>) => Object.fromEntries(Object.entries(value).filter(([key]) => !["applicability", "exclusions"].includes(key)));
  const reworded: string[] = []; const count = {description: 0, body: 0, intake: 0};
  for (const skillId of skillIds) {
    const descriptor = `skills/${skillId}/classification.json`, source = `skills/${skillId}/SKILL.md`;
    const prior = JSON.parse(before(descriptor)), after = JSON.parse(live(descriptor));
    expect(stable(after)).toEqual(stable(prior));
    const skill = inventory.skills.find(row => row.skillId === skillId)!;
    const [oldStart, oldEnd] = descriptionLines(before(source));
    const clauses: Record<"applicability" | "exclusions", Span[]> = {applicability: [], exclusions: []};
    for (const group of ["applicability", "exclusions"] as const) {
      expect(after[group]).toHaveLength(prior[group].length);
      for (const [index, span] of (after[group] as Span[]).entries()) {
        const old = prior[group][index] as Span, at = `${skillId}:${group}[${index}]`;
        expect(span.digest).toBe(hash(r40Source(span.path)));
        const actual = selected(r40Source(span.path), span), previous = selected(atBase(old.path), old);
        const text = actual.toString("utf8");
        if (!r40Base(span.path)) expect(skill[group]).toContain(text.trim());
        expect(text).not.toContain("ponytail");
        if (old.path === intake) {
          const [file, startLine, endLine, head, tail] = intakeSpans.get(`${group}[${index}]`)!;
          expect([span.path, span.startLine, span.endLine]).toEqual([file, startLine, endLine]);
          expect([text.startsWith(head), text.endsWith(tail)], at).toEqual([true, true]);
          if (!actual.equals(previous)) reworded.push(at);
          count.intake++; continue;
        }
        expect(span.path).toBe(old.path);
        if (old.path === source && old.startLine >= oldStart && old.startLine <= oldEnd) {
          // A description clause moves onto the one-line description.
          expect(old.endLine).toBeLessThanOrEqual(oldEnd);
          expect([span.startLine, span.endLine]).toEqual([oldStart, oldStart]);
          clauses[group].push(span); count.description++; continue;
        }
        // A body span moves only by the description's line delta and keeps its bytes; only the hand-off name may change.
        const delta = lineDelta.get(old.path) ?? 0;
        expect([span.startLine, span.endLine, span.startByte]).toEqual([old.startLine + delta, old.endLine + delta, old.startByte]);
        if (actual.equals(previous)) expect(span.endByte).toBe(old.endByte);
        else {
          expect(previous.toString("utf8").split("ponytail")).toHaveLength(2);
          expect(text).toBe(previous.toString("utf8").replace("ponytail", "minimal-implementation")); reworded.push(at);
        }
        count.body++;
      }
    }
    // The description splits into one applicability clause from the line start and the adjacent exclusion clause up to
    // the closing quote; both end a sentence.
    expect([clauses.applicability.length, clauses.exclusions.length], skillId).toEqual([1, 1]);
    const [applies] = clauses.applicability as [Span], [excludes] = clauses.exclusions as [Span];
    const line = Buffer.from(live(source).split("\n")[oldStart - 1]!);
    expect([applies.startByte, applies.endByte! + 1, excludes.endByte], skillId).toEqual([0, excludes.startByte, line.length - 1]);
    expect([line.subarray(applies.endByte! - 1, excludes.startByte!).toString(), line.subarray(excludes.endByte! - 1).toString()], skillId).toEqual([". ", ".\""]);
  }
  expect(count).toMatchObject({description: 2 * skillIds.length, intake: 13});
  expect(count.body).toBeGreaterThan(0);
  expect(reworded).toEqual(["orchestrator:applicability[2]", "orchestrator:applicability[3]", "orchestrator:applicability[4]",
    "orchestrator:applicability[5]", "orchestrator:applicability[6]", "orchestrator:applicability[9]", "orchestrator:exclusions[3]",
    "orchestrator:exclusions[4]", "cs-engineering:applicability[1]"]);
});

it("MI4 retires ponytail and binds minimal-implementation as its purpose successor without rewriting the frozen corpus", async () => {
  expect(manifest.retiredSkills).toEqual([{skillId: "ponytail", replacement: "minimal-implementation", paths: retiredPaths, retiredSpans: 7}]);
  const retiredDescriptor = JSON.parse(atBase("skills/ponytail/classification.json").toString("utf8"));
  expect(retiredDescriptor.applicability.length + retiredDescriptor.exclusions.length).toBe(manifest.retiredSkills[0].retiredSpans);
  expect(existsSync(path.join(root, "skills/ponytail"))).toBe(false);
  expect(manifest.purposeSuccessors).toHaveLength(1);
  const successor = manifest.purposeSuccessors[0];
  expect(successor).toMatchObject({skillId: "minimal-implementation", version: "1.0.0", predecessorSkillId: "ponytail"});
  expect(successor.sources.map((source: {path: string}) => source.path)).toEqual(["skills/minimal-implementation/SKILL.md", "skills/minimal-implementation/classification.json"]);
  for (const source of successor.sources as {path: string; bytes: number; digest: string}[]) {
    expect(() => atBase(source.path)).toThrow();
    const actual = readFileSync(path.join(root, source.path));
    expect([actual.length, hash(actual)]).toEqual([source.bytes, source.digest]);
  }
  expect(readFileSync(path.join(root, "skills/minimal-implementation/VERSION"), "utf8").trim()).toBe(successor.version);
  const inventory = await loadSkillInventory({root}); expect(inventory.issues).toEqual([]);
  expect(inventory.skills.map(skill => skill.skillId)).not.toContain("ponytail");
  const skill = inventory.skills.find(row => row.skillId === "minimal-implementation")!;
  const descriptor = JSON.parse(readFileSync(path.join(root, "skills/minimal-implementation/classification.json"), "utf8"));
  const skillSource = readFileSync(path.join(root, "skills/minimal-implementation/SKILL.md"));
  let spans = 0;
  for (const group of ["applicability", "exclusions"] as const) for (const span of descriptor[group] as Span[]) {
    expect(span.path).toBe("skills/minimal-implementation/SKILL.md");
    expect(skill[group]).toContain(selected(skillSource, span).toString("utf8").trim()); spans++;
  }
  expect(spans).toBeGreaterThan(0);
  // The intake's "call minimal-implementation first" rule moved into this description; an applicability span binds it.
  expect((descriptor.applicability as Span[]).some(span => selected(skillSource, span).toString("utf8")
    .includes("invoke it first when available, active and not against user instructions"))).toBe(true);
  // The frozen corpus and its labels stay as they were: ponytail at its original digest, no successor label.
  const corpusBytes = readFileSync(path.join(root, "tests/skill-classification/fixtures.json"));
  const corpus = JSON.parse(corpusBytes.toString("utf8"));
  expect(oracleDigest(corpus)).toBe(corpus.oracleDigest);
  expect(corpus.sourceSkills.filter((source: {path: string}) => source.path === "skills/ponytail/SKILL.md")
    .map((source: {digest: string}) => source.digest)).toEqual(["sha256:2ce28db45c1a84e63fa2af7079e58a3803fc26b16ab7073436efd55b1e1214f9"]);
  expect(corpusBytes.includes(Buffer.from("minimal-implementation"))).toBe(false);
  expect(loadCurrentSourceBindings(root).resolveDigest("skills/ponytail/SKILL.md", "sha256:2ce28db45c1a84e63fa2af7079e58a3803fc26b16ab7073436efd55b1e1214f9")).toBeNull();
});

it("MI5 rejects a changed r40 manifest", () => {
  const copy = mkdtempSync(path.join(tmpdir(), "ags40-minimal-source-"));
  if (path.dirname(path.resolve(copy)) !== path.resolve(tmpdir()) || !path.basename(copy).startsWith("ags40-minimal-source-")) throw new Error("TEMP_SCOPE_MISMATCH");
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
