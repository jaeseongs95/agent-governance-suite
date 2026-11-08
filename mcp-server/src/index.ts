import { builtinCallerIngress } from "./builtin-caller-ingress.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { FileSkillRegistry } from "./registry.js";
import { ContinuityService, type ContinuityGateway, UnavailableContinuityService } from "./continuity-service.js";
import { continuityUnavailableReason, SqliteContinuityStore } from "./continuity-store.js";
import {
  resolveAdminPageUrl,
  assertDistinctDatabasePaths,
  resolveAdminPort,
  resolveContextLayerDatabasePath,
  resolveContinuityDatabasePath,
  resolveHostAttestation,
  resolveJevKeyVaultPath,
  resolveKoreanProseGlossaryPath,
  resolveRegistryPath,
  resolveSessionBoardDatabasePath,
  resolveToolSchemaProfile,
  resolveTrustDatabasePath,
  resolveWorkflowDatabasePath,
} from "./runtime-config.js";
import { ContractValidator } from "./schema-validator.js";
import { createMcpServer } from "./server.js";
import { ContextLayerService } from "./context-layer-service.js";
import { ContextLayerStore } from "./context-layer-store.js";
import { PluginUpdateService } from "./plugin-update-service.js";
import { SqliteWorkflowStore } from "./sqlite-workflow-store.js";
import { WorkflowService } from "./workflow-service.js";
import { HostAttestationProvider, type HostExecutionAdapter } from "./host-attestation.js";
import { StateCleanupService } from "./state-cleanup-service.js";
import { SqliteKoreanProseGlossary } from "./korean-prose-glossary.js";
import { TrustStore } from "./trust-store.js";
import { TrustService } from "./trust-service.js";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { ClassificationWireAdapter } from "./skill-classification/providers.js";
import { RuntimeSkillClassificationGateway, readClassificationRuntime } from "./skill-classification/gateway.js";
import { InMemoryClassificationBudget, SkillClassificationService } from "./skill-classification/service.js";
import { ClassificationInitializationError, classificationProviderRuntimeSchema, loadClassificationProviderRuntime, reportClassificationInitializationFailure } from "./skill-classification/runtime.js";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { digestClassificationValue } from "./skill-classification/request.js";
import { listPromptMarkers, openBoard } from "../../runtime/session-board-store.mjs";
import { hostActorId } from "./host-attestation.js";
import { createNativeClassificationAdapters, type NativeClassificationAdapterDefinition, type NativeCliBehavior } from "./skill-classification/native-adapters.js";
import { bindNativeClassificationDefinitions } from "./skill-classification/native-cli-strategies.js";
import { failureContext } from "./failure-diagnostics.js";
import { writeDiagnostic, writeFailureDiagnostic } from "./hook-error-diagnostics.js";
import { type AdminSessionView, sessionKindUnknown, startAdminPage } from "./admin-page-server.js";
import { resolveSkillUsageDatabasePath, skillUsageSummary } from "./skill-usage-store.js";
import { type AdminPageState } from "./context-layer-service.js";
import { adminSettingsView, type AdminSettingsView, type JevInstallationView, type JevProfileFor, type JevProviderView } from "./admin-settings.js";
import { composeJev } from "./skill-classification/jev-composition.js";
import { JevKeyVault } from "./jev-key-vault.js";
import { InMemoryClassificationBudget as ClassificationBudget } from "./skill-classification/service.js";
import { mergeSessionBoard } from "./server.js";
import { SessionMessageService } from "./session-message-service.js";


