import {createHash} from "node:crypto";
import {mkdir, mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {afterEach, describe, expect, it} from "vitest";
import {loadHostObservedInventory, type HostSkillDiscoverySnapshot} from "../../mcp-server/src/skill-classification/host-discovery-adapter.js";
import {loadSkillInventory} from "../../mcp-server/src/skill-classification/inventory.js";

const roots: string[] = [];
const now = new Date("2026-10-09T00:00:00.000Z");
afterEach(async () => {await Promise.all(roots.splice(0).map(root => rm(root, {recursive: true, force: true})));});
async function fixture(id: string, disabled = false) {
  const root = await mkdtemp(path.join(tmpdir(), "ags-host-observed-")); roots.push(root);
  const directory = path.join(root, "skills", id); await mkdir(directory, {recursive: true});
  const bytes = `---\nname: ${id}\ndescription: Read-only concurrency analysis, excluding implementation.\nmetadata:\n  version: "1.0.0"\n---\n\nAnalyze queue invariants without modifying files.\nExclude general implementation tasks.\n`;
  await writeFile(path.join(directory, "SKILL.md"), bytes);
  const source = {path: `skills/${id}/SKILL.md`, startLine: 8, endLine: 9, digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`};
  await writeFile(path.join(directory, "classification.json"), JSON.stringify({schemaVersion: "1.0.0", taxonomyRevision: "1.0.0", actions: ["read-only-analysis"], targets: ["queue"], constraints: ["no-modification"], dependencies: [], capabilities: ["concurrency-analysis"], applicability: [source], exclusions: [source]}));
  await writeFile(path.join(root, "skills/registry.json"), JSON.stringify({schemaVersion: "2.0.0", skills: disabled ? [{skillId: id, version: "1.0.0", path: `./${id}`, enabled: false,
    providers: [{capabilities: ["concurrency-analysis"], phase: "analysis", phaseOrder: 10, requiredInputArtifacts: [], inputBindings: [], producedArtifacts: [], gate: {kind: "none", policy: "none"}}]}] : []}));
  return {root, directory};
}
function snapshot(id = "neutral-k7"): HostSkillDiscoverySnapshot {
  return {schemaVersion: "1.0.0", sourceRef: "fixture:host-snapshot", revision: "r1", observedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 300_000).toISOString(),
    skills: [{skillId: id, installed: true, hostSupported: true, enabled: true, root: null}]};
}
describe("trusted host discovery adapter source and freshness boundaries", () => {
  it("discovers a neutral external installed root dynamically and preserves canonical source evidence", async () => {
    const local = await fixture("neutral-k7"), external = await fixture("neutral-w29"), host = snapshot();
    host.skills.push({...snapshot("neutral-w29").skills[0]!, root: external.directory});
    const result = await loadHostObservedInventory({root: local.root, observeHostSkills: async () => host, now: () => now});
    expect(result.discovery.status).toBe("COMPLETE");
    expect(result.inventory.skills.map(skill => skill.skillId)).toEqual(["neutral-k7", "neutral-w29"]);
    expect(result.inventory.skills[1]).toMatchObject({actions: ["read-only-analysis"], installed: true, hostSupported: true, enabled: true});
    expect(result.inventory.skills[1]!.sourceRefs.some(ref => ref.path.includes(external.directory.replaceAll("\\", "/")) && ref.digest.startsWith("sha256:"))).toBe(true);
  });
  it("host enablement cannot override a disabled registry policy", async () => {
    const local = await fixture("neutral-k7", true);
    const result = await loadHostObservedInventory({root: local.root, observeHostSkills: async () => snapshot(), now: () => now});
    expect(result.discovery.status).toBe("COMPLETE"); expect(result.inventory.skills[0]!.enabled).toBe(false);
  });
  it("an explicit empty host snapshot retains local candidates as unavailable rather than assuming installation", async () => {
    const local = await fixture("neutral-k7"), host = snapshot(); host.skills = [];
    const result = await loadHostObservedInventory({root: local.root, observeHostSkills: async () => host, now: () => now});
    expect(result.discovery.status).toBe("COMPLETE"); expect(result.inventory.skills[0]).toMatchObject({installed: false, hostSupported: false, enabled: false});
  });
  it("refreshing observation identity fences operations but preserves qualification for unchanged inventory", async () => {
    const local = await fixture("neutral-k7"), host = snapshot();
    const first = await loadHostObservedInventory({root: local.root, observeHostSkills: async () => host, now: () => now});
    // Existing qualified workloads remain valid when observed effective flags agree.
    expect(first.inventory.inventoryDigest).toBe((await loadSkillInventory({root: local.root})).inventoryDigest);
    host.revision = "r2"; host.expiresAt = new Date(now.getTime() + 600_000).toISOString();
    const second = await loadHostObservedInventory({root: local.root, observeHostSkills: async () => host, now: () => now});
    expect(second.inventory.inventoryDigest).toBe(first.inventory.inventoryDigest); expect(second.observationDigest).not.toBe(first.observationDigest);
    host.skills[0]!.enabled = false;
    const third = await loadHostObservedInventory({root: local.root, observeHostSkills: async () => host, now: () => now});
    expect(third.inventory.inventoryDigest).not.toBe(second.inventory.inventoryDigest);
  });
  it("snapshot order is irrelevant to the bound observation", async () => {
    const local = await fixture("neutral-k7"), host = snapshot();
    host.skills.push({...snapshot("neutral-uninstalled").skills[0]!, installed: false, hostSupported: false});
    const first = await loadHostObservedInventory({root: local.root, observeHostSkills: async () => host, now: () => now}); host.skills.reverse();
    const second = await loadHostObservedInventory({root: local.root, observeHostSkills: async () => host, now: () => now});
    expect(second.observationDigest).toBe(first.observationDigest); expect(second.inventory.inventoryDigest).toBe(first.inventory.inventoryDigest);
  });
  it.each(["duplicate", "expired", "future", "relative-root", "extra-field"])("invalid %s host observation cannot claim host completeness", async kind => {
    const local = await fixture("neutral-k7"), host = snapshot();
    if (kind === "duplicate") host.skills.push({...host.skills[0]!});
    else if (kind === "expired") host.expiresAt = now.toISOString();
    else if (kind === "future") host.observedAt = new Date(now.getTime() + 1).toISOString();
    else if (kind === "relative-root") host.skills[0]!.root = "relative/unapproved";
    else Object.assign(host, {inventedSelection: ["neutral-k7"]});
    const result = await loadHostObservedInventory({root: local.root, observeHostSkills: async () => host, now: () => now});
    expect(result.discovery).toEqual({status: "UNAVAILABLE", scope: "local-tree", sourceRef: null, revision: null});
    expect(result.observationDigest).toBeNull(); expect(result.inventory.issues).toContainEqual({skillId: null, code: "HOST_DISCOVERY_UNAVAILABLE", field: "hostDiscovery"});
  });
  it("checks snapshot time after awaited observation so fresh dynamic host results are accepted", async () => {
    const local = await fixture("neutral-k7"), host = snapshot(); let clock = now;
    const result = await loadHostObservedInventory({root: local.root, observeHostSkills: async () => {
      await Promise.resolve(); clock = new Date(now.getTime() + 1); host.observedAt = clock.toISOString(); return host;
    }, now: () => clock});
    expect(result.discovery.status).toBe("COMPLETE");
  });
  it("expired-during-observation and thrown private causes stay unavailable without raw disclosure", async () => {
    const local = await fixture("neutral-k7"), host = snapshot(); let clock = now;
    const expired = await loadHostObservedInventory({root: local.root, observeHostSkills: async () => {
      await Promise.resolve(); clock = new Date(host.expiresAt); return host;
    }, now: () => clock});
    expect(expired.discovery.status).toBe("UNAVAILABLE");
    const thrown = await loadHostObservedInventory({root: local.root, observeHostSkills: async () => {throw new Error("PRIVATE_SOURCE_SECRET");}, now: () => now});
    expect(thrown.discovery.status).toBe("UNAVAILABLE"); expect(JSON.stringify(thrown)).not.toContain("PRIVATE_SOURCE_SECRET");
  });
  it("malformed, oversized and missing approved snapshot files cannot fall back to complete host claims", async () => {
    const local = await fixture("neutral-k7"), file = path.join(local.root, "host.json");
    for (const bytes of ["PRIVATE_MALFORMED_JSON", " ".repeat(1024 * 1024 + 1)]) {
      await writeFile(file, bytes);
      const result = await loadHostObservedInventory({root: local.root, hostDiscoveryRef: file, now: () => now});
      expect(result.discovery.status).toBe("UNAVAILABLE"); expect(JSON.stringify(result)).not.toContain("PRIVATE_MALFORMED_JSON");
    }
    await rm(file);
    expect((await loadHostObservedInventory({root: local.root, hostDiscoveryRef: file, now: () => now})).discovery.status).toBe("UNAVAILABLE");
  });
});
