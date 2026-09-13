import { spawnSync } from "node:child_process";
import { access, cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { SKILL_RUNTIME_ENTRYPOINTS } from "./runtime-entrypoints.mjs";

async function assertMissing(target) {
  try {
    await access(target);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`Clean-room dependency leak: ${target} exists.`);
}

export async function runRuntimeSmokeCheck(sourceRoot) {
  const cleanRoot = await mkdtemp(path.join(tmpdir(), "agent-governance-runtime-"));
  try {
    await Promise.all([
      cp(path.join(sourceRoot, "contracts"), path.join(cleanRoot, "contracts"), { recursive: true }),
      cp(path.join(sourceRoot, "runtime"), path.join(cleanRoot, "runtime"), { recursive: true }),
      cp(path.join(sourceRoot, "skills"), path.join(cleanRoot, "skills"), { recursive: true }),
    ]);
    await assertMissing(path.join(cleanRoot, "node_modules"));

    const environment = { ...process.env };
    delete environment.AGENT_GOVERNANCE_ROOT;
    delete environment.NODE_OPTIONS;
    delete environment.NODE_PATH;

    const results = [];
    for (const entrypoint of SKILL_RUNTIME_ENTRYPOINTS) {
      const executable = path.join(cleanRoot, ...entrypoint.path.split("/"));
      const result = spawnSync(process.execPath, [executable], {
        cwd: cleanRoot,
        encoding: "utf8",
        env: environment,
        input: "{}\n",
        maxBuffer: 5 * 1024 * 1024,
        timeout: 10_000,
        windowsHide: true,
      });
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
      if (result.error) {
        throw new Error(`${entrypoint.path} could not run in the clean room: ${result.error.message}`);
      }
      if (result.status !== entrypoint.expectedExitCode) {
        throw new Error(`${entrypoint.path} exited ${result.status}; expected ${entrypoint.expectedExitCode}.\n${output}`);
      }
      if (!output.includes(entrypoint.outputIncludes)) {
        throw new Error(`${entrypoint.path} did not emit ${JSON.stringify(entrypoint.outputIncludes)}.\n${output}`);
      }
      if (/ERR_MODULE_NOT_FOUND|Cannot find package/u.test(output)) {
        throw new Error(`${entrypoint.path} leaked an unbundled runtime dependency.\n${output}`);
      }
      results.push({ path: entrypoint.path, exitCode: result.status });
    }

    const workspace = path.join(cleanRoot, "resolver-fixture");
    await mkdir(path.join(workspace, "src"), { recursive: true });
    await writeFile(path.join(workspace, "AGENTS.md"), "Use the repository validation commands.\n", "utf8");
    const resolver = path.join(cleanRoot, "skills", "instruction-scope-resolver", "scripts", "resolve-instruction-files.mjs");
    const resolverInput = {
      schemaVersion: "1.0.0",
      workspaceRoot: workspace,
      instructionRoots: [{ path: workspace, precedence: 1, authorized: true }],
      targets: [{ path: "src", mayNotExist: false }],
      externalPolicyRefs: [],
    };
    const resolverResult = spawnSync(process.execPath, [resolver], {
      cwd: cleanRoot,
      encoding: "utf8",
      env: environment,
      input: `${JSON.stringify(resolverInput)}\n`,
      maxBuffer: 5 * 1024 * 1024,
      timeout: 10_000,
      windowsHide: true,
    });
    if (resolverResult.error || resolverResult.status !== 0) {
      throw new Error(`instruction-scope-resolver valid clean-room smoke failed.\n${resolverResult.stderr ?? ""}`);
    }
    const resolverOutput = JSON.parse(resolverResult.stdout);
    if (resolverOutput.ok !== true || resolverOutput.output?.verdict !== "ANALYSIS_REQUIRED") {
      throw new Error(`instruction-scope-resolver returned an unexpected clean-room result.\n${resolverResult.stdout}`);
    }
    return results;
  } finally {
    await rm(cleanRoot, { recursive: true, force: true });
  }
}
