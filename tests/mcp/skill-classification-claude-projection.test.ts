import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadSkillInventory } from "../../mcp-server/src/skill-classification/inventory.js";
import type { SkillMetadata } from "../../mcp-server/src/skill-classification/types.js";

const generator = await import(new URL("../../scripts/build-claude-plugin.mjs", import.meta.url).href) as {
  CLASSIFICATION_PROJECTION: string; EXCLUDED_SKILLS: string[];
  readClassificationSources(root: string, tracked: string[]): Promise<Map<string, Buffer> | null>;
  projectClassificationSources(files: Map<string, Buffer>, sources: Map<string, Buffer> | null): void;
  applySkillAdaptation(files: Map<string, Buffer>, skillId: string, adaptation: unknown): void;
  mapSkillInvocations(files: Map<string, Buffer>, skillIds: string[]): void;
};
const roots: string[] = [];
const hash = (content: string) => `sha256:${createHash("sha256").update(content).digest("hex")}`;
async function temporary() { const root = await mkdtemp(path.join(os.tmpdir(), "ags-claude-classification-")); roots.push(root); return root; }
async function writeMap(root: string, files: Map<string, Buffer>) {
  for (const [relative, content] of files) { const target = path.join(root, relative); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, content); }
}
async function actualAdaptedProjection() {
  const sourceRoot = process.cwd();
  const tracked = (await readdir(path.join(sourceRoot, "skills"), { withFileTypes: true })).filter((item) => item.isDirectory()).map((item) => `skills/${item.name}/SKILL.md`);
  const canonical = await generator.readClassificationSources(sourceRoot, tracked);
  const files = new Map(canonical!);
  for (const relative of files.keys()) if (generator.EXCLUDED_SKILLS.some((id) => relative.startsWith(`skills/${id}/`))) files.delete(relative);
  const registry = JSON.parse(files.get("skills/registry.json")!.toString("utf8")) as { skills: { skillId: string }[] };
  registry.skills = registry.skills.filter((skill) => !generator.EXCLUDED_SKILLS.includes(skill.skillId));
  files.set("skills/registry.json", Buffer.from(JSON.stringify(registry, null, 2) + "\n"));
  for (const adaptationFile of (await readdir(path.join(sourceRoot, "claude-overlay/adaptations"))).sort()) {
    const id = adaptationFile.replace(/\.json$/, "");
    const adaptation = JSON.parse(await readFile(path.join(sourceRoot, "claude-overlay/adaptations", adaptationFile), "utf8")) as { replacements?: { file: string }[] };
    for (const replacement of adaptation.replacements ?? []) {
      const relative = `skills/${id}/${replacement.file}`;
      if (!files.has(relative)) files.set(relative, await readFile(path.join(sourceRoot, relative)));
    }
    generator.applySkillAdaptation(files, id, adaptation);
  }
  generator.mapSkillInvocations(files, registry.skills.map((skill) => skill.skillId));
  generator.projectClassificationSources(files, canonical);
  const root = await temporary(); await writeMap(root, files);
  return { root, files, canonical: canonical!, tracked };
}
const semantic = (skill: SkillMetadata) => {
  const value = { ...skill } as Partial<SkillMetadata>;
  delete value.sourceRefs; delete value.sourceMap; delete value.installed; delete value.hostSupported;
  return value;
};
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("derived Claude classification projection", () => {
  it("keeps canonical meaning for every skill while validating actual adapted bytes and availability", async () => {
    const { root, files } = await actualAdaptedProjection();
    const canonical = await loadSkillInventory({ root: process.cwd() });
    const projected = await loadSkillInventory({ root });
    expect(projected.issues).toEqual([]);
    expect(projected.skills.map((skill) => semantic(skill))).toEqual(canonical.skills.map((skill) => semantic(skill)));
    expect(projected.skills).toHaveLength(canonical.skills.length);
    const actualDirectories = (await readdir(path.join(root, "skills"), { withFileTypes: true })).filter((item) => item.isDirectory());
    expect(projected.skills.filter((skill) => skill.installed)).toHaveLength(actualDirectories.length);
    for (const id of generator.EXCLUDED_SKILLS) expect(projected.skills.find((skill) => skill.skillId === id)).toMatchObject({ installed: false, hostSupported: false });
    expect(projected.inventoryDigest).not.toBe(canonical.inventoryDigest);
    expect(projected.skills.find((skill) => skill.skillId === "orchestrator")?.sourceRefs).toContainEqual({ path: "skills/orchestrator/SKILL.md", digest: `sha256:${createHash("sha256").update(files.get("skills/orchestrator/SKILL.md")!).digest("hex")}` });
    expect(projected.skills.find((skill) => skill.skillId === "context-continuity")?.sourceMap?.some((source) => source.path.startsWith("canonical:"))).toBe(true);
    expect(projected.skills.find((skill) => skill.skillId === "korean-prose-editor")?.phases).toEqual(canonical.skills.find((skill) => skill.skillId === "korean-prose-editor")?.phases);
  });
  it("rejects stale actual host bytes and canonical digest corruption without falling back", async () => {
    const { root } = await actualAdaptedProjection();
    const skill = path.join(root, "skills/orchestrator/SKILL.md"); const original = await readFile(skill);
    await writeFile(skill, Buffer.concat([original, Buffer.from("\nchanged host source\n")]));
    const stale = await loadSkillInventory({ root });
    expect(stale.skills).toEqual([]); expect(stale.issues[0]?.code).toBe("HOST_SOURCE_STALE");
    await writeFile(skill, original);
    const projectionFile = path.join(root, generator.CLASSIFICATION_PROJECTION);
    const projection = JSON.parse(await readFile(projectionFile, "utf8")) as { canonicalSources: { content: string }[] };
    projection.canonicalSources[0]!.content += "corrupt";
    await writeFile(projectionFile, JSON.stringify(projection));
    expect((await loadSkillInventory({ root })).issues[0]?.code).toBe("CANONICAL_SOURCE_STALE");
  });
  it("checks closed projection membership, source paths and original stale source spans", async () => {
    const { root, files } = await actualAdaptedProjection();
    const projectionFile = path.join(root, generator.CLASSIFICATION_PROJECTION);
    const original = files.get(generator.CLASSIFICATION_PROJECTION)!;
    const missing = JSON.parse(original.toString("utf8")) as { hostSources: unknown[] };
    missing.hostSources.pop(); await writeFile(projectionFile, JSON.stringify(missing));
    expect((await loadSkillInventory({ root })).issues[0]?.code).toBe("PROJECTION_MEMBERSHIP_CONFLICT");
    const invalid = JSON.parse(original.toString("utf8")) as { canonicalSources: { path: string }[] };
    invalid.canonicalSources[0]!.path = "skills/../outside"; await writeFile(projectionFile, JSON.stringify(invalid));
    expect((await loadSkillInventory({ root })).issues[0]?.code).toBe("PROJECTION_SOURCE_CONFLICT");
    await writeFile(projectionFile, original); await mkdir(path.join(root, "skills/unreported"));
    expect((await loadSkillInventory({ root })).issues[0]?.code).toBe("PROJECTION_MEMBERSHIP_CONFLICT");
    const sourceRoot = await temporary();
    const source = "---\nname: neutral\ndescription: source changed\nmetadata:\n  version: '1.0.0'\n---\n";
    await writeMap(sourceRoot, new Map([["skills/registry.json", Buffer.from('{"schemaVersion":"2.0.0","skills":[]}')], ["skills/neutral/SKILL.md", Buffer.from(source)], ["skills/neutral/classification.json", Buffer.from(JSON.stringify({ schemaVersion: "1.0.0", applicability: [{ path: "skills/neutral/SKILL.md", startLine: 3, endLine: 3, digest: hash("different bytes") }], exclusions: [] }))]]));
    await expect(generator.readClassificationSources(sourceRoot, ["skills/neutral/SKILL.md"])).rejects.toThrow("Stale classification source");
  });
  it("projects a new neutral ID without selector or host name lists changing", async () => {
    const root = await temporary();
    const id = "skill-z17";
    const skill = `---\nname: ${id}\ndescription: 큐의 중복·유실 분석에 적용하고 일반 설명에는 적용하지 않는다.\nmetadata:\n  version: '1.0.0'\n---\n`;
    const span = { path: `skills/${id}/SKILL.md`, startLine: 3, endLine: 3, digest: hash(skill) };
    const metadata = { schemaVersion: "1.0.0", taxonomyRevision: "1.0.0", actions: ["read-only-analysis"], targets: ["message-queue"], constraints: [], dependencies: [], capabilities: ["concurrency-analysis"], applicability: [span], exclusions: [span] };
    const files = new Map([["skills/registry.json", Buffer.from('{"schemaVersion":"2.0.0","skills":[]}')], [`skills/${id}/SKILL.md`, Buffer.from(skill)], [`skills/${id}/classification.json`, Buffer.from(JSON.stringify(metadata))]]);
    await writeMap(root, files);
    const canonical = await generator.readClassificationSources(root, [`skills/${id}/SKILL.md`]);
    generator.projectClassificationSources(files, canonical);
    await writeMap(root, files);
    expect((await loadSkillInventory({ root })).skills[0]).toMatchObject({ skillId: id, capabilities: ["concurrency-analysis"], installed: true, hostSupported: true });
    expect((await loadSkillInventory({ root })).issues).toEqual([]);
  });
});
