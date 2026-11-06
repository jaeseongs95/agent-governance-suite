import path from "node:path";
import {cpSync, mkdtempSync, rmSync} from "node:fs";
import {spawnSync} from "node:child_process";
import {tmpdir} from "node:os";
import {fileURLToPath} from "node:url";
import {build} from "esbuild";
import {describe, expect, it} from "vitest";
import {resolveCatalogModel} from "../../skills/coordinate-subagents/scripts/model-catalog-adapter.mjs";
import {collaborationDecisionStructuralDiagnostic} from "../../skills/orchestrator/scripts/collaboration-decision.mjs";
import {openBoard, recordInput, setSummary, readEntry} from "../../skills/session-board/scripts/board-store.mjs";
import {createCatalogExecutionAdapters, type CatalogModelEntryV1} from "../../mcp-server/src/host-execution-adapters.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
describe("AGS3 D0007 shared implementation boundaries", () => {
  it.each(["provider-semantics.ts", "host-execution-adapters.ts", "trust-service.ts", "inactive-shared-stores.ts", "session-board-hook.ts"])("CB-07 bundles %s when skill implementation files are unavailable", async entry => {
    await expect(build({entryPoints: [path.join(root, "mcp-server/src", entry)], bundle: true, platform: "node", format: "esm", write: false,
      plugins: [{name: "unavailable-skill-implementations", setup(builder) {builder.onResolve({filter: /skills[\\/][^\\/]+[\\/]scripts[\\/]/}, () => ({errors: [{text: "skill implementation unavailable"}]}));}}], logLevel: "silent"})).resolves.toMatchObject({errors: []});
  });
  it("CB-08 preserves exact catalog evidence through the existing skill export", () => {
    const catalog = {matching: "exact-only" as const, models: {"exact-model": {}, balanced: {}}, aliases: {"provider/exact": "exact-model"}, profile_only_keys: ["balanced"]};
    expect(resolveCatalogModel(catalog, "exact-model")).toBe("exact-model");
    expect(resolveCatalogModel(catalog, "provider/exact")).toBe("exact-model");
    expect(resolveCatalogModel(catalog, "exact-model-new")).toBeNull();
    expect(resolveCatalogModel(catalog, "balanced")).toBeNull();
    expect(resolveCatalogModel(catalog, "balanced", {allowProfileKeys: true})).toBe("balanced");
  });
  it("CB-09 preserves user prohibitions and independent audit requirements through the existing skill export", () => {
    const decision = {schemaVersion: "1.2.0", sourceOriginKind: "user-turn", sourceReceiptId: null, authorityEffect: "none", userDirective: "forbid",
      netBenefitCriteria: {independentlyCompletable: true, parallelBottleneckReduced: true, limitedContextSufficient: true, singleWriterOwnership: true, netBenefitAfterOverhead: true},
      auditSeparationRequired: true, route: "audit-only"};
    expect(collaborationDecisionStructuralDiagnostic(decision)).toMatchObject({scope: "structural-only", valid: true, errors: []});
    expect(collaborationDecisionStructuralDiagnostic({...decision, route: "delegate"}).valid).toBe(false);
  });
  it("CB-10 preserves role when the existing board skill caller only updates its summary", () => {
    const db = openBoard(":memory:"), session = {host: "synthetic-neutral-host", sessionId: "owned-session", now: "2026-11-07T00:00:00.000Z"};
    try {
      recordInput(db, {...session, cwd: root}, {prompt: true});
      setSummary(db, session, "initial", "reviewer");
      setSummary(db, session, "updated");
      expect(readEntry(db, session.host, session.sessionId)).toMatchObject({summary: "updated", role: "reviewer", lastPromptAt: session.now});
    } finally {db.close();}
  });
  it("CB-11 preserves the skill-folder-only CLI without a shared runtime", () => {
    const clean = mkdtempSync(path.join(tmpdir(), "ags38-catalog-standalone-"));
    try {
      cpSync(path.join(root, "skills/coordinate-subagents"), path.join(clean, "skill"), {recursive: true});
      const result = spawnSync(process.execPath, [path.join(clean, "skill/scripts/model-routing.mjs")], {cwd: clean, encoding: "utf8", windowsHide: true});
      expect(result.error).toBeUndefined();
      expect(result.stderr.trim()).toBe("skillTools.modelRouting.usage");
    } finally {rmSync(clean, {recursive: true, force: true});}
  });
  it("CB-12 compiles only declared admission IDs and snapshots their capability metadata", () => {
    const entry: CatalogModelEntryV1 = {model_class: "general", minimum_effort: "medium", supported_efforts: ["medium", "high"]};
    const catalog = {matching: "exact-only" as const, models: {"model-a": entry, balanced: entry},
      aliases: {observed: "model-a", dangling: "missing", "model-a": "model-a"}, profile_only_keys: ["balanced"]};
    const suite = createCatalogExecutionAdapters({schema_version: 1, model_class_order: ["general"], effort_order: ["medium", "high"],
      providers: {vendor: {host: "neutral-admission-host", catalog, minimum_efforts: {observed: "high"}}}});
    const adapter = suite.adapters.get("neutral-admission-host")!;
    expect(adapter.resolveModel?.("model-a")).toMatchObject({modelClass: "general", resolvedModel: "model-a", minimumReasoningEffort: "medium", aliasUsed: false});
    expect(adapter.resolveModel?.("observed")).toMatchObject({modelClass: "general", resolvedModel: "model-a", minimumReasoningEffort: "high", aliasUsed: true});
    for (const raw of ["model-a-next", "balanced", "dangling"]) expect(adapter.resolveModel?.(raw)).toBeNull();
    catalog.models["model-a"] = {model_class: "frontier", minimum_effort: "high", supported_efforts: ["high"]};
    catalog.aliases.observed = "missing";
    expect(adapter.resolveModel?.("observed")).toMatchObject({modelClass: "general", resolvedModel: "model-a", minimumReasoningEffort: "high"});
  });
});
