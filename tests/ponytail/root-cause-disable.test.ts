import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { loadSkillInventory } from "../../mcp-server/src/skill-classification/inventory.js";
const { matchesPonytailPolicySuccessor, matchesSkillPolicyWordingSuccessorBytes, readHistoricalSource }: { matchesPonytailPolicySuccessor: (relative: string, bytes: Uint8Array) => boolean; matchesSkillPolicyWordingSuccessorBytes: (relative: string, bytes: Uint8Array) => boolean; readHistoricalSource: (relative: string) => Buffer } = await import(new URL("../../scripts/check-skill-context-optimization.mjs", import.meta.url).href);

const root = fileURLToPath(new URL("../../", import.meta.url));
const temporary: string[] = [];
const read = (relative: string) => readFile(path.join(root, relative), "utf8");
afterEach(async () => { await Promise.all(temporary.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

it("keeps causal correction in the existing bug-fix and test rules without a new gate", async () => {
  const text = await read("skills/ponytail/SKILL.md");
  expect(text).toContain("**Bug fix = root cause, not symptom.**");
  expect(text.replace(/\s+/gu, " ")).toContain("Derive the list with existing code, or add a check that fails when it is incomplete");
  expect(text.replace(/\s+/gu, " ")).toContain("allowlists and test case tables stay hand-written");
  expect(text.replace(/\s+/gu, " ")).toContain("A typo or wrong constant in the line itself is its own root cause: fix the line");
  expect(text.replace(/\s+/gu, " ")).toContain("the command or CI step that originally failed, passing where it failed");
  expect(text.replace(/\s+/gu, " ")).toContain("a new test counts only if it fails on the pre-fix code");
  expect(text.replace(/\s+/gu, " ")).toContain("never swallow or flatten an error to shorten code");
  expect(text).toContain("../orchestrator/references/engineering-practices/implementation.md");
  expect(text).toContain("Preserve CS invariants and verification obligations supplied for the task");
  expect(text).not.toMatch(/## (?:Defect fixes|Root cause before)/u);
  expect(text).not.toContain("root cause: [X]; recurs if [Y].");
  expect(text).not.toContain("it takes precedence over the ladder, intensity, Output limits and one-check shortcuts");
});
it("keeps explicit disable and user override above persistence and mandatory-first intake", async () => {
  const text = await read("skills/ponytail/SKILL.md");
  const intake = await read("skills/orchestrator/SKILL.md");
  expect(text).not.toContain("Off only:");
  expect(text).toContain("Explicit disable or user override takes precedence over automatic selection and mandatory-first wording");
  expect(text).toContain("examples, not the only ways to disable it");
  expect(intake).toContain("명시적 disable·사용자 override는 선행 호출보다 우선한다");
  expect(intake).toContain("부재·비활성인 스킬의 재활성화를 요구하거나 원 작업을 중단하지 않고 일반 engineering 원칙으로 계속한다");
  expect(intake).toContain("원 요구·수용 기준·필요한 시험은 줄이지 않는다");
  expect(text).toContain("A later explicit user request may enable this skill for that request; it does not change persistent settings");
  expect(intake).toContain("후속 사용자의 명시적 사용 지시는 해당 요청 범위에서만 존중하며 전역 설정을 바꾸지 않는다");
  expect(await read("skills/ponytail/agents/openai.yaml")).toContain("$ponytail로 이 코드 작업을 필요 없는 기능·추상화·의존성 없이 가장 단순하게 구현해 주세요.");
});

it("projects current root-cause and disable evidence through the actual source inventory", async () => {
  const inventory = await loadSkillInventory({ root });
  expect(inventory.issues).toEqual([]);
  const pony = inventory.skills.find(skill => skill.skillId === "ponytail")!;
  const intake = inventory.skills.find(skill => skill.skillId === "orchestrator")!;
  expect(pony.applicability.join("\n")).toContain("root cause");
  expect(pony.exclusions.join("\n")).toContain("Explicit disable or user override takes precedence");
  expect(intake.applicability.join("\n")).toContain("명시적 disable·사용자 override는 선행 호출보다 우선한다");
  expect(pony.sourceRefs).toContainEqual({ path: "skills/ponytail/SKILL.md", digest: `sha256:${createHash("sha256").update(await read("skills/ponytail/SKILL.md")).digest("hex")}` });
});

async function fixture(enabled: boolean) {
  const directory = await mkdtemp(path.join(tmpdir(), "pony-policy-")); temporary.push(directory);
  await mkdir(path.join(directory, "skills"));
  await cp(path.join(root, "skills/ponytail"), path.join(directory, "skills/ponytail"), { recursive: true });
  const registry = JSON.parse(await read("skills/registry.json"));
  registry.skills = registry.skills.filter((skill: { skillId: string }) => skill.skillId === "ponytail");
  registry.skills[0].enabled = enabled;
  await writeFile(path.join(directory, "skills/registry.json"), JSON.stringify(registry));
  return directory;
}

it("does not revive disabled or unexposed skills in actual inventory membership", async () => {
  const directory = await fixture(false);
  const disabled = await loadSkillInventory({ root: directory });
  expect(disabled.issues).toEqual([]);
  expect(disabled.skills[0]).toMatchObject({ skillId: "ponytail", enabled: false });
  const absent = await loadSkillInventory({ root: directory, installedSkillIds: [], hostSupportedSkillIds: [] });
  expect(absent.issues).toEqual([]);
  expect(absent.skills[0]).toMatchObject({ enabled: false, installed: false, hostSupported: false });
});

it("rejects stale policy evidence rather than silently accepting a changed source", async () => {
  const directory = await fixture(true);
  await writeFile(path.join(directory, "skills/ponytail/SKILL.md"), (await read("skills/ponytail/SKILL.md")) + "\nchanged after pin\n");
  const inventory = await loadSkillInventory({ root: directory });
  expect(inventory.skills).toEqual([]);
  expect(inventory.issues).toContainEqual({ skillId: "ponytail", code: "STALE_SOURCE", field: "applicability" });
});

it("accepts only exact successor bytes and rejects extra edits or unrelated paths", async () => {
  for (const relative of ["skills/ponytail/SKILL.md", "skills/ponytail/agents/openai.yaml", "skills/ponytail/classification.json", "skills/orchestrator/SKILL.md", "skills/orchestrator/classification.json"]) {
    const current = Buffer.from(await read(relative));
    const bytes = readHistoricalSource(relative);
    if (!bytes.equals(current)) expect(matchesSkillPolicyWordingSuccessorBytes(relative, current)).toBe(true);
    expect(matchesSkillPolicyWordingSuccessorBytes(relative, Buffer.concat([current, Buffer.from("\nextra")]))).toBe(false);
    expect(matchesPonytailPolicySuccessor(relative, bytes)).toBe(true);
    expect(matchesPonytailPolicySuccessor(relative, Buffer.concat([bytes, Buffer.from("\nextra")]))).toBe(false);
  }
  expect(matchesPonytailPolicySuccessor("skills/code-review/SKILL.md", Buffer.from(await read("skills/code-review/SKILL.md")))).toBe(false);
});
