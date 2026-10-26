import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
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
it("generates and checks the Claude package without loading development dependencies, including the governance bundle", async (context) => {
  const started = performance.now();
  const children = [];
  let phase = { name: "allocate-temp", startedAtMs: 0 };
  let failureObservation = null;
  let abortObservation = null;
  const enter = name => { phase = { name, startedAtMs: performance.now() - started }; };
  const snapshot = trigger => {
    const elapsedMs = performance.now() - started;
    return { trigger, elapsedMs, phase: phase.name, phaseElapsedMs: elapsedMs - phase.startedAtMs,
      children: children.slice(0, 4).map(child => ({ ...child, args: [...child.args], elapsedMs: child.elapsedMs ?? elapsedMs - child.startedAtMs })) };
  };
  // This is the phase at abort observation, not a cause: spawnSync can delay the event loop.
  context.signal.addEventListener("abort", () => { abortObservation = snapshot("abort-observed"); }, { once: true });
  context.onTestFailed(({ task }) => {
    const error = task.result?.errors?.[0];
    if (!error) return;
    const diagnostic = "\nAGS_CLAUDE_GENERATOR_DIAGNOSTIC " + JSON.stringify(abortObservation ?? failureObservation ?? snapshot("failure-observed"));
    error.message += diagnostic;
    if (typeof error.stack === "string") error.stack += diagnostic;
  });
  const directory = await mkdtemp(path.join(tmpdir(), "ags-claude-generator-"));
  expect(path.dirname(directory)).toBe(path.resolve(tmpdir()));
  const source = path.join(directory, "source");
  const sourceBytes = new Map();
  const write = async (relative, bytes) => {
    enter(`fixture-write:${relative}`);
    const destination = path.join(source, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, bytes);
    sourceBytes.set(relative, Buffer.from(bytes));
  };
  const copy = async relative => {
    enter(`fixture-copy:${relative}`);
    const destination = path.join(source, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(path.join(repository, relative), destination);
    sourceBytes.set(relative, await readFile(destination));
  };
  const environment = { ...process.env, AGENT_GOVERNANCE_ROOT: source };
  delete environment.NODE_OPTIONS;
  delete environment.NODE_PATH;
  const run = (stage, command, args) => {
    enter(`child:${stage}`);
    const observed = { stage, command, args: [...args], startedAtMs: performance.now() - started,
      completed: false, status: null, signal: null, errorCode: null };
    children.push(observed);
    const child = spawnSync(command, args, { cwd: source, env: environment, encoding: "utf8", timeout: 10_000, windowsHide: true });
    Object.assign(observed, { completed: true, status: child.status, signal: child.signal,
      errorCode: child.error?.code ?? null, elapsedMs: performance.now() - started - observed.startedAtMs });
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
    enter("fixture-validation");
    expect(await readdir(source)).not.toContain("node_modules");
    expect(() => createRequire(path.join(source, "package.json")).resolve("esbuild"))
      .toThrow(expect.objectContaining({ code: "MODULE_NOT_FOUND" }));
    run("git-init", "git", ["init"]);
    run("git-add", "git", ["add", "--all"]);
    const built = run("build", process.execPath, ["scripts/build-claude-plugin.mjs"]);
    expect(built.stdout).toMatch(/^claude-plugin: wrote \d+ files\s*$/u);
    expect(run("check", process.execPath, ["scripts/build-claude-plugin.mjs", "--check"]).stdout.trim()).toBe("claude-plugin: fresh");
    const installed = path.join(source, "claude-plugin");
    enter("installed-verification");
    expect(await readdir(source)).not.toContain("node_modules");
    expect(await readdir(installed)).not.toContain("node_modules");
    for (const relative of bundlePaths) {
      enter(`installed-read:${relative}`);
      expect(await readFile(path.join(installed, relative)), relative).toEqual(sourceBytes.get(relative));
    }
    enter("installed-read:hooks/governance-hook.mjs");
    expect(await readFile(path.join(installed, "hooks/governance-hook.mjs"))).toEqual(sourceBytes.get("claude-overlay/hooks/governance-hook.mjs"));
    for (const [relative, bytes] of sourceBytes) {
      enter(`source-read:${relative}`);
      expect(await readFile(path.join(source, relative)), relative).toEqual(bytes);
    }
  } catch (error) {
    failureObservation = snapshot("body-failure-observed");
    primaryFailure = { error };
  }
  try {
    enter("cleanup");
    // Only the directory created above is disposable; the repository is read only.
    expect(path.dirname(directory)).toBe(path.resolve(tmpdir()));
    await rm(directory, { recursive: true, force: true });
  } catch (cleanup) {
    if (primaryFailure === null) throw cleanup;
    retainFailureSecondary(primaryFailure.error, cleanup);
  }
  if (primaryFailure !== null) throw primaryFailure.error;
});
