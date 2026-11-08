import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ApiResultV1, WorkflowReceiptV1 } from "../../contracts/types.js";
import { adminSettingsView, type JevInstallationView } from "../../mcp-server/src/admin-settings.js";
import { ContextLayerService } from "../../mcp-server/src/context-layer-service.js";
import { ContextLayerStore } from "../../mcp-server/src/context-layer-store.js";
import { JevKeyVault, jevKeyFingerprint } from "../../mcp-server/src/jev-key-vault.js";
import { InMemoryPluginUpdateStore } from "../../mcp-server/src/plugin-update-store.js";
import { PluginUpdateService } from "../../mcp-server/src/plugin-update-service.js";
import { ContractValidator } from "../../mcp-server/src/schema-validator.js";
import { createMcpServer } from "../../mcp-server/src/server.js";
import type { SessionMessageService } from "../../mcp-server/src/session-message-service.js";
import { readClassificationRuntime, RuntimeSkillClassificationGateway, type ClassificationRuntimeSnapshot,
  type SkillClassificationGateway } from "../../mcp-server/src/skill-classification/gateway.js";
import type { HostSkillDiscoverySnapshot } from "../../mcp-server/src/skill-classification/host-discovery-adapter.js";
import { loadSkillInventory } from "../../mcp-server/src/skill-classification/inventory.js";
import { composeJev } from "../../mcp-server/src/skill-classification/jev-composition.js";
import { createJevModelCatalog } from "../../mcp-server/src/skill-classification/jev-model-catalog.js";
import { TYPESAFE_JEV } from "../../mcp-server/src/skill-classification/jev-provider.js";
import { digestProviderProfileConfiguration } from "../../mcp-server/src/skill-classification/profiles.js";
import { unknownUsage } from "../../mcp-server/src/skill-classification/providers.js";
import { InMemoryClassificationBudget, SkillClassificationService } from "../../mcp-server/src/skill-classification/service.js";
import type { ProviderProfile, SkillClassificationProviderPort, SkillClassificationRequestV1, SkillInventory } from "../../mcp-server/src/skill-classification/types.js";
import type { WorkflowService } from "../../mcp-server/src/workflow-service.js";
import { callerMeta, metaIngress } from "../helpers/caller.js";
import { ensureBootstrapped, fakeAuthenticator, type FakeAuthenticator, signAndCommit } from "../helpers/fake-authenticator.js";

// 4.0.0: JEV is composed by the MCP server from the provider AGS ships and the admin page's signed settings and key.
// No installation file and no environment variable is read for it. JEV is an advice layer: no qualification gate, and
// a failure leaves the agent to choose. The provider call goes to an injected fetch; nothing reaches TypeSafe.
const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const PAGE_KEY = "page-key-value-0001";
const ENV_KEY = "environment-key-value-0002";
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function withEnvironmentKey(value: string | undefined) {
  const before = process.env.JEV_API_KEY;
  if (value === undefined) delete process.env.JEV_API_KEY; else process.env.JEV_API_KEY = value;
  cleanups.push(() => { if (before === undefined) delete process.env.JEV_API_KEY; else process.env.JEV_API_KEY = before; });
}

