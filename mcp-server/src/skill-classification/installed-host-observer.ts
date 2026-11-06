import {execFile} from "node:child_process";
import {readFile, realpath} from "node:fs/promises";
import path from "node:path";
import {z} from "zod";
import type {HostSkillDiscoverySnapshot} from "./host-discovery-adapter.js";
import {loadSkillInventory} from "./inventory.js";
import {digestClassificationValue} from "./request.js";

const plugin = z.object({id: z.string().min(1), version: z.string().min(1), enabled: z.boolean(),
  installPath: z.string().min(1), readFromFolder: z.string().min(1).optional(), errors: z.array(z.string()).optional()}).passthrough();
const manifest = z.object({name: z.string().min(1), version: z.string().min(1)}).passthrough();

/** Read-only host command. No shell, model turn, install, credentials or conversation file reads. */
function listClaudePlugins(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("claude", ["plugin", "list", "--json"], {encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024, windowsHide: true},
      (error, stdout) => {if (error) reject(new Error("HOST_SKILL_LIST_FAILED")); else resolve(stdout);});
  });
}

/**
 * Produces a new observation from the host's installation list and the matching running installation.
 * A package tree alone cannot prove that the host installed, enabled or supports it. Unsupported host
 * protocols return null until an adapter can establish the same facts; they never infer true flags.
 * The sourceRef names this installation scope, not an assertion that every host plugin was classified.
 */
async function observeInstalledHostSkills(options: {
  root: string;
  host?: string | undefined;
  now?: (() => Date) | undefined;
}): Promise<HostSkillDiscoverySnapshot | null> {
  if (options.host !== "claude-code") return null;
  const bytes = await listClaudePlugins();
  const plugins = z.array(plugin).max(1000).parse(JSON.parse(bytes));
  const root = await realpath(options.root);
  const manifestBytes = await readFile(path.join(root, ".claude-plugin/plugin.json"));
  if (manifestBytes.length > 64 * 1024) throw new Error("HOST_PLUGIN_MANIFEST_TOO_LARGE");
  const installedManifest = manifest.parse(JSON.parse(manifestBytes.toString("utf8")));
  const matches = [];
  for (const entry of plugins) {
    if (entry.id.split("@")[0] !== installedManifest.name) continue;
    const location = entry.readFromFolder ?? entry.installPath;
    if (!path.isAbsolute(location)) continue;
    if (await realpath(location) === root && entry.version === installedManifest.version && !entry.errors?.length) matches.push(entry);
  }
  if (matches.length !== 1) return null;
  const entry = matches[0]!;
  const inventory = await loadSkillInventory({root});
  if (inventory.issues.length) return null;
  const skills = inventory.skills.map(skill => ({skillId: skill.skillId, installed: true, enabled: entry.enabled,
    hostSupported: true, root: null}));
  const observedAt = options.now?.() ?? new Date();
  return {schemaVersion: "1.0.0", sourceRef: `host:claude-code:installed-plugin:${root}`,
    revision: digestClassificationValue({host: options.host, root, entry, inventoryDigest: inventory.inventoryDigest}),
    observedAt: observedAt.toISOString(), expiresAt: new Date(observedAt.getTime() + 30_000).toISOString(), skills};
}

/** Each gateway owns its freshness window; re-query host state on every call and retain only unchanged observations. */
export function createInstalledHostSkillObserver(root: string, now?: () => Date): () => Promise<HostSkillDiscoverySnapshot | null> {
  let previous: HostSkillDiscoverySnapshot | null = null;
  return async () => {
    const current = await observeInstalledHostSkills({root, host: process.env.AGENT_GOVERNANCE_HOST_ATTESTATION, now});
    if (!current) {previous = null; return null;}
    if (previous && previous.sourceRef === current.sourceRef && previous.revision === current.revision
      && Date.parse(previous.expiresAt) > Date.parse(current.observedAt)) return previous;
    previous = current;
    return current;
  };
}
