import {createHash} from "node:crypto";
import {mkdtemp, mkdir, realpath, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {afterEach, describe, expect, it, vi} from "vitest";
import {RuntimeSkillClassificationGateway} from "../../mcp-server/src/skill-classification/gateway.js";
import {InMemoryClassificationBudget, SkillClassificationService} from "../../mcp-server/src/skill-classification/service.js";

// D0013: a Windows npm install of Claude Code puts only claude.cmd/claude.ps1 on PATH, so a shell-less execFile("claude")
// is ENOENT (measured on the Windows TEST server with @anthropic-ai/claude-code 2.1.316). The platform is stubbed so the
// same cases also run on Linux; the npm layout is the official one (package bin "bin/claude.exe", npm cmd shim).
const host = vi.hoisted(() => ({executable: "", output: "[]", calls: [] as {file: string; args: string[]}[]}));
vi.mock("node:child_process", async importOriginal => ({...await importOriginal<typeof import("node:child_process")>(),
  execFile: (file: string, args: string[], _options: unknown, callback: (error: Error | null, stdout: string) => void) => {
    host.calls.push({file, args});
    if (file === "claude") {callback(Object.assign(new Error("spawn claude ENOENT"), {code: "ENOENT"}), ""); return;}
    callback(file === host.executable ? null : new Error("PRIVATE_HOST_CAUSE"), file === host.executable ? host.output : "");
  }}));

const directories: string[] = [];
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
afterEach(async () => {
  Object.defineProperty(process, "platform", platform);
  vi.unstubAllEnvs(); host.executable = ""; host.output = "[]"; host.calls = [];
  await Promise.all(directories.splice(0).map(directory => rm(directory, {recursive: true, force: true})));
});

async function installedPlugin(home: string) {
  const root = path.join(home, ".claude/plugins/cache/neutral-market/neutral-plugin/1.0.0");
  const skill = path.join(root, "skills/neutral-review"); await mkdir(skill, {recursive: true});
  await mkdir(path.join(root, ".claude-plugin"));
  await writeFile(path.join(root, ".claude-plugin/plugin.json"), JSON.stringify({name: "neutral-plugin", version: "1.0.0"}));
  const content = "---\nname: neutral-review\ndescription: Review a fixed patch; exclude implementation.\nmetadata:\n  version: '1.0.0'\n---\nReview a fixed patch.\nExclude implementation.\n";
  await writeFile(path.join(skill, "SKILL.md"), content);
  const span = {path: "skills/neutral-review/SKILL.md", startLine: 8, endLine: 9, digest: `sha256:${createHash("sha256").update(content).digest("hex")}`};
  await writeFile(path.join(skill, "classification.json"), JSON.stringify({schemaVersion: "1.0.0", taxonomyRevision: "1.0.0", actions: ["review"],
    targets: ["patch"], constraints: [], dependencies: [], capabilities: ["fixed-patch-review"], applicability: [span], exclusions: [span]}));
  await writeFile(path.join(root, "skills/registry.json"), JSON.stringify({schemaVersion: "2.0.0", skills: []}));
  host.output = JSON.stringify([{id: "neutral-plugin@neutral-market", version: "1.0.0", enabled: true, scope: "user", installPath: root}]);
  return root;
}

/** The official npm layout: a global prefix with the cmd shim and node_modules/@anthropic-ai/claude-code/bin/claude.exe. */
async function npmInstall(prefix: string, mutation = "") {
  const packageRoot = path.join(prefix, "node_modules/@anthropic-ai/claude-code");
  await mkdir(path.join(packageRoot, "bin"), {recursive: true});
  await writeFile(path.join(prefix, "claude.cmd"), "@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n"
    + "\"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe\"   %*\r\n");
  await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({name: mutation === "wrong-package" ? "unverified-package" : "@anthropic-ai/claude-code",
    version: "2.1.316", bin: {claude: mutation === "wrong-bin" ? "cli.js" : "bin/claude.exe"}}));
  const executable = path.join(packageRoot, "bin/claude.exe");
  if (mutation !== "missing") await writeFile(executable, "public-native-fixture");
  return executable;
}

async function fixture() {
  const home = await mkdtemp(path.join(tmpdir(), "ags39-claude-npm-")); directories.push(home);
  const root = await installedPlugin(home);
  vi.stubEnv("AGENT_GOVERNANCE_HOST_ATTESTATION", "claude-code");
  Object.defineProperty(process, "platform", {...platform, value: "win32"});
  const gateway = new RuntimeSkillClassificationGateway({root,
    service: new SkillClassificationService({providers: {}, budget: new InMemoryClassificationBudget({jev: {limitUsd: null, spentUsd: null}, vendors: {}})}),
    readRuntime: async () => ({config: {jevEnabled: false, mode: "select", providerProfileRegistryRef: "unconfigured", externalClassificationAllowed: false,
      configRevision: "fixture", timeoutMs: 1000}, registry: {schemaVersion: "1.0.0", profileRevision: "fixture", profiles: []}, allowRemotePrivateContent: false})});
  return {home, gateway};
}

describe("D0013 Windows npm Claude Code installation", () => {
  it("CN01: an ENOENT bare claude runs the verified npm package's native executable with the same arguments", async () => {
    const {home, gateway} = await fixture(); const prefix = path.join(home, "npm");
    host.executable = await realpath(await npmInstall(prefix));
    vi.stubEnv("PATH", prefix);
    const inventory = await gateway.inventory();
    expect(inventory.discovery).toMatchObject({status: "COMPLETE", scope: "host"});
    expect(inventory.skills).toMatchObject([{skillId: "neutral-review", installed: true, enabled: true, hostSupported: true}]);
    expect(host.calls).toEqual([{file: "claude", args: ["plugin", "list", "--json"]}, {file: host.executable, args: ["plugin", "list", "--json"]}]);
  });

  it.each(["missing", "wrong-package", "wrong-bin", "duplicate"])("CN02: a %s npm installation stays unavailable and starts nothing else", async mutation => {
    const {home, gateway} = await fixture(); const prefix = path.join(home, "npm");
    await npmInstall(prefix, mutation === "duplicate" ? "" : mutation);
    let commandPath = prefix;
    if (mutation === "duplicate") {const other = path.join(home, "npm-other"); await npmInstall(other); commandPath += path.delimiter + other;}
    vi.stubEnv("PATH", commandPath);
    const inventory = await gateway.inventory();
    expect(inventory.discovery.status).toBe("UNAVAILABLE");
    expect(inventory.issues).toContainEqual({skillId: null, code: "HOST_DISCOVERY_UNAVAILABLE", field: "hostDiscovery"});
    expect(host.calls.filter(call => call.file !== "claude")).toEqual([]);
  });

  it("CN03: off Windows an ENOENT claude has no npm fallback", async () => {
    const {home, gateway} = await fixture(); const prefix = path.join(home, "npm");
    host.executable = await realpath(await npmInstall(prefix));
    vi.stubEnv("PATH", prefix);
    Object.defineProperty(process, "platform", {...platform, value: "linux"});
    expect((await gateway.inventory()).discovery.status).toBe("UNAVAILABLE");
    expect(host.calls).toEqual([{file: "claude", args: ["plugin", "list", "--json"]}]);
  });
});
