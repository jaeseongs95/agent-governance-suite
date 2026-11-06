import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { Ajv2020 } from "../../runtime/schema-validation.mjs";
import { modelPolicySchema, REASONING_EFFORT } from "../../runtime/model-policy.mjs";
import { adviseSubagentModel } from "../../skills/model-effort-advisor/scripts/advise.mjs";
import { recordModelApplication } from "../../skills/coordinate-subagents/scripts/model-routing.mjs";

const cli = fileURLToPath(new URL("../../skills/model-effort-advisor/scripts/advise.mjs", import.meta.url));
const requestSchema = JSON.parse(readFileSync(new URL("../../skills/model-effort-advisor/contracts/subagent-model-request.v1.schema.json", import.meta.url), "utf8"));
const adviceSchema = JSON.parse(readFileSync(new URL("../../skills/model-effort-advisor/contracts/subagent-model-advice.v1.schema.json", import.meta.url), "utf8"));
const validateAdvice = new Ajv2020({ strict: false }).addSchema(modelPolicySchema).addSchema(requestSchema).compile(adviceSchema);
const temporaryRoots = [];
afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// These are artificial adapter fixtures, never claims about a live vendor or host.
const models = (prefix) => ["quick", "standard", "deep", "frontier"].map((name) => `${prefix}-${name}`);
const classes = ["lightweight", "general", "deep", "frontier"];
function adapter(prefix) {
  const ids = models(prefix);
  const setting = (index, effort) => ({ model: ids[index], model_class: classes[index], effort });
  const general = (index, effort) => ({
    discovery: setting(0, "low"), "general-implementation": setting(index, effort),
    "complex-reasoning": setting(2, "high"), "independent-audit": setting(3, "high"),
  });
  return {
    catalog: { matching: "exact-only", models: Object.fromEntries(ids.map((id, index) => [id, {
      model_class: classes[index], supported_efforts: [...REASONING_EFFORT],
    }])), aliases: {} },
    profiles: { economy: general(1, "low"), balanced: general(1, "medium"), quality: general(2, "high") },
    application: {
      model_field: "selected_model", effort_field: "selected_effort", context_field: "history_mode",
      default_context: "full", full_history_value: "full", limited_context_value: "fresh", full_history_overrides: false,
    },
  };
}
const policy = {
  default_profile: "balanced", providers: { "vendor-one": adapter("one"), "vendor-two": adapter("two") },
};
const request = (prefix = "one", hostId = "host-alpha") => ({
  schemaVersion: "1.0.0",
  assignment: {
    role: "general-implementation", difficulty: "substantial", riskLevel: "low", verification: "direct",
    signals: ["One bounded implementation with an executable acceptance check"],
  },
  host: {
    id: hostId, provider: prefix === "one" ? "vendor-one" : "vendor-two", capabilityReference: "fixture://current-capabilities",
    supported: models(prefix).map((model, index) => ({ model, modelClass: classes[index], efforts: [...REASONING_EFFORT] })),
  },
});
const invoke = (input, presets = policy, args = []) => {
  const root = mkdtempSync(path.join(tmpdir(), "ags-advisor-"));
  temporaryRoots.push(root);
  const presetPath = path.join(root, "presets.json");
  writeFileSync(presetPath, JSON.stringify(presets));
  return spawnSync(process.execPath, [cli, "--presets", presetPath, ...args], {
    input: typeof input === "string" ? input : JSON.stringify(input), encoding: "utf8",
  });
};