/** Trusted installation code supplies adapters; request JSON and environment names cannot register them. */
export async function startMcpServer(
  wireAdapters: ReadonlyMap<string, ClassificationWireAdapter> = new Map(),
  executionAdapters?: ReadonlyMap<string, HostExecutionAdapter>,
  nativeBehaviors?: ReadonlyMap<string, NativeCliBehavior>,
): Promise<void> {
  const executionAdapter = resolveHostAttestation(process.env, executionAdapters);
  // Snapshot trusted composition before the first asynchronous operation.
  const installedWireAdapters = new Map(wireAdapters);
  const installedNativeBehaviors = nativeBehaviors === undefined ? undefined : new Map(nativeBehaviors);
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
  const hostAttestation = executionAdapter ? new HostAttestationProvider(executionAdapter) : null;
  // Native form support is checked per client; actual user response provenance remains a host contract.
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
  let adminPort = 0;
  try { adminPort = resolveAdminPort(); } catch { writeDiagnostic("admin-page", "port-invalid", { setting: "AGENT_GOVERNANCE_ADMIN_PORT" }); }
  // Opened per call: every host's processes share this file, and a read never creates it. The JEV settings and keys the
  // user signed on the admin page are read through it on each use (verified every time).
  const contextLayers = new ContextLayerService(create => ContextLayerStore.open(resolveContextLayerDatabasePath(), create), undefined,
    () => adminPort ? resolveAdminPageUrl() : null, new JevKeyVault(resolveJevKeyVaultPath()));
  const signedJev = () => {
    try { return contextLayers.verifiedState()?.jev ?? null; } catch { return null; }
  };
  // A key registered on the page (never logged).
  const pageKey = (name: string): string | null => {
    try { return contextLayers.jevKey(name); } catch (error) {
      writeDiagnostic("skill-classification", "jev-key-unreadable", { code: (error as { code?: unknown }).code ?? "UNREADABLE" });
      return null;
    }
  };
  // The installation's vendor routes: an environment variable named by the route wins, else the page key (unchanged).
  const getCredentialByEnvName = async (name: string): Promise<string | null> => process.env[name] ? process.env[name]! : pageKey(name);
  // JEV (4.0.0): the provider AGS ships and the page's signed settings only; its key is the one registered on the page.
  const jev = composeJev({ signed: signedJev, pageKey });
  const jevSignedLimitUsd = jev.signedLimitUsd;
  const classificationRoot = path.dirname(path.dirname(registryPath));
  const classificationConfig = process.env.AGENT_GOVERNANCE_CLASSIFICATION_CONFIG;
  let initializationFailure: ClassificationInitializationError | null = null;
  let providerRuntimeRef: string | null | undefined;
  let providerBytesDigest: string | null = null;
  let nativeDefinitionsRef: string | null | undefined;
  let nativeDefinitionDigest: string | null = null;
  let vendorAdviceConfigured = false;
  let providerRuntime: ConstructorParameters<typeof SkillClassificationService>[0] =
    {providers: {jev: jev.provider}, budget: new InMemoryClassificationBudget({jev: {limitUsd: null, spentUsd: null}, vendors: {}, jevSignedLimitUsd})};
  try {
    const initialRuntime = await readClassificationRuntime(classificationConfig, classificationRoot);
    providerRuntimeRef = initialRuntime.providerRuntimeRef;
    providerBytesDigest = providerRuntimeRef ? digestClassificationValue((await readFile(providerRuntimeRef)).toString("utf8")) : null;
    nativeDefinitionsRef = initialRuntime.nativeAdapterDefinitionsRef;
    const nativeDefinitionBytes = nativeDefinitionsRef ? await readFile(nativeDefinitionsRef) : null;
    if (nativeDefinitionBytes && nativeDefinitionBytes.length > 1024 * 1024) throw new Error("NATIVE_ADAPTER_DEFINITIONS_TOO_LARGE");
    nativeDefinitionDigest = nativeDefinitionBytes ? digestClassificationValue(nativeDefinitionBytes.toString("utf8")) : null;
    const nativeDefinitions: NativeClassificationAdapterDefinition[] = nativeDefinitionBytes ? JSON.parse(nativeDefinitionBytes.toString("utf8")) as NativeClassificationAdapterDefinition[] : [];
    const nativeAdapters = createNativeClassificationAdapters(bindNativeClassificationDefinitions(nativeDefinitions, installedNativeBehaviors));
    if (providerRuntimeRef) {
      const installed = await loadClassificationProviderRuntime(providerRuntimeRef, {nativeAdapters, wireAdapters: installedWireAdapters,
        getCredentialByEnvName, jevSignedLimitUsd, ignoreJev: true});
      providerRuntime = {providers: {jev: jev.provider, ...(installed.providers.vendor ? {vendor: installed.providers.vendor} : {})}, budget: installed.budget};
    }
    vendorAdviceConfigured = initialRuntime.registry.profiles.some(profile => profile.providerKind === "vendor");
    // The installation's JEV settings are no longer read; say so once instead of ignoring them silently.
    const ignored = await ignoredJevSettings(initialRuntime);
    const jevEnabledInFile = Boolean(classificationConfig) && initialRuntime.config.jevEnabled;
    if (ignored.routes || ignored.profiles || jevEnabledInFile) {
      writeDiagnostic("skill-classification", "jev-installation-settings-ignored", { ...ignored, jevEnabled: jevEnabledInFile,
        adminUrl: adminPort ? resolveAdminPageUrl() : null });
    }
  } catch (error) {
    initializationFailure = new ClassificationInitializationError(error);
    reportClassificationInitializationFailure(initializationFailure);
  }
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
        // A child caller's actor ID extends its root session's actor ID; both read the root session's prompt.
        const session = listPromptMarkers(board).find(candidate => {
          const root = hostActorId(candidate.host, candidate.sessionId);
          return observation.actorId === root || (observation.actorId ?? "").startsWith(`${root}:`);
        });
        return session ? {taskRevision: request.confirmedContext.taskRevision, requestDigest: request.requestDigest, cancelled: false, sourceRef: `host-prompt:${observation.actorId}:${session.lastPromptAt}`} : null;
      } finally {board.close();}
    },
    readRuntime: async () => {
      if (initializationFailure) throw initializationFailure;
      const runtime = await readClassificationRuntime(classificationConfig, classificationRoot);
      if (runtime.providerRuntimeRef !== providerRuntimeRef || (providerRuntimeRef && digestClassificationValue((await readFile(providerRuntimeRef)).toString("utf8")) !== providerBytesDigest)) throw new Error("APPROVED_PROVIDER_RUNTIME_CHANGED");
      if (runtime.nativeAdapterDefinitionsRef !== nativeDefinitionsRef || (nativeDefinitionsRef && digestClassificationValue((await readFile(nativeDefinitionsRef)).toString("utf8")) !== nativeDefinitionDigest)) throw new Error("APPROVED_NATIVE_ADAPTERS_CHANGED");
      // The switch, the preset, the model, the consent and the fallback the user signed apply on each read (default off).
      return jev.apply(runtime);
    },
    service: new SkillClassificationService(providerRuntime),
    adviceReady: () => !initializationFailure && (jev.ready(jevUsage(providerRuntime.budget)) || vendorAdviceConfigured),
  });
  const classificationBudget = providerRuntime.budget;
  const sessionMessages = new SessionMessageService();
  const server = createMcpServer(service, updates, continuity, cleanup, glossary, validator, resolveToolSchemaProfile(), hostAttestation, resolveSessionBoardDatabasePath(), sessionMessages, trust, classification, builtinCallerIngress(process.env.AGENT_GOVERNANCE_HOST_ATTESTATION, store),
    contextLayers);
  await server.connect(new StdioServerTransport());
  await startAdminPage({
    service: contextLayers,
    port: adminPort,
    listSessions: () => adminSessions(sessionMessages, resolveSessionBoardDatabasePath()),
    settings: async admin => adminSettings(admin, classificationConfig, classificationRoot, jevUsage(classificationBudget),
      await jev.views(), jev.profileFor),
    skillUsage: days => ({
      skills: (JSON.parse(readFileSync(registryPath, "utf8")) as { skills: Array<{ skillId: string }> }).skills.map(skill => skill.skillId),
      ...skillUsageSummary(resolveSkillUsageDatabasePath(), days),
    }),
  });
}

