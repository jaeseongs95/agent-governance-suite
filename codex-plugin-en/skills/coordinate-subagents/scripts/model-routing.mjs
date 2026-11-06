import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveCatalogModel } from "./model-catalog-adapter.mjs";
import { MODEL_CLASS as classes, REASONING_EFFORT as efforts, HIGH_RISK_MINIMUM } from "./model-routing-policy.mjs";

// Messages come from the AGS runtime when this skill sits beside it (repository, plugin or zip layout). A skill folder
// copied alone has no catalog, so it prints the message key and its parameters. An existing but broken runtime is not
// guarded: its import failure surfaces instead of silently falling back.
const agsI18n = fileURLToPath(new URL("../../../runtime/i18n.mjs", import.meta.url));
const renderHostText = existsSync(agsI18n) ? (await import(pathToFileURL(agsI18n).href)).hostText : null;
function hostText(key, params = {}) {
  if (renderHostText) return renderHostText(key, params);
  return Object.keys(params).length ? `${key} ${JSON.stringify(params)}` : key;
}

const presets = JSON.parse(readFileSync(new URL("../references/model-routing-presets.json", import.meta.url), "utf8"));
const defaultRoles = Object.freeze(["discovery", "general-implementation", "complex-reasoning", "independent-audit"]);

// The message is a catalog key rendered only on failure.
function check(condition, key, params = {}) {
  if (!condition) throw new Error(hostText(key, params));
}

function same(left, right) {
  return Boolean(left && right && left.model === right.model && left.effort === right.effort);
}

function activePresets(customPresets = presets) {
  return customPresets && typeof customPresets === "object" && !Array.isArray(customPresets)
    ? customPresets
    : presets;
}

function assertImmutablePolicyOrder(currentPresets) {
  if (currentPresets.model_class_order !== undefined) {
    check(
      Array.isArray(currentPresets.model_class_order)
        && currentPresets.model_class_order.length === classes.length
        && currentPresets.model_class_order.every((item, index) => item === classes[index]),
      "skillTools.modelRouting.modelClassOrderImmutable",
    );
  }
  if (currentPresets.effort_order !== undefined) {
    check(
      Array.isArray(currentPresets.effort_order)
        && currentPresets.effort_order.length > 0
        && currentPresets.effort_order.every((item, index, order) => efforts.includes(item)
          && (index === 0 || efforts.indexOf(order[index - 1]) < efforts.indexOf(item))),
      "skillTools.modelRouting.effortOrderImmutable",
    );
  }
}

export function getPolicyRevision(customPresets = presets) {
  const revision = activePresets(customPresets)?.policy_revision;
  return typeof revision === "string" && revision.length > 0 ? revision : "1.0.0";
}

function resolveSupportedSetting(setting, options, currentPresets = presets) {
  if (!setting || typeof setting.model !== "string" || !efforts.includes(setting.effort)) return null;
  const providerEntry = Object.hasOwn(currentPresets.providers ?? {}, options.provider)
    ? currentPresets.providers[options.provider]
    : null;
  const resolvedModel = providerEntry?.catalog
    ? resolveCatalogModel(providerEntry.catalog, setting.model, { allowProfileKeys: true })
    : setting.model;
  if (providerEntry?.catalog && !resolvedModel) return null;
  const directCapability = options.supported.find((item) => item.model === setting.model);
  const canonicalCapability = !directCapability && resolvedModel && resolvedModel !== setting.model
    ? options.supported.find((item) => item.model === resolvedModel)
    : null;
  const capability = directCapability ?? canonicalCapability;
  if (!capability?.efforts.includes(setting.effort)) return null;
  const catalogEntry = resolvedModel && providerEntry?.catalog?.models && Object.hasOwn(providerEntry.catalog.models, resolvedModel)
    ? providerEntry.catalog.models[resolvedModel]
    : null;
  if (Array.isArray(catalogEntry?.supported_efforts) && catalogEntry.supported_efforts.length > 0) {
    if (!catalogEntry.supported_efforts.includes(setting.effort)) return null;
  }
  const minimum = providerEntry?.minimum_efforts?.[setting.model]
    ?? (resolvedModel ? providerEntry?.minimum_efforts?.[resolvedModel] : undefined)
    ?? catalogEntry?.minimum_effort;
  if (minimum && efforts.indexOf(setting.effort) < efforts.indexOf(minimum)) return null;
  if (
    options.highRisk && (
      classes.indexOf(capability.modelClass) < classes.indexOf(HIGH_RISK_MINIMUM.modelClass)
      || (catalogEntry && classes.indexOf(catalogEntry.model_class) < classes.indexOf(HIGH_RISK_MINIMUM.modelClass))
      || efforts.indexOf(setting.effort) < efforts.indexOf(HIGH_RISK_MINIMUM.reasoningEffort)
    )
  ) {
    return null;
  }
  return { model: capability.model, effort: setting.effort };
}

