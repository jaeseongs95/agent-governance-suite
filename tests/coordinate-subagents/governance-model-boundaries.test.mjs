import {spawnSync} from "node:child_process";
import {cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {createHash} from "node:crypto";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {afterEach, describe, expect, it} from "vitest";
import {applySkillAdaptation} from "../../scripts/build-claude-plugin.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const cleanups = [];
afterEach(() => {while (cleanups.length) {const dir = cleanups.pop(); if (path.dirname(dir) !== path.resolve(root)) throw new Error("fixture cleanup escaped owned root"); rmSync(dir, {recursive: true, force: true});}});
const classes = ["lightweight", "general", "deep", "frontier"];
const efforts = ["low", "medium", "high", "xhigh", "max", "ultra"];
function policy(provider = "opaque-host-a", model = "opaque-engine-a") {
  return {schema_version: 1, policy_revision: "fixture.r1", default_profile: "balanced", roles: ["general-implementation", "independent-audit"],
    model_class_order: classes, effort_order: efforts, providers: {[provider]: {
      catalog: {matching: "exact-only", models: {[model]: {model_class: "general", supported_efforts: ["medium", "high"], minimum_effort: "high"}}, aliases: {}},
      profiles: {balanced: {"general-implementation": {model, effort: "high", model_class: "general"}, "independent-audit": {model, effort: "high", model_class: "general"}}},
      application: {model_field: "engine", effort_field: "reasoning", context_field: "context", default_context: "full", full_history_value: "full", limited_context_value: "isolated", full_history_overrides: false},
    }}};
}
function fixture(provider = "opaque-host-a", model = "opaque-engine-a") {
  const dir = mkdtempSync(path.join(root, ".gov-routing-")); cleanups.push(dir);
  cpSync(path.join(root, "skills/coordinate-subagents"), path.join(dir, "skill"), {recursive: true});
  const cli = path.join(dir, "skill/scripts/model-routing.mjs"), inputPath = path.join(dir, "input.json"), presetPath = path.join(dir, "presets.json");
  const presets = policy(provider, model);
  const options = {provider, role: "general-implementation", highRisk: false, supported: [{model, modelClass: "general", efforts: ["medium", "high"]}]};
  const run = (operation, input = options, custom = presets, extra = ["--presets", presetPath]) => {
    writeFileSync(inputPath, JSON.stringify(input)); writeFileSync(presetPath, JSON.stringify(custom));
    const env = {...process.env}; delete env.NODE_OPTIONS; delete env.NODE_PATH;
    const result = spawnSync(process.execPath, [cli, operation, inputPath, ...extra], {cwd: dir, env, encoding: "utf8", windowsHide: true});
    if (result.error) throw result.error;
    return {...result, value: result.stdout ? JSON.parse(result.stdout) : null};
  };
  const record = () => ({assignmentId: "fixture-unit", selectionReason: "Observed role capability", options, spawnArguments: {engine: model, reasoning: "high", context: "isolated"}, observation: null});
  return {dir, cli, options, presets, run, record};
}

describe("GOV09/10 actual provider replacement boundary", () => {
  it.each([["opaque-host-a", "opaque-engine-a"], ["opaque-host-b", "opaque-engine-b"], ["opaque-host-c", "opaque-engine-c"]])("resolves %s through the packaged CLI role/profile without editing common code", (provider, model) => {
    const h = fixture(provider, model), result = h.run("resolve");
    expect(result.status).toBe(0); expect(result.value.selection).toEqual({model, effort: "high"}); expect(result.value.delivery).toBe("explicit");
  });
  it("replaces one installed adapter's profile and actual argument mapping as data", () => {
    const h = fixture(), before = createHash("sha256").update(readFileSync(h.cli)).digest("hex");
    expect(h.run("record", h.record()).value.actual.status).toBe("unverified");
    const model = "replacement-without-core-registration", provider = "replacement-provider";
    const next = policy(provider, model), options = {...h.options, provider, supported: [{model, modelClass: "general", efforts: ["high"]}]};
    Object.assign(next.providers[provider].application, {model_field: "selected_model", effort_field: "effort_level"});
    const input = {...h.record(), options, spawnArguments: {selected_model: model, effort_level: "high", context: "isolated"}};
    const unverified = h.run("record", input, next); expect(unverified.status).toBe(0); expect(unverified.value.actual.status).toBe("unverified");
    const applied = h.run("record", {...input, observation: {model, effort: "high", source: "host-task-view", reference: "fixture:actual-task-view"}}, next);
    expect(applied.status).toBe(0); expect(applied.value.actual).toEqual({status: "applied", model, effort: "high"});
    expect(applied.value.spawnArguments).toEqual(input.spawnArguments);
    expect(createHash("sha256").update(readFileSync(h.cli)).digest("hex")).toBe(before);
  });
  it.each(["unsupported", "unknown-catalog", "minimum", "class", "unknown-class", "audit", "order", "injection"])("keeps the original %s guard on explicitly supplied presets", mode => {
    const h = fixture(), input = structuredClone(h.options), presets = structuredClone(h.presets), provider = presets.providers[input.provider];
    if (mode === "unsupported") input.supported = [];
    if (mode === "unknown-catalog") {input.user = {model: "unregistered", effort: "high"}; input.supported = [{model: "unregistered", modelClass: "frontier", efforts: ["high"]}];}
    if (mode === "minimum") input.user = {effort: "medium"};
    if (mode === "class") {input.highRisk = true; provider.catalog.models["opaque-engine-a"].model_class = "lightweight";}
    if (mode === "unknown-class") {input.highRisk = true; input.supported[0].modelClass = null;}
    if (mode === "audit") input.role = "independent-audit";
    if (mode === "order") presets.model_class_order = [...classes].reverse();
    if (mode === "injection") input.presets = presets;
    const result = h.run("resolve", input, presets); expect(result.status).toBe(1);
    if (["audit", "order", "injection"].includes(mode)) expect(result.value).toBeNull();
    else expect(result.value.delivery).toBe("blocked");
  });
  it.each(["missing", "partial", "self-report", "full-history"])("preserves dispatch observation and independence: %s", mode => {
    const h = fixture(), input = h.record();
    if (mode === "missing") delete h.presets.providers[h.options.provider].application;
    if (mode === "partial") delete input.spawnArguments.reasoning;
    if (mode === "self-report") input.observation = {model: "opaque-engine-a", effort: "high", source: "worker-self-report", reference: "fixture:worker"};
    if (mode === "full-history") {input.spawnArguments.context = "full"; input.contextReason = "Previous source required";}
    const result = h.run("record", input); expect(result.status).toBe(1); expect(result.value).toBeNull();
  });
  it.each([[null], [[]], ["not-policy"]])("rejects malformed explicit presets instead of silently loading defaults: %j", value => {
    const h = fixture(), result = h.run("resolve", h.options, value); expect(result.status).toBe(1); expect(result.value).toBeNull();
  });
  it("does not discover a nearby config or implicitly read environment overrides", () => {
    const h = fixture(); const result = h.run("resolve", h.options, h.presets, []);
    expect(result.status).toBe(1); expect(result.value.delivery).toBe("blocked");
  });
  it("rejects duplicate, unknown and incomplete CLI options", () => {
    const h = fixture();
    for (const extra of [["--presets"], ["--unknown", "unused"], ["--presets", "a", "--presets", "b"]]) expect(h.run("resolve", h.options, h.presets, extra).status).toBe(1);
  });
  it("keeps shared guidance capability-based and preserves required one-implementation adapter boundaries", () => {
    const panel = readFileSync(path.join(root, "skills/independent-deliberation-panel/references/orchestration-policy.md"), "utf8");
    expect(panel).not.toContain("reviewer에는 Terra"); expect(panel).not.toContain("Judge에는 Sol");
    const pony = readFileSync(path.join(root, "skills/ponytail/SKILL.md"), "utf8");
    expect(pony).not.toContain("no interface with one implementation"); expect(pony).toContain("vendor/host adapter");
    const implementation = readFileSync(path.join(root, "skills/orchestrator/references/engineering-practices/implementation.md"), "utf8");
    expect(implementation).toContain("단일 구현"); expect(implementation).toContain("adapter");
    const catalog = JSON.parse(readFileSync(path.join(root, "skills/orchestrator/references/engineering-practices/catalog.json"), "utf8"));
    expect(catalog.rules.find(rule => rule.id === "IMP-002").exceptions).toContain("adapter");
  });
  it("passes the actual Claude adaptation functions without generating or writing the host tree", () => {
    const files = new Map();
    for (const relative of ["skills/ponytail/SKILL.md", "skills/model-effort-advisor/SKILL.md", "skills/independent-deliberation-panel/references/orchestration-policy.md", "skills/coordinate-subagents/references/model-routing.md", "skills/orchestrator/references/engineering-practices/implementation.md"]) files.set(relative, readFileSync(path.join(root, relative)));
    for (const skill of ["ponytail", "model-effort-advisor"]) applySkillAdaptation(files, skill, JSON.parse(readFileSync(path.join(root, `claude-overlay/adaptations/${skill}.json`), "utf8")));
    expect(files.get("skills/ponytail/SKILL.md").toString()).toContain("vendor/host adapter");
    expect(files.get("skills/model-effort-advisor/SKILL.md").toString()).not.toContain("GPT-5.6 Sol High");
    expect(files.get("skills/independent-deliberation-panel/references/orchestration-policy.md").toString()).not.toContain("Judge에는 Sol");
  });
});
