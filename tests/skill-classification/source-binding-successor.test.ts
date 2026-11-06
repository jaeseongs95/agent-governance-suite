import {createHash} from "node:crypto";
import {execFileSync} from "node:child_process";
import {existsSync, readFileSync, readdirSync} from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {expect, it} from "vitest";
import {oracleDigest, loadCurrentSourceBindings} from "./evaluation.js";
import {loadSkillInventory} from "../../mcp-server/src/skill-classification/inventory.js";
const root = fileURLToPath(new URL("../../", import.meta.url));
const currentSourceBinding = loadCurrentSourceBindings(root);
const current = JSON.parse(readFileSync(new URL("./fixtures.json", import.meta.url), "utf8"));
const successor = JSON.parse(readFileSync(new URL("./fixtures.source-successor.json", import.meta.url), "utf8"));
const hash = (bytes: string | Buffer) => "sha256:" + createHash("sha256").update(bytes).digest("hex");
const specialistBytes = readFileSync(new URL("./fixtures.specialist-behavior-source-successor.json", import.meta.url));
const specialist = JSON.parse(specialistBytes.toString("utf8"));
const multiBytes = readFileSync(new URL("./fixtures.orchestrator-multi-workflow-source-successor.json", import.meta.url));
const multi = JSON.parse(multiBytes.toString("utf8"));
const overwriteBytes = readFileSync(new URL("./fixtures.mutation-risk-preflight-overwrite-ask-source-successor.json", import.meta.url));
const overwrite = JSON.parse(overwriteBytes.toString("utf8"));
const premiseBytes = readFileSync(new URL("./fixtures.orchestrator-intake-premise-ask-source-successor.json", import.meta.url));
const premise = JSON.parse(premiseBytes.toString("utf8"));
const retireBytes = readFileSync(new URL("./fixtures.context-continuity-retirement-source-successor.json", import.meta.url));
const retire = JSON.parse(retireBytes.toString("utf8"));
const roleBytes = readFileSync(new URL("./fixtures.role-delegation-intake-source-successor.json", import.meta.url));
const role = JSON.parse(roleBytes.toString("utf8"));
const purposeBytes = readFileSync(new URL("./fixtures.intake-purpose-check-source-successor.json", import.meta.url));
const purpose = JSON.parse(purposeBytes.toString("utf8"));
const moveBytes = readFileSync(new URL("./fixtures.intake-reference-move-source-successor.json", import.meta.url));
const move = JSON.parse(moveBytes.toString("utf8"));
const blockedBytes = readFileSync(new URL("./fixtures.intake-blocked-step-source-successor.json", import.meta.url));
const blocked = JSON.parse(blockedBytes.toString("utf8"));
const neutralBytes = readFileSync(new URL("./fixtures.field-neutral-wording-source-successor.json", import.meta.url));
const neutral = JSON.parse(neutralBytes.toString("utf8"));
/** A null digest retires the path: the source no longer exists. */
type LaterBinding = {path: string; previousDigest: string; digest: string | null};
/** For each file a successor after specialist behavior rebound: the first rebinding's base and predecessor, the last one's digest. */
const reboundAfterSpecialist = new Map<string, {sourceBaseRevision: string; previousDigest: string; digest: string | null}>();
for (const later of [multi, overwrite, premise, retire, role, purpose, move, blocked, neutral]) {
  for (const binding of later.bindings as LaterBinding[]) {
    const first = reboundAfterSpecialist.get(binding.path);
    reboundAfterSpecialist.set(binding.path, first ? {...first, digest: binding.digest}
      : {sourceBaseRevision: later.sourceBaseRevision, previousDigest: binding.previousDigest, digest: binding.digest});
  }
}
/** A source as of a git revision, checked against the digest the binding recorded for it. */
function sourceAt(revision: string, relativePath: string, digest: string): Buffer {
  const bytes = execFileSync("git", ["show", `${revision}:${relativePath}`], {cwd: root, maxBuffer: 4 * 1024 * 1024});
  expect(hash(bytes)).toBe(digest);
  return bytes;
}
/** A source as the specialist successor bound it: a file a later successor rebound reads at that successor's base. */
function specialistSource(relativePath: string): Buffer {
  const later = reboundAfterSpecialist.get(relativePath);
  if (!later) return blockedSource(relativePath);
  return sourceAt(later.sourceBaseRevision, relativePath, later.previousDigest);
}
/** The digest the last of these successors binds for a path, or the given digest when none of them rebinds it. */
function latestDigest(relativePath: string, digest: string | null, successors: {bindings: LaterBinding[]}[]): string | null {
  for (const later of successors) for (const binding of later.bindings) if (binding.path === relativePath) digest = binding.digest;
  return digest;
}
/** A source as the intake premise successor bound it: a file the retirement successor rebound reads at its base. */
function premiseSource(relativePath: string): Buffer {
  const later = (retire.bindings as LaterBinding[]).find(binding => binding.path === relativePath);
  if (!later) return blockedSource(relativePath);
  return sourceAt(retire.sourceBaseRevision, relativePath, later.previousDigest);
}
const retireChanged = (skillId: string, group: string, index: number) => retire.spanPreservation.changedSpans.includes(`${skillId}:${group}[${index}]`);
/** A source as the retirement successor bound it: a file the role and delegation successor rebound reads at its base. */
function retireSource(relativePath: string): Buffer {
  const later = (role.bindings as LaterBinding[]).find(binding => binding.path === relativePath);
  if (!later) return blockedSource(relativePath);
  return sourceAt(role.sourceBaseRevision, relativePath, later.previousDigest);
}
const roleChanged = (skillId: string, group: string, index: number) => role.spanPreservation.changedSpans.includes(`${skillId}:${group}[${index}]`);
/** A source as the role and delegation successor bound it: a file the intake purpose-check successor rebound reads at its base. */
function roleSource(relativePath: string): Buffer {
  const later = (purpose.bindings as LaterBinding[]).find(binding => binding.path === relativePath);
  if (!later) return blockedSource(relativePath);
  return sourceAt(purpose.sourceBaseRevision, relativePath, later.previousDigest);
}
const purposeChanged = (skillId: string, group: string, index: number) => purpose.spanPreservation.changedSpans.includes(`${skillId}:${group}[${index}]`);
/** A source as the intake purpose-check successor bound it: a file the intake move successor rebound reads at its base. */
function purposeSource(relativePath: string): Buffer {
  const later = (move.bindings as LaterBinding[]).find(binding => binding.path === relativePath);
  if (!later) return blockedSource(relativePath);
  return sourceAt(move.sourceBaseRevision, relativePath, later.previousDigest);
}
const moveChanged = (skillId: string, group: string, index: number) => move.spanPreservation.changedSpans.includes(`${skillId}:${group}[${index}]`);
/** A source as the intake move successor bound it: a file the intake blocked-step successor rebound reads at its base. */
function moveSource(relativePath: string): Buffer {
  const later = (blocked.bindings as LaterBinding[]).find(binding => binding.path === relativePath);
  if (!later) return blockedSource(relativePath);
  return sourceAt(blocked.sourceBaseRevision, relativePath, later.previousDigest);
}
const blockedChanged = (skillId: string, group: string, index: number) => blocked.spanPreservation.changedSpans.includes(`${skillId}:${group}[${index}]`);
/** A source as every successor up to the intake blocked step bound it: a file the field-neutral successor rebound reads at its base. */
function blockedSource(relativePath: string): Buffer {
  const later = (neutral.bindings as LaterBinding[]).find(binding => binding.path === relativePath);
  if (!later) return readFileSync(path.join(root, relativePath));
  return sourceAt(neutral.sourceBaseRevision, relativePath, later.previousDigest);
}
const neutralChanged = (skillId: string, group: string, index: number) => neutral.spanPreservation.changedSpans.includes(`${skillId}:${group}[${index}]`);
/** A source as the multi-workflow successor bound it: a file the intake premise successor rebound reads at its base. */
function multiSource(relativePath: string): Buffer {
  const later = (premise.bindings as LaterBinding[]).find(binding => binding.path === relativePath);
  if (!later) return blockedSource(relativePath);
  return sourceAt(premise.sourceBaseRevision, relativePath, later.previousDigest);
}
type SourceSpan = {path: string; startLine: number; endLine: number; digest: string; startByte?: number; endByte?: number};
type RecordedSpan = SourceSpan & {selectedBytes: number; selectedDigest: string};
type SourcePin = {path: string; bytes: number; digest: string; gitBlob: string};
type ReboundSpan = {skillId: string; group: "applicability" | "exclusions"; index: number; change: string; previous: RecordedSpan; current: RecordedSpan};
let pinnedMainSources: Map<string, Buffer> | null = null;
function mainSource(relativePath: string): Buffer {
  if (pinnedMainSources === null) {
    const pins: SourcePin[] = [...specialist.sourceInventory.sourceFiles, ...specialist.sourceInventory.descriptorFiles];
    const bytes = execFileSync("git", ["cat-file", "--batch"], {
      cwd: root,
      input: pins.map(pin => `${specialist.sourceBaseRevision}:${pin.path}\n`).join(""),
      maxBuffer: 4 * 1024 * 1024,
    });
    const sources = new Map<string, Buffer>();
    let offset = 0;
    for (const pin of pins) {
      const headerEnd = bytes.indexOf(10, offset);
      const header = bytes.subarray(offset, headerEnd).toString("utf8");
      const parsed = /^([a-f0-9]{40}) blob ([0-9]+)$/.exec(header);
      if (!parsed) throw new Error(`PINNED_MAIN_SOURCE_UNAVAILABLE:${pin.path}:${header}`);
      expect(parsed[1]).toBe(pin.gitBlob);
      const length = Number(parsed[2]);
      expect(length).toBe(pin.bytes);
      const source = bytes.subarray(headerEnd + 1, headerEnd + 1 + length);
      expect(hash(source)).toBe(pin.digest);
      expect(bytes[headerEnd + 1 + length]).toBe(10);
      sources.set(pin.path, source);
      offset = headerEnd + 2 + length;
    }
    expect(offset).toBe(bytes.length);
    pinnedMainSources = sources;
  }
  const source = pinnedMainSources.get(relativePath);
  if (!source) throw new Error(`PINNED_MAIN_SOURCE_NOT_REGISTERED:${relativePath}`);
  return source;
}
function sourceRef(span: RecordedSpan): SourceSpan {
  return {path: span.path, startLine: span.startLine, endLine: span.endLine, digest: span.digest,
    ...(span.startByte === undefined ? {} : {startByte: span.startByte}),
    ...(span.endByte === undefined ? {} : {endByte: span.endByte})};
}
function selectedSource(bytes: Buffer, span: SourceSpan): Buffer {
  expect(hash(bytes)).toBe(span.digest);
  const lines = bytes.toString("utf8").split(/\r?\n/);
  expect(span.startLine).toBeGreaterThanOrEqual(1);
  expect(span.endLine).toBeGreaterThanOrEqual(span.startLine);
  expect(span.endLine).toBeLessThanOrEqual(lines.length);
  const joined = Buffer.from(lines.slice(span.startLine - 1, span.endLine).join("\n"));
  const start = span.startByte ?? 0, end = span.endByte ?? joined.length;
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  expect(end).toBeLessThanOrEqual(joined.length);
  const selected = joined.subarray(start, end);
  expect(() => new TextDecoder("utf-8", {fatal: true}).decode(selected)).not.toThrow();
  return selected;
}
it("chains the exact orchestrator multi-workflow source after specialist behavior, moving only the two widened spans", async () => {
  expect(hash(multiBytes)).toBe("sha256:2cb48a780ad6edf78f1ff68d468c053947ac8ab81b3b00177fb4068d21488f1c");
  expect(multiBytes.includes(Buffer.from("\r\n"))).toBe(false);
  expect(multi.revision).toBe("orchestrator-multi-workflow-source-binding-r19");
  expect(multi.frozenPredecessor).toEqual({path: "tests/skill-classification/fixtures.specialist-behavior-source-successor.json",
    bytes: specialistBytes.length, digest: hash(specialistBytes)});
  expect(multi.bindings.map((binding: {path: string}) => binding.path)).toEqual(["skills/orchestrator/SKILL.md", "skills/orchestrator/classification.json"]);
  expect(multi.spanPreservation.changedSpans).toEqual(["applicability[5]", "exclusions[4]"]);
  expect(multi.fixtureFileRewritten).toBe(false);
  expect(multi.labelChanges).toEqual([]);
  expect(multi.priceAndBudgetChanges).toEqual([]);
  expect(multi.modelBehavior).toBe("NOT_RUN");
  for (const binding of multi.bindings) {
    const actual = multiSource(binding.path);
    expect(actual.length).toBe(binding.bytes);
    expect(hash(actual)).toBe(binding.digest);
    expect(hash(specialistSource(binding.path))).toBe(binding.previousDigest);
    const latest = latestDigest(binding.path, binding.digest, [premise, retire, role, purpose, move, blocked, neutral]);
    expect(currentSourceBinding.resolveDigest(binding.path, binding.previousDigest)).toBe(latest);
    if (latest !== binding.digest) expect(currentSourceBinding.resolveDigest(binding.path, binding.digest)).toBe(latest);
    else expect(() => currentSourceBinding.resolveDigest(binding.path, binding.digest)).toThrow("SOURCE_BINDING_PREDECESSOR_MISMATCH");
  }
  const before = JSON.parse(specialistSource("skills/orchestrator/classification.json").toString("utf8"));
  const after = JSON.parse(multiSource("skills/orchestrator/classification.json").toString("utf8"));
  const stableFields = (value: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(value).filter(([key]) => !["applicability", "exclusions"].includes(key)));
  expect(stableFields(after)).toEqual(stableFields(before));
  const previousLines = specialistSource("skills/orchestrator/SKILL.md").toString("utf8").split(/\r?\n/);
  const lines = multiSource("skills/orchestrator/SKILL.md").toString("utf8").split(/\r?\n/);
  // The one inserted sentence, taken from the two sources (the intake wording lives only in SKILL.md).
  const [was, now] = [previousLines.join("\n"), lines.join("\n")];
  let head = 0, tail = 0;
  while (was[head] === now[head]) head++;
  while (tail < was.length - head && was[was.length - 1 - tail] === now[now.length - 1 - tail]) tail++;
  expect(was.length - head - tail).toBe(0);
  const inserted = now.slice(head, now.length - tail);
  expect(inserted).toMatch(/^[^\n]*writeTargets[^\n]*다\. $/u);
  const inventory = await loadSkillInventory({root});
  const orchestrator = inventory.skills.find(skill => skill.skillId === "orchestrator")!;
  expect(multi.spanPreservation.spans).toHaveLength(after.applicability.length + after.exclusions.length);
  for (const span of multi.spanPreservation.spans) {
    const current = after[span.group][span.index];
    expect([current.startLine, current.endLine, current.startByte ?? 0]).toEqual([span.startLine, span.endLine, span.startByte]);
    const selected = Buffer.from(lines.slice(span.startLine - 1, span.endLine).join("\n")).subarray(span.startByte, span.endByte);
    expect([selected.length, hash(selected)]).toEqual([span.bytes, span.digest]);
    // A span a later successor widened is checked against the current inventory in that successor's test.
    if (!premise.spanPreservation.changedSpans.includes(`${span.group}[${span.index}]`) && !retireChanged("orchestrator", span.group, span.index)
      && !roleChanged("orchestrator", span.group, span.index) && !purposeChanged("orchestrator", span.group, span.index)
      && !moveChanged("orchestrator", span.group, span.index)) {
      expect(orchestrator[span.group as "applicability" | "exclusions"]).toContain(selected.toString("utf8").trim());
    }
    const previous = Buffer.from(previousLines.slice(span.startLine - 1, span.endLine).join("\n")).subarray(span.previousStartByte, span.previousEndByte);
    // Unchanged spans keep their exact text; the two widened spans differ only by the one inserted sentence.
    if (!multi.spanPreservation.changedSpans.includes(`${span.group}[${span.index}]`)) expect(selected.equals(previous)).toBe(true);
    else expect(selected.toString("utf8").replace(inserted, "")).toBe(previous.toString("utf8"));
  }
});
it("chains the exact mutation-risk-preflight overwrite source after the multi-workflow source, moving only the spans below the added line", async () => {
  expect(hash(overwriteBytes)).toBe("sha256:831f685e583f4f872553bbe101f786bfc48bfa3a1d38540564c9df461943466f");
  expect(overwriteBytes.includes(Buffer.from("\r\n"))).toBe(false);
  expect(overwrite.revision).toBe("mutation-risk-preflight-overwrite-ask-source-binding-r20");
  expect(overwrite.sourceBaseRevision).toBe("a3ff66402860c508c80f7a996d1875ffa8700702");
  expect(overwrite.frozenPredecessor).toEqual({path: "tests/skill-classification/fixtures.orchestrator-multi-workflow-source-successor.json",
    bytes: multiBytes.length, digest: hash(multiBytes)});
  expect(overwrite.bindings.map((binding: {path: string}) => binding.path)).toEqual(["skills/mutation-risk-preflight/SKILL.md", "skills/mutation-risk-preflight/classification.json"]);
  expect(overwrite.spanPreservation.changedSpans).toEqual([]);
  expect(overwrite.fixtureFileRewritten).toBe(false);
  expect(overwrite.labelChanges).toEqual([]);
  expect(overwrite.priceAndBudgetChanges).toEqual([]);
  expect(overwrite.modelBehavior).toBe("NOT_RUN");
  const base = (relativePath: string) => sourceAt(overwrite.sourceBaseRevision, relativePath,
    overwrite.bindings.find((binding: LaterBinding) => binding.path === relativePath).previousDigest);
  for (const binding of overwrite.bindings) {
    const actual = blockedSource(binding.path);
    expect(actual.length).toBe(binding.bytes);
    expect(hash(actual)).toBe(binding.digest);
    expect(hash(specialistSource(binding.path))).toBe(binding.previousDigest);
    const latest = latestDigest(binding.path, binding.digest, [neutral]);
    expect(currentSourceBinding.resolveDigest(binding.path, binding.previousDigest)).toBe(latest);
    if (latest !== binding.digest) expect(currentSourceBinding.resolveDigest(binding.path, binding.digest)).toBe(latest);
    else expect(() => currentSourceBinding.resolveDigest(binding.path, binding.digest)).toThrow("SOURCE_BINDING_PREDECESSOR_MISMATCH");
  }
  const before = JSON.parse(base("skills/mutation-risk-preflight/classification.json").toString("utf8"));
  const after = JSON.parse(blockedSource("skills/mutation-risk-preflight/classification.json").toString("utf8"));
  const stableFields = (value: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(value).filter(([key]) => !["applicability", "exclusions"].includes(key)));
  expect(stableFields(after)).toEqual(stableFields(before));
  const previousLines = base("skills/mutation-risk-preflight/SKILL.md").toString("utf8").split(/\r?\n/);
  const lines = blockedSource("skills/mutation-risk-preflight/SKILL.md").toString("utf8").split(/\r?\n/);
  // The one added line, taken from the two sources (the guidance wording lives only in SKILL.md).
  expect(lines.length).toBe(previousLines.length + 1);
  const added = lines.findIndex((line, index) => line !== previousLines[index]);
  expect([...lines.slice(0, added), ...lines.slice(added + 1)]).toEqual(previousLines);
  expect(added + 1).toBe(18);
  expect(lines[added]).toMatch(/^- [^\n]*`irreversibilityAccepted`[^\n]*다\.$/u);
  const inventory = await loadSkillInventory({root});
  const preflight = inventory.skills.find(skill => skill.skillId === "mutation-risk-preflight")!;
  expect(overwrite.spanPreservation.spans).toHaveLength(after.applicability.length + after.exclusions.length);
  for (const span of overwrite.spanPreservation.spans) {
    const current = after[span.group][span.index], previous = before[span.group][span.index];
    expect([current.startLine, current.endLine, current.startByte ?? 0]).toEqual([span.startLine, span.endLine, span.startByte]);
    expect([previous.startLine, previous.endLine, previous.startByte ?? 0]).toEqual([span.previousStartLine, span.previousEndLine, span.previousStartByte]);
    // Spans below the added line move down by exactly one line; spans above it keep their lines.
    const shift = span.previousStartLine > added ? 1 : 0;
    expect([span.startLine, span.endLine]).toEqual([span.previousStartLine + shift, span.previousEndLine + shift]);
    expect(current.digest).toBe(hash(blockedSource(current.path)));
    const selected = Buffer.from(lines.slice(span.startLine - 1, span.endLine).join("\n")).subarray(span.startByte, span.endByte);
    expect([selected.length, hash(selected)]).toEqual([span.bytes, span.digest]);
    // A span the field-neutral successor reworded is checked against the current inventory in that successor's test.
    if (!neutralChanged("mutation-risk-preflight", span.group, span.index)) expect(preflight[span.group as "applicability" | "exclusions"]).toContain(selected.toString("utf8").trim());
    const previousSelected = Buffer.from(previousLines.slice(span.previousStartLine - 1, span.previousEndLine).join("\n")).subarray(span.previousStartByte, span.previousEndByte);
    expect(selected.equals(previousSelected)).toBe(true);
  }
});
it("chains the exact orchestrator intake premise source after the overwrite source, widening only the span over the changed line", async () => {
  expect(hash(premiseBytes)).toBe("sha256:fd1acda5ee529f0654b909f261b237baa073b5d3b60220a228e9882276e75dbb");
  expect(premiseBytes.includes(Buffer.from("\r\n"))).toBe(false);
  expect(premise.revision).toBe("orchestrator-intake-premise-ask-source-binding-r21");
  expect(premise.sourceBaseRevision).toBe("fc5ea360bbafafc8f5e54d466eb04f0d3ceba1bb");
  expect(premise.frozenPredecessor).toEqual({path: "tests/skill-classification/fixtures.mutation-risk-preflight-overwrite-ask-source-successor.json",
    bytes: overwriteBytes.length, digest: hash(overwriteBytes)});
  expect(premise.bindings.map((binding: {path: string}) => binding.path)).toEqual(["skills/orchestrator/SKILL.md", "skills/orchestrator/classification.json"]);
  expect(premise.spanPreservation.changedSpans).toEqual(["applicability[5]"]);
  expect(premise.fixtureFileRewritten).toBe(false);
  expect(premise.labelChanges).toEqual([]);
  expect(premise.priceAndBudgetChanges).toEqual([]);
  expect(premise.modelBehavior).toBe("NOT_RUN");
  for (const binding of premise.bindings) {
    const actual = premiseSource(binding.path);
    expect(actual.length).toBe(binding.bytes);
    expect(hash(actual)).toBe(binding.digest);
    // The predecessor is the multi-workflow successor's exact bytes, read at this successor's base.
    expect(multi.bindings.find((row: LaterBinding) => row.path === binding.path).digest).toBe(binding.previousDigest);
    expect(hash(multiSource(binding.path))).toBe(binding.previousDigest);
    const latest = latestDigest(binding.path, binding.digest, [retire, role, purpose, move, blocked, neutral]);
    expect(currentSourceBinding.resolveDigest(binding.path, binding.previousDigest)).toBe(latest);
    if (latest !== binding.digest) expect(currentSourceBinding.resolveDigest(binding.path, binding.digest)).toBe(latest);
    else expect(() => currentSourceBinding.resolveDigest(binding.path, binding.digest)).toThrow("SOURCE_BINDING_PREDECESSOR_MISMATCH");
  }
  const before = JSON.parse(multiSource("skills/orchestrator/classification.json").toString("utf8"));
  const after = JSON.parse(premiseSource("skills/orchestrator/classification.json").toString("utf8"));
  const stableFields = (value: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(value).filter(([key]) => !["applicability", "exclusions"].includes(key)));
  expect(stableFields(after)).toEqual(stableFields(before));
  const previousLines = multiSource("skills/orchestrator/SKILL.md").toString("utf8").split(/\r?\n/);
  const lines = premiseSource("skills/orchestrator/SKILL.md").toString("utf8").split(/\r?\n/);
  // The inserted text, taken from the two sources (the intake wording lives only in SKILL.md): one line changes,
  // and it gains two sentences placed right before that line's last sentence.
  expect(lines.length).toBe(previousLines.length);
  const changedLines = lines.flatMap((line, index) => line === previousLines[index] ? [] : [index]);
  expect(changedLines).toEqual([24]);
  const [was, now] = [previousLines[24]!, lines[24]!];
  const lastSentence = was.lastIndexOf("다. ") + 3;
  expect(lastSentence).toBeGreaterThan(3);
  expect(now.startsWith(was.slice(0, lastSentence)) && now.endsWith(was.slice(lastSentence))).toBe(true);
  const inserted = now.slice(lastSentence, now.length - (was.length - lastSentence));
  expect(inserted.length).toBeGreaterThan(0);
  expect(inserted).toMatch(/^[^\n]*다\. $/u);
  expect(inserted.match(/다\. /gu)).toHaveLength(2);
  const shift = Buffer.byteLength(inserted);
  const inventory = await loadSkillInventory({root});
  const orchestrator = inventory.skills.find(skill => skill.skillId === "orchestrator")!;
  expect(premise.spanPreservation.spans).toHaveLength(after.applicability.length + after.exclusions.length);
  for (const span of premise.spanPreservation.spans) {
    const current = after[span.group][span.index], previous = before[span.group][span.index];
    expect([current.startLine, current.endLine, current.startByte ?? 0]).toEqual([span.startLine, span.endLine, span.startByte]);
    expect([previous.startLine, previous.endLine, previous.startByte ?? 0]).toEqual([span.previousStartLine, span.previousEndLine, span.previousStartByte]);
    // No line moves; only a span over the changed line widens, by exactly the inserted bytes.
    expect([span.startLine, span.endLine]).toEqual([span.previousStartLine, span.previousEndLine]);
    expect(current.digest).toBe(hash(premiseSource(current.path)));
    const selected = Buffer.from(lines.slice(span.startLine - 1, span.endLine).join("\n")).subarray(span.startByte, span.endByte);
    expect([selected.length, hash(selected)]).toEqual([span.bytes, span.digest]);
    // A span the retirement successor widened is checked against the current inventory in that successor's test.
    if (!retireChanged("orchestrator", span.group, span.index) && !roleChanged("orchestrator", span.group, span.index)
      && !purposeChanged("orchestrator", span.group, span.index)
      && !moveChanged("orchestrator", span.group, span.index)) {
      expect(orchestrator[span.group as "applicability" | "exclusions"]).toContain(selected.toString("utf8").trim());
    }
    const previousSelected = Buffer.from(previousLines.slice(span.previousStartLine - 1, span.previousEndLine).join("\n")).subarray(span.previousStartByte, span.previousEndByte);
    const widened = span.startLine <= 25 && span.endLine >= 25;
    expect(premise.spanPreservation.changedSpans.includes(`${span.group}[${span.index}]`)).toBe(widened);
    if (!widened) {
      expect([span.startByte, span.endByte]).toEqual([span.previousStartByte, span.previousEndByte]);
      expect(selected.equals(previousSelected)).toBe(true);
    } else {
      // Where the inserted text begins inside this span's selection.
      const offset = Buffer.byteLength([...lines.slice(span.startLine - 1, 24), was.slice(0, lastSentence)].join("\n")) - span.startByte;
      expect([span.startByte, span.endByte]).toEqual([span.previousStartByte, span.previousEndByte + shift]);
      expect(selected.subarray(offset, offset + shift).toString("utf8")).toBe(inserted);
      expect(Buffer.concat([selected.subarray(0, offset), selected.subarray(offset + shift)]).equals(previousSelected)).toBe(true);
    }
  }
});
it("retires context-continuity and chains the orchestrator and coordinate-subagents sources after the intake premise source", async () => {
  expect(hash(retireBytes)).toBe("sha256:bb170e6860c96686dd7cfc19ac017c178a7bf3e9da751af3048cc148d6c387cf");
  expect(retireBytes.includes(Buffer.from("\r\n"))).toBe(false);
  expect(retire.revision).toBe("context-continuity-retirement-source-binding-r22");
  expect(retire.role).toBe("source-binding-only-not-evaluation-or-install-authority");
  expect(retire.sourceBaseRevision).toBe("e6e313864a4fe1be15ac2b199fb56284dbc327a9");
  expect(retire.frozenPredecessor).toEqual({path: "tests/skill-classification/fixtures.orchestrator-intake-premise-ask-source-successor.json",
    bytes: premiseBytes.length, digest: hash(premiseBytes)});
  expect(retire.fixtureFileRewritten).toBe(false);
  expect(retire.labelChanges).toEqual([]);
  expect(retire.priceAndBudgetChanges).toEqual([]);
  expect(retire.modelBehavior).toBe("NOT_RUN");
  expect(currentSourceBinding.manifest).toMatchObject({revision: neutral.revision});
  const retiredPaths = ["skills/context-continuity/SKILL.md", "skills/context-continuity/classification.json", "skills/context-continuity/references/entry-details.md"];
  const tools = ["checkpoint_context", "inspect_context", "load_context", "suppress_context_restore", "purge_direct_context"];
  expect(retire.bindings.map((binding: LaterBinding) => binding.path)).toEqual(["skills/orchestrator/SKILL.md", "skills/orchestrator/classification.json",
    "skills/coordinate-subagents/classification.json", "skills/coordinate-subagents/references/entry-details.md", ...retiredPaths]);
  expect(retire.retiredSkills).toEqual([{skillId: "context-continuity", replacement: "mcp-tools-and-hooks", tools, paths: retiredPaths, retiredSpans: 7}]);
  // The replacing tools exist and each says when to call it.
  for (const locale of ["ko", "en"]) {
    const catalog = JSON.parse(readFileSync(path.join(root, `locales/${locale}/tools.json`), "utf8"));
    for (const tool of tools) expect(catalog[`tools.${tool}.description`], `${locale}:${tool}`).toMatch(/\S/u);
  }
  const base = (relativePath: string) => sourceAt(retire.sourceBaseRevision, relativePath,
    retire.bindings.find((binding: LaterBinding) => binding.path === relativePath).previousDigest);
  for (const binding of retire.bindings as (LaterBinding & {bytes: number})[]) {
    // The predecessor is what the earlier successors bound last, read at this successor's base.
    expect(latestDigest(binding.path, null, [specialist, multi, overwrite, premise])).toBe(binding.previousDigest);
    base(binding.path);
    expect(currentSourceBinding.resolveDigest(binding.path, binding.previousDigest)).toBe(binding.digest);
    if (binding.digest === null) {
      expect(retiredPaths).toContain(binding.path);
      expect(binding.bytes).toBe(0);
      expect(existsSync(path.join(root, binding.path))).toBe(false);
    } else {
      const actual = retireSource(binding.path);
      expect([actual.length, hash(actual)]).toEqual([binding.bytes, binding.digest]);
      const latest = latestDigest(binding.path, binding.digest, [role, purpose, move, blocked, neutral]);
      if (latest !== binding.digest) expect(currentSourceBinding.resolveDigest(binding.path, binding.digest!)).toBe(latest);
      else expect(() => currentSourceBinding.resolveDigest(binding.path, binding.digest!)).toThrow("SOURCE_BINDING_PREDECESSOR_MISMATCH");
    }
  }
  expect(existsSync(path.join(root, "skills/context-continuity"))).toBe(false);
  const inventory = await loadSkillInventory({root});
  expect(inventory.issues).toEqual([]);
  expect(inventory.skills.map(skill => skill.skillId)).not.toContain("context-continuity");
  const retiredDescriptor = JSON.parse(base("skills/context-continuity/classification.json").toString("utf8"));
  expect(retiredDescriptor.applicability.length + retiredDescriptor.exclusions.length).toBe(7);
  // orchestrator: line 20 names checkpoint_context instead of the retired skill and line 25 gains sentences; no line moves.
  const previousLines = base("skills/orchestrator/SKILL.md").toString("utf8").split(/\r?\n/);
  const lines = retireSource("skills/orchestrator/SKILL.md").toString("utf8").split(/\r?\n/);
  expect(lines.length).toBe(previousLines.length);
  expect(lines.flatMap((line, index) => line === previousLines[index] ? [] : [index])).toEqual([19, 24]);
  expect(previousLines[19]).toContain("`context-continuity`");
  expect(lines.join("\n")).not.toContain("context-continuity");
  expect(lines[19]).toContain("`checkpoint_context`");
  // coordinate-subagents: one paragraph and a blank line are inserted after line 53; nothing else changes.
  const previousDetail = base("skills/coordinate-subagents/references/entry-details.md").toString("utf8").split(/\r?\n/);
  const detail = retireSource("skills/coordinate-subagents/references/entry-details.md").toString("utf8").split(/\r?\n/);
  expect([...detail.slice(0, 53), ...detail.slice(55)]).toEqual(previousDetail);
  expect(detail[53]).toMatch(/^Give a verification agent [^\n]*\.$/u);
  expect(detail[54]).toBe("");
  const changedLines = new Map([["skills/orchestrator/SKILL.md", [19, 24]]]);
  const skills = new Map(inventory.skills.map(skill => [skill.skillId, skill]));
  const descriptors = new Map(["orchestrator", "coordinate-subagents"].map(skillId => {
    const relative = `skills/${skillId}/classification.json`;
    const before = JSON.parse(base(relative).toString("utf8")), after = JSON.parse(retireSource(relative).toString("utf8"));
    const stableFields = (value: Record<string, unknown>) =>
      Object.fromEntries(Object.entries(value).filter(([key]) => !["applicability", "exclusions"].includes(key)));
    expect(stableFields(after)).toEqual(stableFields(before));
    return [skillId, {before, after}];
  }));
  expect(retire.spanPreservation.spans).toHaveLength([...descriptors.values()].reduce((total, {after}) => total + after.applicability.length + after.exclusions.length, 0));
  for (const span of retire.spanPreservation.spans) {
    const {before, after} = descriptors.get(span.skillId)!;
    const current = after[span.group][span.index], previous = before[span.group][span.index];
    expect([current.path, current.startLine, current.endLine, current.startByte ?? 0, current.endByte]).toEqual([span.path, span.startLine, span.endLine, span.startByte, span.endByte]);
    expect([previous.path, previous.startLine, previous.endLine, previous.startByte ?? 0, previous.endByte]).toEqual([span.path, span.previousStartLine, span.previousEndLine, span.previousStartByte, span.previousEndByte]);
    expect([span.startLine, span.endLine, span.startByte]).toEqual([span.previousStartLine, span.previousEndLine, span.previousStartByte]);
    const selected = selectedSource(retireSource(current.path), current);
    expect([selected.length, hash(selected)]).toEqual([span.bytes, span.digest]);
    // A span a later successor changed is checked against the current inventory in that successor's test.
    if (!roleChanged(span.skillId, span.group, span.index) && !purposeChanged(span.skillId, span.group, span.index)
      && !moveChanged(span.skillId, span.group, span.index) && !neutralChanged(span.skillId, span.group, span.index)) expect(skills.get(span.skillId)![span.group as "applicability" | "exclusions"]).toContain(selected.toString("utf8").trim());
    const previousSelected = selectedSource(sourceAt(retire.sourceBaseRevision, previous.path, previous.digest), previous);
    const widened = (changedLines.get(span.path) ?? []).filter(index => index >= span.startLine - 1 && index <= span.endLine - 1);
    expect(retireChanged(span.skillId, span.group, span.index)).toBe(widened.length > 0);
    if (widened.length === 0) {
      expect(span.endByte).toBe(span.previousEndByte);
      expect(selected.equals(previousSelected)).toBe(true);
    } else {
      // The span still selects the same lines; only the changed lines' text differs, and its end moves by their size change.
      let expected = previousSelected.toString("utf8");
      for (const index of widened) expected = expected.replace(previousLines[index]!, lines[index]!);
      expect(selected.toString("utf8")).toBe(expected);
      expect(span.endByte - span.previousEndByte).toBe(widened.reduce((total, index) => total + Buffer.byteLength(lines[index]!) - Buffer.byteLength(previousLines[index]!), 0));
    }
  }
  expect(retire.spanPreservation.changedSpans).toEqual(["orchestrator:applicability[4]", "orchestrator:applicability[5]"]);
});
it("chains the role and delegation intake source after the retirement source, changing one line in each of two sources", async () => {
  expect(hash(roleBytes)).toBe("sha256:53063904e18a416690da94ea5c54ae867586174028806e90202c76c61fcce2c8");
  expect(roleBytes.includes(Buffer.from("\r\n"))).toBe(false);
  expect(role.revision).toBe("role-delegation-intake-source-binding-r23");
  expect(role.role).toBe("source-binding-only-not-evaluation-or-install-authority");
  expect(role.sourceBaseRevision).toBe("4849bdd43fded206f6661b0fc952c398a0682856");
  expect(role.frozenPredecessor).toEqual({path: "tests/skill-classification/fixtures.context-continuity-retirement-source-successor.json",
    bytes: retireBytes.length, digest: hash(retireBytes)});
  expect(role.fixtureFileRewritten).toBe(false);
  expect(role.labelChanges).toEqual([]);
  expect(role.priceAndBudgetChanges).toEqual([]);
  expect(role.modelBehavior).toBe("NOT_RUN");
  expect(currentSourceBinding.manifest).toMatchObject({revision: neutral.revision});
  expect(role.bindings.map((binding: LaterBinding) => binding.path)).toEqual(["skills/orchestrator/SKILL.md", "skills/orchestrator/classification.json",
    "skills/coordinate-subagents/classification.json", "skills/coordinate-subagents/references/entry-details.md"]);
  const base = (relativePath: string) => sourceAt(role.sourceBaseRevision, relativePath,
    role.bindings.find((binding: LaterBinding) => binding.path === relativePath).previousDigest);
  for (const binding of role.bindings as (LaterBinding & {bytes: number})[]) {
    // The predecessor is what the retirement successor bound last, read at this successor's base.
    expect(latestDigest(binding.path, null, [retire])).toBe(binding.previousDigest);
    base(binding.path);
    const actual = roleSource(binding.path);
    expect([actual.length, hash(actual)]).toEqual([binding.bytes, binding.digest]);
    const latest = latestDigest(binding.path, binding.digest, [purpose, move, blocked, neutral]);
    expect(currentSourceBinding.resolveDigest(binding.path, binding.previousDigest)).toBe(latest);
    if (latest !== binding.digest) expect(currentSourceBinding.resolveDigest(binding.path, binding.digest!)).toBe(latest);
    else expect(() => currentSourceBinding.resolveDigest(binding.path, binding.digest!)).toThrow("SOURCE_BINDING_PREDECESSOR_MISMATCH");
  }
  // One line changes in each source; nothing moves. The orchestrator role line gains sentences between its first and
  // last sentence (role, hand-over or ask, delegation review and brief rules); the coordinate-subagents default changes.
  const changedLines = new Map([["skills/orchestrator/SKILL.md", 25], ["skills/coordinate-subagents/references/entry-details.md", 20]]);
  const previousSources = new Map([...changedLines.keys()].map(relative => [relative, base(relative).toString("utf8").split(/\r?\n/)]));
  const currentSources = new Map([...changedLines.keys()].map(relative => [relative, roleSource(relative).toString("utf8").split(/\r?\n/)]));
  for (const [relative, index] of changedLines) {
    const before = previousSources.get(relative)!, after = currentSources.get(relative)!;
    expect(after.length).toBe(before.length);
    expect(after.flatMap((line, at) => line === before[at] ? [] : [at])).toEqual([index]);
  }
  const [wasRole, nowRole] = [previousSources.get("skills/orchestrator/SKILL.md")![25]!, currentSources.get("skills/orchestrator/SKILL.md")![25]!];
  const firstSentence = wasRole.indexOf("다. ") + 3, lastSentence = wasRole.lastIndexOf("peer 메시지는");
  expect(nowRole.startsWith(wasRole.slice(0, firstSentence)) && nowRole.endsWith(wasRole.slice(lastSentence))).toBe(true);
  const inserted = nowRole.slice(firstSentence, nowRole.length - (wasRole.length - lastSentence));
  for (const term of ["`update_session_status`의 `role`", "`list_session_status`", "`prepare_session_message`·`send_session_message`", "사용자에게 묻는다",
    "`coordinate-subagents`의 위임 판단", "금지 구역", "검증 에이전트에 맡기지 않는다"]) expect(inserted).toContain(term);
  expect(currentSources.get("skills/coordinate-subagents/references/entry-details.md")![20]).toMatch(/^Without an explicit delegation request, check the net-benefit conditions whenever an independent unit exists instead of keeping work local by default\. /u);
  const inventory = await loadSkillInventory({root});
  expect(inventory.issues).toEqual([]);
  const skills = new Map(inventory.skills.map(skill => [skill.skillId, skill]));
  const descriptors = new Map(["orchestrator", "coordinate-subagents"].map(skillId => {
    const relative = `skills/${skillId}/classification.json`;
    const before = JSON.parse(base(relative).toString("utf8")), after = JSON.parse(roleSource(relative).toString("utf8"));
    const stableFields = (value: Record<string, unknown>) =>
      Object.fromEntries(Object.entries(value).filter(([key]) => !["applicability", "exclusions"].includes(key)));
    expect(stableFields(after)).toEqual(stableFields(before));
    return [skillId, {before, after}];
  }));
  expect(role.spanPreservation.spans).toHaveLength([...descriptors.values()].reduce((total, {after}) => total + after.applicability.length + after.exclusions.length, 0));
  for (const span of role.spanPreservation.spans) {
    const {before, after} = descriptors.get(span.skillId)!;
    const current = after[span.group][span.index], previous = before[span.group][span.index];
    expect([current.path, current.startLine, current.endLine, current.startByte ?? 0, current.endByte]).toEqual([span.path, span.startLine, span.endLine, span.startByte, span.endByte]);
    expect([previous.path, previous.startLine, previous.endLine, previous.startByte ?? 0, previous.endByte]).toEqual([span.path, span.previousStartLine, span.previousEndLine, span.previousStartByte, span.previousEndByte]);
    expect([span.startLine, span.endLine, span.startByte]).toEqual([span.previousStartLine, span.previousEndLine, span.previousStartByte]);
    const selected = selectedSource(roleSource(current.path), current);
    expect([selected.length, hash(selected)]).toEqual([span.bytes, span.digest]);
    // A span the intake purpose-check successor changed is checked against the current inventory in that successor's test.
    if (!purposeChanged(span.skillId, span.group, span.index) && !moveChanged(span.skillId, span.group, span.index)
      && !neutralChanged(span.skillId, span.group, span.index)) expect(skills.get(span.skillId)![span.group as "applicability" | "exclusions"]).toContain(selected.toString("utf8").trim());
    const previousSelected = selectedSource(sourceAt(role.sourceBaseRevision, previous.path, previous.digest), previous);
    const index = changedLines.get(span.path);
    const widened = index !== undefined && index >= span.startLine - 1 && index <= span.endLine - 1;
    expect(roleChanged(span.skillId, span.group, span.index)).toBe(widened);
    if (!widened) {
      expect(span.endByte).toBe(span.previousEndByte);
      expect(selected.equals(previousSelected)).toBe(true);
    } else {
      // The span still selects the same line; only that line's text differs, and its end moves by the size change.
      const was = previousSources.get(span.path)![index]!, now = currentSources.get(span.path)![index]!;
      expect(selected.toString("utf8")).toBe(previousSelected.toString("utf8").replace(was, now));
      expect(span.endByte - span.previousEndByte).toBe(Buffer.byteLength(now) - Buffer.byteLength(was));
    }
  }
  expect(role.spanPreservation.changedSpans).toEqual(["orchestrator:applicability[5]", "coordinate-subagents:exclusions[4]"]);
});
it("chains the intake purpose-check source after the role source, rewording only the intake lines and moving none", async () => {
  expect(hash(purposeBytes)).toBe("sha256:db4969559ebffdefbb84fb92e71c83fb93b53b3d215fc7f680fada0d8e4bfdd7");
  expect(purposeBytes.includes(Buffer.from("\r\n"))).toBe(false);
  expect(purpose.revision).toBe("intake-purpose-check-source-binding-r24");
  expect(purpose.role).toBe("source-binding-only-not-evaluation-or-install-authority");
  expect(purpose.sourceBaseRevision).toBe("d068dfd6ed0546c2f9ec422f3ecde73c48ddf610");
  expect(purpose.frozenPredecessor).toEqual({path: "tests/skill-classification/fixtures.role-delegation-intake-source-successor.json",
    bytes: roleBytes.length, digest: hash(roleBytes)});
  expect(purpose.fixtureFileRewritten).toBe(false);
  expect(purpose.labelChanges).toEqual([]);
  expect(purpose.priceAndBudgetChanges).toEqual([]);
  expect(purpose.modelBehavior).toBe("NOT_RUN");
  expect(currentSourceBinding.manifest).toMatchObject({revision: neutral.revision});
  expect(purpose.bindings.map((binding: LaterBinding) => binding.path)).toEqual(["skills/orchestrator/SKILL.md", "skills/orchestrator/classification.json"]);
  const base = (relativePath: string) => sourceAt(purpose.sourceBaseRevision, relativePath,
    purpose.bindings.find((binding: LaterBinding) => binding.path === relativePath).previousDigest);
  for (const binding of purpose.bindings as (LaterBinding & {bytes: number})[]) {
    // The predecessor is what the role and delegation successor bound last, read at this successor's base.
    expect(latestDigest(binding.path, null, [role])).toBe(binding.previousDigest);
    base(binding.path);
    const actual = purposeSource(binding.path);
    expect([actual.length, hash(actual)]).toEqual([binding.bytes, binding.digest]);
    const latest = latestDigest(binding.path, binding.digest, [move, blocked, neutral]);
    expect(currentSourceBinding.resolveDigest(binding.path, binding.previousDigest)).toBe(latest);
    if (latest !== binding.digest) expect(currentSourceBinding.resolveDigest(binding.path, binding.digest!)).toBe(latest);
    else expect(() => currentSourceBinding.resolveDigest(binding.path, binding.digest!)).toThrow("SOURCE_BINDING_PREDECESSOR_MISMATCH");
  }
  // Only lines inside the intake block change and no line moves: repeated sentences merge, the skill-load line folds
  // into the selection paragraph, and the purpose-check line (AGS3-D-0031) takes its place in the list.
  const previousLines = base("skills/orchestrator/SKILL.md").toString("utf8").split(/\r?\n/);
  const lines = purposeSource("skills/orchestrator/SKILL.md").toString("utf8").split(/\r?\n/);
  expect(lines.length).toBe(previousLines.length);
  const start = previousLines.indexOf("<!-- skill-intake:start -->"), end = previousLines.indexOf("<!-- skill-intake:end -->");
  expect([lines.indexOf("<!-- skill-intake:start -->"), lines.indexOf("<!-- skill-intake:end -->")]).toEqual([start, end]);
  const changed = lines.flatMap((line, index) => line === previousLines[index] ? [] : [index]);
  expect(changed.length).toBeGreaterThan(0);
  expect(changed.every(index => index > start && index < end)).toBe(true);
  const bullets = (from: string[]) => from.slice(start, end).filter(line => line.startsWith("- "));
  expect(bullets(lines)).toHaveLength(bullets(previousLines).length);
  expect(bullets(previousLines).filter(line => line.startsWith("- 선택한 스킬은 설치된 본문"))).toHaveLength(1);
  expect(bullets(lines).filter(line => line.startsWith("- 선택한 스킬은"))).toEqual([]);
  expect(bullets(lines).filter(line => line.startsWith("- 닫기·삭제·되돌리기·대체를 고르거나"))).toHaveLength(1);
  const block = (from: string[]) => from.slice(start + 1, end).join("\n");
  // AGS3-D-0032: the reworded block is shorter than before even with the added line.
  expect([...block(lines)].length).toBeLessThan([...block(previousLines)].length);
  const inventory = await loadSkillInventory({root});
  expect(inventory.issues).toEqual([]);
  const orchestrator = inventory.skills.find(skill => skill.skillId === "orchestrator")!;
  const before = JSON.parse(base("skills/orchestrator/classification.json").toString("utf8"));
  const after = JSON.parse(purposeSource("skills/orchestrator/classification.json").toString("utf8"));
  const stableFields = (value: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(value).filter(([key]) => !["applicability", "exclusions"].includes(key)));
  expect(stableFields(after)).toEqual(stableFields(before));
  for (const group of ["applicability", "exclusions"]) expect(after[group]).toHaveLength(before[group].length);
  expect(purpose.spanPreservation.spans).toHaveLength(after.applicability.length + after.exclusions.length);
  for (const span of purpose.spanPreservation.spans) {
    const current = after[span.group][span.index], previous = before[span.group][span.index];
    expect([current.path, current.startLine, current.endLine, current.startByte ?? 0, current.endByte]).toEqual([span.path, span.startLine, span.endLine, span.startByte, span.endByte]);
    expect([previous.path, previous.startLine, previous.endLine, previous.startByte ?? 0, previous.endByte]).toEqual([span.path, span.previousStartLine, span.previousEndLine, span.previousStartByte, span.previousEndByte]);
    const selected = selectedSource(purposeSource(current.path), current);
    expect([selected.length, hash(selected)]).toEqual([span.bytes, span.digest]);
    // A span the intake move successor changed is checked against the current inventory in that successor's test.
    if (!moveChanged(span.skillId, span.group, span.index)) expect(orchestrator[span.group as "applicability" | "exclusions"]).toContain(selected.toString("utf8").trim());
    const previousSelected = selectedSource(sourceAt(purpose.sourceBaseRevision, previous.path, previous.digest), previous);
    const reworded = !selected.equals(previousSelected);
    expect(purposeChanged(span.skillId, span.group, span.index)).toBe(reworded);
    // A reworded span selects text over the changed lines; a span outside them keeps its exact place and text.
    const overlaps = changed.some(index => index >= span.startLine - 1 && index <= span.endLine - 1);
    if (reworded) expect(overlaps).toBe(true);
    if (!overlaps) expect([span.startLine, span.endLine, span.startByte, span.endByte]).toEqual([span.previousStartLine, span.previousEndLine, span.previousStartByte, span.previousEndByte]);
  }
  expect(purpose.spanPreservation.changedSpans).toEqual(["orchestrator:applicability[2]", "orchestrator:applicability[3]", "orchestrator:applicability[4]",
    "orchestrator:applicability[5]", "orchestrator:applicability[6]", "orchestrator:applicability[7]", "orchestrator:applicability[8]",
    "orchestrator:exclusions[5]", "orchestrator:exclusions[6]", "orchestrator:exclusions[7]"]);
});
it("chains the intake move after the purpose-check source, moving the intake block unchanged into references/intake.md", async () => {
  expect(hash(moveBytes)).toBe("sha256:cb81c00e4e854e20c1ea58d561c205cafeba7665d66692f8520ab563066fae88");
  expect(moveBytes.includes(Buffer.from("\r\n"))).toBe(false);
  expect(move.revision).toBe("intake-reference-move-source-binding-r25");
  expect(move.role).toBe("source-binding-only-not-evaluation-or-install-authority");
  expect(move.sourceBaseRevision).toBe("bdcb07922ffab9b40a166a6c15ef42db184fbe5f");
  expect(move.frozenPredecessor).toEqual({path: "tests/skill-classification/fixtures.intake-purpose-check-source-successor.json",
    bytes: purposeBytes.length, digest: hash(purposeBytes)});
  expect(move.fixtureFileRewritten).toBe(false);
  expect(move.labelChanges).toEqual([]);
  expect(move.priceAndBudgetChanges).toEqual([]);
  expect(move.modelBehavior).toBe("NOT_RUN");
  expect(currentSourceBinding.manifest).toMatchObject({revision: neutral.revision});
  expect(move.bindings.map((binding: LaterBinding) => binding.path)).toEqual(["skills/orchestrator/SKILL.md", "skills/orchestrator/classification.json"]);
  const base = (relativePath: string) => sourceAt(move.sourceBaseRevision, relativePath,
    move.bindings.find((binding: LaterBinding) => binding.path === relativePath).previousDigest);
  for (const binding of move.bindings as (LaterBinding & {bytes: number})[]) {
    expect(latestDigest(binding.path, null, [purpose])).toBe(binding.previousDigest);
    base(binding.path);
    const actual = moveSource(binding.path);
    expect([actual.length, hash(actual)]).toEqual([binding.bytes, binding.digest]);
    const latest = latestDigest(binding.path, binding.digest, [blocked, neutral]);
    expect(currentSourceBinding.resolveDigest(binding.path, binding.previousDigest)).toBe(latest);
    if (latest !== binding.digest) expect(currentSourceBinding.resolveDigest(binding.path, binding.digest!)).toBe(latest);
    else expect(() => currentSourceBinding.resolveDigest(binding.path, binding.digest!)).toThrow("SOURCE_BINDING_PREDECESSOR_MISMATCH");
  }
  // The block (both markers included) moves byte for byte; SKILL.md keeps one pointer line in its place.
  const previousLines = base("skills/orchestrator/SKILL.md").toString("utf8").split("\n");
  const lines = moveSource("skills/orchestrator/SKILL.md").toString("utf8").split("\n");
  const start = previousLines.indexOf("<!-- skill-intake:start -->"), end = previousLines.indexOf("<!-- skill-intake:end -->");
  expect([start, end]).toEqual([14, 30]);
  const intakeSource = moveSource("skills/orchestrator/references/intake.md").toString("utf8");
  expect(intakeSource).toBe(`${previousLines.slice(start, end + 1).join("\n")}\n`);
  expect(lines).toEqual([...previousLines.slice(0, start), lines[start], ...previousLines.slice(end + 1)]);
  expect(lines[start]).toMatch(/^[^\n]*MCP 서버 instructions[^\n]*\]\(references\/intake\.md\)[^\n]*다\.$/u);
  expect(lines.join("\n")).not.toContain("<!-- skill-intake:");
  const inventory = await loadSkillInventory({root});
  expect(inventory.issues).toEqual([]);
  const orchestrator = inventory.skills.find(skill => skill.skillId === "orchestrator")!;
  const before = JSON.parse(base("skills/orchestrator/classification.json").toString("utf8"));
  const after = JSON.parse(moveSource("skills/orchestrator/classification.json").toString("utf8"));
  const stableFields = (value: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(value).filter(([key]) => !["applicability", "exclusions"].includes(key)));
  expect(stableFields(after)).toEqual(stableFields(before));
  for (const group of ["applicability", "exclusions"]) expect(after[group]).toHaveLength(before[group].length);
  expect(move.spanPreservation.spans).toHaveLength(after.applicability.length + after.exclusions.length);
  for (const span of move.spanPreservation.spans) {
    const current = after[span.group][span.index], previous = before[span.group][span.index];
    const previousPath = span.previousPath ?? span.path;
    expect([current.path, current.startLine, current.endLine, current.startByte ?? 0, current.endByte]).toEqual([span.path, span.startLine, span.endLine, span.startByte, span.endByte]);
    expect([previous.path, previous.startLine, previous.endLine, previous.startByte ?? 0, previous.endByte]).toEqual([previousPath, span.previousStartLine, span.previousEndLine, span.previousStartByte, span.previousEndByte]);
    const selected = selectedSource(moveSource(current.path), current);
    expect([selected.length, hash(selected)]).toEqual([span.bytes, span.digest]);
    // A span the intake blocked-step successor changed is checked against the current inventory in that successor's test.
    if (!blockedChanged(span.skillId, span.group, span.index)) expect(orchestrator[span.group as "applicability" | "exclusions"]).toContain(selected.toString("utf8").trim());
    const previousSelected = selectedSource(sourceAt(move.sourceBaseRevision, previous.path, previous.digest), previous);
    const inBlock = previous.startLine - 1 >= start && previous.endLine - 1 <= end;
    expect(moveChanged(span.skillId, span.group, span.index)).toBe(inBlock || !selected.equals(previousSelected) || previousPath !== span.path);
    if (inBlock) {
      // A span inside the block selects the same bytes at the same offsets, shifted to the block's lines in intake.md.
      expect(span.path).toBe("skills/orchestrator/references/intake.md");
      expect([span.startLine, span.endLine, span.startByte, span.endByte]).toEqual([span.previousStartLine - start, span.previousEndLine - start, span.previousStartByte, span.previousEndByte]);
      expect(selected.equals(previousSelected)).toBe(true);
    } else if (previous.startLine - 1 === end) {
      // The one span that began at the end marker now selects only the paragraph after it.
      expect(span.path).toBe("skills/orchestrator/SKILL.md");
      expect(previousSelected.toString("utf8").replace(/^<!-- skill-intake:end -->\n\n/u, "")).toBe(selected.toString("utf8"));
    } else if (previous.startLine - 1 < start && previous.endLine - 1 < start) {
      expect([span.path, span.startLine, span.endLine, span.startByte, span.endByte]).toEqual([previousPath, span.previousStartLine, span.previousEndLine, span.previousStartByte, span.previousEndByte]);
      expect(selected.equals(previousSelected)).toBe(true);
    }
  }
  expect(move.spanPreservation.changedSpans.filter((id: string) => {
    const match = /^orchestrator:(applicability|exclusions)\[(\d+)\]$/u.exec(id)!;
    const current = after[match[1]!][Number(match[2])], previous = before[match[1]!][Number(match[2])];
    return !selectedSource(moveSource(current.path), current)
      .equals(selectedSource(sourceAt(move.sourceBaseRevision, previous.path, previous.digest), previous));
  })).toEqual(["orchestrator:applicability[9]"]);
});
it("chains the intake blocked-step rule after the intake move, rewording only intake lines and moving none", async () => {
  // AGS3-D-0031 (formerly D-0034): one rule holds only a blocked step and the steps that depend on it and keeps the rest of the work
  // going; the three narrower continue-the-independent-work sentences (lines 6, 12 and 16) merge into it.
  expect(hash(blockedBytes)).toBe("sha256:68ce214f41600ba36422f9549d9004c727c103a0c35374f43181ce683bdff199");
  expect(blockedBytes.includes(Buffer.from("\r\n"))).toBe(false);
  expect(blocked.revision).toBe("intake-blocked-step-source-binding-r26");
  expect(blocked.role).toBe("source-binding-only-not-evaluation-or-install-authority");
  expect(blocked.sourceBaseRevision).toBe("86933a331d9356c3197708833da46b66b04aabdc");
  expect(blocked.frozenPredecessor).toEqual({path: "tests/skill-classification/fixtures.intake-reference-move-source-successor.json",
    bytes: moveBytes.length, digest: hash(moveBytes)});
  expect(blocked.fixtureFileRewritten).toBe(false);
  expect(blocked.labelChanges).toEqual([]);
  expect(blocked.priceAndBudgetChanges).toEqual([]);
  expect(blocked.modelBehavior).toBe("NOT_RUN");
  expect(currentSourceBinding.manifest).toMatchObject({revision: neutral.revision});
  const intake = "skills/orchestrator/references/intake.md", descriptor = "skills/orchestrator/classification.json";
  expect(blocked.bindings.map((binding: LaterBinding) => binding.path)).toEqual([descriptor, intake]);
  const base = (relativePath: string) => sourceAt(blocked.sourceBaseRevision, relativePath,
    blocked.bindings.find((binding: LaterBinding) => binding.path === relativePath).previousDigest);
  // The descriptor's predecessor is what the move successor bound; the intake's is the digest every intake span of
  // that descriptor names (the move added the file without a binding of its own).
  expect(blocked.bindings[0].previousDigest).toBe(latestDigest(descriptor, null, [move]));
  const before = JSON.parse(base(descriptor).toString("utf8"));
  const intakeDigests = new Set(["applicability", "exclusions"].flatMap(group => (before[group] as {path: string; digest: string}[])
    .filter(span => span.path === intake).map(span => span.digest)));
  expect(intakeDigests).toEqual(new Set([blocked.bindings[1].previousDigest]));
  for (const binding of blocked.bindings as (LaterBinding & {bytes: number})[]) {
    base(binding.path);
    const actual = readFileSync(path.join(root, binding.path));
    expect([actual.length, hash(actual)]).toEqual([binding.bytes, binding.digest]);
    expect(currentSourceBinding.resolveDigest(binding.path, binding.previousDigest)).toBe(binding.digest);
    expect(() => currentSourceBinding.resolveDigest(binding.path, binding.digest!)).toThrow("SOURCE_BINDING_PREDECESSOR_MISMATCH");
  }
  // Only the three lines that carried a continue-the-independent-work sentence change, inside the block; none moves.
  const previousLines = base(intake).toString("utf8").split("\n");
  const lines = readFileSync(path.join(root, intake), "utf8").split("\n");
  expect(lines.length).toBe(previousLines.length);
  const start = previousLines.indexOf("<!-- skill-intake:start -->"), end = previousLines.indexOf("<!-- skill-intake:end -->");
  expect([lines.indexOf("<!-- skill-intake:start -->"), lines.indexOf("<!-- skill-intake:end -->")]).toEqual([start, end]);
  const changed = lines.flatMap((line, index) => line === previousLines[index] ? [] : [index]);
  expect(changed.map(index => index + 1)).toEqual([6, 12, 16]);
  const inventory = await loadSkillInventory({root});
  expect(inventory.issues).toEqual([]);
  const orchestrator = inventory.skills.find(skill => skill.skillId === "orchestrator")!;
  const after = JSON.parse(readFileSync(path.join(root, descriptor), "utf8"));
  const stableFields = (value: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(value).filter(([key]) => !["applicability", "exclusions"].includes(key)));
  expect(stableFields(after)).toEqual(stableFields(before));
  for (const group of ["applicability", "exclusions"]) expect(after[group]).toHaveLength(before[group].length);
  expect(blocked.spanPreservation.spans).toHaveLength(after.applicability.length + after.exclusions.length);
  for (const span of blocked.spanPreservation.spans) {
    const current = after[span.group][span.index], previous = before[span.group][span.index];
    expect([current.path, current.startLine, current.endLine, current.startByte ?? 0, current.endByte]).toEqual([span.path, span.startLine, span.endLine, span.startByte, span.endByte]);
    expect([previous.path, previous.startLine, previous.endLine, previous.startByte ?? 0, previous.endByte]).toEqual([span.path, span.previousStartLine, span.previousEndLine, span.previousStartByte, span.previousEndByte]);
    const selected = selectedSource(readFileSync(path.join(root, current.path)), current);
    expect([selected.length, hash(selected)]).toEqual([span.bytes, span.digest]);
    expect(orchestrator[span.group as "applicability" | "exclusions"]).toContain(selected.toString("utf8").trim());
    const previousSelected = selectedSource(sourceAt(blocked.sourceBaseRevision, previous.path, previous.digest), previous);
    const reworded = !selected.equals(previousSelected);
    expect(blockedChanged(span.skillId, span.group, span.index)).toBe(reworded);
    // A reworded span covers a changed line; a span on no changed line keeps its exact place and text.
    const overlaps = span.path === intake && changed.some(index => index >= span.startLine - 1 && index <= span.endLine - 1);
    if (reworded) expect(overlaps).toBe(true);
    if (!overlaps) expect([span.startLine, span.endLine, span.startByte, span.endByte]).toEqual([span.previousStartLine, span.previousEndLine, span.previousStartByte, span.previousEndByte]);
  }
  expect(blocked.spanPreservation.changedSpans).toEqual(["orchestrator:applicability[4]", "orchestrator:applicability[5]"]);
});
it("chains the field-neutral wording source after the intake blocked-step rule, rewording lines of nine general skills and moving none", async () => {
  // AGS3-D-0038: general skills drop words that tied them to code work or name such work as one example; no line moves.
  expect(hash(neutralBytes)).toBe("sha256:73c25ae3bb66f423f3da6b64c4432aa83f4da1f41e155e2fb9bb37a3cc7713f6");
  expect(neutralBytes.includes(Buffer.from("\r\n"))).toBe(false);
  expect(neutral.revision).toBe("field-neutral-wording-source-binding-r27");
  expect(neutral.role).toBe("source-binding-only-not-evaluation-or-install-authority");
  expect(neutral.sourceBaseRevision).toBe("6ce31f6773d9617c321ba28972532578d1329ede");
  expect(neutral.frozenPredecessor).toEqual({path: "tests/skill-classification/fixtures.intake-blocked-step-source-successor.json",
    bytes: blockedBytes.length, digest: hash(blockedBytes)});
  expect(neutral.fixtureFileRewritten).toBe(false);
  expect(neutral.labelChanges).toEqual([]);
  expect(neutral.priceAndBudgetChanges).toEqual([]);
  expect(neutral.modelBehavior).toBe("NOT_RUN");
  expect(currentSourceBinding.manifest).toMatchObject({revision: neutral.revision});
  const skillIds = ["acceptance-evidence-validator", "blocker-diagnostician", "coordinate-subagents", "independent-audit-gate",
    "iteration-frame-auditor", "mutation-risk-preflight", "prompt-engineering", "session-board", "task-contract"];
  expect(neutral.bindings.map((binding: LaterBinding) => binding.path))
    .toEqual(skillIds.flatMap(skillId => [`skills/${skillId}/classification.json`, `skills/${skillId}/SKILL.md`]));
  const base = (relativePath: string) => sourceAt(neutral.sourceBaseRevision, relativePath,
    neutral.bindings.find((binding: LaterBinding) => binding.path === relativePath).previousDigest);
  for (const binding of neutral.bindings as (LaterBinding & {bytes: number})[]) {
    // The predecessor is what the earlier successors bound last, read at this successor's base.
    expect(latestDigest(binding.path, null, [specialist, multi, overwrite, premise, retire, role, purpose, move, blocked])).toBe(binding.previousDigest);
    base(binding.path);
    const actual = readFileSync(path.join(root, binding.path));
    expect([actual.length, hash(actual)]).toEqual([binding.bytes, binding.digest]);
    expect(currentSourceBinding.resolveDigest(binding.path, binding.previousDigest)).toBe(binding.digest);
    expect(() => currentSourceBinding.resolveDigest(binding.path, binding.digest!)).toThrow("SOURCE_BINDING_PREDECESSOR_MISMATCH");
  }
  const inventory = await loadSkillInventory({root});
  expect(inventory.issues).toEqual([]);
  const skills = new Map(inventory.skills.map(skill => [skill.skillId, skill]));
  const stableFields = (value: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(value).filter(([key]) => !["applicability", "exclusions"].includes(key)));
  const changedLines = new Map<string, number[]>();
  let spanCount = 0;
  for (const skillId of skillIds) {
    const entry = `skills/${skillId}/SKILL.md`;
    const previousLines = base(entry).toString("utf8").split("\n"), lines = readFileSync(path.join(root, entry), "utf8").split("\n");
    // Words change inside lines; no line is added, removed or moved.
    expect(lines.length).toBe(previousLines.length);
    const changed = lines.flatMap((line, index) => line === previousLines[index] ? [] : [index]);
    expect(changed.length).toBeGreaterThan(0);
    changedLines.set(entry, changed);
    const descriptor = `skills/${skillId}/classification.json`;
    const before = JSON.parse(base(descriptor).toString("utf8")), after = JSON.parse(readFileSync(path.join(root, descriptor), "utf8"));
    expect(stableFields(after)).toEqual(stableFields(before));
    for (const group of ["applicability", "exclusions"]) expect(after[group]).toHaveLength(before[group].length);
    spanCount += after.applicability.length + after.exclusions.length;
  }
  expect(neutral.spanPreservation.spans).toHaveLength(spanCount);
  for (const span of neutral.spanPreservation.spans) {
    const descriptor = `skills/${span.skillId}/classification.json`;
    const current = JSON.parse(readFileSync(path.join(root, descriptor), "utf8"))[span.group][span.index];
    const previous = JSON.parse(base(descriptor).toString("utf8"))[span.group][span.index];
    expect([current.path, current.startLine, current.endLine, current.startByte ?? 0, current.endByte]).toEqual([span.path, span.startLine, span.endLine, span.startByte, span.endByte]);
    expect([previous.path, previous.startLine, previous.endLine, previous.startByte ?? 0, previous.endByte]).toEqual([span.path, span.previousStartLine, span.previousEndLine, span.previousStartByte, span.previousEndByte]);
    expect([span.startLine, span.endLine]).toEqual([span.previousStartLine, span.previousEndLine]);
    const selected = selectedSource(readFileSync(path.join(root, current.path)), current);
    expect([selected.length, hash(selected)]).toEqual([span.bytes, span.digest]);
    expect(skills.get(span.skillId)![span.group as "applicability" | "exclusions"]).toContain(selected.toString("utf8").trim());
    const previousSelected = selectedSource(sourceAt(neutral.sourceBaseRevision, previous.path, previous.digest), previous);
    const reworded = !selected.equals(previousSelected);
    expect(neutralChanged(span.skillId, span.group, span.index)).toBe(reworded);
    // A reworded span covers a changed line.
    if (reworded) expect((changedLines.get(span.path) ?? []).some(index => index >= span.startLine - 1 && index <= span.endLine - 1)).toBe(true);
  }
  expect(neutral.spanPreservation.changedSpans).toEqual(["acceptance-evidence-validator:applicability[0]", "acceptance-evidence-validator:applicability[2]",
    "blocker-diagnostician:applicability[1]", "coordinate-subagents:applicability[2]", "independent-audit-gate:applicability[0]",
    "independent-audit-gate:applicability[1]", "independent-audit-gate:exclusions[1]", "iteration-frame-auditor:exclusions[1]",
    "mutation-risk-preflight:applicability[2]", "prompt-engineering:applicability[0]", "session-board:applicability[0]",
    "session-board:applicability[2]", "task-contract:exclusions[1]"]);
});
it("appends the exact specialist behavior successor without changing frozen fixture semantics", () => {
  expect(specialistBytes.length).toBe(270309);
  expect(hash(specialistBytes)).toBe("sha256:2870d4bc84873ae1e9bc84d85607e932350dec9fbfe70a8253c44c036c4ab34a");
  expect(specialistBytes.includes(Buffer.from("\r\n"))).toBe(false);
  expect(specialist.revision).toBe("specialist-behavior-source-binding-r18");
  expect(specialist.sourceBaseRevision).toBe("480b8dfc143d15c7fb9fdab349d698d75f009893");
  expect(specialist.role).toBe("source-binding-only-not-evaluation-or-install-authority");
  expect(specialist.frozenPredecessor).toEqual({
    path: "tests/skill-classification/fixtures.orchestrator-workflow-enforcement-source-successor.json",
    bytes: 7507,
    digest: "sha256:afaea7927b706378254cefc0a3c5b4068c1a98ae68c492972e856dd294c51a75",
  });
  expect(hash(readFileSync(path.join(root, specialist.frozenPredecessor.path)))).toBe(specialist.frozenPredecessor.digest);
  expect(specialist.fixtureFileRewritten).toBe(false);
  expect(specialist.labelChanges).toEqual([]);
  expect(specialist.priceAndBudgetChanges).toEqual([]);
  expect(specialist.modelBehavior).toBe("NOT_RUN");
  expect(specialist.bindings).toHaveLength(58);
  expect(new Set(specialist.bindings.map((binding: {path: string}) => binding.path)).size).toBe(58);
  for (const binding of specialist.bindings) {
    expect(hash(mainSource(binding.path))).toBe(binding.previousDigest);
    const actual = specialistSource(binding.path);
    expect(actual.length).toBe(binding.bytes);
    expect(hash(actual)).toBe(binding.digest);
    const later = reboundAfterSpecialist.get(binding.path);
    expect(currentSourceBinding.resolveDigest(binding.path, binding.previousDigest)).toBe(later ? later.digest : binding.digest);
    if (later) expect(currentSourceBinding.resolveDigest(binding.path, binding.digest)).toBe(later.digest);
    else expect(() => currentSourceBinding.resolveDigest(binding.path, binding.digest)).toThrow("SOURCE_BINDING_PREDECESSOR_MISMATCH");
    expect(() => currentSourceBinding.resolveDigest(binding.path, "sha256:" + "0".repeat(64))).toThrow("SOURCE_BINDING_PREDECESSOR_MISMATCH");
  }
});
it("rebinds all 215 spans from pinned main to valid current UTF-8 evidence and the real inventory", async () => {
  const liveDescriptorPaths = readdirSync(path.join(root, "skills"), {withFileTypes: true})
    .filter(entry => entry.isDirectory()).map(entry => `skills/${entry.name}/classification.json`).sort();
  const retiredIds: string[] = retire.retiredSkills.map((row: {skillId: string}) => row.skillId);
  for (const skillId of retiredIds) expect(liveDescriptorPaths).not.toContain(`skills/${skillId}/classification.json`);
  // UI/UX was added after this frozen snapshot. Check its live classification in
  // ui-ux-design-registry-compatibility.test.mjs; keep all 26 historical pins intact.
  // The current inventory comparison below still includes the new skill.
  const descriptorPaths = [...liveDescriptorPaths.filter(file => file !== "skills/ui-ux-design/classification.json"),
    ...retiredIds.map(skillId => `skills/${skillId}/classification.json`)].sort();
  expect(specialist.sourceInventory.skillCount).toBe(26);
  expect(specialist.sourceInventory.referenceCount).toBe(215);
  expect(specialist.sourceInventory.descriptorFiles.map((pin: SourcePin) => pin.path)).toEqual(descriptorPaths);
  expect(specialist.sourceInventory.sourceFiles).toHaveLength(37);
  const spans: ReboundSpan[] = specialist.spanPreservation.spans;
  expect(spans).toHaveLength(215);
  expect(new Set(spans.map(span => `${span.skillId}:${span.group}[${span.index}]`)).size).toBe(215);
  const inventory = await loadSkillInventory({root});
  expect(inventory.issues).toEqual([]);
  expect(inventory.skills.map(skill => skill.skillId).sort()).toEqual(liveDescriptorPaths.map(file => file.split("/")[1]));
  const skills = new Map(inventory.skills.map(skill => [skill.skillId, skill]));
  let references = 0;
  for (const descriptorPath of descriptorPaths) {
    const before = JSON.parse(mainSource(descriptorPath).toString("utf8"));
    const after = JSON.parse(specialistSource(descriptorPath).toString("utf8"));
    const stableFields = (value: Record<string, unknown>) => Object.fromEntries(Object.entries(value).filter(([key]) => !["applicability", "exclusions"].includes(key)));
    expect(stableFields(after)).toEqual(stableFields(before));
    for (const group of ["applicability", "exclusions"]) {
      expect(after[group]).toHaveLength(before[group].length);
      references += after[group].length;
    }
  }
  expect(references).toBe(215);
  for (const span of spans) {
    const descriptorPath = `skills/${span.skillId}/classification.json`;
    const before = JSON.parse(mainSource(descriptorPath).toString("utf8"));
    const after = JSON.parse(specialistSource(descriptorPath).toString("utf8"));
    expect(before[span.group][span.index]).toEqual(sourceRef(span.previous));
    expect(after[span.group][span.index]).toEqual(sourceRef(span.current));
    const previousSelected = selectedSource(mainSource(span.previous.path), span.previous);
    expect(previousSelected.length).toBe(span.previous.selectedBytes);
    expect(hash(previousSelected)).toBe(span.previous.selectedDigest);
    const selected = selectedSource(specialistSource(span.current.path), span.current);
    expect(selected.length).toBe(span.current.selectedBytes);
    expect(hash(selected)).toBe(span.current.selectedDigest);
    expect(selected.toString("utf8")).toMatch(/[\p{L}\p{N}]/u);
    // A source a later successor rebound is checked against the current inventory in that successor's test.
    if (!reboundAfterSpecialist.has(span.current.path)) expect(skills.get(span.skillId)![span.group]).toContain(selected.toString("utf8").trim());
    if (span.change === "exact-excerpt") expect(selected.equals(previousSelected)).toBe(true);
  }
  expect(specialist.spanPreservation.changedSpans).toEqual(spans.filter(span => span.change !== "exact-excerpt").map(span => `${span.skillId}:${span.group}[${span.index}]`));
});
it("replaces both historical quote-only applicability spans with actual activation evidence", () => {
  const expected = new Map([
    ["code-review", "변경분 리뷰가 요청되면 사용한다."],
    ["test-engineering", "테스트 설계·구현·회귀 보호가 요청되면 사용한다."],
  ]);
  const repaired: ReboundSpan[] = specialist.spanPreservation.spans.filter((span: ReboundSpan) => span.change === "replace-punctuation-with-applicability");
  expect(repaired.map(span => span.skillId)).toEqual([...expected.keys()]);
  for (const span of repaired) {
    expect(selectedSource(mainSource(span.previous.path), span.previous).toString("utf8")).toBe('"');
    expect(selectedSource(readFileSync(path.join(root, span.current.path)), span.current).toString("utf8")).toBe(expected.get(span.skillId));
    expect(span.group).toBe("applicability");
    expect(span.index).toBe(1);
  }
});
it("chains the exact orchestrator workflow-enforcement source after phase-check", () => {
  const bytes = readFileSync(new URL("./fixtures.orchestrator-workflow-enforcement-source-successor.json", import.meta.url));
  expect(hash(bytes)).toBe("sha256:afaea7927b706378254cefc0a3c5b4068c1a98ae68c492972e856dd294c51a75");
  expect(bytes.includes(Buffer.from("\r\n"))).toBe(false);
  const manifest = JSON.parse(bytes.toString("utf8"));
  expect(manifest.frozenPredecessor).toEqual({path: "tests/skill-classification/fixtures.orchestrator-phase-check-source-successor.json", bytes: readFileSync(path.join(root, "tests/skill-classification/fixtures.orchestrator-phase-check-source-successor.json")).length, digest: "sha256:7eb7d5b4a67b7afc3a48f3e7dd76fdab8f208fc65597e92535400df8f7627429"});
  expect(manifest.bindings.map((binding: {path: string}) => binding.path)).toEqual(["skills/orchestrator/SKILL.md", "skills/orchestrator/classification.json"]);
  expect(manifest.spanPreservation.changedSpans).toEqual(["applicability[5]", "exclusions[4]"]);
  expect(manifest.fixtureFileRewritten).toBe(false);
  expect(manifest.labelChanges).toEqual([]);
  expect(manifest.priceAndBudgetChanges).toEqual([]);
  for (const binding of manifest.bindings) {
    const actual = readFileSync(path.join(root, binding.path));
    const historical = mainSource(binding.path);
    expect(historical.length).toBe(binding.bytes);
    expect(hash(historical)).toBe(binding.digest);
    expect(currentSourceBinding.resolveDigest(binding.path, binding.previousDigest)).toBe(hash(actual));
    expect(currentSourceBinding.resolveDigest(binding.path, binding.digest)).toBe(hash(actual));
  }
});
it("chains the exact orchestrator phase-check source after platform-events", () => {
  const bytes = readFileSync(new URL("./fixtures.orchestrator-phase-check-source-successor.json", import.meta.url));
  expect(hash(bytes)).toBe("sha256:7eb7d5b4a67b7afc3a48f3e7dd76fdab8f208fc65597e92535400df8f7627429");
  expect(bytes.includes(Buffer.from("\r\n"))).toBe(false);
  const manifest = JSON.parse(bytes.toString("utf8"));
  expect(manifest.frozenPredecessor).toEqual({path: "tests/skill-classification/fixtures.preflight-platform-events-source-successor.json", bytes: readFileSync(path.join(root, "tests/skill-classification/fixtures.preflight-platform-events-source-successor.json")).length, digest: "sha256:0d9584c9607e98b953470bd20c7cfbfda82cf5558906368296eba87d68768a03"});
  expect(manifest.bindings.map((binding: {path: string}) => binding.path)).toEqual(["skills/orchestrator/SKILL.md", "skills/orchestrator/classification.json"]);
  expect(manifest.spanPreservation.changedSpans).toEqual(["applicability[5]", "applicability[7]", "exclusions[6]"]);
  expect(manifest.fixtureFileRewritten).toBe(false);
  expect(manifest.labelChanges).toEqual([]);
  expect(manifest.priceAndBudgetChanges).toEqual([]);
  for (const binding of manifest.bindings) {
    const actual = readFileSync(path.join(root, binding.path));
    expect(hash(actual)).toBe(currentSourceBinding.resolveDigest(binding.path, binding.previousDigest));
  }
});
it("chains the exact platform-events source without rewriting earlier oracles", () => {
  const bytes = readFileSync(new URL("./fixtures.preflight-platform-events-source-successor.json", import.meta.url));
  expect(hash(bytes)).toBe("sha256:0d9584c9607e98b953470bd20c7cfbfda82cf5558906368296eba87d68768a03");
  expect(bytes.includes(Buffer.from("\r\n"))).toBe(false);
  const manifest = JSON.parse(bytes.toString("utf8"));
  expect(manifest.frozenPredecessor).toEqual({path: "tests/skill-classification/fixtures.preflight-private-preparation-source-successor.json", bytes: 905, digest: "sha256:fb58272e0f10de935dcfffcb9590ad5012d4065ae16f81d25be1059eed73f5fe"});
  expect(hash(readFileSync(path.join(root, manifest.frozenPredecessor.path)))).toBe(manifest.frozenPredecessor.digest);
  expect(manifest.bindings).toHaveLength(2);
  expect(manifest.fixtureFileRewritten).toBe(false);
  expect(manifest.labelChanges).toEqual([]);
  expect(manifest.priceAndBudgetChanges).toEqual([]);
  for (const binding of manifest.bindings) {
    const actual = readFileSync(path.join(root, binding.path));
    const historical = mainSource(binding.path);
    expect(historical.length).toBe(binding.bytes);
    expect(hash(historical)).toBe(binding.digest);
    expect(currentSourceBinding.resolveDigest(binding.path, binding.previousDigest)).toBe(hash(actual));
    expect(currentSourceBinding.resolveDigest(binding.path, binding.digest)).toBe(hash(actual));
    expect(() => currentSourceBinding.resolveDigest(binding.path, "sha256:" + "0".repeat(64))).toThrow("SOURCE_BINDING_PREDECESSOR_MISMATCH");
  }
});
it("adds only the exact preflight 1.0.2 source while retaining the frozen oracle", () => {
  const bytes = readFileSync(new URL("./fixtures.preflight-private-preparation-source-successor.json", import.meta.url));
  expect(hash(bytes)).toBe("sha256:fb58272e0f10de935dcfffcb9590ad5012d4065ae16f81d25be1059eed73f5fe");
  const committed = execFileSync("git", ["show", "HEAD:tests/skill-classification/fixtures.preflight-private-preparation-source-successor.json"], {cwd: root});
  expect(bytes.equals(committed)).toBe(true);
  expect(hash(committed)).toBe("sha256:fb58272e0f10de935dcfffcb9590ad5012d4065ae16f81d25be1059eed73f5fe");
  const manifest = JSON.parse(bytes.toString("utf8"));
  expect(manifest.frozenPredecessor).toEqual({
    path: "tests/skill-classification/fixtures.continuity-handoff-source-successor.json",
    bytes: 1445,
    digest: "sha256:26887410dff5a98284a90898a76dd6b9cc5e6ea53bc209261180f3d609d39e57",
  });
  expect(hash(readFileSync(path.join(root, manifest.frozenPredecessor.path)))).toBe(manifest.frozenPredecessor.digest);
  expect(manifest.fixtureFileRewritten).toBe(false);
  expect(manifest.labelChanges).toEqual([]);
  expect(manifest.priceAndBudgetChanges).toEqual([]);
  expect(manifest.modelBehavior).toBe("NOT_RUN");
  expect(manifest.bindings).toEqual([{
    path: "skills/mutation-risk-preflight/SKILL.md",
    previousDigest: "sha256:9aa4e7cb143bb0ad9ffc5f6c03ed32331e1f14562cd4322fab0e36cd29c21ce1",
    digest: "sha256:25fbe08cc026df65c7e5788a7c9ad4414a7b5be52f55a587952773966eb29ecb",
    bytes: 3347,
  }]);
  const binding = manifest.bindings[0];
  const currentDigest = currentSourceBinding.manifest.bindings.find(row => row.path === binding.path)!.digest;
  expect(currentSourceBinding.resolveDigest(binding.path, binding.previousDigest)).toBe(currentDigest);
  expect(currentSourceBinding.resolveDigest(binding.path, binding.digest)).toBe(currentDigest);
  expect(hash(readFileSync(path.join(root, binding.path)))).toBe(currentDigest);
  expect(current.sourceSkills.filter((source: {path: string; digest: string}) => source.path === binding.path && source.digest === binding.previousDigest)).toHaveLength(manifest.fixtureReferences);
  expect(manifest.fixtureReferences).toBe(1);
});
it("동결 판정 기준을 보존하고 인계 지침의 현재 바이트만 결속한다", () => {
  const bytes = readFileSync(new URL("./fixtures.continuity-handoff-source-successor.json", import.meta.url));
  expect(hash(bytes)).toBe("sha256:26887410dff5a98284a90898a76dd6b9cc5e6ea53bc209261180f3d609d39e57");
  const manifest = JSON.parse(bytes.toString("utf8"));
  expect(manifest.fixtureFileRewritten).toBe(false);
  expect(manifest.labelChanges).toEqual([]);
  expect(manifest.priceAndBudgetChanges).toEqual([]);
  expect(manifest.modelBehavior).toBe("NOT_RUN");
  expect(currentSourceBinding.manifest).toMatchObject({revision: "field-neutral-wording-source-binding-r27"});
  expect(hash(readFileSync(path.join(root, manifest.frozenPredecessor.path)))).toBe(manifest.frozenPredecessor.digest);
  for (const source of manifest.bindings) {
    const historical = mainSource(source.path);
    expect(historical.length).toBe(source.bytes);
    expect(hash(historical)).toBe(source.digest);
    // The handoff bytes chain on through specialist behavior to the retirement: the source is gone.
    expect(latestDigest(source.path, source.digest, [specialist, retire])).toBeNull();
    expect(existsSync(path.join(root, source.path))).toBe(false);
    expect(currentSourceBinding.resolveDigest(source.path, source.previousDigest)).toBeNull();
    expect(() => currentSourceBinding.resolveDigest(source.path, "sha256:" + "0".repeat(64))).toThrow("SOURCE_BINDING_PREDECESSOR_MISMATCH");
  }
});
// Explicit authoring pins from exact predecessor Git bytes; tests never regenerate expected values.
const predecessor = {
  path: "tests/skill-classification/fixtures.json",
  gitBlob: "f7aedbf77d1547cb49f75ea391c152b3a6172c71",
  bytes: 142465,
  digest: "sha256:7a69d6681e02aa1ce4925e0b3b3eb421cde064dd5a578d16af190e07db24f57b",
  fixtureRevision: "ags-classification-host-source-binding-r04",
  oracleRevision: "pre-live-host-source-reviewed-r04",
  oracleDigest: "sha256:92b7f4d74d88ae5ebae6de59891e7050bec6dacda92ab02e209216bb26d66ee8"
};
const r06SidecarDigest = "sha256:ea2f56ae4bda02a8d96277a482c948a773357007d1765e5fe1e4cf7fea943ada";
const r07SidecarDigest = "sha256:9ed472c1bbca0945b6133f8d1fe66e1aefe12b97b0c20b640ddeb58d1acfc624";
const historicalSidecarDigest = "sha256:28f4840754da38b16bcf8165186271c77b4a883dd8cafa8e97aa686d60d9a075";
const semanticDigest = "sha256:9b9fe0389d497d4b25eac1998cb091d269e7612a92e57912a2cdc8279d8d6542";
const bindings = [
  {skillId: "acceptance-evidence-validator", path: "skills/acceptance-evidence-validator/SKILL.md", previousDigest: "sha256:1ed22041c60ebbb2af76a6a90deca619301aa9d91cef72c3f6bba090e6e4d109", digest: "sha256:934cc5ef2e5d187c31e2eef086c61ff03b5e76cec50bf82be648eda87e228fda"},
  {skillId: "coordinate-subagents", path: "skills/coordinate-subagents/SKILL.md", previousDigest: "sha256:b8f988f615aa7a2c60abe5c8e1546d7bbf9ce5847ee67aa2be887db3b7d181e0", digest: "sha256:6ba85d995e098afe3cdeb8d20a0b130d383447a5ac6d1781c87e6b52461a7e2e"},
  {skillId: "cs-engineering", path: "skills/cs-engineering/SKILL.md", previousDigest: "sha256:aa5133cba109cb65e867f75e8a6d3a6602c49d72dd4fb5676cab3ddf0e2d0646", digest: "sha256:435939d54f74626d07cbfbedd87fcb1a8e13338bc6c0e46d5233d80a7733d681"},
  {skillId: "independent-audit-gate", path: "skills/independent-audit-gate/SKILL.md", previousDigest: "sha256:26086ee54f0d49b1bc861ec27200d26150737d9772773e07139ae59f56404e29", digest: "sha256:abb5d4c1fa0607851018cd6f6a2f3ecf314cc829149ea0d15c5474ed9afd2a18"},
  {skillId: "independent-deliberation-panel", path: "skills/independent-deliberation-panel/SKILL.md", previousDigest: "sha256:899e5af89ad4621107a33ba101cc63ad7ba6ad4d585438e8cb187c3bfe76c3ab", digest: "sha256:eb21677b0f377116250691a8cf84b44ec853c4de9c56e27ea17585016a151f54"},
  {skillId: "mutation-risk-preflight", path: "skills/mutation-risk-preflight/SKILL.md", previousDigest: "sha256:eb02732691b63ca085ff8bca59854a134a8711ac7788888f9f3c6e4324474cbe", digest: "sha256:9aa4e7cb143bb0ad9ffc5f6c03ed32331e1f14562cd4322fab0e36cd29c21ce1"},
  {skillId: "orchestrator", path: "skills/orchestrator/SKILL.md", previousDigest: "sha256:e5f2e1cf5bbfa49821a5aad81ad83b68cf5cae3ec75c92050a8a4cd13b56be45", digest: "sha256:5f2cf07a358914cd068a90cf6eb7fe3bbf549a7fc08e47dfc6daecefeabd44f4"},
  {skillId: "ponytail", path: "skills/ponytail/SKILL.md", previousDigest: "sha256:907667b8b625eab0438b462a4737a056e3833f972c66e432817a12e6f643ac76", digest: "sha256:2ce28db45c1a84e63fa2af7079e58a3803fc26b16ab7073436efd55b1e1214f9"},
  {skillId: "task-contract", path: "skills/task-contract/SKILL.md", previousDigest: "sha256:0482c8aa36c95ddd5b7d68aa5924840341a64bfb05c39c7dcb112c8df1fb4100", digest: "sha256:92cf19444e6c97b1d1d017f8eed481135d708095d89411668ab215123d1266aa"}
];
function semantics(value: unknown, depth = 0): unknown {
  if (Array.isArray(value)) return value.map(child => semantics(child, depth + 1));
  if (value && typeof value === "object") {
    const row = value as Record<string, unknown>;
    const bound = bindings.some(binding => binding.skillId === row.skillId && binding.path === row.path);
    return Object.fromEntries(Object.entries(row)
      .filter(([key]) => !(bound && key === "digest") && !(depth === 0 && ["fixtureRevision", "oracleRevision", "oracleDigest", "sourceBindingRevision"].includes(key)))
      .map(([key, child]) => [key, semantics(child, depth + 1)]));
  }
  return value;
}
it("preserves predecessor history and all frozen 39/18/21 semantics in a distinct source revision", () => {
  expect(successor.predecessor).toEqual({
    path: "tests/skill-classification/fixtures.json",
    gitRevision: "f555748df4f4d74f2cb5d34454c7b3494c161186",
    gitBlob: "b7d4d07d4ec603fad9d5052f7986f799316d6e9f",
    bytes: 142487,
    digest: "sha256:7ef33ec877a2496846a8d9333fb302eba73b467f7be99ccc7e6224026b864159",
    fixtureRevision: "ags-classification-resource-impact-source-binding-r07",
    oracleRevision: "pre-live-resource-impact-source-reviewed-r07",
    oracleDigest: "sha256:45e034a812726867412b6ea78261c0dd98232679b2f66f9c265c6122e28cce33",
  });
  expect(successor.historicalSuccessor.digest).toBe(r07SidecarDigest);
  expect(hash(JSON.stringify(successor.historicalSuccessor.document, null, 2) + "\n")).toBe(r07SidecarDigest);
  const r07 = successor.historicalSuccessor.document;
  expect(r07.successor.fixtureRevision).toBe("ags-classification-resource-impact-source-binding-r07");
  expect(r07.historicalSuccessor.digest).toBe(r06SidecarDigest);
  expect(hash(JSON.stringify(r07.historicalSuccessor.document, null, 2) + "\n")).toBe(r06SidecarDigest);
  const r06 = r07.historicalSuccessor.document;
  expect(r06.successor.fixtureRevision).toBe("ags-classification-midtask-source-binding-r06");
  expect(r06.historicalSuccessor.digest).toBe(historicalSidecarDigest);
  expect(hash(JSON.stringify(r06.historicalSuccessor.document, null, 2) + "\n")).toBe(historicalSidecarDigest);
  const original = r06.historicalSuccessor.document;
  expect(original.predecessor.gitBlob).toBe("af8424b81e3fbc495cbd5f628d3e3d2157e705a2");
  expect(original.predecessor.bytes).toBe(142477);
  expect(original.predecessor.digest).toBe("sha256:49d327a6dca9557312d90014410702f8466e839175b3187bc91693b6cccd4789");
  expect(original.predecessor.oracleDigest).toBe("sha256:96a7c48283c995dd79c662860b179298bd99d474c899d58820de17d7b8770239");
  expect(original.semanticProjection.digest).toBe("sha256:6700d30def96ecbc7869f52dd5ab05e417d3b6ef42dfa3e390361054ff8ad2aa");
  expect(original.historicalSuccessor.digest).toBe("sha256:69ef37b636e35bfdce77103cbe84015c0e2e9482a41e46059d89ac557a8717f7");
  expect(original.successor.fixtureRevision).toBe(predecessor.fixtureRevision);
  expect(original.successor.oracleDigest).toBe(predecessor.oracleDigest);
  expect(current.fixtureRevision).toBe("ags-classification-governance-behavior-source-binding-r09");
  expect(current.oracleRevision).toBe("pre-live-governance-behavior-source-reviewed-r09");
  expect(current.sourceBindingRevision).toBe("pre-live-source-binding-9");
  expect(current.fixtureRevision).toBe(successor.successor.fixtureRevision);
  expect(current.oracleRevision).toBe(successor.successor.oracleRevision);
  expect(successor.semanticProjection.digest).toBe(semanticDigest);
  expect(hash(JSON.stringify(semantics(current)))).toBe(semanticDigest);
  expect(current.cases).toHaveLength(39);
  expect(current.cases.filter((row: {oracle: unknown}) => row.oracle !== null)).toHaveLength(18);
  expect(current.cases.filter((row: {publicSynthetic: boolean; originalPrompt: unknown}) => row.publicSynthetic && typeof row.originalPrompt === "string" && row.originalPrompt.length > 0)).toHaveLength(21);
  expect(current.status).toBe("NOT_RUN");
  expect(successor.review.labelChanges).toEqual([]);
  expect(oracleDigest(current)).toBe(current.oracleDigest);
  expect(current.oracleDigest).toBe(successor.successor.oracleDigest);
  expect(current.oracleDigest).not.toBe(predecessor.oracleDigest);
  expect(successor.governanceBehaviorSourceSuccessor.sourceBaseRevision).toBe("f555748df4f4d74f2cb5d34454c7b3494c161186");
  expect(successor.governanceBehaviorSourceSuccessor.predecessor).toEqual(successor.predecessor);
  expect(successor.governanceBehaviorSourceSuccessor.sourceBindings).toEqual([
    {path: "skills/orchestrator/SKILL.md", previousDigest: "sha256:e5f2e1cf5bbfa49821a5aad81ad83b68cf5cae3ec75c92050a8a4cd13b56be45", digest: "sha256:082e2fe237d22455ccbcedb3f4b26dcaa0b1a78f5f552011e3ac36515d21653b", bytes: 9285},
    {path: "skills/orchestrator/classification.json", previousDigest: "sha256:6d33ef4bc3ae5daa8c15867f03dbdaf4c0cebf76fcfbd872ca1b8c3b6636baad", digest: "sha256:81ac5daaa54a6fc6947ba5e805bf7c1d3e4c061dd473be820f4a553a762dd577", bytes: 4577},
  ]);
  expect(successor.governanceBehaviorSourceSuccessor.reboundReferences).toBe(17);
  expect(successor.governanceBehaviorSourceSuccessor.labelChanges).toEqual([]);
  expect(successor.governanceBehaviorSourceSuccessor.modelBehavior).toBe("NOT_RUN");
  const r09 = successor.orchestratorInvocationSourceSuccessor;
  expect(r09.revision).toBe("orchestrator-invocation-source-binding-r09");
  expect(r09.sourceBaseRevision).toBe("9d393393e68c6ee72894599299051e1cbff41b95");
  expect(r09.predecessor).toEqual({"path": "tests/skill-classification/fixtures.json", "gitRevision": "9d393393e68c6ee72894599299051e1cbff41b95", "gitBlob": "87333e8e281d06d26ce88ceac2b042043eac282a", "bytes": 142495, "digest": "sha256:d3490862893ee85f13dbee39ad992498bf7a76360c898d30d8089e5e485c1b88", "fixtureRevision": "ags-classification-governance-behavior-source-binding-r08", "oracleRevision": "pre-live-governance-behavior-source-reviewed-r08", "oracleDigest": "sha256:e48f0d37e8675f046a00648451fc3086753af97d663ca4a0aa18b8fdad386666", "sourceBindingRevision": "pre-live-source-binding-8"});
  expect(r09.predecessorSidecar).toEqual({"path": "tests/skill-classification/fixtures.source-successor.json", "gitRevision": "9d393393e68c6ee72894599299051e1cbff41b95", "gitBlob": "dd74211fc527015a9554af2c1f1af7d89f02ff68", "bytes": 40883, "digest": "sha256:2d8192e1ce5793d20bfe6fb6839e448141c40ea0d520fd9da3a1a414a13ebed1"});
  expect(r09.sourceBindings).toEqual([{"path": "skills/orchestrator/SKILL.md", "previousDigest": "sha256:082e2fe237d22455ccbcedb3f4b26dcaa0b1a78f5f552011e3ac36515d21653b", "digest": "sha256:5f2cf07a358914cd068a90cf6eb7fe3bbf549a7fc08e47dfc6daecefeabd44f4", "bytes": 9945}, {"path": "skills/orchestrator/classification.json", "previousDigest": "sha256:81ac5daaa54a6fc6947ba5e805bf7c1d3e4c061dd473be820f4a553a762dd577", "digest": "sha256:44d66bda8d2c80034d3f881ff3f12de6d628bd4d8ce850fd49718df656aa95d2", "bytes": 4577}]);
  expect(r09.reboundReferences).toBe(17);
  expect(r09.classificationReferences).toBe(18);
  expect(r09.labelChanges).toEqual([]);
  expect(r09.modelBehavior).toBe("NOT_RUN");
  for (const binding of successor.governanceBehaviorSourceSuccessor.sourceBindings) {
    expect(r09.sourceBindings.find((current: {path: string}) => current.path === binding.path)?.previousDigest).toBe(binding.digest);
  }
  for (const binding of r09.sourceBindings) {
    expect(hash(readFileSync(path.join(root, binding.path)))).toBe(currentSourceBinding.resolveDigest(binding.path, binding.digest));
  }
  expect(r06.midtaskSourceSuccessor.predecessor).toEqual({
    gitRevision: "45556669124efc64151be21be9958463e1f18d40",
    gitBlob: "2078c29de99d2c5a2dc1693b9c68da9cac395bac",
    digest: "sha256:3c7c2159bbaa74521c5c5aefbae21710a7a507a6235315608ec941fb1b1294f1", bytes: 142481,
    fixtureRevision: "ags-classification-skill-policy-source-binding-r05",
    oracleRevision: "pre-live-skill-policy-source-reviewed-r05",
    oracleDigest: "sha256:307f07d6f78cba04e1f606f680e6609b9a17f22f499b802f1b0cf46329a1bd2e",
  });
  expect(r06.midtaskSourceSuccessor.reboundReferences).toBe(17);
  expect(r06.midtaskSourceSuccessor.labelChanges).toEqual([]);
  expect(r06.midtaskSourceSuccessor.modelBehavior).toBe("NOT_RUN");
});
it("binds exactly the nine changed skill policy sources across global and per-case evidence", () => {
  expect(successor.bindings).toEqual(bindings);
  expect(successor.semanticProjection.omittedRevisionFields).toEqual(["fixtureRevision", "oracleRevision", "oracleDigest", "sourceBindingRevision"]);
  expect(successor.semanticProjection.omittedDigestPaths).toEqual(bindings.map(({skillId, path}) => ({skillId, path})));
  let references = 0;
  const walk = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    const row = value as Record<string, unknown>;
    const binding = bindings.find(item => item.skillId === row.skillId && item.path === row.path);
    if (binding && "digest" in row) {expect(row.digest).toBe(binding.digest); references++;}
    for (const child of Object.values(row)) walk(child);
  };
  walk(current);
  expect(references).toBe(58);
  expect(references).toBe(successor.reboundReferences);
  for (const binding of bindings) {
    expect(hash(readFileSync(path.join(root, binding.path)))).toBe(currentSourceBinding.resolveDigest(binding.path, binding.digest));
    expect(binding.digest).not.toBe(binding.previousDigest);
  }
});

