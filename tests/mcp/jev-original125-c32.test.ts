import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StdioClientTransport} from "@modelcontextprotocol/sdk/client/stdio.js";
import {randomUUID} from "node:crypto";
import {access, mkdir, mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";
import {expect, it, vi} from "vitest";
import {loadHostObservedInventory} from "../../mcp-server/src/skill-classification/host-discovery-adapter.js";
import {digestProviderProfileConfiguration} from "../../mcp-server/src/skill-classification/profiles.js";
import type {ProviderProfile} from "../../mcp-server/src/skill-classification/types.js";
import {codexCallMeta} from "../helpers/caller.js";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const input = {schemaVersion: "1.0.0", requestId: "fixture-c32-request", operationId: "fixture-c32-operation", originalPrompt: "닫힌 합성 재시작 경계만 확인해.",
  confirmedContext: {taskRevision: null, objective: null, actions: null, targets: null, constraints: null, prohibitedActions: null, background: null},
  contextSources: [], explicitSkillIds: [], ruleRequiredSkillIds: [], vendorContext: {vendorId: "fixture-c32", reference: "fixture:c32"}, publicSynthetic: true};

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "jev-c32-"));
  const p04 = JSON.parse(await readFile(new URL("./fixtures/jev-current-workload-p04.r01.json", import.meta.url), "utf8")) as {
    baseFiles: Record<string, string>; variants: Array<{name: string; patch: Record<string, string>}>;
  };
  const put = async (files: Record<string, string>) => {
    for (const [relative, text] of Object.entries(files)) {
      const target = path.join(directory, relative);
      await mkdir(path.dirname(target), {recursive: true}); await writeFile(target, text, "utf8");
    }
  };
  await put(p04.baseFiles);
  const profilesPath = path.join(directory, "profiles.json"), configPath = path.join(directory, "config.json"), hostPath = path.join(directory, "host.json");
  const host = {schemaVersion: "1.0.0", sourceRef: "fixture:c32-owned-host", revision: "h1", observedAt: new Date(Date.now() - 1000).toISOString(),
    expiresAt: new Date(Date.now() + 300_000).toISOString(), skills: ["fixture-g", "fixture-r", "fixture-w"].map(skillId =>
      ({skillId, installed: true, hostSupported: true, enabled: true, root: null}))};
  await writeFile(hostPath, JSON.stringify(host), "utf8");
  const configure = async (revision: string, profiles: ProviderProfile[] = [], extra: Record<string, string> = {}) => {
    await writeFile(profilesPath, JSON.stringify({schemaVersion: "1.0.0", profileRevision: `pr${revision}`, profiles}), "utf8");
    await writeFile(configPath, JSON.stringify({config: {jevEnabled: false, mode: "select", providerProfileRegistryRef: profilesPath,
      externalClassificationAllowed: false, configRevision: `c${revision}`, timeoutMs: 20_000}, allowRemotePrivateContent: false, hostDiscoveryRef: hostPath, ...extra}), "utf8");
  };
  await configure("1");
  const environment = Object.fromEntries(Object.entries({...process.env,
    AGENT_GOVERNANCE_CLASSIFICATION_CONFIG: configPath, AGENT_GOVERNANCE_HOST_ATTESTATION: "codex", SKILL_REGISTRY_PATH: path.join(directory, "skills", "registry.json"),
    AGENT_GOVERNANCE_SHARED_STATE_DIR: directory, AGENT_GOVERNANCE_DB_PATH: path.join(directory, "workflow.sqlite3"),
    AGENT_GOVERNANCE_CONTINUITY_DB_PATH: path.join(directory, "continuity.sqlite3"), AGENT_GOVERNANCE_TRUST_DB_PATH: path.join(directory, "trust.sqlite3"),
    AGENT_GOVERNANCE_SESSION_BOARD_DB_PATH: path.join(directory, "board.sqlite3"), AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR: path.join(directory, "messages"),
  }).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  const start = async (code?: string) => {
    const args = code ? ["--import", "tsx", "--input-type=module", "--eval", code] : ["--import", "tsx", path.join(repository, "mcp-server/src/index.ts")];
    const transport = new StdioClientTransport({command: process.execPath, args, cwd: repository, env: environment, stderr: "pipe"});
    const client = new Client({name: "c32-source-process-fixture", version: "1.0.0"});
    try {await client.connect(transport);} catch (error) {await transport.close(); throw error;}
    const call = async (name: string, data: Record<string, unknown>) => {
      // 소유 합성 호출자 _meta이다(Codex 형식, 실행 관측 없음). 실제 호스트 관측이 아니다.
      const meta = codexCallMeta("fixture-c32-session", {model: null, effort: null, callId: `fixture-c32-call-${randomUUID()}`});
      const reply = await client.callTool({name, arguments: data, _meta: meta});
      return JSON.parse((reply.content as Array<{type: string; text?: string}>).find(item => item.type === "text")!.text!);
    };
    return {call, close: async () => {try {await client.close();} finally {await transport.close();}}};
  };
  const addInventory = async () => {
    await put(p04.variants.find(item => item.name === "add-irrelevant")!.patch);
    host.revision = "h2"; host.skills.push({skillId: "fixture-q", installed: true, hostSupported: true, enabled: true, root: null});
    await writeFile(hostPath, JSON.stringify(host), "utf8");
  };
  return {directory, configure, start, addInventory, hostPath};
}

