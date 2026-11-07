import {execFile} from "node:child_process";
import {readFile, realpath} from "node:fs/promises";
import path from "node:path";
import {z} from "zod";
import type {HostSkillDiscoverySnapshot} from "./host-discovery-adapter.js";
import {loadSkillInventory} from "./inventory.js";
import {digestClassificationValue} from "./request.js";
import {observeCodexInstalledPlugin} from "./codex-installed-plugin.js";
import {observeAntigravityInstalledPlugin} from "./antigravity-installed-plugin.js";

const plugin = z.object({id: z.string().min(1), version: z.string().min(1), enabled: z.boolean(),
  installPath: z.string().min(1), readFromFolder: z.string().min(1).optional(), errors: z.array(z.string()).optional()}).passthrough();
const manifest = z.object({name: z.string().min(1), version: z.string().min(1)}).passthrough();

/** Read-only host command. No shell, model turn, install, credentials or conversation file reads. */
function hostCommand(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, {encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024, windowsHide: true},
      (error, stdout) => {if (error || Buffer.byteLength(stdout) > 1024 * 1024) reject(Object.assign(new Error("HOST_SKILL_LIST_FAILED"), {code: error?.code})); else resolve(stdout);});
  });
}

const claudeNpmManifest = z.object({name: z.literal("@anthropic-ai/claude-code"),
  bin: z.object({claude: z.literal("bin/claude.exe")})}).passthrough();

/**
 * A Windows npm install of Claude Code puts only the claude.cmd/claude.ps1 shims on PATH. execFile without a shell
 * starts only .com/.exe names (and cmd.exe would reparse arguments), so `claude` is ENOENT there. The official shim runs
 * its package's native bin/claude.exe; run that one exactly, when PATH names one verified installation.
 */
async function windowsNpmClaudeExecutable(): Promise<string | null> {
  const matches = new Set<string>();
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    const location = directory.replace(/^"|"$/gu, "");
    if (!path.isAbsolute(location)) continue;
    try {
      const shim = await readFile(path.join(location, "claude.cmd"), "utf8");
      if (shim.length > 64 * 1024 || !shim.replaceAll("\\", "/").includes("node_modules/@anthropic-ai/claude-code/bin/claude.exe")) continue;
      const packageRoot = path.join(location, "node_modules/@anthropic-ai/claude-code");
      const bytes = await readFile(path.join(packageRoot, "package.json"));
      if (bytes.length > 64 * 1024 || !claudeNpmManifest.safeParse(JSON.parse(bytes.toString("utf8"))).success) continue;
      const executable = await realpath(path.join(packageRoot, "bin/claude.exe"));
      if (path.dirname(executable) !== path.join(await realpath(packageRoot), "bin")) continue;
      matches.add(executable);
    } catch { /* A missing or unverified npm installation is not a launch candidate. */ }
  }
  return matches.size === 1 ? [...matches][0]! : null;
}

/** `claude` as installed: the native executable on PATH, or on Windows the one a verified npm shim runs. */
async function claudeCommand(args: string[]): Promise<string> {
  try { return await hostCommand("claude", args); }
  catch (error) {
    if (process.platform !== "win32" || (error as {code?: unknown}).code !== "ENOENT") throw error;
    const executable = await windowsNpmClaudeExecutable();
    if (!executable) throw error;
    return hostCommand(executable, args);
  }
}

async function observeClaudeInstalledPlugin(root: string) {
  const bytes = await claudeCommand(["plugin", "list", "--json"]);
  const plugins = z.array(plugin).max(1000).parse(JSON.parse(bytes));
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
  return {enabled: matches[0]!.enabled, entry: matches[0]!};
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
  if (!["claude-code", "codex", "antigravity"].includes(options.host ?? "")) return null;
  const root = await realpath(options.root);
  const binding = options.host === "claude-code" ? await observeClaudeInstalledPlugin(root)
    : options.host === "codex" ? await observeCodexInstalledPlugin(root, hostCommand)
      : await observeAntigravityInstalledPlugin(root, hostCommand);
  if (!binding) return null;
  const inventory = await loadSkillInventory({root});
  if (inventory.issues.length || ("skillCount" in binding && binding.skillCount !== inventory.skills.length)) return null;
  const skills = inventory.skills.map(skill => ({skillId: skill.skillId, installed: true, enabled: binding.enabled,
    hostSupported: true, root: null}));
  const observedAt = options.now?.() ?? new Date();
  return {schemaVersion: "1.0.0", sourceRef: `host:${options.host}:installed-plugin:${root}`,
    revision: digestClassificationValue({host: options.host, root, entry: binding.entry, inventoryDigest: inventory.inventoryDigest}),
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