it("binds the current unavailable-classification guidance while preserving the frozen r09 corpus and all 18 spans", () => {
  const bytes = readFileSync(new URL("./fixtures.unavailable-source-successor.json", import.meta.url));
  expect(hash(bytes)).toBe("sha256:bd4a64b9079fe828fc6ae45fb6c41b09e8df03767ed5b6d55331e53f09343596");
  const binding = JSON.parse(bytes.toString("utf8"));
  expect(binding.revision).toBe("orchestrator-unavailable-source-binding-r11");
  expect(binding.role).toBe("source-binding-only-not-evaluation-or-install-authority");
  expect(binding.fixtureFileRewritten).toBe(false);
  expect(binding.frozenFixture.digest).toBe("sha256:947b92701fe640dfa94c532b92f82fb251e401e9b4b7c3616afe3d5c2e263065");
  expect(binding.frozenFixture.oracleDigest).toBe("sha256:33ca2c2edc3b20d3287eddc45d907ac6bba0b742386aa7ab7a5516a30b6cd914");
  expect(binding.frozenSidecar.digest).toBe("sha256:181f9d83c9e2b53e40a8e8fe5767018a798c2db8ced4e9a94109ce7b9503e61a");
  expect(binding.bindings).toEqual([{"path": "skills/orchestrator/SKILL.md", "previousDigest": "sha256:5f2cf07a358914cd068a90cf6eb7fe3bbf549a7fc08e47dfc6daecefeabd44f4", "digest": "sha256:4b00fd06d5636f2ef914a5ac66dec10145a62887371813ec1592f0790b4e965d", "bytes": 10169}, {"path": "skills/orchestrator/classification.json", "previousDigest": "sha256:44d66bda8d2c80034d3f881ff3f12de6d628bd4d8ce850fd49718df656aa95d2", "digest": "sha256:c43f537d2c0fff5c8f9f569cb224d8d6925076d271fdf47b78253bc41ba5ace4", "bytes": 4577}]);
  expect(binding.fixtureReferences).toBe(17);
  expect(binding.classificationReferences).toBe(18);
  expect(binding.labelChanges).toEqual([]);
  expect(binding.priceAndBudgetChanges).toEqual([]);
  expect(binding.modelBehavior).toBe("NOT_RUN");
  expect(binding.semanticProjectionDigest).toBe(semanticDigest);
  expect(hash(JSON.stringify(semantics(current)))).toBe(semanticDigest);
  for (const source of binding.bindings) {
    const actual = readFileSync(path.join(root, source.path));
    expect(hash(actual)).toBe(currentSourceBinding.resolveDigest(source.path, source.previousDigest));
    expect(() => currentSourceBinding.resolveDigest(source.path, "sha256:" + "0".repeat(64))).toThrow("SOURCE_BINDING_PREDECESSOR_MISMATCH");
  }
  const metadata = JSON.parse(mainSource("skills/orchestrator/classification.json").toString("utf8"));
  const sourceLines = mainSource("skills/orchestrator/SKILL.md").toString("utf8").split(/\r?\n/);
  expect(binding.spanPreservation.spans).toHaveLength(18);
  const phase = JSON.parse(readFileSync(new URL("./fixtures.orchestrator-workflow-enforcement-source-successor.json", import.meta.url), "utf8"));
  expect(phase.spanPreservation.spans.map((span: {group: string; index: number}) => [span.group, span.index]))
    .toEqual(binding.spanPreservation.spans.map((span: {group: string; index: number}) => [span.group, span.index]));
  for (const span of phase.spanPreservation.spans) {
    const actual = metadata[span.group][span.index];
    expect(actual.startLine).toBe(span.startLine);
    expect(actual.endLine).toBe(span.endLine);
    const joined = Buffer.from(sourceLines.slice(actual.startLine - 1, actual.endLine).join("\n"));
    expect(actual.startByte ?? 0).toBe(span.startByte);
    expect(actual.endByte ?? joined.length).toBe(span.endByte);
    const selected = joined.subarray(span.startByte, span.endByte);
    expect(selected.length).toBe(span.bytes);
    expect(hash(selected)).toBe(span.digest);
  }
});
