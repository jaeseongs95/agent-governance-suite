import {readFile, realpath} from "node:fs/promises";
import {homedir} from "node:os";
import path from "node:path";
import {z} from "zod";

const segment = z.string().min(1).max(255).refine(value => value !== "." && value !== ".." && !/[\\/\0]/u.test(value));
const manifest = z.object({name: segment, version: segment}).passthrough();

/** Verified AGY 1.5.2 default installation and public text-list protocol only. */
export async function observeAntigravityInstalledPlugin(root: string, command: (file: string, args: string[]) => Promise<string>) {
  if ((await command("agy", ["--version"])).trim() !== "1.5.2") return null;
  const bytes = await readFile(path.join(root, ".gemini-plugin/plugin.json"));
  if (bytes.length > 64 * 1024) return null;
  const installedManifest = manifest.parse(JSON.parse(bytes.toString("utf8")));
  const text = await command("agy", ["plugin", "list"]);
  if (!text.startsWith("Installed plugins:\n") && !text.startsWith("Installed plugins:\r\n")) return null;
  const lines = text.split(/\r?\n/u);
  const matches = lines.flatMap((line, index) => line.startsWith(`- ${installedManifest.name} (`) ? [index] : []);
  if (matches.length !== 1) return null;
  const index = matches[0]!;
  const row = /^- (.+) \((enabled|disabled), ([^)]+)\)$/u.exec(lines[index]!);
  const components = /^\s+Components:\s+(\d+) skills?, (\d+) MCP servers?, (\d+) hooks?\s*$/u.exec(lines[index + 2] ?? "");
  if (!row || row[1] !== installedManifest.name || row[3] !== installedManifest.version
    || !/^\s+Source:\s+antigravity\s*$/u.test(lines[index + 1] ?? "") || !components) return null;
  // Official install reports this default root; bind fresh registration to the actual running tree.
  if (await realpath(path.join(homedir(), ".gemini/config/plugins", installedManifest.name)) !== root) return null;
  return {enabled: row[2] === "enabled", skillCount: Number(components[1]),
    entry: {name: row[1], version: row[3], state: row[2], source: "antigravity", components: components.slice(1)}};
}
