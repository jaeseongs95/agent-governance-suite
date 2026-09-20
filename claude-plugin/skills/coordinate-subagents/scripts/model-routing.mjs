import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const presets = JSON.parse(readFileSync(new URL("../references/model-routing-presets.json", import.meta.url), "utf8"));
const classes = presets.model_class_order;
const efforts = presets.effort_order;

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function same(left, right) {
  return Boolean(left && right && left.model === right.model && left.effort === right.effort);
}

function supportedSetting(setting, options) {
  if (!setting || typeof setting.model !== "string" || !efforts.includes(setting.effort)) return false;
  const capability = options.supported.find((item) => item.model === setting.model);
  if (!capability?.efforts.includes(setting.effort)) return false;
  const minimum = presets.providers[options.provider]?.minimum_efforts?.[setting.model];
  if (minimum && efforts.indexOf(setting.effort) < efforts.indexOf(minimum)) return false;
  return !options.highRisk || (
    classes.indexOf(capability.modelClass) >= classes.indexOf("general")
    && efforts.indexOf(setting.effort) >= efforts.indexOf("high")
  );
}

function validateOptions(options) {
  check(options && typeof options.provider === "string", "provider is required");
  check(typeof options.highRisk === "boolean", "highRisk must be explicit");
  check(Array.isArray(options.supported), "supported must come from current host capabilities");
  const names = new Set();
  for (const item of options.supported) {
    check(typeof item.model === "string" && !names.has(item.model), "model capabilities must be unique");
    names.add(item.model);
    check(item.modelClass === null || classes.includes(item.modelClass), "unknown modelClass must be null");
    check(Array.isArray(item.efforts) && item.efforts.every((effort) => efforts.includes(effort)), "invalid supported efforts");
  }
  check(presets.roles.includes(options.role), "unknown assignment role");
  check(options.role !== "independent-audit" || options.highRisk, "independent-audit requires highRisk: true");
  check(["economy", "balanced", "quality"].includes(options.profile ?? presets.default_profile), "unknown profile");
  check(options.inheritOnly === undefined || typeof options.inheritOnly === "boolean", "inheritOnly must be boolean");
  check(options.inheritanceSupported === undefined || typeof options.inheritanceSupported === "boolean", "inheritanceSupported must be boolean");
  if (options.user) {
    check(Object.keys(options.user).every((key) => ["model", "effort"].includes(key)), "unknown user override field");
    check(options.user.model === undefined || typeof options.user.model === "string", "invalid user model");
    check(options.user.effort === undefined || efforts.includes(options.user.effort), "invalid user effort");
  }
}

// This checks a supplied host capability snapshot; it does not discover capabilities or launch workers.
export function resolveModelSelection(options) {
  validateOptions(options);
  const provider = Object.hasOwn(presets.providers, options.provider) ? presets.providers[options.provider] : null;
  const profile = options.profile ?? presets.default_profile;
  let recommendation = provider?.profiles[profile]?.[options.role];
  if (recommendation && options.highRisk) {
    if (classes.indexOf(recommendation.model_class) < classes.indexOf("general")) {
      recommendation = provider.profiles[profile]["general-implementation"];
    }
    if (efforts.indexOf(recommendation.effort) < efforts.indexOf("high")) {
      recommendation = { ...recommendation, effort: "high" };
    }
  }
  const baseline = recommendation ?? options.inherited;
  const requested = baseline || options.user
    ? { model: options.user?.model ?? baseline?.model ?? null, effort: options.user?.effort ?? baseline?.effort ?? null }
    : null;
  if (!options.inheritOnly && supportedSetting(requested, options)) {
    return { requested, selection: requested, delivery: "explicit", fallbackReason: null };
  }
  if (supportedSetting(options.inherited, options)) {
    return {
      requested, selection: { model: options.inherited.model, effort: options.inherited.effort }, delivery: "inherited",
      fallbackReason: options.inheritOnly ? "Host/context requires inheritance" : "Requested combination unavailable or below risk floor",
    };
  }
  if (!options.highRisk && options.inheritanceSupported && !options.inherited) {
    return { requested, selection: null, delivery: "inherited", fallbackReason: "Host supports inheritance but effective settings are not observable" };
  }
  return { requested, selection: null, delivery: "blocked", fallbackReason: "No supported configuration establishes the required floor" };
}

