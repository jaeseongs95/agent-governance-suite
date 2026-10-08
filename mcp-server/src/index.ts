import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { FileSkillRegistry } from "./registry.js";
import { ContinuityService, type ContinuityGateway, UnavailableContinuityService } from "./continuity-service.js";
import { continuityUnavailableReason, SqliteContinuityStore } from "./continuity-store.js";
import {
  assertDistinctDatabasePaths,
  resolveContinuityDatabasePath,
  resolveHostAttestation,
  resolveKoreanProseGlossaryPath,
  resolveRegistryPath,
  resolveSessionBoardDatabasePath,
  resolveToolSchemaProfile,
  resolveTrustDatabasePath,
  resolveWorkflowDatabasePath,
} from "./runtime-config.js";
import { ContractValidator } from "./schema-validator.js";
import { createMcpServer } from "./server.js";
import { PluginUpdateService } from "./plugin-update-service.js";
import { SqliteWorkflowStore } from "./sqlite-workflow-store.js";
import { WorkflowService } from "./workflow-service.js";
import { HostAttestationProvider } from "./host-attestation.js";
import { claudeCodeExecutionAdapter, codexExecutionAdapter } from "./host-execution-adapters.js";
import { StateCleanupService } from "./state-cleanup-service.js";
import { SqliteKoreanProseGlossary } from "./korean-prose-glossary.js";
import { TrustStore } from "./trust-store.js";
import { TrustService } from "./trust-service.js";
import path from "node:path";
import { RuntimeSkillClassificationGateway, readClassificationRuntime } from "./skill-classification/gateway.js";
import { InMemoryClassificationBudget, SkillClassificationService } from "./skill-classification/service.js";
import { loadClassificationProviderRuntime } from "./skill-classification/runtime.js";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { digestClassificationValue } from "./skill-classification/request.js";
import { listSessions, openBoard } from "../../skills/session-board/scripts/board-store.mjs";
import { hostActorId } from "./host-attestation.js";
import { createNativeClassificationAdapters, type NativeClassificationAdapterDefinition } from "./skill-classification/native-adapters.js";