function validateOptions(options, currentPresets = presets) {
  assertImmutablePolicyOrder(currentPresets);
  const currentRoles = Array.isArray(currentPresets.roles) ? currentPresets.roles : defaultRoles;
  check(options && typeof options.provider === "string", "skillTools.modelRouting.providerRequired");
  check(!Object.hasOwn(options, "presets"), "skillTools.modelRouting.presetsNotOverridableOptions");
  check(typeof options.highRisk === "boolean", "skillTools.modelRouting.highRiskExplicit");
  check(Array.isArray(options.supported), "skillTools.modelRouting.supportedFromHost");
  const names = new Set();
  for (const item of options.supported) {
    check(typeof item.model === "string" && !names.has(item.model), "skillTools.modelRouting.capabilitiesUnique");
    names.add(item.model);
    check(item.modelClass === null || classes.includes(item.modelClass), "skillTools.modelRouting.unknownModelClassNull");
    check(Array.isArray(item.efforts) && item.efforts.every((effort) => efforts.includes(effort)), "skillTools.modelRouting.invalidSupportedEfforts");
  }
  check(currentRoles.includes(options.role), "skillTools.modelRouting.unknownRole");
  check(options.role !== "independent-audit" || options.highRisk, "skillTools.modelRouting.auditNeedsHighRisk");
  check(["economy", "balanced", "quality"].includes(options.profile ?? currentPresets.default_profile ?? presets.default_profile), "skillTools.modelRouting.unknownProfile");
  check(options.inheritOnly === undefined || typeof options.inheritOnly === "boolean", "skillTools.modelRouting.inheritOnlyBoolean");
  check(options.inheritanceSupported === undefined || typeof options.inheritanceSupported === "boolean", "skillTools.modelRouting.inheritanceSupportedBoolean");
  if (options.user) {
    check(Object.keys(options.user).every((key) => ["model", "effort"].includes(key)), "skillTools.modelRouting.unknownUserOverrideField");
    check(options.user.model === undefined || typeof options.user.model === "string", "skillTools.modelRouting.invalidUserModel");
    check(options.user.effort === undefined || efforts.includes(options.user.effort), "skillTools.modelRouting.invalidUserEffort");
  }
}

// This checks a supplied host capability snapshot; it does not discover capabilities or launch workers.
export function resolveModelSelection(options, customPresets = presets) {
  const currentPresets = activePresets(customPresets);
  validateOptions(options, currentPresets);
  const provider = Object.hasOwn(currentPresets.providers ?? {}, options.provider)
    ? currentPresets.providers[options.provider]
    : null;
  const profile = options.profile ?? currentPresets.default_profile ?? presets.default_profile;
  let recommendation = provider?.profiles?.[profile]?.[options.role];
  if (recommendation && options.highRisk) {
    if (classes.indexOf(recommendation.model_class) < classes.indexOf(HIGH_RISK_MINIMUM.modelClass)) {
      recommendation = provider.profiles[profile]["general-implementation"];
    }
    if (efforts.indexOf(recommendation.effort) < efforts.indexOf(HIGH_RISK_MINIMUM.reasoningEffort)) {
      recommendation = { ...recommendation, effort: HIGH_RISK_MINIMUM.reasoningEffort };
    }
  }
  const baseline = recommendation ?? options.inherited;
  const requested = baseline || options.user
    ? { model: options.user?.model ?? baseline?.model ?? null, effort: options.user?.effort ?? baseline?.effort ?? null }
    : null;
  const explicitSelection = !options.inheritOnly ? resolveSupportedSetting(requested, options, currentPresets) : null;
  if (explicitSelection) {
    return { requested, selection: explicitSelection, delivery: "explicit", fallbackReason: null };
  }
  const inheritedSelection = resolveSupportedSetting(options.inherited, options, currentPresets);
  if (inheritedSelection) {
    return {
      requested, selection: inheritedSelection, delivery: "inherited",
      fallbackReason: options.inheritOnly ? hostText("skillTools.modelRouting.reasonInheritanceRequired") : hostText("skillTools.modelRouting.reasonCombinationUnavailable"),
    };
  }
  if (!options.highRisk && options.inheritanceSupported && !options.inherited) {
    return { requested, selection: null, delivery: "inherited", fallbackReason: hostText("skillTools.modelRouting.reasonSettingsNotObservable") };
  }
  return { requested, selection: null, delivery: "blocked", fallbackReason: hostText("skillTools.modelRouting.reasonNoFloor") };
}

