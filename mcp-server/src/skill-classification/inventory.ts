import { createHash } from "node:crypto";
import { readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { SkillInventory, SkillMetadata } from "./types.js";
import { digestClassificationValue } from "./request.js";

const strings = z.array(z.string().min(1));
const span = z.object({ path: z.string().min(1), startLine: z.number().int().positive(), endLine: z.number().int().positive(), digest: z.string().regex(/^sha256:[a-f0-9]{64}$/) }).strict();
const classification = z.object({
  schemaVersion: z.literal("1.0.0"), taxonomyRevision: z.string().min(1),
  actions: strings.min(1), targets: strings.min(1), constraints: strings, dependencies: strings,
  capabilities: strings.optional(), applicability: z.array(span).min(1), exclusions: z.array(span).min(1),
}).strict();
const provider = z.object({
  capabilities: strings.min(1), phase: z.string().min(1), phaseOrder: z.number().int(),
  requiredInputArtifacts: strings, producedArtifacts: strings,
  inputBindings: z.array(z.object({ targetArtifact: z.string(), sources: strings, operation: z.string() }).passthrough()),
  gate: z.record(z.string(), z.unknown()),
}).passthrough();
const descriptor = z.object({ skillId: z.string().min(1), version: z.string().min(1), path: z.string(), enabled: z.boolean(), providers: z.array(provider).min(1), dependencies: strings.optional() }).passthrough();
const projectionPath = "skills/classification-projection.json";
const projectionSource = z.object({ path: z.string().min(1).max(4096), digest: z.string().regex(/^sha256:[a-f0-9]{64}$/) }).strict();
const projectionSchema = z.object({
  schemaVersion: z.literal("1.0.0"), projectionRevision: z.literal("1.0.0"), host: z.literal("claude-code"),
  installedSkillIds: strings, canonicalSources: z.array(projectionSource.extend({ content: z.string().max(1024 * 1024) })).min(1).max(1000),
  hostSources: z.array(projectionSource).min(1).max(1000),
}).strict();

export interface InventoryOptions {
  root: string;
  /** These are host discovery observations; omission means this installed tree. */
  installedSkillIds?: string[];
  hostSupportedSkillIds?: string[];
  /** Approved host-discovered individual skill directories containing SKILL.md. */
  externalSkillRoots?: string[];
}

/** A deliberately narrow reader for the scalar fields in the existing SKILL frontmatter. */
function frontmatter(text: string): { name: string; description: string; version: string | null; descriptionStart: number; descriptionEnd: number } {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  if (lines[0] !== "---") throw new Error("INVALID_FRONTMATTER");
  const end = lines.indexOf("---", 1);
  if (end < 0) throw new Error("INVALID_FRONTMATTER");
  const scalar = (value: string): string => {
    const clean = value.trim();
    if (clean.startsWith('"')) return JSON.parse(clean) as string;
    if (clean.startsWith("'")) return clean.slice(1, -1).replace(/''/g, "'");
    return clean;
  };
  const value = (key: string, indent = ""): string | null => {
    const matching = lines.slice(1, end).filter((item) => item.startsWith(`${indent}${key}:`));
    if (matching.length > 1) throw new Error("DUPLICATE_FRONTMATTER_FIELD");
    const line = matching[0];
    return line ? scalar(line.slice(indent.length + key.length + 1)) : null;
  };
  const start = lines.findIndex((line, index) => index > 0 && index < end && line.startsWith("description:"));
  if (start < 0) throw new Error("MISSING_DESCRIPTION");
  const raw = lines[start]!.slice("description:".length).trim();
  let stop = start + 1;
  let description = scalar(raw);
  if (/^[>|][-+]?\s*$/.test(raw)) {
    while (stop < end && (/^\s/.test(lines[stop]!) || lines[stop] === "")) stop++;
    const body = lines.slice(start + 1, stop).map((line) => line.replace(/^ {2}/, ""));
    description = raw.startsWith(">") ? body.join(" ").trim() : body.join("\n").trim();
  }
  const name = value("name");
  if (!name || !description) throw new Error("MISSING_FRONTMATTER_FIELD");
  if (lines.slice(1, end).filter((line) => line.startsWith("description:")).length > 1) throw new Error("DUPLICATE_FRONTMATTER_FIELD");
  const metadataVersion = value("version", "  ");
  const rootVersion = value("version");
  if (metadataVersion && rootVersion && metadataVersion !== rootVersion) throw new Error("SOURCE_CONFLICT");
  return { name, description, version: metadataVersion ?? rootVersion, descriptionStart: start + 1, descriptionEnd: stop };
}

function byteDigest(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** Re-read the full tree on each call: no cached descriptor can outlive its source bytes. */
async function readInventory(options: InventoryOptions, directSkillDirectory = false): Promise<SkillInventory> {
  const root = await realpath(options.root);
  const skillsRoot = directSkillDirectory ? path.dirname(root) : path.join(root, "skills");
  const directPrefix = `skills/${path.basename(root)}/`;
  let projection: z.infer<typeof projectionSchema> | null = null;
  const canonicalFiles = new Map<string, Buffer>();
  const tracePath = (relative: string): string => directSkillDirectory ? path.join(root, relative.slice(directPrefix.length)).replaceAll("\\", "/") : relative.startsWith("host:") ? relative.slice(5) : projection && relative !== projectionPath ? `canonical:${relative}` : relative;
  const issues: SkillInventory["issues"] = [];
  const skills: SkillMetadata[] = [];
  const allSources = new Map<string, string>();
  const readActual = async (relative: string, sourceKey = relative): Promise<Buffer> => {
    if (directSkillDirectory && !relative.startsWith(directPrefix)) throw new Error("SOURCE_PATH_INVALID");
    const resolved = path.resolve(root, directSkillDirectory ? relative.slice(directPrefix.length) : relative);
    if (path.isAbsolute(relative) || path.relative(root, resolved).startsWith("..") || relative.includes("\\")) throw new Error("SOURCE_PATH_INVALID");
    const actual = await realpath(resolved);
    if (path.relative(root, actual).startsWith("..")) throw new Error("SOURCE_PATH_INVALID");
    const bytes = await readFile(actual);
    const digest = byteDigest(bytes);
    if (allSources.has(sourceKey) && allSources.get(sourceKey) !== digest) throw new Error("SOURCE_CHANGED_DURING_LOAD");
    allSources.set(sourceKey, digest);
    return bytes;
  };
  const read = async (relative: string): Promise<Buffer> => {
    if (!projection) return readActual(relative);
    const bytes = canonicalFiles.get(relative);
    if (!bytes) throw new Error("CANONICAL_SOURCE_MISSING");
    allSources.set(relative, byteDigest(bytes));
    return bytes;
  };
  const add = (skillId: string | null, code: string, field: string): void => { issues.push({ skillId, code, field }); };
  if (!directSkillDirectory) {
    let projectionBytes: Buffer | null = null;
    try { projectionBytes = await readActual(projectionPath); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") add(null, "PROJECTION_UNAVAILABLE", projectionPath); }
    if (projectionBytes) try {
      if (projectionBytes.length > 8 * 1024 * 1024) throw new Error("PROJECTION_TOO_LARGE");
      projection = projectionSchema.parse(JSON.parse(projectionBytes.toString("utf8")));
      const safePath = (relative: string): boolean => relative.startsWith("skills/") && relative !== projectionPath && !relative.includes("\\") && !relative.includes(":") && relative.split("/").every((part) => part && part !== "." && part !== "..");
      for (const source of projection.canonicalSources) {
        if (!safePath(source.path) || canonicalFiles.has(source.path)) throw new Error("PROJECTION_SOURCE_CONFLICT");
        const bytes = Buffer.from(source.content, "utf8");
        if (byteDigest(bytes) !== source.digest) throw new Error("CANONICAL_SOURCE_STALE");
        canonicalFiles.set(source.path, bytes);
      }
      if (!canonicalFiles.has("skills/registry.json")) throw new Error("CANONICAL_SOURCE_MISSING");
      const canonicalIds = [...canonicalFiles.keys()].filter((file) => /^skills\/[^/]+\/SKILL\.md$/.test(file)).map((file) => file.split("/")[1]!);
      if (new Set(projection.installedSkillIds).size !== projection.installedSkillIds.length || projection.installedSkillIds.some((id) => !canonicalIds.includes(id))) throw new Error("PROJECTION_MEMBERSHIP_CONFLICT");
      const actualIds = (await readdir(skillsRoot, { withFileTypes: true })).filter((item) => item.isDirectory()).map((item) => item.name).sort();
      if (JSON.stringify(actualIds) !== JSON.stringify([...projection.installedSkillIds].sort())) throw new Error("PROJECTION_MEMBERSHIP_CONFLICT");
      const hostPaths = new Set<string>();
      for (const source of projection.hostSources) {
        if (!safePath(source.path) || !canonicalFiles.has(source.path) || hostPaths.has(source.path)) throw new Error("PROJECTION_SOURCE_CONFLICT");
        hostPaths.add(source.path);
        if (byteDigest(await readActual(source.path, `host:${source.path}`)) !== source.digest) throw new Error("HOST_SOURCE_STALE");
      }
      const expectedHostPaths = [...canonicalFiles.keys()].filter((file) => file === "skills/registry.json" || projection!.installedSkillIds.includes(file.split("/")[1]!));
      if (JSON.stringify([...hostPaths].sort()) !== JSON.stringify(expectedHostPaths.sort())) throw new Error("PROJECTION_MEMBERSHIP_CONFLICT");
      for (const id of canonicalIds) if (!canonicalFiles.has(`skills/${id}/classification.json`)) throw new Error("CANONICAL_SOURCE_MISSING");
    } catch (error) {
      const code = error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : "PROJECTION_INVALID";
      add(null, code, projectionPath);
      return { skills: [], issues, taxonomyRevision: "invalid", inventoryDigest: digestClassificationValue({ issues, sources: [...allSources] }) };
    }
    if (issues.length) return { skills: [], issues, taxonomyRevision: "invalid", inventoryDigest: digestClassificationValue({ issues, sources: [...allSources] }) };
  }
  const registry = new Map<string, z.infer<typeof descriptor>>();
  const duplicateIds = new Set<string>();
  if (!directSkillDirectory) try {
    const raw = JSON.parse((await read("skills/registry.json")).toString("utf8")) as { schemaVersion?: unknown; skills?: unknown };
    if (raw.schemaVersion !== "2.0.0" || !Array.isArray(raw.skills)) throw new Error("INVALID_REGISTRY");
    for (const candidate of raw.skills) {
      const parsed = descriptor.safeParse(candidate);
      if (!parsed.success) { add(null, "INVALID_REGISTRY_DESCRIPTOR", "registry"); continue; }
      const entry = parsed.data;
      if (registry.has(entry.skillId)) { duplicateIds.add(entry.skillId); add(entry.skillId, "DUPLICATE_ID", "registry.skillId"); }
      registry.set(entry.skillId, entry);
    }
  } catch { add(null, "MISSING_OR_INVALID_REGISTRY", "registry"); }
  const directories = directSkillDirectory ? [path.basename(root)] : projection ? [...canonicalFiles.keys()].filter((file) => /^skills\/[^/]+\/SKILL\.md$/.test(file)).map((file) => file.split("/")[1]!).sort() : (await readdir(skillsRoot, { withFileTypes: true })).filter((item) => item.isDirectory()).map((item) => item.name).sort();
  const names = new Set<string>();
  const revisions = new Set<string>();
  for (const directory of directories) {
    const base = `skills/${directory}`;
    let currentField = "SKILL.md";
    try {
      const skillBytes = await read(`${base}/SKILL.md`);
      const head = frontmatter(skillBytes.toString("utf8"));
      if (names.has(head.name)) { duplicateIds.add(head.name); add(head.name, "DUPLICATE_ID", "frontmatter.name"); }
      names.add(head.name);
      if (head.name !== directory) { add(directory, "SOURCE_CONFLICT", "frontmatter.name"); continue; }
      const entry = registry.get(directory);
      if (entry && (entry.path !== `./${directory}` || (head.version !== null && head.version !== entry.version))) {
        add(directory, "SOURCE_CONFLICT", "registry.path/version"); continue;
      }
      currentField = "classification.json";
      const metadataPath = `${base}/classification.json`;
      const metadata = classification.parse(JSON.parse((await read(metadataPath)).toString("utf8")));
      revisions.add(metadata.taxonomyRevision);
      const sourceMap: NonNullable<SkillMetadata["sourceMap"]> = [
        { field: "skillId", path: entry ? "skills/registry.json" : `${base}/SKILL.md`, digest: entry ? allSources.get("skills/registry.json")! : byteDigest(skillBytes) },
        { field: "description", path: `${base}/SKILL.md`, startLine: head.descriptionStart, endLine: head.descriptionEnd, digest: byteDigest(skillBytes) },
        ...(entry ? ["version", "enabled", "capabilities", "phases"] : ["version"]).map((field) => ({ field, path: entry ? "skills/registry.json" : `${base}/SKILL.md`, digest: entry ? allSources.get("skills/registry.json")! : byteDigest(skillBytes) })),
        ...["actions", "targets", "constraints", "dependencies", "taxonomyRevision"].map((field) => ({ field, path: metadataPath, digest: allSources.get(metadataPath)! })),
      ];
      if (!entry) sourceMap.push({ field: "capabilities", path: metadataPath, digest: allSources.get(metadataPath)! });
      if (entry?.dependencies) {
        sourceMap.find((source) => source.field === "dependencies")!.path = "skills/registry.json";
        sourceMap.find((source) => source.field === "dependencies")!.digest = allSources.get("skills/registry.json")!;
      }
      const sourceRefs = new Map<string, string>([[`${base}/SKILL.md`, byteDigest(skillBytes)], [metadataPath, allSources.get(metadataPath)!]]);
      if (entry) sourceRefs.set("skills/registry.json", allSources.get("skills/registry.json")!);
      const resolveSpans = async (spans: z.infer<typeof span>[], field: string): Promise<string[]> => {
        currentField = field;
        const result: string[] = [];
        for (const source of spans) {
          if (!source.path.startsWith(`${base}/`)) throw new Error("SOURCE_PATH_INVALID");
          const bytes = await read(source.path);
          const digest = byteDigest(bytes);
          if (source.digest !== digest) throw new Error("STALE_SOURCE");
          const lines = bytes.toString("utf8").split(/\r?\n/);
          if (source.endLine < source.startLine || source.endLine > lines.length) throw new Error("SOURCE_RANGE_INVALID");
          const value = lines.slice(source.startLine - 1, source.endLine).join("\n").trim();
          if (!value) throw new Error("MISSING_APPLICABILITY_OR_EXCLUSION");
          result.push(value);
          sourceRefs.set(source.path, digest);
          sourceMap.push({ field, ...source });
        }
        return result;
      };
      const applicability = await resolveSpans(metadata.applicability, "applicability");
      const exclusions = await resolveSpans(metadata.exclusions, "exclusions");
      const capabilities = entry ? [...new Set(entry.providers.flatMap((item) => item.capabilities))] : metadata.capabilities;
      if (!capabilities?.length || (!entry && !head.version)) throw new Error("MISSING_CAPABILITY_OR_VERSION");
      if (entry && metadata.capabilities && digestClassificationValue(capabilities) !== digestClassificationValue(metadata.capabilities)) throw new Error("SOURCE_CONFLICT");
      if (entry?.dependencies && digestClassificationValue(entry.dependencies) !== digestClassificationValue(metadata.dependencies)) throw new Error("SOURCE_CONFLICT");
      skills.push({
        skillId: directory, version: entry?.version ?? head.version!, description: head.description,
        enabled: entry?.enabled ?? true, installed: (options.installedSkillIds?.includes(directory) ?? true) && (projection?.installedSkillIds.includes(directory) ?? true),
        hostSupported: (options.hostSupportedSkillIds?.includes(directory) ?? true) && (projection?.installedSkillIds.includes(directory) ?? true),
        capabilities, actions: metadata.actions, targets: metadata.targets, constraints: metadata.constraints,
        applicability, exclusions, dependencies: entry?.dependencies ?? metadata.dependencies,
        phases: entry?.providers.flatMap((item) => item.capabilities.map((capability) => ({ capability, phase: item.phase, phaseOrder: item.phaseOrder, requiredInputArtifacts: item.requiredInputArtifacts, producedArtifacts: item.producedArtifacts, inputBindings: item.inputBindings, gate: item.gate }))) ?? [],
        sourceRefs: [...sourceRefs].sort(([a], [b]) => a.localeCompare(b)).map(([sourcePath, digest]) => ({ path: tracePath(sourcePath), digest })).concat(projection ? [{ path: projectionPath, digest: allSources.get(projectionPath)! }, ...[...allSources].filter(([sourcePath]) => sourcePath === `host:${base}/SKILL.md` || sourcePath === "host:skills/registry.json").map(([sourcePath, digest]) => ({ path: tracePath(sourcePath), digest }))] : []),
        sourceMap: sourceMap.map((source) => ({ ...source, path: tracePath(source.path) })).concat(projection ? [{ field: "hostProjection", path: projectionPath, digest: allSources.get(projectionPath)! }] : []),
      });
    } catch (error) {
      const code = error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : "MISSING_OR_INVALID_METADATA";
      add(directory, code, currentField);
    }
  }
  for (const id of registry.keys()) if (!names.has(id)) add(id, "REGISTRY_SKILL_MISSING", "SKILL.md");
  const valid = skills.filter((skill) => !duplicateIds.has(skill.skillId));
  for (const skill of valid) for (const dependency of skill.dependencies) if (!valid.some((candidate) => candidate.skillId === dependency && candidate.enabled && candidate.installed && candidate.hostSupported)) add(skill.skillId, "DEPENDENCY_UNAVAILABLE", "dependencies");
  if (revisions.size !== 1) add(null, "TAXONOMY_REVISION_CONFLICT", "taxonomyRevision");
  const taxonomyRevision = revisions.size === 1 ? [...revisions][0]! : "invalid";
  const sources = [...allSources].sort(([a], [b]) => a.localeCompare(b)).map(([sourcePath, digest]) => [tracePath(sourcePath), digest]);
  return { skills: valid, issues, taxonomyRevision, inventoryDigest: digestClassificationValue({ skills: valid, taxonomyRevision, issues, sources }) };
}

/** Union local plugin metadata with approved host discovery, without inventing missing taxonomy. */
export async function loadSkillInventory(options: InventoryOptions): Promise<SkillInventory> {
  const inventories = [await readInventory(options)];
  for (const [index, externalRoot] of (options.externalSkillRoots ?? []).entries()) {
    try { inventories.push(await readInventory({ ...options, root: externalRoot }, true)); }
    catch { inventories.push({ skills: [], issues: [{ skillId: null, code: "EXTERNAL_SKILL_UNAVAILABLE", field: `externalSkillRoots[${index}]` }], taxonomyRevision: "invalid", inventoryDigest: digestClassificationValue({ externalRoot, unavailable: true }) }); }
  }
  const issues = inventories.flatMap((inventory) => inventory.issues).filter((issue) => issue.code !== "DEPENDENCY_UNAVAILABLE");
  const candidates = inventories.flatMap((inventory) => inventory.skills);
  const duplicates = new Set(candidates.filter((skill, index) => candidates.findIndex((candidate) => candidate.skillId === skill.skillId) !== index).map((skill) => skill.skillId));
  for (const id of duplicates) issues.push({ skillId: id, code: "DUPLICATE_ID", field: "externalSkillRoots" });
  const skills = candidates.filter((skill) => !duplicates.has(skill.skillId));
  for (const id of options.installedSkillIds ?? []) if (!skills.some((skill) => skill.skillId === id) && !issues.some((issue) => issue.skillId === id)) issues.push({ skillId: id, code: "INSTALLED_SKILL_UNEXPOSED", field: "installedSkillIds" });
  for (const skill of skills) for (const id of skill.dependencies) if (!skills.some((candidate) => candidate.skillId === id && candidate.enabled && candidate.installed && candidate.hostSupported)) issues.push({ skillId: skill.skillId, code: "DEPENDENCY_UNAVAILABLE", field: "dependencies" });
  const revisions = new Set(inventories.filter((inventory) => inventory.skills.length).map((inventory) => inventory.taxonomyRevision));
  if (revisions.size > 1) issues.push({ skillId: null, code: "TAXONOMY_REVISION_CONFLICT", field: "taxonomyRevision" });
  const taxonomyRevision = revisions.size === 1 ? [...revisions][0]! : inventories[0]!.taxonomyRevision;
  const inventoryDigest = digestClassificationValue({ skills, issues, taxonomyRevision, sourceInventoryDigests: inventories.map((inventory) => inventory.inventoryDigest) });
  return { skills, issues, taxonomyRevision, inventoryDigest };
}
