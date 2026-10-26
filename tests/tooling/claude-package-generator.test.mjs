import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { RUNTIME_BUNDLES } from "../../scripts/runtime-bundles.mjs";
import { retainFailureSecondary } from "../../runtime/failure-diagnostics.mjs";

const repository = path.resolve(import.meta.dirname, "../..");

// Regression for official 06a-claude-package: the source generator imports bundle
// metadata in a dependency-free clone. This does not execute the installed runtime
// or qualify a live host. Actual bundle compilation still requires esbuild.
it("generates and checks the Claude package without loading development dependencies, including the governance bundle", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ags-claude-generator-"));
  expect(path.dirname(directory)).toBe(path.resolve(tmpdir()));
  const source = path.join(directory, "source");
  const sourceBytes = new Map();
  const write = async (relative, bytes) => {
    const destination = path.join(source, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, bytes);
    sourceBytes.set(relative, Buffer.from(bytes));
  };
  const copy = async relative => {
    const destination = path.join(source, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(path.join(repository, relative), destination);
    sourceBytes.set(relative, await readFile(destination));
  };
  const environment = { ...process.env, AGENT_GOVERNANCE_ROOT: source };
  delete environment.NODE_OPTIONS;
  delete environment.NODE_PATH;
  const run = (command, args) => {
    const child = spawnSync(command, args, { cwd: source, env: environment, encoding: "utf8", timeout: 10_000, windowsHide: true });
    expect(child.error).toBeUndefined();
    expect(child.signal).toBeNull();
    // Preserve the real loader error in the assertion; never skip or translate it.
    expect(child.status, child.stderr).toBe(0);
    return child;
  };
  let primaryFailure = null;
  try {
    for (const relative of ["scripts/build-claude-plugin.mjs", "scripts/lib.mjs", "scripts/runtime-bundles.mjs", "LICENSE"]) await copy(relative);
    const bundlePaths = RUNTIME_BUNDLES.map(target => target.output).filter(output => output.startsWith("mcp-server/dist/"));
    expect(bundlePaths).toContain("mcp-server/dist/governance-hook.mjs");
    for (const relative of bundlePaths) await copy(relative);
    await copy("claude-overlay/hooks/governance-hook.mjs");
    await write("package.json", JSON.stringify({ private: true, type: "module" }));
    await write("release/version.json", JSON.stringify({ version: "1.2.3" }));
    await write("skills/registry.json", JSON.stringify({ skills: [] }));
    await write("hooks/hooks.json", JSON.stringify({ hooks: { PreToolUse: [] } }));
    await write("claude-overlay/hooks/hooks.json", JSON.stringify({ hooks: { PreToolUse: [] } }));
    await write("claude-overlay/.claude-plugin/plugin.json", JSON.stringify({ name: "agent-governance-suite" }));
    expect(await readdir(source)).not.toContain("node_modules");
    expect(() => createRequire(path.join(source, "package.json")).resolve("esbuild"))
      .toThrow(expect.objectContaining({ code: "MODULE_NOT_FOUND" }));
    run("git", ["init"]);
    run("git", ["add", "--all"]);
    const built = run(process.execPath, ["scripts/build-claude-plugin.mjs"]);
    expect(built.stdout).toMatch(/^claude-plugin: wrote \d+ files\s*$/u);
    expect(run(process.execPath, ["scripts/build-claude-plugin.mjs", "--check"]).stdout.trim()).toBe("claude-plugin: fresh");
    const installed = path.join(source, "claude-plugin");
    expect(await readdir(source)).not.toContain("node_modules");
    expect(await readdir(installed)).not.toContain("node_modules");
    for (const relative of bundlePaths) expect(await readFile(path.join(installed, relative)), relative).toEqual(sourceBytes.get(relative));
    expect(await readFile(path.join(installed, "hooks/governance-hook.mjs"))).toEqual(sourceBytes.get("claude-overlay/hooks/governance-hook.mjs"));
    for (const [relative, bytes] of sourceBytes) expect(await readFile(path.join(source, relative)), relative).toEqual(bytes);
  } catch (error) {
    primaryFailure = { error };
  }
  try {
    // Only the directory created above is disposable; the repository is read only.
    expect(path.dirname(directory)).toBe(path.resolve(tmpdir()));
    await rm(directory, { recursive: true, force: true });
  } catch (cleanup) {
    if (primaryFailure === null) throw cleanup;
    retainFailureSecondary(primaryFailure.error, cleanup);
  }
  if (primaryFailure !== null) throw primaryFailure.error;
});
