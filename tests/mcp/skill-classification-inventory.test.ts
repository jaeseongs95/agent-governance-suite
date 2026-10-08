import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadSkillInventory } from "../../mcp-server/src/skill-classification/inventory.js";

const roots: string[] = [];
const hash = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "ags-inventory-")); roots.push(root);
  await mkdir(path.join(root, "skills"));
  await writeFile(path.join(root, "skills/registry.json"), JSON.stringify({ schemaVersion: "2.0.0", skills: [] }));
  return root;
}
async function addSkill(root: string, id = "skill-z17", description = "중복·유실 불변조건 분석. 일반 설명에는 사용하지 않는다.") {
  const directory = path.join(root, "skills", id); await mkdir(directory, { recursive: true });
  const text = `---\nname: ${id}\ndescription: ${description}\nmetadata:\n  version: "1.0.0"\n---\n\n큐의 중복·유실 불변조건만 읽기 전용 분석한다.\n일반 설명과 수정에는 적용하지 않는다.\n`;
  await writeFile(path.join(directory, "SKILL.md"), text);
  const source = { path: `skills/${id}/SKILL.md`, startLine: 8, endLine: 9, digest: hash(text) };
  await writeFile(path.join(directory, "classification.json"), JSON.stringify({ schemaVersion: "1.0.0", taxonomyRevision: "1.0.0", actions: ["read-only-analysis"], targets: ["message-queue"], constraints: ["no-modification"], dependencies: [], capabilities: ["concurrency-analysis"], applicability: [source], exclusions: [source] }));
}
async function metadata(root: string, mutate: (value: Record<string, unknown>) => void, id = "skill-z17") {
  const file = path.join(root, "skills", id, "classification.json"); const value = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>; mutate(value); await writeFile(file, JSON.stringify(value));
}
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("classification inventory source authority (SS26/SS37)", () => {
  it("reads every actual directory including infrastructure and all capability stages", async () => {
    const inventory = await loadSkillInventory({ root: process.cwd() });
    const directories = (await readdir("skills", { withFileTypes: true })).filter((item) => item.isDirectory());
    expect(inventory.issues).toEqual([]);
    expect(inventory.skills).toHaveLength(directories.length);
    expect(inventory.skills.map((skill) => skill.skillId)).toEqual(expect.arrayContaining(["orchestrator", "context-continuity", "session-board"]));
    const prose = inventory.skills.find((skill) => skill.skillId === "korean-prose-editor")!;
    expect(prose.phases.map((item) => item.phase)).toEqual(["korean-prose-selection", "korean-prose-editing", "korean-prose-verification", "korean-prose-finalization"]);
    expect(prose.phases[3]?.inputBindings?.find((binding) => binding.targetArtifact === "edit-verification-report")?.sources).toEqual(["provider:korean-prose-verification.edit-verification-report"]);
    expect(prose.phases[3]?.gate?.policy).toBe("conditional");
    expect((await loadSkillInventory({ root: process.cwd() })).inventoryDigest).toBe(inventory.inventoryDigest);
  });
  it("discovers a neutral new ID, re-reads roles and honors actual host membership", async () => {
    const root = await fixture(); await addSkill(root);
    const first = await loadSkillInventory({ root });
    expect(first.skills[0]).toMatchObject({ skillId: "skill-z17", capabilities: ["concurrency-analysis"], actions: ["read-only-analysis"], targets: ["message-queue"] });
    await addSkill(root, "neutral-2");
    await metadata(root, (value) => { value.actions = ["review-design"]; });
    const second = await loadSkillInventory({ root, installedSkillIds: ["neutral-2", "unexposed"], hostSupportedSkillIds: ["neutral-2"] });
    expect(second.skills).toHaveLength(2);
    expect(second.skills.find((skill) => skill.skillId === "skill-z17")).toMatchObject({ installed: false, hostSupported: false, actions: ["review-design"] });
    expect(second.issues).toContainEqual({ skillId: "unexposed", code: "INSTALLED_SKILL_UNEXPOSED", field: "installedSkillIds" });
    expect(second.inventoryDigest).not.toBe(first.inventoryDigest);
  });
  it("detects stale prose sources without hiding independent complete candidates", async () => {
    const root = await fixture(); await addSkill(root); await addSkill(root, "complete");
    const first = await loadSkillInventory({ root });
    await writeFile(path.join(root, "skills/skill-z17/SKILL.md"), (await readFile(path.join(root, "skills/skill-z17/SKILL.md"), "utf8")).replace("일반 설명", "단순 설명"));
    const stale = await loadSkillInventory({ root });
    expect(stale.skills.map((skill) => skill.skillId)).toEqual(["complete"]);
    expect(stale.issues).toContainEqual({ skillId: "skill-z17", code: "STALE_SOURCE", field: "applicability" });
    expect(stale.inventoryDigest).not.toBe(first.inventoryDigest);
    await addSkill(root, "skill-z17", "새 설명. 단순 설명에는 사용하지 않는다.");
    const refreshed = await loadSkillInventory({ root });
    expect(refreshed.issues).toEqual([]); expect(refreshed.skills).toHaveLength(2);
    expect(refreshed.inventoryDigest).not.toBe(first.inventoryDigest);
  });
  it("reports missing metadata, description, dependencies and invalid source ranges", async () => {
    const root = await fixture(); await addSkill(root);
    await metadata(root, (value) => { value.dependencies = ["missing"]; });
    expect((await loadSkillInventory({ root })).issues).toContainEqual({ skillId: "skill-z17", code: "DEPENDENCY_UNAVAILABLE", field: "dependencies" });
    await metadata(root, (value) => { (value.applicability as { endLine: number }[])[0]!.endLine = 1000; });
    expect((await loadSkillInventory({ root })).issues[0]?.code).toBe("SOURCE_RANGE_INVALID");
    await rm(path.join(root, "skills/skill-z17/classification.json"));
    expect((await loadSkillInventory({ root })).issues[0]?.field).toBe("classification.json");
    await addSkill(root); await writeFile(path.join(root, "skills/skill-z17/SKILL.md"), "---\nname: skill-z17\n---\n");
    expect((await loadSkillInventory({ root })).issues[0]?.code).toBe("MISSING_DESCRIPTION");
  });
  it("rejects duplicate IDs/version conflicts and retains disabled registry entries", async () => {
    const root = await fixture(); await addSkill(root);
    const entry = { skillId: "skill-z17", version: "1.0.0", path: "./skill-z17", enabled: false, providers: [{ capabilities: ["concurrency-analysis"], phase: "analysis", phaseOrder: 10, requiredInputArtifacts: [], inputBindings: [], producedArtifacts: [], gate: { kind: "none", policy: "none" } }] };
    const writeRegistry = (entries: unknown[]) => writeFile(path.join(root, "skills/registry.json"), JSON.stringify({ schemaVersion: "2.0.0", skills: entries }));
    await writeRegistry([entry]); expect((await loadSkillInventory({ root })).skills[0]?.enabled).toBe(false);
    await writeRegistry([{ ...entry, version: "2.0.0" }]); expect((await loadSkillInventory({ root })).issues[0]?.code).toBe("SOURCE_CONFLICT");
    await writeRegistry([entry, entry]); const duplicate = await loadSkillInventory({ root });
    expect(duplicate.skills).toEqual([]); expect(duplicate.issues.some((issue) => issue.code === "DUPLICATE_ID")).toBe(true);
    await writeRegistry([{ ...entry, skillId: "deleted", path: "./deleted" }]);
    expect((await loadSkillInventory({ root })).issues).toContainEqual({ skillId: "deleted", code: "REGISTRY_SKILL_MISSING", field: "SKILL.md" });
  });
  it("unions approved host roots and reports source conflicts and missing external taxonomy", async () => {
    const root = await fixture(); await addSkill(root, "local");
    const external = await fixture(); await addSkill(external);
    const externalSkillRoots = [path.join(external, "skills/skill-z17")];
    const union = await loadSkillInventory({ root, externalSkillRoots, installedSkillIds: ["local", "skill-z17"] });
    expect(union.issues).toEqual([]);
    expect(union.skills.map((skill) => skill.skillId)).toEqual(["local", "skill-z17"]);
    expect(union.skills[1]?.sourceRefs[0]?.path).toContain(external.replaceAll("\\", "/"));
    await metadata(root, (value) => { value.dependencies = ["skill-z17"]; }, "local");
    expect((await loadSkillInventory({ root, externalSkillRoots })).issues).toEqual([]);
    await addSkill(root);
    const conflict = await loadSkillInventory({ root, externalSkillRoots });
    expect(conflict.skills.map((skill) => skill.skillId)).toEqual(["local"]);
    expect(conflict.issues).toContainEqual({ skillId: "skill-z17", code: "DUPLICATE_ID", field: "externalSkillRoots" });
    await rm(path.join(external, "skills/skill-z17/classification.json"));
    const missing = await loadSkillInventory({ root, externalSkillRoots });
    expect(missing.issues).toContainEqual({ skillId: "skill-z17", code: "MISSING_OR_INVALID_METADATA", field: "classification.json" });
    expect(missing.inventoryDigest).not.toBe(union.inventoryDigest);
    expect((await loadSkillInventory({ root, externalSkillRoots: [path.join(external, "unavailable")] })).issues).toContainEqual({ skillId: null, code: "EXTERNAL_SKILL_UNAVAILABLE", field: "externalSkillRoots[0]" });
  });
});
