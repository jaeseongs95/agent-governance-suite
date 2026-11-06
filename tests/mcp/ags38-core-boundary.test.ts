import {createHash} from "node:crypto";
import {mkdtemp, mkdir, writeFile, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {build} from "esbuild";
import {afterEach, describe, expect, it, vi} from "vitest";
import {RuntimeSkillClassificationGateway} from "../../mcp-server/src/skill-classification/gateway.js";
import {InMemoryClassificationBudget, SkillClassificationService} from "../../mcp-server/src/skill-classification/service.js";

const host = vi.hoisted(() => ({output: "[]", error: false}));
vi.mock("node:child_process", async importOriginal => ({...await importOriginal<typeof import("node:child_process")>(), execFile: (_file: string, _args: string[], _options: unknown, callback: (error: Error | null, stdout: string) => void) => {
  callback(host.error ? new Error("PRIVATE_HOST_CAUSE") : null, host.output);
}}));
const roots: string[] = [];
afterEach(async () => {vi.unstubAllEnvs(); host.error = false; await Promise.all(roots.splice(0).map(root => rm(root, {recursive: true, force: true})));});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "ags38-core-boundary-")); roots.push(root);
  const dir = path.join(root, "skills", "neutral-review"); await mkdir(dir, {recursive: true});
  await mkdir(path.join(root, ".claude-plugin"));
  await writeFile(path.join(root, ".claude-plugin/plugin.json"), JSON.stringify({name: "neutral-plugin", version: "1.0.0"}));
  const content = "---\nname: neutral-review\ndescription: Review a fixed patch; exclude implementation.\nmetadata:\n  version: '1.0.0'\n---\nReview a fixed patch.\nExclude implementation.\n";
  await writeFile(path.join(dir, "SKILL.md"), content);
  const source = {path: "skills/neutral-review/SKILL.md", startLine: 8, endLine: 9, digest: `sha256:${createHash("sha256").update(content).digest("hex")}`};
  await writeFile(path.join(dir, "classification.json"), JSON.stringify({schemaVersion: "1.0.0", taxonomyRevision: "1.0.0", actions: ["review"], targets: ["patch"], constraints: [], dependencies: [], applicability: [source], exclusions: [source]}));
  await writeFile(path.join(root, "skills/registry.json"), JSON.stringify({schemaVersion: "2.0.0", skills: []}));
  const listed = (enabled = true, installPath = root, version = "1.0.0") => {host.output = JSON.stringify([{id: "neutral-plugin@fixture", version, enabled, scope: "user", installPath}]);};
  listed(); vi.stubEnv("AGENT_GOVERNANCE_HOST_ATTESTATION", "claude-code");
  const gateway = new RuntimeSkillClassificationGateway({root,
    service: new SkillClassificationService({providers: {}, budget: new InMemoryClassificationBudget({jev: {limitUsd: null, spentUsd: null}, vendors: {}})}),
    readRuntime: async () => ({config: {jevEnabled: false, mode: "select", providerProfileRegistryRef: "unconfigured", externalClassificationAllowed: false, configRevision: "fixture", timeoutMs: 1000}, registry: {schemaVersion: "1.0.0", profileRevision: "fixture", profiles: []}, allowRemotePrivateContent: false})});
  return {gateway, root, listed};
}

describe("AGS3 D0007 and D0013 core/host boundaries", () => {
  it("CB-01 bundles provider core without security skill scripts", async () => {
    const root = fileURLToPath(new URL("../../", import.meta.url));
    await expect(build({entryPoints: [path.join(root, "mcp-server/src/provider-semantics.ts")], bundle: true, platform: "node", format: "esm", write: false,
      plugins: [{name: "unavailable-security-skill", setup(builder) {builder.onResolve({filter: /software-security-auditor[\\/]scripts[\\/]/}, () => ({errors: [{text: "security skill implementation unavailable"}]}));}}], logLevel: "silent"})).resolves.toMatchObject({errors: []});
  });
  it("CB-02 observes installed skills through the default production gateway", async () => {
    const {gateway} = await fixture();
    expect(await gateway.inventory()).toMatchObject({discovery: {status: "COMPLETE", scope: "host"}, skills: [{skillId: "neutral-review", installed: true, enabled: true, hostSupported: true}]});
  });
  it("CB-03 and CB-06 preserve host disablement and detect changes without volatile revisions", async () => {
    const {gateway, listed} = await fixture(); const first = await gateway.inventory(); const second = await gateway.inventory();
    expect(second).toMatchObject({discovery: {status: "COMPLETE", revision: first.discovery.revision}, inventoryDigest: first.inventoryDigest});
    listed(false); const disabled = await gateway.inventory();
    expect(disabled).toMatchObject({discovery: {status: "COMPLETE"}, skills: [{installed: true, enabled: false, hostSupported: true}]});
    expect(disabled.inventoryDigest).not.toBe(first.inventoryDigest);
  });
  it.each(["throw", "malformed", "unsupported"])("CB-04 keeps %s observations unavailable", async kind => {
    const {gateway} = await fixture();
    if (kind === "throw") host.error = true; else if (kind === "malformed") host.output = "PRIVATE_INVALID_JSON"; else vi.stubEnv("AGENT_GOVERNANCE_HOST_ATTESTATION", "neutral-unsupported-host");
    const inventory = await gateway.inventory();
    expect(inventory.discovery.status).toBe("UNAVAILABLE"); expect(inventory.issues).toContainEqual({skillId: null, code: "HOST_DISCOVERY_UNAVAILABLE", field: "hostDiscovery"});
    expect(JSON.stringify(inventory)).not.toContain("PRIVATE_");
  });
  it.each(["path", "version"])("CB-05 rejects a changed installation %s", async kind => {
    const {gateway, root, listed} = await fixture(); listed(true, kind === "path" ? path.dirname(root) : root, kind === "version" ? "9.9.9" : "1.0.0");
    expect((await gateway.inventory()).discovery.status).toBe("UNAVAILABLE");
  });
});
