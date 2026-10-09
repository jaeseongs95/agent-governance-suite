import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterAll, expect, it } from "vitest";
import { loadSkillInventory } from "../../mcp-server/src/skill-classification/inventory.js";
import { createClassificationRequest, digestClassificationValue, projectClassificationRequest } from "../../mcp-server/src/skill-classification/request.js";
import { RuntimeSkillClassificationGateway } from "../../mcp-server/src/skill-classification/gateway.js";
import { InMemoryClassificationBudget, SkillClassificationService } from "../../mcp-server/src/skill-classification/service.js";
import { oracleDigest } from "./evaluation.js";
import type { SkillInventory } from "../../mcp-server/src/skill-classification/types.js";

// SS37 ONLY. No fetch, native CLI, provider adapter, selection receipt, or product edits.
const repo = process.cwd();
const out = path.join(repo, ".ss37-artifacts");
const fixtureBytes = await readFile(path.join(repo, "tests/skill-classification/fixtures.json"));
const corpus = JSON.parse(fixtureBytes.toString("utf8"));
const sourceCase = corpus.cases.find((c: any) => c.caseId === "SS37");
const roles = corpus.metadataRoleCases.filter((c: any) => c.variantId.startsWith("SS37-"));
const roots: string[] = [];
const records: any[] = [];
const byteHash = (bytes: string | Buffer) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const ids = (i: SkillInventory) => i.skills.map(s => s.skillId).sort();
const nullContext = {taskRevision: null, objective: null, actions: null, targets: null, constraints: null, prohibitedActions: null, background: null};
const runtime = {
  config: {jevEnabled: false, mode: "select" as const, providerProfileRegistryRef: "offline-empty", externalClassificationAllowed: false, configRevision: "SS37-offline", timeoutMs: 1000},
  registry: {schemaVersion: "1.0.0" as const, profileRevision: "offline-empty", profiles: []},
  allowRemotePrivateContent: false,
};
function gateway(root: string) {
  return new RuntimeSkillClassificationGateway({root, readRuntime: async () => runtime,
    service: new SkillClassificationService({providers: {}, budget: new InMemoryClassificationBudget({jev: {limitUsd: null, spentUsd: null}, vendors: {}})})});
}
const input = (id: string) => ({schemaVersion: "1.0.0", requestId: id, operationId: id,
  originalPrompt: sourceCase.originalPrompt, confirmedContext: nullContext, contextSources: [],
  explicitSkillIds: [], ruleRequiredSkillIds: [], vendorContext: {vendorId: "offline", reference: "SS37-delegation"}, publicSynthetic: true});
function probe(id: string, expected: any, fn: (r: any) => Promise<void>) {
  it(`SS37 ${id}`, async () => {
    const r: any = {id, executionKind: "isolated-offline", expected, observed: null,
      agentSelectedSkillIds: null, hostReceipt: null, stages: {selected: "NOTRUN", read: "NOTRUN", applied: "NOTRUN", verified: "NOTRUN"}, API0: true};
    records.push(r);
    try { await fn(r); r.status = "PASS"; }
    catch (e) { r.status = "FAIL"; r.error = e instanceof Error ? e.message : String(e); throw e; }
  });
}
async function emptyRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), "SS37-")); roots.push(root);
  await mkdir(path.join(root, "skills"));
  await writeFile(path.join(root, "skills/registry.json"), JSON.stringify({schemaVersion: "2.0.0", skills: []}));
  return root;
}
async function treeRoot() {
  const root = await emptyRoot();
  await cp(path.join(repo, "skills"), path.join(root, "skills"), {recursive: true});
  return root;
}
const neutral = {skillId: "skill-z17", capabilities: ["concurrency-analysis"], actions: ["read-only-analysis"], targets: ["message-queue"],
  applicability: ["duplicate and loss invariants"], exclusions: ["general explanation"], dependencies: [], enabled: true};