// Observations are caller-visible evidence, not cryptographic execution attestation.
export function recordModelApplication(input, customPresets = presets) {
  check(typeof input.assignmentId === "string" && input.assignmentId.length > 0, "skillTools.modelRouting.assignmentIdRequired");
  check(typeof input.selectionReason === "string" && input.selectionReason.length > 0, "skillTools.modelRouting.selectionReasonRequired");
  check(!Object.hasOwn(input, "presets"), "skillTools.modelRouting.presetsNotOverridableInput");
  const currentPresets = activePresets(customPresets);
  const plan = resolveModelSelection(input.options, currentPresets);
  const application = currentPresets.providers?.[input.options.provider]?.application;
  check(application, "skillTools.modelRouting.adapterRequired");
  const args = input.spawnArguments;
  check(args && typeof args === "object" && !Array.isArray(args), "skillTools.modelRouting.spawnArgumentsRequired");
  let contextMode = input.contextMode;
  let context;
  if (application.context_field) {
    context = args[application.context_field] ?? application.default_context;
    check(typeof context === "string" && (context === application.full_history_value || context === application.limited_context_value || /^[1-9][0-9]*$/u.test(context)), "skillTools.modelRouting.invalidContextArgument");
    contextMode = context === application.full_history_value ? "full-history" : "limited";
    check(input.contextMode === undefined || input.contextMode === contextMode, "skillTools.modelRouting.contextModeContradicts");
  }
  check(["limited", "full-history"].includes(contextMode), "skillTools.modelRouting.invalidContextMode");
  // An independent audit must start fresh; a context reason never justifies inherited parent turns.
  check(input.options.role !== "independent-audit" || (contextMode === "limited"
    && (!application.context_field || context === application.limited_context_value)),
  "skillTools.modelRouting.auditInheritedContext");
  if (contextMode === "full-history") {
    check(typeof input.contextReason === "string" && input.contextReason.length > 0, "skillTools.modelRouting.fullHistoryNeedsReason");
  }
  if (plan.delivery === "blocked") throw new Error(plan.fallbackReason);
  const dispatched = args[application.model_field] === undefined && args[application.effort_field] === undefined
    ? null : { model: args[application.model_field], effort: args[application.effort_field] };
  if (plan.delivery === "explicit") {
    check(same(dispatched, plan.selection), "skillTools.modelRouting.dispatchMustMatch");
  } else {
    check(dispatched === null, "skillTools.modelRouting.inheritedNoOverrides");
  }
  check(!(contextMode === "full-history" && application.full_history_overrides === false && dispatched), "skillTools.modelRouting.fullHistoryOverridesUnsupported");
  const observation = input.observation ?? null;
  if (observation) {
    check(["spawn-result", "host-task-view", "tool-contract"].includes(observation.source), "skillTools.modelRouting.observationSource");
    check(typeof observation.reference === "string" && observation.reference.length > 0, "skillTools.modelRouting.observationReference");
  }
  const confirmed = same(observation, plan.selection) || (
    plan.delivery === "inherited" && plan.selection === null && Boolean(resolveSupportedSetting(observation, input.options, currentPresets))
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
    fallbackReason: confirmed ? plan.fallbackReason : [plan.fallbackReason, hostText("skillTools.modelRouting.reasonNotConfirmed")].filter(Boolean).join("; "),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [operation, inputPath, ...extra] = process.argv.slice(2);
    const explicitPresets = extra.length === 2 && extra[0] === "--presets" && extra[1];
    check(["resolve", "record"].includes(operation) && inputPath && (extra.length === 0 || explicitPresets), "skillTools.modelRouting.usage");
    const input = JSON.parse(readFileSync(inputPath, "utf8"));
    // Same supplied-data boundary as the API's customPresets; this does not authenticate policy or host evidence.
    const currentPresets = explicitPresets ? JSON.parse(readFileSync(explicitPresets, "utf8")) : presets;
    check(currentPresets && typeof currentPresets === "object" && !Array.isArray(currentPresets), "skillTools.modelRouting.presetsJsonObject");
    const result = operation === "resolve" ? resolveModelSelection(input, currentPresets) : recordModelApplication(input, currentPresets);
    console.log(JSON.stringify(result, null, 2));
    if (result.delivery === "blocked") process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
