// Test evidence barrier, not user approval: root supplies observations for fields the native CLI cannot expose.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export const sha256 = value => createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest("hex");
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
  ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
const sorted = rows => rows.map(row => JSON.stringify(canonical(row))).sort();
export const equal = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const nativeEvent = event => event[0].toLowerCase() + event.slice(1);

export function normalizeHooks(hooks) {
  return Object.entries(hooks).flatMap(([event, entries]) => entries.flatMap(entry => (entry.hooks ?? []).map(hook => ({
    event: nativeEvent(event), matcher: entry.matcher ?? null, enabled: true, type: hook.type ?? "command",
    commandSha256: sha256(hook.command ?? ""), argsSha256: sha256(hook.args ?? []),
    timeout: hook.timeout ?? null, onFailure: hook.onFailure ?? null, async: hook.async ?? false,
    additionalContextLimit: hook.additionalContextLimit ?? null, statusMessage: hook.statusMessage ?? null,
  }))));
}

// Save structure and comparison fields, never raw commands/args or account/auth payloads.
export function verifyCodexHooks(value, expected, cwd) {
  if (!Array.isArray(value?.data) || value.data.length !== 1 || value.data[0].cwd !== cwd
    || !Array.isArray(value.data[0].hooks) || !Array.isArray(value.data[0].errors) || value.data[0].errors.length) throw new Error("HOOK_DISCOVERY_INVALID");
  const hooks = value.data[0].hooks;
  if (hooks.some(hook => hook.handlerType !== "command" || hook.source !== "sessionFlags"
    || !["trusted", "managed"].includes(hook.trustStatus) || typeof hook.command !== "string")) throw new Error("HOOK_SOURCE_OR_TRUST_MISMATCH");
  const actual = hooks.map(hook => ({ event: hook.eventName, matcher: hook.matcher ?? null, enabled: hook.enabled, type: hook.handlerType,
    commandSha256: sha256(hook.command), argsSha256: sha256([]), timeout: hook.timeoutSec ?? null, onFailure: null,
    async: hook.async ?? false, additionalContextLimit: hook.additionalContextLimit ?? null, statusMessage: hook.statusMessage ?? null }));
  if (!equal(sorted(actual), sorted(expected))) throw new Error("HOOKS_MISSING_EXTRA_OR_CHANGED");
  return { actualHooks: actual, provenance: hooks.map(hook => ({ key: hook.key, source: hook.source, sourcePath: hook.sourcePath,
    trustStatus: hook.trustStatus, currentHash: hook.currentHash, displayOrder: hook.displayOrder })), warningCount: value.data[0].warnings?.length ?? null };
}

// Project only the explicit candidate descriptor. Never persist the full native configuration.
export function verifyMcpDescriptor(value, expected, allowUnobservedCwd = false) {
  if (!value || typeof value !== "object") throw new Error("MCP_CONFIG_UNOBSERVABLE");
  const actual = { name: expected.name, command: value.command, args: value.args ?? [], cwd: value.cwd ?? null,
    bundleSha256: sha256(readFileSync(expected.args[0])), env: value.env ?? {} };
  const expectedProjection = allowUnobservedCwd && actual.cwd === null ? { ...expected, cwd: null } : expected;
  if (!equal(actual, expectedProjection)) throw new Error("MCP_COMMAND_BUNDLE_OR_ENV_MISMATCH");
  return actual;
}

export function verifyCodexSkills(value, expected, cwd) {
  if (!Array.isArray(value?.data) || value.data.length !== 1 || value.data[0].cwd !== cwd
    || !Array.isArray(value.data[0].errors) || value.data[0].errors.length || !Array.isArray(value.data[0].skills)) throw new Error("SKILLS_DISCOVERY_INVALID");
  const inventory = value.data[0].skills.map(skill => ({ name: skill.name, path: skill.path, enabled: skill.enabled, scope: skill.scope, pluginId: skill.pluginId ?? null }));
  const names = new Set(expected.map(skill => skill.name));
  const selected = inventory.filter(skill => names.has(skill.name));
  if (selected.length !== expected.length || inventory.some(skill => !names.has(skill.name) && /agent-governance/u.test(skill.pluginId ?? ""))) throw new Error("SKILLS_MISSING_OR_MIXED");
  const actual = expected.map(skill => {
    const matches = selected.filter(item => item.name === skill.name);
    if (matches.length !== 1 || !matches[0].enabled || matches[0].scope !== "repo" || matches[0].pluginId
      || realpathSync(matches[0].path) !== skill.path) throw new Error("SKILL_SOURCE_MISMATCH");
    // Read only the known candidate file, never another discovered skill's contents.
    return { name: skill.name, path: skill.path, sha256: sha256(readFileSync(skill.path)) };
  });
  if (!equal(sorted(actual), sorted(expected))) throw new Error("SKILL_BYTES_CHANGED");
  return { actualSkills: actual, inventory };
}

export async function awaitRootPreflight(runDir, hostPid, native, stopped = () => false) {
  const expected = JSON.parse(readFileSync(path.join(runDir, "composition.json"), "utf8"));
  const snapshot = { hostPid, expected, native, modelTurnsStarted: 0 };
  const digest = sha256(snapshot);
  writeFileSync(path.join(runDir, "preflight.json"), JSON.stringify({ ...snapshot, preflightSha256: digest }, null, 2));
  const confirmation = path.join(runDir, "preflight-confirmed.json");
  while (!existsSync(confirmation)) {
    if (stopped()) throw new Error("Preflight interrupted");
    await delay(100);
  }
  const receipt = JSON.parse(readFileSync(confirmation, "utf8"));
  if (receipt.preflightSha256 !== digest || receipt.hostPid !== hostPid || receipt.verification !== "OBSERVED"
    || !Array.isArray(receipt.evidenceRefs) || receipt.evidenceRefs.length === 0) throw new Error("PREFLIGHT_RECEIPT_NOT_BOUND");
  if (JSON.stringify(sorted(receipt.actualHooks ?? [])) !== JSON.stringify(sorted(expected.normalizedHooks))) throw new Error("PREFLIGHT_HOOKS_MISSING_OR_MIXED");
  if (!equal(receipt.actualMcp, expected.mcp)) throw new Error("PREFLIGHT_MCP_BINDING_MISMATCH");
  if (JSON.stringify(sorted(receipt.actualSkills ?? [])) !== JSON.stringify(sorted(expected.skills))) throw new Error("PREFLIGHT_SKILLS_MISSING_OR_MIXED");
  if (!equal([...(receipt.actualToolNames ?? [])].sort(), [...(native.toolNames ?? [])].sort()) || receipt.toolSetVerified !== true) throw new Error("PREFLIGHT_TOOLSET_UNVERIFIED");
  if (receipt.noExtraAGS !== true || receipt.statePathsVerified !== true || receipt.nativeModelTurnsStarted !== 0) throw new Error("PREFLIGHT_NOT_OBSERVED");
  return { state: "ROOT_OBSERVATION_BOUND", preflightSha256: digest };
}