it("C-32 완료 cache는 같은 프로세스에서 변경을 거부하고 재시작 뒤 같은 ID에 현재 snapshot을 사용한다", async () => {
  const f = await fixture();
  let server: Awaited<ReturnType<typeof f.start>> | undefined;
  try {
    server = await f.start();
    const first = await server.call("classify_skills", input);
    expect(first.ok).toBe(true);
    expect(first.data.result.snapshot).toMatchObject({configRevision: "c1", profileRevision: "pr1"});
    expect(first.data.result.response).toMatchObject({status: "UNAVAILABLE", error: {code: "PROFILE_UNAVAILABLE", dispatchState: "not-started"}});
    expect(first.data.result.attempts).toEqual([]);
    expect(first.data.agentSelectedSkillIds).toBeNull();
    expect(await server.call("classify_skills", input)).toEqual(first);

    await f.configure("2");
    const stale = await server.call("classify_skills", input);
    expect(stale).toMatchObject({ok: false, data: null, error: {code: "INVALID_INPUT", details: {category: "request-state", reasonCode: "STALE_CLASSIFICATION_OPERATION"}}});
    await f.addInventory();
    expect(await server.call("classify_skills", input)).toMatchObject({ok: false, error: {code: "INVALID_INPUT", details: {reasonCode: "OPERATION_DIGEST_CONFLICT"}}});
    await server.close(); server = undefined;

    server = await f.start();
    const restarted = await server.call("classify_skills", input);
    expect(restarted.ok).toBe(true);
    expect(restarted.data.result.snapshot).toMatchObject({configRevision: "c2", profileRevision: "pr2"});
    expect(restarted.data.result.request.operationId).toBe(input.operationId);
    expect(restarted.data.result.request.requestId).toBe(input.requestId);
    expect(restarted.data.result.request.skills.map((skill: {skillId: string}) => skill.skillId).sort()).toEqual(["fixture-g", "fixture-q", "fixture-r", "fixture-w"]);
    expect(restarted.data.result.snapshot.inventoryDigest).not.toBe(first.data.result.snapshot.inventoryDigest);
    expect(restarted.data.result.snapshot.requestDigest).not.toBe(first.data.result.snapshot.requestDigest);
    expect(restarted.data.result.response.error.code).toBe("PROFILE_UNAVAILABLE");
    expect(restarted.data.result.attempts).toEqual([]);
    expect(restarted.data.agentSelectedSkillIds).toBeNull();
  } finally {try {await server?.close();} finally {await rm(f.directory, {recursive: true, force: true, maxRetries: 5});}}
}, 30_000);