// Observations are caller-visible evidence, not cryptographic execution attestation.
export function recordModelApplication(input) {
  check(typeof input.assignmentId === "string" && input.assignmentId.length > 0, "assignmentId is required");
  check(typeof input.selectionReason === "string" && input.selectionReason.length > 0, "selectionReason is required");
  const plan = resolveModelSelection(input.options);
  const application = presets.providers[input.options.provider]?.application;
  check(application, "Application recording requires a provider adapter");
  const args = input.spawnArguments;
  check(args && typeof args === "object" && !Array.isArray(args), "spawnArguments must contain actual host settings arguments");
  let contextMode = input.contextMode;
  if (application.context_field) {
    const context = args[application.context_field] ?? application.default_context;
    check(typeof context === "string" && (context === application.full_history_value || context === application.limited_context_value || /^[1-9][0-9]*$/u.test(context)), "Invalid host context argument");
    contextMode = context === application.full_history_value ? "full-history" : "limited";
    check(input.contextMode === undefined || input.contextMode === contextMode, "contextMode contradicts actual host arguments");
  }
  check(["limited", "full-history"].includes(contextMode), "invalid contextMode");
  if (contextMode === "full-history") {
    check(typeof input.contextReason === "string" && input.contextReason.length > 0, "full-history requires contextReason");
  }
  check(plan.delivery !== "blocked", plan.fallbackReason);
  const dispatched = args[application.model_field] === undefined && args[application.effort_field] === undefined
    ? null : { model: args[application.model_field], effort: args[application.effort_field] };
  if (plan.delivery === "explicit") {
    check(same(dispatched, plan.selection), "Both dispatched model and effort must match the selection");
  } else {
    check(dispatched === null, "Inherited execution must not contain overrides");
  }
  check(!(contextMode === "full-history" && application.full_history_overrides === false && dispatched), "Full-history overrides are unsupported by this adapter");
  const observation = input.observation ?? null;
  if (observation) {
    check(["spawn-result", "host-task-view", "tool-contract"].includes(observation.source), "Observation must be caller-visible host evidence");
    check(typeof observation.reference === "string" && observation.reference.length > 0, "Observation requires an evidence reference");
  }
  const confirmed = same(observation, plan.selection) || (
    plan.delivery === "inherited" && plan.selection === null && supportedSetting(observation, input.options)
  );
  const settingsArguments = Object.fromEntries([application.model_field, application.effort_field, application.context_field]
    .filter((key) => key && Object.hasOwn(args, key)).map((key) => [key, args[key]]));
  return {
    assignmentId: input.assignmentId, selectionReason: input.selectionReason,
    contextMode, contextReason: input.contextReason ?? null, spawnArguments: settingsArguments,
    requested: plan.requested, dispatched, observation,
    actual: {
      status: confirmed ? (plan.delivery === "inherited" ? "inherited" : "applied") : "unverified",
      model: observation?.model ?? null, effort: observation?.effort ?? null,
    },
    fallbackReason: confirmed ? plan.fallbackReason : [plan.fallbackReason, "Effective model and effort not confirmed by caller-visible evidence"].filter(Boolean).join("; "),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [operation, inputPath, ...extra] = process.argv.slice(2);
    check(["resolve", "record"].includes(operation) && inputPath && extra.length === 0, "Usage: node model-routing.mjs resolve|record input.json");
    const input = JSON.parse(readFileSync(inputPath, "utf8"));
    const result = operation === "resolve" ? resolveModelSelection(input) : recordModelApplication(input);
    console.log(JSON.stringify(result, null, 2));
    if (result.delivery === "blocked") process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
