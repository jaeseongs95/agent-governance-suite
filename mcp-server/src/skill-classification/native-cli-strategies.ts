import {assertNativeAdapterDataObject, assertEligibleNativeAdapterDefinition, hasRequiredNativeAdapterEvidence} from "./native-adapters.js";
import {mkdtemp, rm, writeFile} from "node:fs/promises";
import path from "node:path";
import {ClassificationProviderError, unknownUsage} from "./providers.js";
import type {ProviderProfile} from "./types.js";
import type {
  BoundNativeClassificationAdapterDefinition, NativeClassificationAdapterDefinition, NativeCliBehavior,
} from "./native-adapters.js";

const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const tokens = (value: unknown): number | null => Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;

// This checks representation only. Actual support comes from the qualified profile and approved route.
const canEncodeProfile = (profile: Readonly<ProviderProfile>): boolean =>
  typeof profile.reasoningEffort === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(profile.reasoningEffort);

async function removeNativeSchema(root: string, temporary: string): Promise<void> {
  const target = path.resolve(temporary);
  const relative = path.relative(path.resolve(root), target);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new ClassificationProviderError("NATIVE_CLEANUP_UNAVAILABLE", "unknown");
  await rm(target, {recursive: true, force: true});
}

const codexBehavior: NativeCliBehavior = {
  validateIsolationArgs(args) {
    for (let i = 0; i < args.length; i += 2) {
      if (args[i] !== "--disable" || !/^[A-Za-z0-9_]+$/u.test(args[i + 1] ?? "")) return false;
    }
    return true;
  },
  canEncodeProfile,
  async prepare(definition, profile, schema) {
    const args = ["exec", "--json", "--sandbox", "read-only", "--ephemeral", "--ignore-user-config", "--skip-git-repo-check",
      "--model", profile.modelId, "--config", `model_reasoning_effort=${JSON.stringify(profile.reasoningEffort)}`, ...definition.isolationArgs];
    const temporary = await mkdtemp(path.join(definition.workingDirectory, ".ags-native-"));
    try {
      const schemaPath = path.join(temporary, "response.schema.json");
      await writeFile(schemaPath, schema, {encoding: "utf8", flag: "wx", mode: 0o600});
      args.push("--output-schema", schemaPath, "-");
      return {args, cleanup: () => removeNativeSchema(definition.workingDirectory, temporary)};
    } catch (error) {
      await removeNativeSchema(definition.workingDirectory, temporary);
      throw error;
    }
  },
  decode(output) {
    const events: unknown[] = output.stdout.trim().split(/\r?\n/u).map(line => JSON.parse(line));
    const messages: string[] = [];
    let completed = 0;
    let usage: Record<string, unknown> = {};
    for (const event of events) {
      if (!object(event) || ["error", "turn.failed"].includes(String(event.type))) throw new Error("NATIVE_RESULT_FAILURE");
      if (object(event.item) && ["command_execution", "file_change", "mcp_tool_call", "web_search"].includes(String(event.item.type))) throw new Error("NATIVE_ISOLATION_VIOLATION");
      if (event.type === "item.completed" && object(event.item) && event.item.type === "agent_message") {
        if (typeof event.item.text !== "string") throw new Error("NATIVE_MESSAGE_MISSING");
        messages.push(event.item.text);
      }
      if (event.type === "turn.completed") { completed++; if (object(event.usage)) usage = event.usage; }
    }
    if (completed !== 1 || messages.length !== 1) throw new Error("NATIVE_RESULT_AMBIGUOUS");
    return {response: JSON.parse(messages[0]!), usage: {...unknownUsage(), inputTokens: tokens(usage.input_tokens),
      outputTokens: tokens(usage.output_tokens), cachedInputTokens: tokens(usage.cached_input_tokens)}};
  },
};

const claudeBehavior: NativeCliBehavior = {
  validateIsolationArgs: args => args.length === 0,
  canEncodeProfile,
  prepare(definition, profile, schema) {
    return {args: ["--print", "--safe-mode", "--tools", "", "--strict-mcp-config", "--mcp-config", "{}",
      "--output-format", "json", "--json-schema", schema, "--model", profile.modelId, "--effort", profile.reasoningEffort!,
      ...definition.isolationArgs]};
  },
  decode(output) {
    const result: unknown = JSON.parse(output.stdout);
    if (!object(result) || result.type !== "result" || result.subtype !== "success" || result.is_error !== false) throw new Error("NATIVE_RESULT_FAILURE");
    const usage = object(result.usage) ? result.usage : {};
    // Input total includes uncached + cache read + cache creation. Missing/invalid/overflow is unknown.
    const counts = [tokens(usage.input_tokens), tokens(usage.cache_read_input_tokens), tokens(usage.cache_creation_input_tokens)];
    const inputTokens = counts.every(count => count !== null) ? tokens(counts.reduce<number>((sum, count) => sum + count!, 0)) : null;
    return {response: result.structured_output, usage: {...unknownUsage(), inputTokens,
      outputTokens: tokens(usage.output_tokens), cachedInputTokens: tokens(usage.cache_read_input_tokens)}};
  },
};

// Legacy JSON names select trusted built-in code here; they never establish approval/capability.
const builtInBehaviors: ReadonlyMap<string, NativeCliBehavior> = new Map([
  ["codex", codexBehavior], ["claude", claudeBehavior],
]);

/** A trusted in-process producer may provide another behavior map; JSON cannot supply callbacks or modules. */
export function bindNativeClassificationDefinitions(
  definitions: readonly NativeClassificationAdapterDefinition[],
  behaviors: ReadonlyMap<string, NativeCliBehavior> = builtInBehaviors,
): BoundNativeClassificationAdapterDefinition[] {
  if (!Array.isArray(definitions)) throw new Error("INVALID_NATIVE_ADAPTER_DEFINITION");
  const seen = new Set<string>();
  return definitions.map(data => {
    assertNativeAdapterDataObject(data);
    if (seen.has(data.adapterId)) throw new Error("DUPLICATE_NATIVE_ADAPTER");
    seen.add(data.adapterId);
    if (!hasRequiredNativeAdapterEvidence(data)) return {data};
    assertEligibleNativeAdapterDefinition(data);
    const behavior = behaviors.get(data.host);
    return behavior ? {data, behavior} : {data};
  });
}