it("C-32 dispatch 전 pending을 가진 프로세스를 닫아도 새 프로세스가 같은 ID의 옛 flight를 승계하지 않는다", async () => {
  const f = await fixture(), marker = path.join(f.directory, "prepare-entered");
  let server: Awaited<ReturnType<typeof f.start>> | undefined;
  let settled: Promise<unknown> | undefined;
  try {
    const {inventory} = await loadHostObservedInventory({root: f.directory, hostDiscoveryRef: f.hostPath});
    expect(inventory.issues).toEqual([]);
    const profile: ProviderProfile = {profileId: "fixture-c32-native", providerKind: "vendor", vendorId: "fixture-c32", modelId: "fixture-model", modelRevision: "fixture-model",
      reasoningEffort: "low", supportedOptions: {reasoningEfforts: ["low"], structuredOutput: true}, approvedRouteRef: "fixture-c32-route", qualificationRevision: "fixture-only",
      adapterRevision: "fixture-c32-native-r1", promptRevision: "fixture-c32-prompt", maximumInputBytes: 1_000_000, maximumOutputTokens: 1000, maximumCostUsd: 0,
      judgmentPolicy: null, qualification: {status: "PASS", inventoryDigest: inventory.inventoryDigest, taxonomyRevision: inventory.taxonomyRevision,
        modelRevision: "fixture-model", promptRevision: "fixture-c32-prompt", validUntil: "2099-01-01T00:00:00Z", profileConfigurationDigest: ""}};
    profile.qualification.profileConfigurationDigest = digestProviderProfileConfiguration(profile);
    const definitions = path.join(f.directory, "native.json"), runtime = path.join(f.directory, "runtime.json");
    await writeFile(definitions, JSON.stringify([{adapterId: "fixture-c32-adapter", host: "fixture-c32-host", executable: process.execPath, workingDirectory: f.directory,
      approvalRef: "fixture-only", capabilityEvidenceRef: "fixture-only", retryPolicyVerified: true, retryPolicyEvidenceRef: "fixture-only", isolationEvidenceRef: "fixture-only",
      isolationArgs: [], timeoutMs: 20_000, maximumOutputBytes: 64000}]), "utf8");
    await writeFile(runtime, JSON.stringify({schemaVersion: "1.0.0", routes: [{routeRef: "fixture-c32-route", approvalRef: "fixture-only", approved: true, providerKind: "vendor",
      vendorId: "fixture-c32", adapterRevision: "fixture-c32-native-r1", modelIds: ["fixture-model"], reasoningEfforts: ["low"], structuredOutput: true, kind: "native",
      nativeAdapterRef: "fixture-c32-adapter", capabilityEvidenceRef: "fixture-only", retryPolicyVerified: true}],
      budget: {jev: {limitUsd: 0, spentUsd: 0}, vendors: {}, nativeAllowances: {"fixture-c32-native": {approvalRef: "fixture-only", remainingCalls: 1}}}}), "utf8");
    await f.configure("1", [profile], {providerRuntimeRef: runtime, nativeAdapterDefinitionsRef: definitions});
    // 기존 공개 startMcpServer의 call-local behavior 주입이다. 새 실행기/API나 실제 CLI를 만들지 않는다.
    const code = `import {startMcpServer} from ${JSON.stringify(pathToFileURL(path.join(repository, "mcp-server/src/index.ts")).href)};
      import {writeFile} from 'node:fs/promises';
      const behavior = {validateIsolationArgs: args => args.length === 0, canEncodeProfile: () => true,
        prepare: async () => {await writeFile(${JSON.stringify(marker)}, 'pending-before-dispatch', 'utf8'); await new Promise(() => {});},
        decode: () => {throw new Error('UNREACHABLE_SYNTHETIC_DECODE');}};
      await startMcpServer(new Map(), undefined, new Map([['fixture-c32-host', behavior]]));`;
    server = await f.start(code);
    let finished = false;
    settled = server.call("classify_skills", input).then(value => ({value}), error => ({error})).finally(() => {finished = true;});
    await vi.waitFor(async () => {await access(marker);}, {timeout: 10_000, interval: 20});
    expect(await readFile(marker, "utf8")).toBe("pending-before-dispatch");
    expect(finished).toBe(false);
    await server.close(); server = undefined;
    expect(await settled).toHaveProperty("error");
    await f.configure("2"); await f.addInventory();
    server = await f.start();
    const current = await server.call("classify_skills", input);
    expect(current.ok).toBe(true);
    expect(current.data.result.snapshot).toMatchObject({configRevision: "c2", profileRevision: "pr2"});
    expect(current.data.result.response).toMatchObject({status: "UNAVAILABLE", error: {code: "PROFILE_UNAVAILABLE", dispatchState: "not-started"}});
    expect(current.data.result.request.operationId).toBe(input.operationId);
    expect(current.data.result.request.skills.some((skill: {skillId: string}) => skill.skillId === "fixture-q")).toBe(true);
    expect(current.data.result.attempts).toEqual([]);
    expect(current.data.agentSelectedSkillIds).toBeNull();
  } finally {try {await server?.close(); await settled;} finally {await rm(f.directory, {recursive: true, force: true, maxRetries: 5});}}
}, 30_000);