/** The JEV spending this process has tallied (spent since it started, plus reservations); null when it keeps none. */
function jevUsage(budget: unknown): { spentUsd: number | null; reservedUsd: number } | null {
  if (!(budget instanceof ClassificationBudget)) return null;
  const snapshot = budget.snapshot();
  return { spentUsd: snapshot.limits.jev?.spentUsd ?? null,
    reservedUsd: snapshot.reservations.filter(item => item.bucket === "jev").reduce((sum, item) => sum + item.maximumUsd, 0) };
}

/** JEV routes and profiles an installation still carries; AGS no longer reads them (4.0.0). */
async function ignoredJevSettings(runtime: { providerRuntimeRef?: string | null; registry: { profiles: Array<{ providerKind: string }> } }) {
  let routes = 0;
  if (runtime.providerRuntimeRef) {
    const parsed = JSON.parse(await readFile(runtime.providerRuntimeRef, "utf8")) as { routes?: Array<{ providerKind?: unknown }> };
    routes = (parsed.routes ?? []).filter(route => route.providerKind === "jev").length;
  }
  return { routes, profiles: runtime.registry.profiles.filter(profile => profile.providerKind === "jev").length };
}

/** The page lists sessions by their presence (no session of its own); ended ones come from the presence it still keeps. */
const ADMIN_PAGE_SELF = { host: "ags-admin-page", sessionId: "admin-page" };

