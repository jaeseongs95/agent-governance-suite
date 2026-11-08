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
const flat = (text: string) => text.replace(/\s+/gu, " ");
afterEach(async () => { await Promise.all(temporary.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

// The rules ponytail carried for causal correction and its tests, kept for every kind of deliverable.
it("keeps causal correction in the existing defect-fix and verification rules without a new gate", async () => {
  const text = flat(await read("skills/minimal-implementation/SKILL.md"));
  expect(text).toContain("결함 수정은 증상이 아니라 깨진 불변조건이 있는 자리에서 고친다.");
  expect(text).toContain("같은 원인을 공유하는 다른 경로도 확인하고, 이미 올바르게 동작하는 호출자는 보존한다.");
  expect(text).toContain("원본에서 도출하거나 빠지면 실패하는 검사를 둔다.");
  expect(text).toContain("의도된 허용 목록과 시험 사례 표는 손으로 둔다.");
  expect(text).toContain("결함 수정은 원래 실패 조건을 지정된 환경에서 실행해 확인한다.");
  expect(text).toContain("재현할 수 있으면 수정 전 실패를 보이고, 없으면 그 공백을 적는다.");
  expect(text).toContain("기존 범위로 결함을 잡을 수 없을 때만 집중 회귀 시험을 더한다.");
  expect(text).toContain("축소판을 내고 원래 요구를 원하느냐고 되묻지 않는다.");
  expect(text).toContain("오류를 삼키거나 다른 원인·성공 상태로 바꾸지 않는다.");
  expect(text).toContain("../orchestrator/references/engineering-practices/implementation.md");
  expect(text).toContain("주어진 CS 불변조건과 검증 의무를 유지하며");
});

it("keeps explicit disable and user override above automatic selection and the mandatory-first rule", async () => {
  const text = flat(await read("skills/minimal-implementation/SKILL.md"));
  const intake = await read("skills/orchestrator/references/intake.md");
  expect(text).toContain("명시적 비활성화나 사용자 재정의는 이 스킬 전체에 적용되며 자동 선택보다 우선한다.");
  expect(text).toContain("이후의 명시적 사용은 그 요청에만 적용한다.");
  expect(text).toContain("스킬이 없거나 꺼져 있으면 멈추거나 다시 켜 달라고 하지 말고 원 요구·수용 기준·필요한 시험을 지킨다.");
  // 4.0.0 (token optimization): "call it first" moved from the intake into the skill's own description, which every
  // host lists for selection; the override and missing-skill rules stay in the intake for every skill.
  const description = /^description: (.*)$/mu.exec(await read("skills/minimal-implementation/SKILL.md"))?.[1] ?? "";
  expect(description).toContain("invoke it first when available, active and not against user instructions");
  expect(intake).toContain("사용자 disable·override가 우선하며");
  expect(intake).toContain("없거나 꺼져 있으면 재활성화를 요구하거나 멈추지 말고");
  expect(intake).toContain("원 요구·수용 기준·시험을 지킨다");
  expect(intake).toContain("후속 명시 사용은 그 요청에만 적용하고 전역 설정은 바꾸지 않는다");
  expect(await read("skills/minimal-implementation/agents/openai.yaml")).toContain("$minimal-implementation");
});

it("projects current root-cause and disable evidence through the actual source inventory", async () => {
  const inventory = await loadSkillInventory({ root });
  expect(inventory.issues).toEqual([]);
  const skill = inventory.skills.find(candidate => candidate.skillId === "minimal-implementation")!;
  const intake = inventory.skills.find(candidate => candidate.skillId === "orchestrator")!;
  expect(skill.applicability.join("\n")).toContain("결함 수정은 증상이 아니라");
  expect(skill.applicability.join("\n")).toContain("## 대체물로 완료를 만들지 않는다");
  expect(skill.exclusions.join("\n")).toContain("명시적 비활성화나 사용자 재정의는 이 스킬 전체에 적용되며 자동 선택보다 우선한다.");
  expect(intake.applicability.join("\n")).toContain("사용자 disable·override가 우선하며");
  expect(skill.sourceRefs).toContainEqual({ path: "skills/minimal-implementation/SKILL.md", digest: `sha256:${createHash("sha256").update(await read("skills/minimal-implementation/SKILL.md")).digest("hex")}` });
});

async function fixture(enabled: boolean) {
  const directory = await mkdtemp(path.join(tmpdir(), "minimal-policy-")); temporary.push(directory);
  await mkdir(path.join(directory, "skills"));
  await cp(path.join(root, "skills/minimal-implementation"), path.join(directory, "skills/minimal-implementation"), { recursive: true });
  const registry = JSON.parse(await read("skills/registry.json"));
  registry.skills = registry.skills.filter((skill: { skillId: string }) => skill.skillId === "minimal-implementation");
  registry.skills[0].enabled = enabled;
  await writeFile(path.join(directory, "skills/registry.json"), JSON.stringify(registry));
  return directory;
}

it("does not revive disabled or unexposed skills in actual inventory membership", async () => {
  const directory = await fixture(false);
  const disabled = await loadSkillInventory({ root: directory });
  expect(disabled.issues).toEqual([]);
  expect(disabled.skills[0]).toMatchObject({ skillId: "minimal-implementation", enabled: false });
  const absent = await loadSkillInventory({ root: directory, installedSkillIds: [], hostSupportedSkillIds: [] });
  expect(absent.issues).toEqual([]);
  expect(absent.skills[0]).toMatchObject({ enabled: false, installed: false, hostSupported: false });
});

it("rejects stale policy evidence rather than silently accepting a changed source", async () => {
  const directory = await fixture(true);
  await writeFile(path.join(directory, "skills/minimal-implementation/SKILL.md"), (await read("skills/minimal-implementation/SKILL.md")) + "\nchanged after pin\n");
  const inventory = await loadSkillInventory({ root: directory });
  expect(inventory.skills).toEqual([]);
  expect(inventory.issues).toContainEqual({ skillId: "minimal-implementation", code: "STALE_SOURCE", field: "applicability" });
});

// The removed ponytail sources stay verifiable from history; only the orchestrator files still exist in the tree.
it("accepts only exact successor bytes and rejects extra edits or unrelated paths", async () => {
  for (const relative of ["skills/ponytail/SKILL.md", "skills/ponytail/agents/openai.yaml", "skills/ponytail/classification.json"]) {
    const bytes = readHistoricalSource(relative);
    expect(bytes.length).toBeGreaterThan(0);
    expect(matchesPonytailPolicySuccessor(relative, bytes)).toBe(true);
    expect(matchesPonytailPolicySuccessor(relative, Buffer.concat([bytes, Buffer.from("\nextra")]))).toBe(false);
  }
  for (const relative of ["skills/orchestrator/SKILL.md", "skills/orchestrator/classification.json"]) {
    const current = Buffer.from(await read(relative));
    const bytes = readHistoricalSource(relative);
    if (!bytes.equals(current)) expect(matchesSkillPolicyWordingSuccessorBytes(relative, current)).toBe(true);
    expect(matchesSkillPolicyWordingSuccessorBytes(relative, Buffer.concat([current, Buffer.from("\nextra")]))).toBe(false);
    expect(matchesPonytailPolicySuccessor(relative, bytes)).toBe(true);
    expect(matchesPonytailPolicySuccessor(relative, Buffer.concat([bytes, Buffer.from("\nextra")]))).toBe(false);
  }
  expect(matchesPonytailPolicySuccessor("skills/code-review/SKILL.md", Buffer.from(await read("skills/code-review/SKILL.md")))).toBe(false);
});