async function add(root: string, d: any) {
  const directory = path.join(root, "skills", d.skillId); await mkdir(directory, {recursive: true});
  if (d.skillId === "cs-engineering" && !d.capabilities) {
    await cp(path.join(repo, "skills/cs-engineering"), directory, {recursive: true});
    const registry = JSON.parse(await readFile(path.join(repo, "skills/registry.json"), "utf8"));
    const entry = structuredClone(registry.skills.find((s: any) => s.skillId === "cs-engineering")); entry.enabled = false;
    await writeFile(path.join(root, "skills/registry.json"), JSON.stringify({schemaVersion: "2.0.0", skills: [entry]}));
    return;
  }
  // Schema scaffolding is synthetic; semantic fields below are exact frozen descriptors.
  const lines = ["---", `name: ${d.skillId}`, `description: ${JSON.stringify(d.applicability.join("; ") + ". Exclusions: " + d.exclusions.join("; "))}`,
    "metadata:", "  version: \"1.0.0\"", "---", "", ...d.applicability, ...d.exclusions, ""];
  const text = lines.join("\n"); await writeFile(path.join(directory, "SKILL.md"), text);
  const span = (start: number, end: number) => ({path: `skills/${d.skillId}/SKILL.md`, startLine: start, endLine: end, digest: byteHash(text)});
  await writeFile(path.join(directory, "classification.json"), JSON.stringify({schemaVersion: "1.0.0", taxonomyRevision: "1.0.0",
    capabilities: d.capabilities, actions: d.actions, targets: d.targets, constraints: [], dependencies: d.dependencies,
    applicability: [span(8, 7 + d.applicability.length)], exclusions: [span(8 + d.applicability.length, 7 + d.applicability.length + d.exclusions.length)]}));
}
function request(inventory: SkillInventory, id: string, originalPrompt = sourceCase.originalPrompt) {
  return createClassificationRequest({requestId: id, operationId: id, originalPrompt, inventory,
    classificationCriteriaRef: "skills/orchestrator/references/skill-classification.md"});
}
afterAll(async () => {
  await mkdir(out, {recursive: true});
  await writeFile(path.join(out, "SS37.observations.json"), JSON.stringify({caseId: "SS37", sourceCase, metadataRoleCases: roles,
    fixtureSHA: byteHash(fixtureBytes), oracleSHA: oracleDigest(corpus), records,
    executionBoundary: "Actual loader/request/gateway; empty profiles/providers; no semantic classification, host acceptance or execution receipts",
    API: {JEV: 0, externalVendor: 0, Claude: 0}, accuracy: null}, null, 2));
  await Promise.all(roots.map(root => rm(root, {recursive: true, force: true})));
});

probe("frozen-bindings", {fixtureSHA: "sha256:17ade7e27cc11ffee8cc0b7b2070785617861d4c3384448cf24fce75f40d87e9", oracleSHA: "sha256:5db1d67cef8719c40b17b0ab07003f01f765746d34ced0b326e59fadb2efe055", oracle: null}, async r => {
  r.observed = {fixtureSHA: byteHash(fixtureBytes), oracleSHA: oracleDigest(corpus), oracle: sourceCase.oracle, variants: sourceCase.variants};
  expect(r.observed.fixtureSHA).toBe(r.expected.fixtureSHA); expect(r.observed.oracleSHA).toBe(r.expected.oracleSHA);
  expect(sourceCase.oracle).toBeNull(); expect(sourceCase.variants).toHaveLength(8);
});
for (const role of roles) probe(role.variantId.slice(5), {source: "frozen metadataRoleCases", descriptors: role.descriptors, required: role.required, forbidden: role.forbidden,
  structural: "All metadata preserved in inventory and provider projection; selected remains null without host evidence"}, async r => {
  const root = await emptyRoot(); for (const d of role.descriptors) await add(root, d);
  const inventory = await loadSkillInventory({root}); const req = request(inventory, role.variantId, role.prompt);
  const projection = projectClassificationRequest(req); const classified: any = await gateway(root).classify({...input(role.variantId), originalPrompt: role.prompt});
  r.observed = {inventory, request: req, projection, classified};
  expect(inventory.issues).toEqual([]); expect(ids(inventory)).toEqual(role.descriptors.map((d: any) => d.skillId).sort());
  for (const d of role.descriptors) {
    const loaded = inventory.skills.find(s => s.skillId === d.skillId)!;
    expect(loaded.enabled).toBe(d.enabled);
    if (d.capabilities) for (const field of ["capabilities", "actions", "targets", "applicability", "exclusions", "dependencies"] as const) expect(loaded[field]).toEqual(d[field]);
  }
  expect(projection.payload.skills.map(s => s.skillId).sort()).toEqual(ids(inventory)); expect(projection.payload.originalPrompt).toBe(role.prompt);
  expect(classified.agentSelectedSkillIds).toBeNull(); expect(classified.result.response.status).toBe("UNAVAILABLE"); expect(classified.result.attempts).toEqual([]);
});
probe("dependency-hidden", {source: "SS37 embedded 허용선택/보류조건", dependency: "dependency-z99", loaderIssue: "DEPENDENCY_UNAVAILABLE", gatewayStatus: "NEEDS_INPUT"}, async r => {
  const root = await emptyRoot(); await add(root, {...neutral, dependencies: ["dependency-z99"]});
  const inventory = await loadSkillInventory({root}); const req = request(inventory, "dependency-hidden"); const classified = await gateway(root).classify(input("dependency-hidden"));
  r.observed = {inventory, request: req, classified};
  expect(inventory.issues).toContainEqual({skillId: "skill-z17", code: "DEPENDENCY_UNAVAILABLE", field: "dependencies"});
  expect(req.skills[0]?.dependencies).toEqual(["dependency-z99"]);
  expect(classified).toMatchObject({status: "NEEDS_INPUT", response: null, agentSelectedSkillIds: null});
});
for (const [variant, hidden] of [["orchestrator-hidden", "orchestrator"], ["continuity-hidden", "context-continuity"], ["session-board-hidden", "session-board"]]) {
  probe(variant!, {source: "SS37 embedded 통과기준", hidden, issue: "INSTALLED_SKILL_UNEXPOSED", gatewayStatusWithUnresolvedHostDiscovery: "NEEDS_INPUT"}, async r => {
    const root = await treeRoot(); const baseline = await loadSkillInventory({root});
    await rm(path.join(root, "skills", hidden!), {recursive: true});
    const direct = await loadSkillInventory({root, installedSkillIds: ids(baseline)});
    const exposed = await gateway(root).inventory(); const classified: any = await gateway(root).classify(input(variant!));
    r.observed = {installedSkillIds: ids(baseline), direct, gatewayInventory: exposed, classified};
    expect(direct.issues).toContainEqual({skillId: hidden, code: "INSTALLED_SKILL_UNEXPOSED", field: "installedSkillIds"});
    expect(ids(direct)).not.toContain(hidden); expect(baseline.skills.find(s => s.skillId === hidden)).toBeDefined();
    // Expected failure: gateway cannot receive host installed-ID observations.
    expect(classified.status, `Missing ${hidden} must be detected at MCP-facing gateway`).toBe("NEEDS_INPUT");
  });
}
probe("metadata-missing", {source: "SS37 embedded 통과기준", issue: "MISSING_OR_INVALID_METADATA", field: "classification.json", gatewayStatus: "NEEDS_INPUT"}, async r => {
  const root = await emptyRoot(); await add(root, neutral); await add(root, {...neutral, skillId: "complete"});
  await rm(path.join(root, "skills/skill-z17/classification.json"));
  const inventory = await loadSkillInventory({root, installedSkillIds: ["skill-z17", "complete"]}); const classified = await gateway(root).classify(input("metadata-missing"));
  r.observed = {inventory, classified};
  expect(ids(inventory)).toEqual(["complete"]);
  expect(inventory.issues).toContainEqual({skillId: "skill-z17", code: "MISSING_OR_INVALID_METADATA", field: "classification.json"});
  expect(classified).toMatchObject({status: "NEEDS_INPUT", response: null, agentSelectedSkillIds: null});
});

