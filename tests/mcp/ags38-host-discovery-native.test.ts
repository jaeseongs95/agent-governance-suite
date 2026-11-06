import {createHash} from "node:crypto";
import {mkdtemp, mkdir, writeFile, readFile, copyFile, chmod, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {build} from "esbuild";
import {afterEach, describe, expect, it, vi} from "vitest";
import {RuntimeSkillClassificationGateway} from "../../mcp-server/src/skill-classification/gateway.js";
import {InMemoryClassificationBudget, SkillClassificationService} from "../../mcp-server/src/skill-classification/service.js";

const host = vi.hoisted(() => ({home: "", outputs: {} as Record<string, string>, failed: false, calls: [] as string[]}));
vi.mock("node:os", async original => ({...await original<typeof import("node:os")>(), homedir: () => host.home}));
vi.mock("node:child_process", async original => ({...await original<typeof import("node:child_process")>(),
  execFile: (file: string, args: string[], _options: unknown, callback: (error: Error | null, stdout: string) => void) => {
    const key = [file, ...args].join(" "); host.calls.push(key);
    callback(host.failed || !(key in host.outputs) ? new Error("PRIVATE_HOST_CAUSE") : null, host.outputs[key] ?? "");
  }}));
const directories: string[] = [];
afterEach(async () => {vi.unstubAllEnvs(); host.outputs = {}; host.calls = []; host.failed = false;
  await Promise.all(directories.splice(0).map(directory => rm(directory, {recursive: true, force: true})));});

async function packageTree(root: string, manifest: ".codex-plugin" | ".gemini-plugin") {
  await mkdir(path.join(root, manifest), {recursive: true});
  await writeFile(path.join(root, manifest, "plugin.json"), JSON.stringify({name: "neutral-plugin", version: "1.0.0", skills: "./skills/"}));
  const skill = path.join(root, "skills", "neutral-review"); await mkdir(skill, {recursive: true});
  const content = "---\nname: neutral-review\ndescription: Review a patch; exclude implementation.\nmetadata:\n  version: '1.0.0'\n---\nReview a fixed patch.\nExclude implementation.\n";
  await writeFile(path.join(skill, "SKILL.md"), content);
  const span = {path: "skills/neutral-review/SKILL.md", startLine: 8, endLine: 9, digest: `sha256:${createHash("sha256").update(content).digest("hex")}`};
  await writeFile(path.join(skill, "classification.json"), JSON.stringify({schemaVersion: "1.0.0", taxonomyRevision: "1.0.0", actions: ["review"], targets: ["patch"], constraints: [], dependencies: [], capabilities: ["fixed-patch-review"], applicability: [span], exclusions: [span]}));
  await writeFile(path.join(root, "skills/registry.json"), JSON.stringify({schemaVersion: "2.0.0", skills: []}));
}
function gateway(root: string, now?: () => Date) {
  return new RuntimeSkillClassificationGateway({root, ...(now ? {now} : {}),
    service: new SkillClassificationService({providers: {}, budget: new InMemoryClassificationBudget({jev: {limitUsd: null, spentUsd: null}, vendors: {}})}),
    readRuntime: async () => ({config: {jevEnabled: false, mode: "select", providerProfileRegistryRef: "unconfigured", externalClassificationAllowed: false, configRevision: "fixture", timeoutMs: 1000}, registry: {schemaVersion: "1.0.0", profileRevision: "fixture", profiles: []}, allowRemotePrivateContent: false})});
}
async function fixture(kind: "codex" | "antigravity") {
  const home = await mkdtemp(path.join(tmpdir(), "ags38-native-inventory-")); directories.push(home); host.home = home;
  const codexHome = path.join(home, ".codex"); vi.stubEnv("CODEX_HOME", codexHome);
  const source = path.join(home, "marketplace"); await mkdir(source);
  const root = kind === "codex" ? path.join(codexHome, "plugins/cache/neutral-market/neutral-plugin/1.0.0")
    : path.join(home, ".gemini/config/plugins/neutral-plugin");
  await packageTree(root, kind === "codex" ? ".codex-plugin" : ".gemini-plugin");
  const listed = (enabled = true) => {
    host.outputs["codex --version"] = "codex-cli 0.166.0\n";
    host.outputs["codex plugin list --json"] = JSON.stringify({installed: [{pluginId: "neutral-plugin@neutral-market", name: "neutral-plugin", marketplaceName: "neutral-market", version: "1.0.0", installed: true, enabled,
      source: {source: "local", path: source}, marketplaceSource: {sourceType: "local", source}}], available: []});
    host.outputs["codex plugin marketplace list --json"] = JSON.stringify({marketplaces: [{name: "neutral-market", root: source}]});
    host.outputs["agy --version"] = "1.5.2\n";
    host.outputs["agy plugin list"] = `Installed plugins:\n- neutral-plugin (${enabled ? "enabled" : "disabled"}, 1.0.0)\n    Source:     antigravity\n    Components: 1 skills, 1 MCP server, 2 hooks\n`;
  };
  listed(); vi.stubEnv("AGENT_GOVERNANCE_HOST_ATTESTATION", kind);
  return {root, home, source, listed};
}
const unavailable = (inventory: Awaited<ReturnType<RuntimeSkillClassificationGateway["inventory"]>>) => {
  expect(inventory.discovery.status).toBe("UNAVAILABLE");
  expect(inventory.issues).toContainEqual({skillId: null, code: "HOST_DISCOVERY_UNAVAILABLE", field: "hostDiscovery"});
};

describe("D0013 current native installation and running root binding", () => {
  for (const kind of ["codex", "antigravity"] as const) {
    it(`${kind}: observes official installed state only at the bound running root`, async () => {
      const f = await fixture(kind); const result = await gateway(f.root).inventory();
      expect(result.discovery).toMatchObject({status: "COMPLETE", scope: "host"});
      expect(result.discovery.sourceRef).toContain(`host:${kind}:installed-plugin:`);
      expect(result.skills).toMatchObject([{skillId: "neutral-review", installed: true, enabled: true, hostSupported: true}]);
      expect(host.calls).toContain(kind === "codex" ? "codex plugin list --json" : "agy plugin list");
    });
    it(`${kind}: re-queries disablement and keeps unchanged observation revisions stable`, async () => {
      const f = await fixture(kind); const g = gateway(f.root); const first = await g.inventory(); const second = await g.inventory();
      expect(second.discovery).toMatchObject({status: "COMPLETE", revision: first.discovery.revision});
      const before = host.calls.length; f.listed(false); const disabled = await g.inventory();
      expect(host.calls.length).toBeGreaterThan(before);
      expect(disabled.skills).toMatchObject([{installed: true, enabled: false, hostSupported: true}]);
      expect(disabled.discovery.revision).not.toBe(first.discovery.revision);
    });
    it(`${kind}: refuses a same-name and same-version source copy outside the installed cache`, async () => {
      const f = await fixture(kind); await packageTree(f.source, kind === "codex" ? ".codex-plugin" : ".gemini-plugin");
      unavailable(await gateway(f.source).inventory());
    });
    it(`${kind}: keeps host errors private and unsupported CLI versions unavailable`, async () => {
      const f = await fixture(kind); host.failed = true; const failed = await gateway(f.root).inventory();
      unavailable(failed); expect(JSON.stringify(failed)).not.toContain("PRIVATE_HOST_CAUSE"); host.failed = false;
      host.outputs[kind === "codex" ? "codex --version" : "agy --version"] = "unverified-next-version\n";
      unavailable(await gateway(f.root).inventory());
    });
  }
  it.each(["missing", "remote", "duplicate", "wrong-marketplace", "malformed"])("codex: rejects %s host registration", async mutation => {
    const f = await fixture("codex"); const key = "codex plugin list --json"; const raw = JSON.parse(host.outputs[key]!);
    if (mutation === "missing") raw.installed = [];
    if (mutation === "remote") raw.installed[0].source = {source: "remote", id: "public-connector"};
    if (mutation === "duplicate") raw.installed.push(raw.installed[0]);
    if (mutation === "wrong-marketplace") host.outputs["codex plugin marketplace list --json"] = JSON.stringify({marketplaces: []});
    host.outputs[key] = mutation === "malformed" ? "PRIVATE_INVALID_JSON" : JSON.stringify(raw);
    unavailable(await gateway(f.root).inventory());
  });
  it.each(["missing", "duplicate", "wrong-version", "wrong-count", "malformed"])("antigravity: rejects %s installation text", async mutation => {
    const f = await fixture("antigravity"); const key = "agy plugin list"; const original = host.outputs[key]!;
    host.outputs[key] = mutation === "missing" ? "No plugins installed.\n" : mutation === "duplicate" ? original + original
      : mutation === "wrong-version" ? original.replace("1.0.0", "9.9.9") : mutation === "wrong-count" ? original.replace("1 skills", "2 skills") : "PRIVATE_INVALID_TEXT";
    unavailable(await gateway(f.root).inventory());
  });
  it("unsupported hosts never run an inventory command", async () => {
    const f = await fixture("codex"); vi.stubEnv("AGENT_GOVERNANCE_HOST_ATTESTATION", "unverified-host");
    unavailable(await gateway(f.root).inventory()); expect(host.calls).toEqual([]);
  });
  it.skipIf(process.platform === "win32")("TEST Linux public CLI fixture crosses actual execFile boundary without shell or model turn", async () => {
    const f = await fixture("codex"); const fixtureRoot = path.dirname(fileURLToPath(new URL("./fixtures/ags38-host-discovery/cli.mjs", import.meta.url)));
    const bin = path.join(f.home, "bin"); await mkdir(bin); const executable = path.join(bin, "codex");
    await copyFile(path.join(fixtureRoot, "cli.mjs"), executable); await chmod(executable, 0o755);
    const responses = path.join(f.home, "public-responses.json"); await writeFile(responses, JSON.stringify(host.outputs));
    const bundle = path.join(f.home, "probe.mjs");
    await build({entryPoints: [path.join(fixtureRoot, "probe.ts")], outfile: bundle, platform: "node", target: "node24", format: "esm", bundle: true, logLevel: "silent"});
    const {execFile} = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const output = await new Promise<string>((resolve, reject) => execFile(process.execPath, [bundle, f.root], {
      encoding: "utf8", timeout: 20_000, env: {...process.env, HOME: f.home, CODEX_HOME: path.join(f.home, ".codex"),
        PATH: `${bin}${path.delimiter}${process.env.PATH}`, HOST_DISCOVERY_FIXTURE: responses, HOST_DISCOVERY_CALLS: path.join(f.home, "calls.jsonl")},
    }, (error, stdout, stderr) => error ? reject(new Error(`${error.message}\n${stderr}`)) : resolve(stdout)));
    const result = JSON.parse(output);
    expect(result.discovery).toMatchObject({status: "COMPLETE", scope: "host"});
    expect(result.inventory.skills).toMatchObject([{skillId: "neutral-review", installed: true, enabled: true, hostSupported: true}]);
    expect((await readFile(path.join(f.home, "calls.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line))).toContainEqual(["plugin", "list", "--json"]);
  });
});
