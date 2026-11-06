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

/** Codex 0.166 local-marketplace protocol. The CLI list alone has no installation path. */
export async function observeCodexInstalledPlugin(root: string, command: (file: string, args: string[]) => Promise<string>) {
  if ((await command("codex", ["--version"])).trim() !== "codex-cli 0.166.0") return null;
  const bytes = await readFile(path.join(root, ".codex-plugin/plugin.json"));
  if (bytes.length > 64 * 1024) return null;
  const installedManifest = manifest.parse(JSON.parse(bytes.toString("utf8")));
  const plugins = listing.parse(JSON.parse(await command("codex", ["plugin", "list", "--json"])));
  const matches = plugins.installed.filter(entry => entry.name === installedManifest.name);
  if (matches.length !== 1) return null;
  const entry = matches[0]!;
  if (!entry.installed || entry.version !== installedManifest.version || entry.pluginId !== `${entry.name}@${entry.marketplaceName}`) return null;
  const source = localSource.safeParse(entry.source);
  if (!source.success || !path.isAbsolute(source.data.path)) return null;
  const market = marketplaces.parse(JSON.parse(await command("codex", ["plugin", "marketplace", "list", "--json"])));
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