describe("pre-dispatch model and reasoning advice", () => {
  it("P01 selects before dispatch without observing the current main model", () => {
    const input = request();
    const before = JSON.stringify(input);
    const result = adviseSubagentModel(input, policy);
    expect(result.status).toBe("READY");
    expect(result.selectionPlan).toEqual({
      requested: { model: "one-standard", effort: "medium" },
      selection: { model: "one-standard", effort: "medium" }, delivery: "explicit", fallbackReason: null,
    });
    expect(result.capabilitySource).toEqual({ hostId: "host-alpha", reference: "fixture://current-capabilities" });
    expect(result.authorityEffect).toBe("none");
    expect(validateAdvice(result), JSON.stringify(validateAdvice.errors)).toBe(true);
    expect(JSON.stringify(input)).toBe(before);
    const actual = invoke(input);
    expect(actual.status, actual.stderr).toBe(0);
    expect(JSON.parse(actual.stdout)).toEqual(result);
  });

  it.each([
    ["discovery", "routine", "direct", "one-quick", "low"],
    ["general-implementation", "substantial", "indirect", "one-standard", "medium"],
    ["complex-reasoning", "complex", "limited", "one-deep", "high"],
    ["complex-reasoning", "frontier", "limited", "one-deep", "high"],
    ["independent-audit", "complex", "indirect", "one-frontier", "high"],
  ])("P02 preserves %s role and task criteria", (role, difficulty, verification, model, effort) => {
    const input = request();
    Object.assign(input.assignment, { role, difficulty, verification });
    const result = adviseSubagentModel(input, policy);
    expect(result.assignment).toEqual(input.assignment);
    expect(result.selectionPlan.selection).toEqual({ model, effort });
    expect(result.routingOptions.highRisk).toBe(role === "independent-audit");
  });

  it.each([
    ["economy", "one-standard", "low"], ["balanced", "one-standard", "medium"], ["quality", "one-deep", "high"],
  ])("P03 applies %s only to supported settings", (preference, model, effort) => {
    const input = { ...request(), preference };
    const result = adviseSubagentModel(input, policy);
    expect(result.selectionPlan.selection).toEqual({ model, effort });
    expect(result.assignment).toEqual(input.assignment);
    expect(result.authorityEffect).toBe("none");
    expect(Object.keys(result).sort()).toEqual([
      "assignment", "authorityEffect", "capabilitySource", "profile", "routingOptions", "schemaVersion", "selectionPlan", "status",
    ]);
  });

  it("P04 honors partial user choices and preserves unsupported requests", () => {
    const input = request();
    input.user = { model: "one-deep" };
    expect(adviseSubagentModel(input, policy).selectionPlan.selection).toEqual({ model: "one-deep", effort: "medium" });
    input.user = { effort: "high" };
    expect(adviseSubagentModel(input, policy).selectionPlan.selection).toEqual({ model: "one-standard", effort: "high" });
    input.user = { model: "not-provided" };
    const blocked = adviseSubagentModel(input, policy);
    expect(blocked.status).toBe("BLOCKED");
    expect(blocked.selectionPlan.requested).toEqual({ model: "not-provided", effort: "medium" });
    expect(blocked.selectionPlan.selection).toBeNull();
    input.host.inherited = { model: "one-standard", effort: "high" };
    const fallback = adviseSubagentModel(input, policy);
    expect(fallback.status).toBe("READY");
    expect(fallback.selectionPlan.delivery).toBe("inherited");
    expect(fallback.selectionPlan.selection).toEqual(input.host.inherited);
  });

  it.each(["high", "critical"])("P05 preserves the shared floor for %s risk despite direct verification and economy", (riskLevel) => {
    const input = { ...request(), preference: "economy" };
    input.assignment.riskLevel = riskLevel;
    expect(adviseSubagentModel(input, policy).selectionPlan.selection).toEqual({ model: "one-standard", effort: "high" });
    input.user = { model: "one-quick", effort: "high" };
    const blocked = adviseSubagentModel(input, policy);
    expect(blocked.status).toBe("BLOCKED");
    expect(blocked.authorityEffect).toBe("none");
    expect(validateAdvice(blocked)).toBe(true);
    const actual = invoke(input);
    expect(actual.status).toBe(1);
    expect(JSON.parse(actual.stdout).status).toBe("BLOCKED");
    input.user = { model: "one-standard", effort: "medium" };
    expect(adviseSubagentModel(input, policy).status).toBe("BLOCKED");
    input.host.supported[1].modelClass = null;
    input.user = { model: "one-standard", effort: "high" };
    expect(adviseSubagentModel(input, policy).status).toBe("BLOCKED");
  });

  it("P05 never lets an independent-audit role opt out of the shared risk floor", () => {
    const input = request();
    input.assignment.role = "independent-audit";
    input.user = { model: "one-quick", effort: "high" };
    expect(adviseSubagentModel(input, policy).status).toBe("BLOCKED");
  });

  it("P06 permits unknown low-risk inheritance without inventing effective settings", () => {
    const input = request();
    input.host.supported = [];
    input.host.inheritOnly = true;
    input.host.inheritanceSupported = true;
    const result = adviseSubagentModel(input, policy);
    expect(result.status).toBe("INHERIT_UNVERIFIED");
    expect(result.selectionPlan.selection).toBeNull();
    expect(result.selectionPlan.delivery).toBe("inherited");
    expect(result.routingOptions).not.toHaveProperty("inherited");
    expect(result.authorityEffect).toBe("none");
    expect(validateAdvice(result)).toBe(true);
    const actual = invoke(input);
    expect(actual.status).toBe(0);
    expect(JSON.parse(actual.stdout)).toEqual(result);
    input.assignment.riskLevel = "high";
    expect(adviseSubagentModel(input, policy).status).toBe("BLOCKED");
  });

  it("P07 keeps policy behavior equal across two hosts and two opaque vendor adapters", () => {
    const left = adviseSubagentModel(request("one", "host-alpha"), policy);
    const right = adviseSubagentModel(request("two", "host-beta"), policy);
    expect(left.assignment).toEqual(right.assignment);
    expect(left.status).toBe(right.status);
    expect(left.profile).toBe(right.profile);
    expect(left.selectionPlan.selection).toEqual({ model: "one-standard", effort: "medium" });
    expect(right.selectionPlan.selection).toEqual({ model: "two-standard", effort: "medium" });
    // Host identity is evidence metadata, never the vendor/catalog selector.
    expect(adviseSubagentModel(request("one", "host-beta"), policy).selectionPlan).toEqual(left.selectionPlan);
    const actual = invoke(request("two", "host-beta"));
    expect(actual.status).toBe(0);
    expect(JSON.parse(actual.stdout)).toEqual(right);
  });

  it("P07/P08 never invents catalog or effort support for an unknown provider", () => {
    const input = request();
    input.host.provider = "unlisted-provider";
    expect(adviseSubagentModel(input, policy).status).toBe("BLOCKED");
    input.user = { model: "one-standard", effort: "high" };
    expect(adviseSubagentModel(input, policy).selectionPlan.selection).toEqual(input.user);
    input.host.supported[1].efforts = ["low"];
    expect(adviseSubagentModel(input, policy).status).toBe("BLOCKED");
    input.user = { effort: "low" };
    const partial = adviseSubagentModel(input, policy);
    expect(partial.selectionPlan.requested).toEqual({ model: null, effort: "low" });
    expect(partial.status).toBe("BLOCKED");
  });

  it.each([
    (input) => { delete input.host.supported; },
    (input) => { delete input.host.capabilityReference; },
    (input) => { input.host.capabilityReference = " "; },
    (input) => { input.host.supported[0].modelClass = "class-from-model-name"; },
    (input) => { input.host.supported[0].efforts = ["unprovided-effort"]; },
    (input) => { input.currentSelection = { model: "secret-sentinel", effort: "high" }; },
    (input) => { input.authorization = "secret-sentinel"; },
    (input) => { input.assignment.signals = []; },
  ])("P08 rejects malformed support or out-of-scope claims without leaking input", (mutate) => {
    const input = request();
    mutate(input);
    expect(() => adviseSubagentModel(input, policy)).toThrow("INVALID_SUBAGENT_MODEL_REQUEST");
    const result = invoke(input);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("INVALID_SUBAGENT_MODEL_REQUEST\n");
  });

  it("P08 keeps malformed request and ambiguous routing input as distinct failures", () => {
    expect(invoke('{"secret-sentinel":').stderr).toBe("INVALID_JSON\n");
    const input = request();
    input.host.supported.push(structuredClone(input.host.supported[0]));
    let failure;
    try { adviseSubagentModel(input, policy); } catch (error) { failure = error; }
    expect(failure?.message).toBe("INVALID_ROUTING_DATA");
    expect(failure?.cause).toBeInstanceOf(Error);
    const duplicate = invoke(input);
    expect(duplicate.status).toBe(2);
    expect(duplicate.stdout).toBe("");
    expect(duplicate.stderr).toBe("INVALID_ROUTING_DATA\n");
    const invalidPolicy = invoke(request(), []);
    expect(invalidPolicy.status).toBe(2);
    expect(invalidPolicy.stderr).toBe("INVALID_PRESETS\n");
    expect(() => adviseSubagentModel(request(), [])).toThrow("INVALID_PRESETS");
  });

  it("P09 passes the exact shared routing options to the existing actual-application recorder", () => {
    const advice = adviseSubagentModel(request(), policy);
    const record = {
      assignmentId: "fixture-unit", selectionReason: advice.assignment.signals.join("; "), options: advice.routingOptions,
      spawnArguments: { selected_model: "one-standard", selected_effort: "medium", history_mode: "fresh" },
      observation: null,
    };
    const unverified = recordModelApplication(record, policy);
    expect(unverified.requested).toEqual(advice.selectionPlan.requested);
    expect(unverified.dispatched).toEqual(advice.selectionPlan.selection);
    expect(unverified.observation).toBeNull();
    expect(unverified.actual.status).toBe("unverified");
    record.observation = { model: "one-standard", effort: "medium", source: "spawn-result", reference: "fixture://host-result" };
    expect(recordModelApplication(record, policy).actual.status).toBe("applied");
    record.observation.effort = "low";
    const mismatch = recordModelApplication(record, policy);
    expect(mismatch.actual.status).toBe("unverified");
    expect(mismatch.actual.effort).toBe("low");
    record.spawnArguments.selected_effort = "low";
    expect(() => recordModelApplication(record, policy)).toThrow();
  });

  it("P09 rejects forged authority and mismatched advice status at the output contract", () => {
    const advice = adviseSubagentModel(request(), policy);
    expect(validateAdvice({ ...advice, authorityEffect: "dispatch-approved" })).toBe(false);
    expect(validateAdvice({ ...advice, status: "BLOCKED" })).toBe(false);
    expect(validateAdvice({ ...advice, status: "INHERIT_UNVERIFIED" })).toBe(false);
    expect(validateAdvice({ ...advice, actual: { status: "applied" } })).toBe(false);
  });
});
