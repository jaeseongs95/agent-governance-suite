import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { OUTPUT_DIRECTORY, renderClaudePlugin } from "../../scripts/build-claude-plugin.mjs";

const repository = path.resolve(import.meta.dirname, "../..");
const entry = path.join(repository, "scripts/build-claude-plugin.mjs");
const directories = [];
const installed = "claude-plugin/contracts/owned.json";
const sourceManifest = "claude-overlay/.claude-plugin/plugin.json";
const modes = ["--check", "--drift"];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "ags-d0112-"));
  directories.push(root);
  const write = async (relative, content) => {
    const file = path.join(root, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  };
  await write("contracts/owned.json", "{}\n");
  await write("mcp-server/dist/server.mjs", "export const owned = true;\n");
  await write("release/version.json", JSON.stringify({ version: "3.0.0" }));
  await write("skills/registry.json", JSON.stringify({ skills: [] }));
  await write("hooks/hooks.json", JSON.stringify({ hooks: { SessionStart: [] } }));
  await write("claude-overlay/hooks/hooks.json", JSON.stringify({ hooks: { SessionStart: [] } }));
  await write(sourceManifest, JSON.stringify({ name: "agent-governance-suite" }));
  for (const args of [["init"], ["add", "."]]) {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8", timeout: 10_000, windowsHide: true });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
  }
  for (const [relative, bytes] of await renderClaudePlugin(root)) await write(`${OUTPUT_DIRECTORY}/${relative}`, bytes);
  return { root, write };
}

async function run(root, mode, faults = []) {
  const preload = path.join(root, "io-fault.mjs");
  const trace = path.join(root, "fault-events.jsonl");
  if (faults.length) {
    // 실제 권한 변경이 아닌 코드 주입이다. 지정된 파일 연산만 실패시키고 나머지는 실제로 실행한다.
    await writeFile(preload, `
import fs from "node:fs/promises";
import { appendFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
const root = ${JSON.stringify(root)}, faults = ${JSON.stringify(faults)};
for (const operation of ["readFile", "readdir"]) {
  const original = fs[operation];
  fs[operation] = async function(file, ...args) {
    const selected = faults.find(item => item.operation === operation && path.resolve(String(file)) === path.join(root, item.relative));
    if (!selected) return original.call(this, file, ...args);
    appendFileSync(${JSON.stringify(trace)}, JSON.stringify({ operation, relative: selected.relative, code: selected.code }) + "\\n");
    throw Object.assign(new Error("D0112_PRIVATE_NATIVE_MESSAGE"), { code: selected.code, path: String(file), syscall: operation });
  };
}
syncBuiltinESMExports();
`, "utf8");
  }
  const child = spawnSync(process.execPath, [...(faults.length ? ["--import", pathToFileURL(preload).href] : []), entry, mode], {
    cwd: root, encoding: "utf8", timeout: 10_000, windowsHide: true,
    env: { ...process.env, NODE_OPTIONS: "", AGENT_GOVERNANCE_ROOT: root, GITHUB_ACTIONS: "false" },
  });
  await writeFile(path.join(root, "child-stdout.txt"), child.stdout ?? "", "utf8");
  await writeFile(path.join(root, "child-stderr.txt"), child.stderr ?? "", "utf8");
  const output = `stdout:\n${child.stdout}\nstderr:\n${child.stderr}`;
  expect(child.error, output).toBeUndefined();
  expect(child.signal, output).toBeNull();
  if (faults.length) {
    let recorded;
    try {
      recorded = await readFile(trace, "utf8");
    } catch (error) {
      throw new Error(`Fault trace unavailable (${error.code}); ${output}`, { cause: error });
    }
    const events = recorded.trim().split("\n").map(line => JSON.parse(line));
    for (const fault of faults) expect(events).toContainEqual(fault);
  }
  return { child, text: child.stdout + child.stderr };
}

function unavailable(result, mode) {
  expect(result.child.status, result.text).toBe(mode === "--check" ? 1 : 0);
  expect(result.text).not.toContain("claude-plugin: fresh");
  if (mode === "--drift") expect(result.text).toContain("warning:");
}

