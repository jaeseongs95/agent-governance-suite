import {readFile} from "node:fs/promises";
import {createHash} from "node:crypto";
import path from "node:path";
import {z} from "zod";
import {loadSkillInventory} from "./inventory.js";
import {digestClassificationValue} from "./request.js";
import type {SkillInventory} from "./types.js";

const text = z.string().min(1).max(4096);
const hostSnapshotSchema = z.strictObject({
  schemaVersion: z.literal("1.0.0"), sourceRef: text, revision: text, observedAt: z.iso.datetime(), expiresAt: z.iso.datetime(),
  skills: z.array(z.strictObject({
    skillId: text, enabled: z.boolean(), installed: z.boolean(), hostSupported: z.boolean(),
    root: text.refine(value => path.isAbsolute(value) && !value.includes("\0")).nullable(),
  })).max(1000),
});
export type HostSkillDiscoverySnapshot = z.infer<typeof hostSnapshotSchema>;
export interface HostInventoryDiscovery {
  status: "COMPLETE" | "INCOMPLETE" | "UNAVAILABLE";
  scope: "host" | "local-tree";
  sourceRef: string | null;
  revision: string | null;
}
export interface ObservedHostInventory {
  inventory: SkillInventory;
  discovery: HostInventoryDiscovery;
  observationDigest: string | null;
  expiresAt: string | null;
  /** Exact loader-read bytes, separate from semantic inventory and host-provided sourceRef. */
  sourceRefs: {path: string; digest: string}[];
}

/** Approved installation/host-owned input only, never a classify_skills argument. */
export async function loadHostObservedInventory(options: {
  root: string;
  externalSkillRoots?: string[];
  hostDiscoveryRef?: string | null;
  observeHostSkills?: () => Promise<unknown>;
  now?: () => Date;
}): Promise<ObservedHostInventory> {
  let snapshot: HostSkillDiscoverySnapshot | null = null;
  const sourceRefs: ObservedHostInventory["sourceRefs"] = [];
  try {
    let raw: unknown = null;
    if (options.observeHostSkills) raw = await options.observeHostSkills();
    else if (options.hostDiscoveryRef) {
      const bytes = await readFile(options.hostDiscoveryRef);
      if (bytes.length > 1024 * 1024) throw new Error("HOST_DISCOVERY_TOO_LARGE");
      raw = JSON.parse(bytes.toString("utf8"));
      sourceRefs.push({path: path.resolve(options.hostDiscoveryRef), digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`});
    }
    if (raw !== null) {
      const parsed = hostSnapshotSchema.parse(raw);
      const ids = parsed.skills.map(skill => skill.skillId);
      // Read the clock after the asynchronous host/file observation, not before.
      const now = (options.now?.() ?? new Date()).getTime();
      if (new Set(ids).size !== ids.length || Date.parse(parsed.observedAt) > now
        || Date.parse(parsed.expiresAt) <= now || Date.parse(parsed.expiresAt) <= Date.parse(parsed.observedAt)) throw new Error("HOST_DISCOVERY_INVALID");
      snapshot = parsed;
    }
  } catch { /* Invalid, missing or expired observation remains unavailable; never expose raw causes. */ }
  const externalSkillRoots = [...new Set([...(options.externalSkillRoots ?? []), ...(snapshot?.skills.flatMap(skill => skill.installed && skill.root ? [skill.root] : []) ?? [])])];
  const inventory = await loadSkillInventory({root: options.root, ...(externalSkillRoots.length ? {externalSkillRoots} : {}),
    ...(snapshot ? {installedSkillIds: snapshot.skills.filter(skill => skill.installed).map(skill => skill.skillId),
      hostSupportedSkillIds: snapshot.skills.filter(skill => skill.hostSupported).map(skill => skill.skillId)} : {})});
  if (!snapshot) {
    inventory.issues.push({skillId: null, code: "HOST_DISCOVERY_UNAVAILABLE", field: "hostDiscovery"});
    inventory.inventoryDigest = digestClassificationValue({sourceInventoryDigest: inventory.inventoryDigest, issues: inventory.issues});
    return {inventory, discovery: {status: "UNAVAILABLE", scope: "local-tree", sourceRef: null, revision: null}, observationDigest: null, expiresAt: null, sourceRefs: []};
  }
  const observed = new Map(snapshot.skills.map(skill => [skill.skillId, skill]));
  // Membership remains in InventoryOptions. Host enablement intersects registry policy;
  // retaining disabled candidates preserves needed vs runnable instead of pruning advice.
  const skills = inventory.skills.map(skill => ({...skill, enabled: skill.enabled && (observed.get(skill.skillId)?.enabled ?? false)}));
  // Refreshing observation time/revision fences an operation without changing the
  // workload qualification digest when the effective inventory itself is unchanged.
  if (skills.some((skill, index) => skill.enabled !== inventory.skills[index]!.enabled)) {
    inventory.inventoryDigest = digestClassificationValue({sourceInventoryDigest: inventory.inventoryDigest, skills, issues: inventory.issues});
  }
  inventory.skills = skills;
  return {inventory, discovery: {status: inventory.issues.length ? "INCOMPLETE" : "COMPLETE", scope: "host", sourceRef: snapshot.sourceRef, revision: snapshot.revision},
    observationDigest: digestClassificationValue({...snapshot, skills: [...snapshot.skills].sort((a, b) => a.skillId.localeCompare(b.skillId))}), expiresAt: snapshot.expiresAt, sourceRefs};
}
