import {readFile, realpath} from "node:fs/promises";
import {homedir} from "node:os";
import path from "node:path";
import {z} from "zod";

const segment = z.string().min(1).max(255).refine(value => value !== "." && value !== ".." && !/[\\/\0]/u.test(value));
const manifest = z.object({name: segment, version: segment, skills: z.literal("./skills/")}).passthrough();
const listing = z.object({installed: z.array(z.object({pluginId: z.string(), name: segment, marketplaceName: segment,
  version: segment, installed: z.boolean(), enabled: z.boolean(), source: z.unknown()}).passthrough()).max(1000)}).passthrough();
const marketplaces = z.object({marketplaces: z.array(z.object({name: segment, root: z.string().min(1)}).passthrough()).max(1000)}).passthrough();
const localSource = z.object({source: z.literal("local"), path: z.string().min(1)}).passthrough();
const npmManifest = z.object({name: z.literal("@openai/codex"), version: z.literal("0.166.0"),
  bin: z.object({codex: z.literal("bin/codex.js")})}).passthrough();

async function windowsNpmLauncher(): Promise<string | null> {
  const matches = new Set<string>();
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    const location = directory.replace(/^"|"$/gu, "");
    if (!path.isAbsolute(location)) continue;
    try {
      const shim = await readFile(path.join(location, "codex.cmd"), "utf8");
      if (shim.length > 64 * 1024 || !shim.replaceAll("\\", "/").includes("node_modules/@openai/codex/bin/codex.js")) continue;
      const packageRoot = path.join(location, "node_modules/@openai/codex");
      const bytes = await readFile(path.join(packageRoot, "package.json"));
      if (bytes.length > 64 * 1024 || !npmManifest.safeParse(JSON.parse(bytes.toString("utf8"))).success) continue;
      const launcher = await realpath(path.join(packageRoot, "bin/codex.js"));
      if (path.dirname(launcher) !== path.join(await realpath(packageRoot), "bin")) continue;
      matches.add(launcher);
    } catch { /* A missing/unverified public npm installation is not a launch candidate. */ }
  }
  return matches.size === 1 ? [...matches][0]! : null;
}

/** Preserve native executables. Only Windows ENOENT may use the verified official npm launcher. */
export function createCodexInspectionCommand(command: (file: string, args: string[]) => Promise<string>) {
  let launcher: string | null = null;
  return async (args: string[]): Promise<string> => {
    if (launcher) return command(process.execPath, [launcher, ...args]);
    try { return await command("codex", args); }
    catch (error) {
      if (process.platform !== "win32" || !(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
      launcher = await windowsNpmLauncher();
      if (!launcher) throw error;
      return command(process.execPath, [launcher, ...args]);
    }
  };
}

/** Codex 0.166 local-marketplace protocol. The CLI list alone has no installation path. */
export async function observeCodexInstalledPlugin(root: string, command: (file: string, args: string[]) => Promise<string>) {
  const inspect = createCodexInspectionCommand(command);
  if ((await inspect(["--version"])).trim() !== "codex-cli 0.166.0") return null;
  const bytes = await readFile(path.join(root, ".codex-plugin/plugin.json"));
  if (bytes.length > 64 * 1024) return null;
  const installedManifest = manifest.parse(JSON.parse(bytes.toString("utf8")));
  const plugins = listing.parse(JSON.parse(await inspect(["plugin", "list", "--json"])));
  const matches = plugins.installed.filter(entry => entry.name === installedManifest.name);
  if (matches.length !== 1) return null;
  const entry = matches[0]!;
  if (!entry.installed || entry.version !== installedManifest.version || entry.pluginId !== `${entry.name}@${entry.marketplaceName}`) return null;
  const source = localSource.safeParse(entry.source);
  if (!source.success || !path.isAbsolute(source.data.path)) return null;
  const market = marketplaces.parse(JSON.parse(await inspect(["plugin", "marketplace", "list", "--json"])));
  const matchingMarkets = market.marketplaces.filter(item => item.name === entry.marketplaceName);
  if (matchingMarkets.length !== 1 || !path.isAbsolute(matchingMarkets[0]!.root)
    || await realpath(source.data.path) !== await realpath(matchingMarkets[0]!.root)) return null;
  // Official add's installedPath and the running package root must identify the same cache entry.
  // A marketplace/source tree with matching metadata is never an installed runtime.
  const codexHome = process.env.CODEX_HOME ?? path.join(homedir(), ".codex");
  if (!path.isAbsolute(codexHome)) return null;
  const expectedRoot = path.join(codexHome, "plugins/cache", entry.marketplaceName, entry.name, entry.version);
  if (await realpath(expectedRoot) !== root) return null;
  return {enabled: entry.enabled, entry: {plugin: entry, marketplace: matchingMarkets[0]}};
}