it.each(modes)("D0112: unchanged owned tree is fresh via %s", async mode => {
  const { root } = await fixture();
  const result = await run(root, mode);
  expect(result.child.status, result.text).toBe(0);
  expect(result.text).toContain("claude-plugin: fresh");
});

const accessCases = [
  ["readFile", installed],
  ["readdir", "claude-plugin"],
  ["readdir", "claude-plugin/contracts"],
  ["readFile", sourceManifest],
];
it.each(accessCases.flatMap(([operation, relative]) => ["EACCES", "EIO"].flatMap(code => modes.map(mode => [operation, relative, code, mode]))))(
  "D0112: %s %s %s is bounded and path-specific via %s", async (operation, relative, code, mode) => {
    const { root } = await fixture();
    const result = await run(root, mode, [{ operation, relative, code }]);
    unavailable(result, mode);
    expect(result.text).toContain(relative);
    expect(result.text).toContain(`${operation} ${code}`);
    expect(result.text).not.toMatch(/is missing|missing file|stale file|SyntaxError/u);
    expect(result.text).not.toContain("D0112_PRIVATE_NATIVE_MESSAGE");
    expect(result.text).not.toContain(root);
  },
);

it.each(modes)("D0112: actual absent installed file is missing via %s", async mode => {
  const { root } = await fixture();
  await rm(path.join(root, installed));
  const result = await run(root, mode);
  unavailable(result, mode);
  expect(result.text).toContain(`missing file ${installed}`);
  expect(result.text).not.toContain("unreadable");
});

it.each(modes)("D0112: actual absent output directory is missing via %s", async mode => {
  const { root } = await fixture();
  await rm(path.join(root, OUTPUT_DIRECTORY), { recursive: true });
  const result = await run(root, mode);
  unavailable(result, mode);
  expect(result.text).toContain("claude-plugin/ is missing");
  expect(result.text).not.toContain("unreadable");
});

it.each(modes)("D0112: actual JSON parse error retains source path via %s", async mode => {
  const { root, write } = await fixture();
  await write(sourceManifest, "{");
  const result = await run(root, mode);
  unavailable(result, mode);
  expect(result.text).toMatch(/JSON|SyntaxError/u);
  expect(result.text).toContain(sourceManifest);
  expect(result.text).not.toMatch(/readFile EACCES|readFile EIO/u);
});

it.each(modes)("D0112: multiple installed read failures are both retained via %s", async mode => {
  const { root } = await fixture();
  const second = "claude-plugin/mcp-server/dist/server.mjs";
  const result = await run(root, mode, [
    { operation: "readFile", relative: installed, code: "EACCES" },
    { operation: "readFile", relative: second, code: "EIO" },
  ]);
  unavailable(result, mode);
  expect(result.text).toContain(installed);
  expect(result.text).toContain(second);
  expect(result.text).toContain("readFile EACCES");
  expect(result.text).toContain("readFile EIO");
});

it("D0112: drift preserves primary render and subsequent hook read failures", async () => {
  const { root } = await fixture();
  const hook = "claude-plugin/hooks/hooks.json";
  const result = await run(root, "--drift", [
    { operation: "readFile", relative: sourceManifest, code: "EACCES" },
    { operation: "readFile", relative: hook, code: "EIO" },
  ]);
  unavailable(result, "--drift");
  expect(result.text).toContain("render failed");
  expect(result.text).toContain("hook event drift not checked");
  expect(result.text).toContain(sourceManifest);
  expect(result.text).toContain(hook);
  expect(result.text).toContain("readFile EACCES");
  expect(result.text).toContain("readFile EIO");
  expect(result.text).not.toContain("D0112_PRIVATE_NATIVE_MESSAGE");
});

it.each(modes)("D0112: unallowlisted native code is bounded to unknown via %s", async mode => {
  const { root } = await fixture();
  const result = await run(root, mode, [{ operation: "readFile", relative: installed, code: "EIO\nPRIVATE_CODE" }]);
  unavailable(result, mode);
  expect(result.text).toContain(`${installed} (readFile unknown)`);
  expect(result.text).not.toContain("PRIVATE_CODE");
  expect(result.text).not.toContain("D0112_PRIVATE_NATIVE_MESSAGE");
});