async function adminSessions(sessionMessages: SessionMessageService, boardPath: string): Promise<AdminSessionView[]> {
  const current = (await sessionMessages.listCurrentPresence(ADMIN_PAGE_SELF)).sessions
    .filter(item => item.host !== ADMIN_PAGE_SELF.host || item.sessionId !== ADMIN_PAGE_SELF.sessionId);
  const seen = new Set(current.map(item => `${item.host}\u0000${item.sessionId}`));
  const ended = sessionMessages.knownPresence().filter(item => item.state === "ended" && !seen.has(`${item.host}\u0000${item.sessionId}`))
    .map(item => ({ host: item.host, sessionId: item.sessionId, state: item.state, startedAt: null, heartbeatAt: item.heartbeatAt, leaseUntil: null,
      workspaceId: null, transport: null, autoWake: null as never }));
  const { sessions } = mergeSessionBoard(boardPath, [...current, ...ended], null);
  return sessions.map(session => ({
    host: session.host, hostLabel: session.host, sessionId: session.sessionId,
    state: session.presence === "online" || session.presence === "unreachable" ? session.presence : "ended",
    cwd: session.cwd, summary: session.summary, selfRole: session.role, lastSeenAt: session.lastSeenAt,
    kindUnknown: sessionKindUnknown(session),
  }));
}

/** What the page shows about the settings: the signed values, the JEV providers AGS ships and the installation's vendors. */
async function adminSettings(admin: AdminPageState, classificationConfig: string | undefined, classificationRoot: string,
  usage: { spentUsd: number | null; reservedUsd: number } | null, providers: JevProviderView[], profileFor: JevProfileFor): Promise<AdminSettingsView> {
  const installation: JevInstallationView = { configured: Boolean(classificationConfig), vendorIds: [], credentials: [],
    ignoredJev: { routes: 0, profiles: 0 }, error: null };
  if (classificationConfig) {
    try {
      const runtime = await readClassificationRuntime(classificationConfig, classificationRoot);
      installation.vendorIds = [...new Set(runtime.registry.profiles.filter(profile => profile.providerKind === "vendor").map(profile => profile.vendorId))].sort();
      installation.ignoredJev = await ignoredJevSettings(runtime);
      if (runtime.providerRuntimeRef) {
        const routes = classificationProviderRuntimeSchema.parse(JSON.parse(await readFile(runtime.providerRuntimeRef, "utf8")));
        const credentials = new Map<string, Set<string>>();
        for (const route of routes.routes) {
          if (route.kind === "remote" && route.providerKind === "vendor") {
            credentials.set(route.credentialEnvName, (credentials.get(route.credentialEnvName) ?? new Set()).add(route.vendorId));
          }
        }
        installation.credentials = [...credentials].map(([name, vendors]) => ({ name, vendorIds: [...vendors].sort() }));
      }
    } catch (error) {
      installation.error = failureContext(error).type === "syntax-error" ? "CONFIG_INVALID" : "CONFIG_UNREADABLE";
    }
  }
  return adminSettingsView({ environment: process.env, signed: admin.signedSettings, installation, usage, providers, profileFor });
}

/** `server.mjs admin-reset`: archives the signed admin log after every passkey was lost (no HTTP or MCP path). */
function adminResetCommand(args: string[]): number {
  const service = new ContextLayerService(create => ContextLayerStore.open(resolveContextLayerDatabasePath(), create));
  const state = service.adminState();
  const summary = { keys: state.keys.length, roles: state.roles.length, bindings: state.bindings.length, lastSeq: state.lastSeq };
  if (!args.includes("--yes")) {
    process.stdout.write(`${JSON.stringify({ command: "admin-reset", dryRun: true, wouldArchive: summary,
      effect: "Every signed admin item returns to its default (no global context, no roles, no bindings, no passkeys, JEV off, no JEV keys; the edit gate exceptions come from the environment or the default). Re-run with --yes." })}\n`);
    return 0;
  }
  const reset = service.reset();
  process.stdout.write(`${JSON.stringify({ command: "admin-reset", reset, archived: summary })}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href && process.argv[2] === "admin-reset") {
  try { process.exitCode = adminResetCommand(process.argv.slice(3)); } catch (error) {
    process.exitCode = 1;
    writeDiagnostic("admin-reset", "failed", { context: failureContext(error) }, line => writeFailureDiagnostic(line + "\n"));
  }
} else if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  void startMcpServer().catch(error => {
    process.exitCode = 1;
    // Fatal startup stays observable on stderr.
    writeDiagnostic("server", "startup-failure", {phase: "startup", context: failureContext(error)}, line => writeFailureDiagnostic(line + "\n"));
  });
}
