import path from "node:path";
import {cpSync, mkdtempSync, readdirSync, readFileSync, rmSync} from "node:fs";
import {spawnSync} from "node:child_process";
import {tmpdir} from "node:os";
import {fileURLToPath} from "node:url";
import {build, transformSync} from "esbuild";
import {describe, expect, it} from "vitest";
import {resolveCatalogModel} from "../../skills/coordinate-subagents/scripts/model-catalog-adapter.mjs";
import {collaborationDecisionStructuralDiagnostic} from "../../skills/orchestrator/scripts/collaboration-decision.mjs";
import {openBoard, recordInput, setSummary, readEntry} from "../../skills/session-board/scripts/board-store.mjs";
import {createCatalogExecutionAdapters, type CatalogModelEntryV1} from "../../mcp-server/src/host-execution-adapters.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
/**
 * Remaining named-skill dependencies, each tracked elsewhere: `<core file> <- <literal or input>`. The list may only
 * shrink; an entry that no longer occurs fails CB-07 so it cannot hide a later regression at the same place.
 */
const KNOWN = new Set([
  // WP-A (model catalog path, AGS3-D-0007).
  "runtime/model-catalog-adapter.mjs <- ../skills/coordinate-subagents/references/model-routing-presets.json",
  "<input> <- skills/coordinate-subagents/references/model-routing-presets.json",
  // Not yet owned: skill contract schemas imported by shared runtime, orchestrator references read by core.
  "runtime/collaboration-decision.mjs <- ../skills/orchestrator/contracts/collaboration-decision.v1.schema.json",
  "<input> <- skills/orchestrator/contracts/collaboration-decision.v1.schema.json",
  "runtime/provider-acceptance-schema.mjs <- ../skills/acceptance-evidence-validator/contracts/acceptance-evidence-input.v1.schema.json",
  "runtime/provider-acceptance-schema.mjs <- ../skills/acceptance-evidence-validator/contracts/acceptance-evidence-report.v1.schema.json",
  "runtime/provider-acceptance-schema.mjs <- ../skills/acceptance-evidence-validator/contracts/acceptance-report-validation.v1.schema.json",
  "runtime/provider-acceptance-schema.mjs <- ../skills/acceptance-evidence-validator/integration/provider-result.v1.schema.json",
  "<input> <- skills/acceptance-evidence-validator/contracts/acceptance-evidence-input.v1.schema.json",
  "<input> <- skills/acceptance-evidence-validator/contracts/acceptance-evidence-report.v1.schema.json",
  "<input> <- skills/acceptance-evidence-validator/contracts/acceptance-report-validation.v1.schema.json",
  "<input> <- skills/acceptance-evidence-validator/integration/provider-result.v1.schema.json",
  "runtime/engineering-practices/core.mjs <- skills/orchestrator/references/engineering-practices",
  "mcp-server/src/skill-intake.ts <- orchestrator/references/intake.md",
  "mcp-server/src/skill-classification/gateway.ts <- skills/orchestrator/references/skill-classification.md",
]);

/**
 * Bundles every core module (all of mcp-server/src, derived, never listed) plus each runtime CLI that core names as a
 * file to run, then reports every bundled input under skills/ and every code literal that starts with a path into a
 * specific skill folder. Skill names come from the skills directory; comments are stripped before the literal scan.
 */
async function namedSkillDependencies(): Promise<string[]> {
  const toPosix = (file: string) => file.split(path.sep).join("/");
  const skills = readdirSync(path.join(root, "skills"), {withFileTypes: true}).filter(entry => entry.isDirectory()).map(entry => entry.name);
  expect(skills.length, "skill folders are discovered").toBeGreaterThan(10);
  expect(skills.every(name => /^[a-z0-9-]+$/u.test(name)), "skill folder names need no regex escaping").toBe(true);
  const named = new RegExp(String.raw`(["'\x60])((?:\.{1,2}/)*(?:skills/)?(?:${skills.join("|")})/[^"'\x60\n]*)\1`, "gu");
  const runtimeCli = /["'`]((?:\.{1,2}\/)*runtime\/[\w./-]+\.mjs)["'`]/gu;
  const entries = new Set(readdirSync(path.join(root, "mcp-server/src"), {recursive: true, encoding: "utf8"})
    .filter(file => file.endsWith(".ts") && !file.endsWith(".d.ts")).map(file => toPosix(path.join("mcp-server/src", file))));
  expect(entries.has("mcp-server/src/index.ts") && entries.has("mcp-server/src/server.ts"), "server entry points are derived").toBe(true);
  const found = new Set<string>();
  for (let size = -1; size !== entries.size;) {
    size = entries.size;
    const result = await build({absWorkingDir: root, entryPoints: [...entries], bundle: true, platform: "node", format: "esm",
      packages: "external", write: false, outdir: path.join(root, ".cb07-unwritten"), metafile: true, logLevel: "silent"});
    for (const input of Object.keys(result.metafile.inputs).map(toPosix)) {
      if (input.startsWith("skills/")) { found.add(`<input> <- ${input}`); continue; }
      if (!/\.(?:[cm]?[jt]s)$/u.test(input) || input.includes("node_modules/")) continue;
      const code = transformSync(readFileSync(path.join(root, input), "utf8"), {loader: input.endsWith(".ts") ? "ts" : "js", format: "esm"}).code;
      for (const match of code.matchAll(named)) found.add(`${input} <- ${match[2]}`);
      for (const match of code.matchAll(runtimeCli)) {
        const cli = toPosix(path.relative(root, path.resolve(root, match[1]!.replace(/^(?:\.{1,2}\/)+/u, ""))));
        if (cli.startsWith("runtime/") && readdirSync(path.join(root, path.dirname(cli))).includes(path.basename(cli))) entries.add(cli);
      }
    }
  }
  return [...found].sort();
}

describe("AGS3 D0007 shared implementation boundaries", () => {
  it("CB-07 core modules and the runtime they load or run never name a file inside a specific skill", async () => {
    const violations = await namedSkillDependencies();
    expect(violations.filter(found => !KNOWN.has(found)), "new core dependency on a specific skill's files").toEqual([]);
    expect([...KNOWN].filter(known => !violations.includes(known)), "resolved exemption: delete it from KNOWN").toEqual([]);
  }, 120_000);
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
