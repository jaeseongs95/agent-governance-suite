import path from "node:path";
import {fileURLToPath} from "node:url";
import {build} from "esbuild";
import {describe, expect, it} from "vitest";
import {resolveCatalogModel} from "../../skills/coordinate-subagents/scripts/model-catalog-adapter.mjs";
import {collaborationDecisionStructuralDiagnostic} from "../../skills/orchestrator/scripts/collaboration-decision.mjs";
import {openBoard, recordInput, setSummary, readEntry} from "../../skills/session-board/scripts/board-store.mjs";

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
});