function adminState() {
  const directory = mkdtempSync(path.join(tmpdir(), "ags-jev-mcp-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  const file = path.join(directory, "context-layers.sqlite3");
  const service = new ContextLayerService(create => ContextLayerStore.open(file, create), undefined, "http://localhost:47615/",
    new JevKeyVault(path.join(directory, "jev-key-vault.bin")));
  const owner = fakeAuthenticator();
  ensureBootstrapped(service, owner);
  return { service, owner };
}

function registerPageKey(service: ContextLayerService, owner: FakeAuthenticator, value = PAGE_KEY) {
  const prepared = service.prepareIntent({ op: "jevKey.set", name: "JEV_API_KEY", fingerprint: jevKeyFingerprint(value) }, false);
  service.commit({ intent: prepared.intent, assertion: owner.assert(prepared.intent), requestId: randomUUID(), proposalId: null, secret: value });
}

const jevOn = (over: Record<string, unknown> = {}) => ({ op: "jev.set", enabled: true, limitUsd: 1, presets: {},
  model: { providerId: "typesafe", modelId: "jev-1.14.0" }, transmissionAllowed: true, fallbackVendorId: null, ...over });

async function skillTree() {
  const root = await mkdtemp(path.join(tmpdir(), "ags-jev-mcp-tree-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "skills", "jev-fixture");
  await mkdir(directory, { recursive: true });
  const bytes = "---\nname: jev-fixture\ndescription: Analyze a fixed queue, excluding modification.\nmetadata:\n  version: \"1.0.0\"\n---\n\nAnalyze a fixed queue.\nExclude modification.\n";
  await writeFile(path.join(directory, "SKILL.md"), bytes, "utf8");
  const source = { path: "skills/jev-fixture/SKILL.md", startLine: 8, endLine: 9, digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}` };
  await writeFile(path.join(directory, "classification.json"), JSON.stringify({ schemaVersion: "1.0.0", taxonomyRevision: "jev-t1", actions: ["analyze"],
    targets: ["queue"], constraints: [], dependencies: [], capabilities: ["analyze"], applicability: [source], exclusions: [source] }), "utf8");
  await writeFile(path.join(root, "skills", "registry.json"), JSON.stringify({ schemaVersion: "2.0.0", skills: [] }), "utf8");
  return root;
}

function host(inventory: SkillInventory): HostSkillDiscoverySnapshot {
  return { schemaVersion: "1.0.0", sourceRef: "synthetic:host", revision: "jev-h1", observedAt: new Date(Date.now() - 1000).toISOString(),
    expiresAt: "2099-01-01T00:00:00.000Z", skills: inventory.skills.map(skill => ({ skillId: skill.skillId, enabled: true, installed: true, hostSupported: true, root: null })) };
}

/** The TypeSafe Choice reply for the request body sent (one answer per skill question). */
function choiceReply(body: string, status = 200): Response {
  if (status !== 200) return new Response("unavailable", { status });
  const sent = JSON.parse(body) as { model: string; questions: Record<string, unknown> };
  return new Response(JSON.stringify({ model: sent.model, usage: { input_tokens: 10, output_tokens: 3 },
    answers: Object.fromEntries(Object.keys(sent.questions).map(id => [id, { type: "choice", choice: "needed", confidence: 0.7,
      probabilities: { "needed": 0.7, "not-needed": 0.2, "uncertain": 0.1 } }])) }), { headers: { "content-type": "application/json" } });
}

function recordingFetch(status = 200) {
  const calls: Array<{ url: string; authorization: string | null; body: string }> = [];
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({ url: String(url), authorization: headers.get("authorization"), body: String(init?.body) });
    return choiceReply(String(init?.body), status);
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

let operation = 0;
const input = (vendorId = "vendor-a") => {
  operation += 1;
  return { schemaVersion: "1.0.0", requestId: `jev-request-${operation}`, operationId: `jev-operation-${operation}`, originalPrompt: "큐를 분석만 한다. 수정은 하지 않는다.",
    confirmedContext: { taskRevision: null, objective: null, actions: null, targets: null, constraints: null, prohibitedActions: null, background: null },
    contextSources: [], explicitSkillIds: [], ruleRequiredSkillIds: [], vendorContext: { vendorId, reference: "synthetic:vendor" }, publicSynthetic: false };
};

/** A qualified vendor profile and a native port, for the fallback (vendor rules unchanged). */
function vendorRoute(vendorId: string, inventory: SkillInventory) {
  const profile: ProviderProfile = { profileId: `vendor-${vendorId}`, providerKind: "vendor", vendorId, modelId: "vendor-model", modelRevision: "vendor-model",
    reasoningEffort: "high", supportedOptions: { structuredOutput: true, reasoningEfforts: ["high"] }, approvedRouteRef: `route-${vendorId}`,
    adapterRevision: "vendor-a1", promptRevision: "vendor-p1", qualificationRevision: "vendor-q1", maximumInputBytes: 2_000_000, maximumOutputTokens: 1000,
    maximumCostUsd: 0, judgmentPolicy: null, qualification: { status: "PASS", inventoryDigest: inventory.inventoryDigest, taxonomyRevision: inventory.taxonomyRevision,
      modelRevision: "vendor-model", promptRevision: "vendor-p1", validUntil: "2099-01-01T00:00:00Z", profileConfigurationDigest: "" } };
  profile.qualification.profileConfigurationDigest = digestProviderProfileConfiguration(profile);
  return profile;
}

async function harness(options: { service: ContextLayerService; fetcher: typeof fetch;
  runtime?: (base: ClassificationRuntimeSnapshot, inventory: SkillInventory) => ClassificationRuntimeSnapshot; vendorIds?: string[] }) {
  const root = await skillTree();
  const inventory = await loadSkillInventory({ root });
  const composed = composeJev({ signed: () => options.service.verifiedState()?.jev ?? null, pageKey: name => options.service.jevKey(name), fetcher: options.fetcher });
  const vendorCalls: string[] = [];
  const vendor: SkillClassificationProviderPort = {
    routeKind: () => "native",
    availability: async () => ({ available: true, approved: true, routeKind: "native", reasonCode: null }),
    classify: async (request: SkillClassificationRequestV1, profile: ProviderProfile, _signal: AbortSignal, fence?: () => void) => {
      fence?.(); vendorCalls.push(profile.vendorId);
      return { response: { schemaVersion: "1.0.0", requestId: request.requestId, operationId: request.operationId, requestDigest: request.requestDigest,
        inventoryDigest: request.inventoryDigest, status: "SUCCESS", judgments: request.skills.map(skill => ({ skillId: skill.skillId, judgment: "not-needed" as const,
          reasonRefs: ["synthetic:vendor"], uncertaintyReason: null })), unresolvedItems: [], error: null },
        usage: { ...unknownUsage(), actualCostUsd: 0 }, dispatchState: "started", diagnostics: null };
    },
  };
  const vendorProfiles = (options.vendorIds ?? []).map(id => vendorRoute(id, inventory));
  const budget = new InMemoryClassificationBudget({ jev: { limitUsd: null, spentUsd: null }, vendors: {},
    nativeAllowances: Object.fromEntries(vendorProfiles.map(profile => [profile.profileId, { approvalRef: "synthetic:allowance", remainingCalls: 5 }])),
    jevSignedLimitUsd: composed.signedLimitUsd });
  const service = new SkillClassificationService({ providers: { jev: composed.provider, vendor }, budget });
  // No installation file: the runtime AGS reads without AGENT_GOVERNANCE_CLASSIFICATION_CONFIG.
  const unconfigured = await readClassificationRuntime(undefined, root);
  const base = { ...unconfigured, registry: { ...unconfigured.registry, profiles: vendorProfiles } };
  const runtime = options.runtime ? options.runtime(base, inventory) : base;
  const gateway = new RuntimeSkillClassificationGateway({ root, service, readRuntime: async () => composed.apply(runtime),
    observeHostSkills: async () => host(inventory) });
  return { gateway, vendorCalls, composed };
}

type Classified = { result: { attempts: Array<{ providerKind: string; dispatchState: string; errorCode: string | null }>; response: { status: string } };
  adviceQualification: string | null };

describe("JEV managed by the MCP server (4.0.0)", () => {
  it("JEV-DISPATCH: reaches the JEV provider with only the signed settings and the page key", async () => {
    withEnvironmentKey(undefined);
    const { service, owner } = adminState();
    signAndCommit(service, owner, jevOn());
    registerPageKey(service, owner);
    const { fetcher, calls } = recordingFetch();
    const { gateway } = await harness({ service, fetcher });
    const classified = await gateway.classify(input()) as Classified;
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: ENDPOINT, authorization: `Bearer ${PAGE_KEY}` });
    expect(JSON.parse(calls[0]!.body)).toMatchObject({ model: "jev-1.14.0" });
    expect(classified.result.attempts).toMatchObject([{ providerKind: "jev", dispatchState: "started", errorCode: null }]);
    expect(classified.result.response.status).toBe("SUCCESS");
    // Advice, not a verdict: the JEV profile claims no qualification.
    expect(classified.adviceQualification).toBe("NOT_RUN");
  });

  it("JEV-ENV-KEY: never uses an environment variable for the JEV key", async () => {
    withEnvironmentKey(ENV_KEY);
    const { service, owner } = adminState();
    signAndCommit(service, owner, jevOn());
    const { fetcher, calls } = recordingFetch();
    const { gateway } = await harness({ service, fetcher });
    const withoutPageKey = await gateway.classify(input()) as Classified;
    expect(calls).toHaveLength(0);
    expect(withoutPageKey.result.attempts).toMatchObject([{ providerKind: "jev", dispatchState: "not-started", errorCode: "CREDENTIAL_UNAVAILABLE" }]);
    registerPageKey(service, owner);
    await gateway.classify(input());
    expect(calls.map(call => call.authorization)).toEqual([`Bearer ${PAGE_KEY}`]);
    expect(JSON.stringify(calls)).not.toContain(ENV_KEY);
  });

  it("JEV-CONSENT-FALLBACK: sends only with the signed consent and falls back only to the signed vendor", async () => {
    withEnvironmentKey(undefined);
    const { service, owner } = adminState();
    registerPageKey(service, owner);
    // The installation allows external transmission and private content; the signed consent is off: no JEV call.
    signAndCommit(service, owner, jevOn({ transmissionAllowed: false }));
    const allowing = (base: ClassificationRuntimeSnapshot) => ({ ...base, allowRemotePrivateContent: true,
      config: { ...base.config, externalClassificationAllowed: true } });
    const quiet = recordingFetch();
    const consentOff = await harness({ service, fetcher: quiet.fetcher, runtime: allowing, vendorIds: ["vendor-a", "vendor-b"] });
    const refused = await consentOff.gateway.classify(input()) as Classified;
    expect(quiet.calls).toHaveLength(0);
    expect(refused.result.attempts.map(attempt => [attempt.providerKind, attempt.errorCode])).toEqual([["jev", "REMOTE_CONTENT_NOT_APPROVED"]]);
    expect(consentOff.vendorCalls).toEqual([]);

    // Consent on, JEV failing (HTTP 503). No fallback chosen: the current vendor's profile is not asked.
    signAndCommit(service, owner, jevOn());
    const failing = recordingFetch(503);
    const noFallback = await harness({ service, fetcher: failing.fetcher, vendorIds: ["vendor-a", "vendor-b"] });
    const alone = await noFallback.gateway.classify(input("vendor-a")) as Classified;
    expect(failing.calls).toHaveLength(1);
    expect(alone.result.attempts.map(attempt => [attempt.providerKind, attempt.errorCode])).toEqual([["jev", "SERVER_UNAVAILABLE"]]);
    expect(noFallback.vendorCalls).toEqual([]);

    // The signed fallback vendor-b is asked once, not the current vendor-a.
    signAndCommit(service, owner, jevOn({ fallbackVendorId: "vendor-b" }));
    const withFallback = await harness({ service, fetcher: recordingFetch(503).fetcher, vendorIds: ["vendor-a", "vendor-b"] });
    const fallen = await withFallback.gateway.classify(input("vendor-a")) as Classified;
    expect(fallen.result.attempts.map(attempt => [attempt.providerKind, attempt.errorCode])).toEqual([["jev", "SERVER_UNAVAILABLE"], ["vendor", null]]);
    expect(withFallback.vendorCalls).toEqual(["vendor-b"]);
    expect(fallen.adviceQualification).toBe("PASS");
  });

  it("D0075-READINESS: says JEV is in use only when it can be asked, and names what is missing", () => {
    const { service, owner } = adminState();
    const { composed } = { composed: composeJev({ signed: () => service.verifiedState()?.jev ?? null, pageKey: name => service.jevKey(name) }) };
    const installation: JevInstallationView = { configured: false, vendorIds: [], credentials: [], ignoredJev: { routes: 0, profiles: 0 }, error: null };
    const view = () => adminSettingsView({ environment: {}, signed: service.adminState().signedSettings, locale: { value: "ko", source: "root" },
      localeOptions: ["ko"], installation, usage: { spentUsd: 0, reservedUsd: 0 }, profileFor: composed.profileFor,
      providers: [{ providerId: "typesafe", label: "TypeSafe", endpoint: ENDPOINT, credentialName: "JEV_API_KEY", perCallUsd: TYPESAFE_JEV.maximumCostUsd,
        catalog: { status: "bundled", updatedAt: null, refreshHours: 24, models: ["jev-1.14.0"] }, transmitted: { request: [], task: [], perSkill: [] } }] }).jev;
    expect(view()).toMatchObject({ switchOn: false, ready: false, missing: ["SWITCH_OFF", "MODEL_NOT_SELECTED", "TRANSMISSION_NOT_ALLOWED", "KEY_MISSING", "BUDGET_MISSING"] });
    // A record signed before 4.0.0 (switch and budget only): switched on, yet nothing can be asked.
    signAndCommit(service, owner, { op: "jev.set", enabled: true, limitUsd: 1, presets: {} });
    expect(view()).toMatchObject({ switchOn: true, ready: false, missing: ["MODEL_NOT_SELECTED", "TRANSMISSION_NOT_ALLOWED", "KEY_MISSING"] });
    signAndCommit(service, owner, jevOn());
    expect(view()).toMatchObject({ switchOn: true, ready: false, missing: ["KEY_MISSING"] });
    registerPageKey(service, owner);
    expect(view()).toMatchObject({ ready: true, missing: [] });
    signAndCommit(service, owner, jevOn({ limitUsd: null }));
    expect(view()).toMatchObject({ ready: false, missing: ["BUDGET_MISSING"] });
    signAndCommit(service, owner, jevOn({ limitUsd: 0.001 }));
    expect(view()).toMatchObject({ ready: false, missing: ["BUDGET_BELOW_ONE_CALL"] });
    signAndCommit(service, owner, jevOn({ model: { providerId: "typesafe", modelId: "jev-latest" } }));
    expect(view()).toMatchObject({ ready: false, missing: ["MODEL_UNSUPPORTED"] });
    signAndCommit(service, owner, jevOn({ transmissionAllowed: false }));
    expect(view()).toMatchObject({ ready: false, missing: ["TRANSMISSION_NOT_ALLOWED"] });
    // The workflow guidance asks the same question.
    expect(composed.ready({ spentUsd: 0, reservedUsd: 0 })).toBe(false);
    signAndCommit(service, owner, jevOn());
    expect(composed.ready({ spentUsd: 0, reservedUsd: 0 })).toBe(true);
    signAndCommit(service, owner, jevOn({ presets: { "skill-classification": false } }));
    expect(composed.ready({ spentUsd: 0, reservedUsd: 0 })).toBe(false);
  });

  it("D0075-NOTICE: the workflow notice says classification support is configured only when advice can be asked", async () => {
    const line = "스킬 분류 지원이 설정돼 있다. 다음 단계의 실제 작업과 전체 inventory를 classify_skills에 넘겨 조언을 받을 수 있다. 조언은 채택·교정·기각하고 최종 선택은 직접 한다.";
    expect(await notice(false)).not.toContain(line);
    expect(await notice(true)).toContain(line);
  });

  it("JEV-CATALOG: lists pinned models, refreshes daily, retries hourly after a failure and never needs a call without a key", async () => {
    let clock = 1_000_000, key: string | null = null, fail = false, release: (() => void) | null = null;
    const calls: Array<{ url: string; redirect: unknown; authorization: string | null }> = [];
    const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), redirect: init?.redirect, authorization: new Headers(init?.headers).get("authorization") });
      if (fail) throw new Error("private provider error");
      await new Promise<void>(resolve => { release = resolve; });
      return new Response(JSON.stringify({ models: [{ name: "jev-1.16.0", secret: "not returned" }, { name: "jev-latest" }] }), { headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const catalog = createJevModelCatalog({ definition: TYPESAFE_JEV, getCredential: async () => key, fetcher, now: () => clock });
    expect(await catalog.get()).toMatchObject({ status: "no-key", models: ["jev-1.14.0", "jev-1.13.0"] });
    expect(calls).toHaveLength(0);
    key = PAGE_KEY;
    const first = catalog.get(), second = catalog.get();
    await vi.waitFor(() => expect(release).not.toBeNull());
    release!();
    const [a, b] = await Promise.all([first, second]);
    expect(calls).toEqual([{ url: "https://api.typesafe.ai/v1/models", redirect: "error", authorization: `Bearer ${PAGE_KEY}` }]);
    expect(a).toEqual(b);
    expect(a).toMatchObject({ status: "current", models: ["jev-1.16.0", "jev-1.14.0", "jev-1.13.0"], refreshHours: 24 });
    expect(JSON.stringify(a)).not.toContain("not returned");
    clock += 24 * 60 * 60_000 - 1;
    await catalog.get();
    expect(calls).toHaveLength(1);
    clock += 2; fail = true;
    expect(await catalog.get()).toMatchObject({ status: "unavailable", models: ["jev-1.16.0", "jev-1.14.0", "jev-1.13.0"] });
    await catalog.get();
    expect(calls).toHaveLength(2);
    clock += 60 * 60_000 + 1;
    await catalog.get();
    expect(calls).toHaveLength(3);
  });

  it("JEV-SIGNED-SHAPE: signs the model, the consent and the fallback; folds a pre-4.0.0 record; refuses a malformed model", () => {
    const { service, owner } = adminState();
    signAndCommit(service, owner, { op: "jev.set", enabled: true, limitUsd: 2, presets: {} });
    expect(service.verifiedState()?.jev).toMatchObject({ enabled: true, limitUsd: 2, model: null, transmissionAllowed: false, fallbackVendorId: null });
    signAndCommit(service, owner, jevOn({ fallbackVendorId: "vendor-b" }));
    expect(service.verifiedState()?.jev).toMatchObject({ model: { providerId: "typesafe", modelId: "jev-1.14.0" }, transmissionAllowed: true, fallbackVendorId: "vendor-b" });
    for (const model of [{ providerId: "TypeSafe!", modelId: "jev-1.14.0" }, { providerId: "typesafe" }, "jev-1.14.0"]) {
      expect(() => service.prepareIntent(jevOn({ model }), false)).toThrow(expect.objectContaining({ code: "ADMIN_CHANGE_INVALID" }));
    }
    expect(() => service.prepareIntent({ ...jevOn(), transmissionAllowed: undefined }, false)).toThrow(expect.objectContaining({ code: "ADMIN_CHANGE_INVALID" }));
  });
});

async function notice(ready: boolean): Promise<string> {
  const receipt = { runId: "run-jev", revision: 3, state: "running",
    plan: { currentStageId: "stage-02", nextStageId: null, stages: [{ stageId: "stage-02", requiredCapability: "minimal-implementation", skillId: "ponytail" }] } } as unknown as WorkflowReceiptV1;
  const ok: ApiResultV1<unknown> = { schemaVersion: "1.0.0", ok: true, data: receipt, error: null };
  const store = new InMemoryPluginUpdateStore();
  store.putPluginUpdateState({ targetId: "agent-governance-suite", currentVersion: "4.0.0", latestVersion: "4.0.0", latestTag: "v4.0.0",
    latestCommit: "a".repeat(40), etag: "jev", comparison: "up-to-date", lastAttemptAt: "2026-11-08T00:00:00.000Z", lastSuccessfulCheckAt: "2026-11-08T00:00:00.000Z",
    nextCheckAt: "2099-01-01T00:00:00.000Z", lastNotifiedVersion: null, lastNotifiedAt: null, lastErrorCode: null });
  const classification = { adviceReady: () => ready } as unknown as SkillClassificationGateway;
  const server = createMcpServer({ abortWorkflow: () => ok, getWorkflowStatus: () => ok } as unknown as WorkflowService, new PluginUpdateService(store),
    undefined, undefined, undefined, new ContractValidator(), "default", null, null, {} as SessionMessageService, null, classification, metaIngress(), "ko");
  const client = new Client({ name: "jev-notice", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const response = await client.callTool({ name: "abort_workflow", arguments: { runId: "run-jev", expectedRevision: 3 }, _meta: callerMeta() });
    return (response.content as Array<{ text: string }>).map(item => item.text).join("\n");
  } finally {
    await client.close();
    await server.close();
  }
}