async function main(): Promise<void> {
  const registryPath = resolveRegistryPath();
  const workflowDatabasePath = resolveWorkflowDatabasePath();
  const continuityDatabasePath = resolveContinuityDatabasePath();
  let continuityPathAvailable = true;
  try {
    assertDistinctDatabasePaths(workflowDatabasePath, continuityDatabasePath);
  } catch {
    continuityPathAvailable = false;
  }
  const store = new SqliteWorkflowStore(workflowDatabasePath);
  const trustStore = new TrustStore(resolveTrustDatabasePath());
  let continuityStore: SqliteContinuityStore | null = null;
  process.once("exit", () => {
    continuityStore?.close();
    trustStore.close();
    store.close();
  });

  const validator = new ContractValidator();
  const attestationHost = resolveHostAttestation();
  const hostAttestation = attestationHost ? new HostAttestationProvider(
    store, attestationHost === "codex" ? codexExecutionAdapter : claudeCodeExecutionAdapter,
  ) : null;
  // Neither bundled host currently exposes a cryptographically distinct direct-human approval event.
  const trust = new TrustService(trustStore);
  const service = new WorkflowService(
    new FileSkillRegistry(registryPath, validator),
    validator,
    store,
    null,
    hostAttestation,
  );
  const updates = new PluginUpdateService(store);
  let continuity: ContinuityGateway = new UnavailableContinuityService(continuityPathAvailable ? "STORE_UNAVAILABLE" : "DATABASE_PATH_CONFLICT");
  if (continuityPathAvailable) {
    try {
      continuityStore = new SqliteContinuityStore(continuityDatabasePath);
      continuity = new ContinuityService(continuityStore, validator, store);
    } catch (error) {
      // Optional continuity failures never prevent the workflow MCP server from starting.
      try { continuityStore?.close(); } catch { /* Preserve the optional initialization failure. */ }
      continuityStore = null;
      continuity = new UnavailableContinuityService(continuityUnavailableReason(error));
    }
  }
  const cleanup = new StateCleanupService(store, continuityStore, validator);
  const glossary = new SqliteKoreanProseGlossary(resolveKoreanProseGlossaryPath());
  const classificationRoot = path.dirname(path.dirname(registryPath));
  const classificationConfig = process.env.AGENT_GOVERNANCE_CLASSIFICATION_CONFIG;
  let initializationFailed = false;
  let providerRuntimeRef: string | null | undefined;
  let providerBytesDigest: string | null = null;
  let nativeDefinitionsRef: string | null | undefined;
  let nativeDefinitionDigest: string | null = null;
  let providerRuntime: ConstructorParameters<typeof SkillClassificationService>[0] =
    {providers: {}, budget: new InMemoryClassificationBudget({jev: {limitUsd: null, spentUsd: null}, vendors: {}})};
  try {
    const initialRuntime = await readClassificationRuntime(classificationConfig, classificationRoot);
    providerRuntimeRef = initialRuntime.providerRuntimeRef;
    providerBytesDigest = providerRuntimeRef ? digestClassificationValue((await readFile(providerRuntimeRef)).toString("utf8")) : null;
    nativeDefinitionsRef = initialRuntime.nativeAdapterDefinitionsRef;
    const nativeDefinitionBytes = nativeDefinitionsRef ? await readFile(nativeDefinitionsRef) : null;
    if (nativeDefinitionBytes && nativeDefinitionBytes.length > 1024 * 1024) throw new Error("NATIVE_ADAPTER_DEFINITIONS_TOO_LARGE");
    nativeDefinitionDigest = nativeDefinitionBytes ? digestClassificationValue(nativeDefinitionBytes.toString("utf8")) : null;
    const nativeDefinitions: NativeClassificationAdapterDefinition[] = nativeDefinitionBytes ? JSON.parse(nativeDefinitionBytes.toString("utf8")) as NativeClassificationAdapterDefinition[] : [];
    const nativeAdapters = createNativeClassificationAdapters(nativeDefinitions);
    if (providerRuntimeRef) providerRuntime = await loadClassificationProviderRuntime(providerRuntimeRef, {nativeAdapters});
  } catch { initializationFailed = true; }
  const classification = new RuntimeSkillClassificationGateway({root: classificationRoot,
    observeRuntime: () => {
      try {
        if (!classificationConfig) return "unconfigured";
        const absolute = path.resolve(classificationRoot, classificationConfig);
        const read = (file: string) => {const bytes = readFileSync(file); if (bytes.length > 1024 * 1024) throw new Error("CONFIG_TOO_LARGE"); return bytes.toString("utf8");};
        const configBytes = read(absolute);
        const data = JSON.parse(configBytes) as {config: {providerProfileRegistryRef: string}; providerRuntimeRef?: string | null; nativeAdapterDefinitionsRef?: string | null};
        return digestClassificationValue([configBytes, read(path.resolve(path.dirname(absolute), data.config.providerProfileRegistryRef)),
          data.providerRuntimeRef ? read(path.resolve(path.dirname(absolute), data.providerRuntimeRef)) : null,
          data.nativeAdapterDefinitionsRef ? read(path.resolve(path.dirname(absolute), data.nativeAdapterDefinitionsRef)) : null]);
      } catch {return null;}
    },
    observeTask: (request, observation) => {
      if (!observation) return null;
      const board = openBoard(resolveSessionBoardDatabasePath(), {busyTimeoutMs: 500});
      try {
        const session = listSessions(board, new Date().toISOString()).find(candidate => observation.actorId === hostActorId(candidate.host, candidate.sessionId));
        return session?.lastPromptAt ? {taskRevision: request.confirmedContext.taskRevision, requestDigest: request.requestDigest, cancelled: false, sourceRef: `host-prompt:${observation.actorId}:${session.lastPromptAt}`} : null;
      } finally {board.close();}
    },
    readRuntime: async () => {
      if (initializationFailed) throw new Error("CLASSIFICATION_CONFIGURATION_UNAVAILABLE");
      const runtime = await readClassificationRuntime(classificationConfig, classificationRoot);
      if (runtime.providerRuntimeRef !== providerRuntimeRef || (providerRuntimeRef && digestClassificationValue((await readFile(providerRuntimeRef)).toString("utf8")) !== providerBytesDigest)) throw new Error("APPROVED_PROVIDER_RUNTIME_CHANGED");
      if (runtime.nativeAdapterDefinitionsRef !== nativeDefinitionsRef || (nativeDefinitionsRef && digestClassificationValue((await readFile(nativeDefinitionsRef)).toString("utf8")) !== nativeDefinitionDigest)) throw new Error("APPROVED_NATIVE_ADAPTERS_CHANGED");
      return runtime;
    },
    service: new SkillClassificationService(providerRuntime),
  });
  const server = createMcpServer(service, updates, continuity, cleanup, glossary, validator, resolveToolSchemaProfile(), hostAttestation, resolveSessionBoardDatabasePath(), undefined, trust, classification);
  await server.connect(new StdioServerTransport());
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