probe("boundary-role-refresh", {source: "SS37 metadata role change", actionBefore: ["read-only-analysis"], actionAfter: ["edit"], capabilityAfter: ["prose-editing"], changedDigest: true}, async r => {
  const root = await emptyRoot(); await add(root, neutral); const before = await loadSkillInventory({root});
  await add(root, roles.find((role: any) => role.variantId === "SS37-roles-swapped").descriptors[0]); const after = await loadSkillInventory({root});
  r.observed = {before, after}; expect(after.issues).toEqual([]); expect(after.inventoryDigest).not.toBe(before.inventoryDigest);
  expect(after.skills[0]?.actions).toEqual(["edit"]); expect(after.skills[0]?.capabilities).toEqual(["prose-editing"]);
});
probe("boundary-four-local-lists", {source: "SS37 설치/registry/MCP/selector 네 목록", fullInventory: "all filesystem skills", infrastructureOutsideRegistry: ["context-continuity", "orchestrator", "session-board"], hostMcp: "NOTRUN"}, async r => {
  const inventory = await loadSkillInventory({root: repo});
  const directories = (await readdir(path.join(repo, "skills"), {withFileTypes: true})).filter(d => d.isDirectory()).map(d => d.name).sort();
  const registry = JSON.parse(await readFile(path.join(repo, "skills/registry.json"), "utf8")); const registryIds = registry.skills.map((s: any) => s.skillId).sort();
  const exposed = await gateway(repo).inventory() as SkillInventory; const selector = request(inventory, "four-local-lists");
  const registryOnlyOmissions = directories.filter(id => !registryIds.includes(id));
  r.observed = {filesystem: directories, registry: registryIds, localMcpFacingGateway: ids(exposed), selectorRequest: selector.skills.map(s => s.skillId).sort(),
    registryOnlyOmissions, fullInventoryMissing: directories.filter(id => !ids(inventory).includes(id)), inventory, actualHostInstalled: null, actualHostMcp: null};
  expect(inventory.issues).toEqual([]); expect(ids(inventory)).toEqual(directories); expect(ids(exposed)).toEqual(directories);
  expect(registryOnlyOmissions).toEqual(["context-continuity", "orchestrator", "session-board"]);
  expect(selector.skills.map(s => s.skillId).sort()).toEqual(directories);
});
probe("boundary-host-membership-supply", {source: "SS37 latest active/install/support metadata; known host state supply gap", installed: false, hostSupported: false}, async r => {
  const root = await emptyRoot(); await add(root, neutral);
  const direct = await loadSkillInventory({root, installedSkillIds: [], hostSupportedSkillIds: []});
  const exposed = await gateway(root).inventory() as SkillInventory;
  r.observed = {direct, gatewayInventory: exposed, supportedRuntimeFields: Object.keys(runtime), inputObservation: {installedSkillIds: [], hostSupportedSkillIds: []}};
  expect(direct.skills[0]).toMatchObject({installed: false, hostSupported: false});
  // No trusted host-observation parameter exists on gateway; this comparison exposes that missing integration.
  expect(exposed.skills[0], "Gateway must preserve host-reported membership rather than defaulting true").toMatchObject({installed: false, hostSupported: false});
});
probe("boundary-dependency-not-runnable", {source: "SS37 dependencies incomplete/unsupported -> NEEDS_INPUT", matrices: ["not-installed", "host-unsupported", "registry-disabled"]}, async r => {
  const root = await emptyRoot(); await add(root, {...neutral, dependencies: ["dependency-z99"]}); await add(root, {...neutral, skillId: "dependency-z99"});
  const observed = [];
  for (const options of [{installedSkillIds: ["skill-z17"]}, {hostSupportedSkillIds: ["skill-z17"]}]) {
    const inventory = await loadSkillInventory({root, ...options}); observed.push({options, inventory});
    expect(inventory.issues).toContainEqual({skillId: "skill-z17", code: "DEPENDENCY_UNAVAILABLE", field: "dependencies"});
  }
  const entry = {skillId: "dependency-z99", version: "1.0.0", path: "./dependency-z99", enabled: false, providers: [{capabilities: ["concurrency-analysis"], phase: "analysis", phaseOrder: 10, requiredInputArtifacts: [], producedArtifacts: [], inputBindings: [], gate: {}}]};
  await writeFile(path.join(root, "skills/registry.json"), JSON.stringify({schemaVersion: "2.0.0", skills: [entry]}));
  const inventory = await loadSkillInventory({root}); const classified = await gateway(root).classify(input("dependency-disabled")); observed.push({options: {registryDisabled: true}, inventory, classified}); r.observed = observed;
  expect(inventory.issues).toContainEqual({skillId: "skill-z17", code: "DEPENDENCY_UNAVAILABLE", field: "dependencies"}); expect(classified).toMatchObject({status: "NEEDS_INPUT", agentSelectedSkillIds: null});
});
probe("boundary-source-role-duplication", {source: "Known metadata condition duplication; distinct role information required", equalApplicabilityExclusionSkills: []}, async r => {
  const inventory = await loadSkillInventory({root: repo});
  const duplicates = inventory.skills.filter(s => JSON.stringify(s.applicability) === JSON.stringify(s.exclusions));
  r.observed = {duplicates: duplicates.map(s => ({skillId: s.skillId, applicability: s.applicability, exclusions: s.exclusions, sourceMap: s.sourceMap})), inventoryDigest: inventory.inventoryDigest};
  expect(duplicates.map(s => s.skillId), "Applicable and excluded conditions are identical in canonical metadata").toEqual([]);
});
probe("boundary-no-auto-select-all-and-null-empty", {source: "SS37 same capability must not auto-select all; no receipt => null", adviceStatus: "UNAVAILABLE", selected: null, candidates: 2}, async r => {
  const root = await emptyRoot(); await add(root, neutral); await add(root, {...neutral, skillId: "same-capability-2"});
  const inventory = await loadSkillInventory({root}); const req = request(inventory, "null-empty");
  const reqEmpty = createClassificationRequest({requestId: "confirmed-empty", operationId: "confirmed-empty", originalPrompt: sourceCase.originalPrompt, inventory,
    classificationCriteriaRef: "skills/orchestrator/references/skill-classification.md", confirmedContext: {actions: []}, contextSources: [{field: "actions", reference: "SS37 synthetic explicit empty control"}]});
  const classified: any = await gateway(root).classify(input("null-empty"));
  r.observed = {inventory, classified, unknownContext: projectClassificationRequest(req).payload.confirmedContext, confirmedEmptyContext: projectClassificationRequest(reqEmpty).payload.confirmedContext,
    limitation: "Unconfigured gateway makes no selection. Real AGENT selection among same-capability implementations is NOTRUN."};
  expect(classified.agentSelectedSkillIds).toBeNull(); expect(classified.result.response.status).toBe("UNAVAILABLE");
  expect(classified.result.attempts).toEqual([]); expect(req.skills).toHaveLength(2); expect(req.confirmedContext.actions).toBeNull(); expect(reqEmpty.confirmedContext.actions).toEqual([]);
  expect(digestClassificationValue(null)).not.toBe(digestClassificationValue([]));
});
