import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { runRuntimeSmokeCheck } from "../../scripts/runtime-smoke.mjs";
import { SKILL_RUNTIME_ENTRYPOINTS } from "../../scripts/runtime-entrypoints.mjs";

const temporaryRoots = [];
const bundles = [
  "session-message-broker.mjs",
  "session-message-relay.mjs",
  "session-message-cli.mjs",
  "session-message-hook.mjs",
];

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "ags-cg10-"));
  temporaryRoots.push(root);
  for (const directory of ["contracts", "runtime", "skills", "mcp-server/dist"]) {
    await mkdir(path.join(root, directory), { recursive: true });
  }
  for (const bundle of ["server.mjs", "continuity-hook.mjs", "host-attestation-hook.mjs", "host-attestation-api.mjs", "session-board-hook.mjs", "governance-hook.mjs"]) {
    await writeFile(path.join(root, "mcp-server/dist", bundle), "", "utf8");
  }
  const trace = path.join(root, "trace.jsonl");
  for (const bundle of bundles) {
    const response = bundle === "session-message-cli.mjs"
      ? 'process.stdout.write(JSON.stringify({ protocolVersion: "1.0.0", ok: false, error: "Unsupported session message operation." }) + "\\n"); process.exitCode = 1;'
      : bundle === "session-message-hook.mjs"
        ? 'console.error("[agent-governance-suite] peer-hook-failure " + JSON.stringify({ phase: "input", reason: "INVALID_JSON", reasonBasis: "unverified-observation", context: { type: "syntax-error" } }));'
        : "process.exitCode = 2;";
    const expectedInput = bundle === "session-message-hook.mjs" ? "{\n" : "{}\n";
    await writeFile(path.join(root, "mcp-server/dist", bundle), `
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
if (existsSync(path.join(process.cwd(), "node_modules"))) throw new Error("Dependency leak");
const input = readFileSync(0, "utf8");
if (input !== ${JSON.stringify(expectedInput)}) throw new Error("Unexpected smoke input");
appendFileSync(${JSON.stringify(trace)}, JSON.stringify({ bundle: ${JSON.stringify(bundle)}, cwd: process.cwd(), script: process.argv[1], input }) + "\\n");
${response}
`, "utf8");
  }
  // Stop after messaging probes at the first unrelated skill. No host/DB fixtures run.
  const firstSkill = path.join(root, SKILL_RUNTIME_ENTRYPOINTS[0].path);
  await mkdir(path.dirname(firstSkill), { recursive: true });
  await writeFile(firstSkill, 'process.stderr.write("CG10_AFTER_MESSAGING"); process.exitCode = 99;\n', "utf8");
  return { root, trace };
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("CG10 messaging clean-room startup regression", () => {
  it("copies and executes all four messaging bundles from the packaged layout without node_modules", async () => {
    const { root, trace } = await fixture();
    await expect(runRuntimeSmokeCheck(root)).rejects.toThrow(/CG10_AFTER_MESSAGING/u);
    const calls = (await readFile(trace, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(calls.map(call => call.bundle)).toEqual(bundles);
    expect(calls.find(call => call.bundle === "session-message-hook.mjs").input).toBe("{\n");
    expect(new Set(calls.map(call => call.cwd)).size).toBe(1);
    for (const call of calls) {
      expect(call.cwd).not.toBe(root);
      expect(call.script).toBe(path.join(call.cwd, "mcp-server/dist", call.bundle));
    }
    await expect(access(calls[0].cwd)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(bundles)("rejects an absent %s even though all other messaging bundles exist", async bundle => {
    const { root } = await fixture();
    await rm(path.join(root, "mcp-server/dist", bundle));
    await expect(runRuntimeSmokeCheck(root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(bundles)("rejects a present but unbundled %s", async bundle => {
    const { root } = await fixture();
    await writeFile(path.join(root, "mcp-server/dist", bundle), 'import "./cg10-missing-dependency.mjs";\n', "utf8");
    await expect(runRuntimeSmokeCheck(root)).rejects.toThrow(`${bundle} failed its node_modules-free messaging startup check.`);
  });

  it.each(bundles)("rejects a wrong startup exit from %s", async bundle => {
    const { root } = await fixture();
    await writeFile(path.join(root, "mcp-server/dist", bundle), "process.exitCode = 7;\n", "utf8");
    await expect(runRuntimeSmokeCheck(root)).rejects.toThrow(`${bundle} failed its node_modules-free messaging startup check.`);
  });

  it("requires the CLI's invalid-input envelope instead of accepting any exit 1", async () => {
    const { root } = await fixture();
    await writeFile(path.join(root, "mcp-server/dist/session-message-cli.mjs"),
      'process.stdout.write(JSON.stringify({protocolVersion:"1.0.0",ok:true})); process.exitCode=1;\n', "utf8");
    await expect(runRuntimeSmokeCheck(root)).rejects.toThrow(/did not reject invalid messaging input/u);
  });

  it("rejects unexpected output from the hook's malformed-input path", async () => {
    const { root } = await fixture();
    await writeFile(path.join(root, "mcp-server/dist/session-message-hook.mjs"), 'process.stdout.write("unexpected");\n', "utf8");
    await expect(runRuntimeSmokeCheck(root)).rejects.toThrow(/emitted unexpected startup output/u);
  });

  it.each([
    ["empty bundle", ""],
    ["inactive entry guard", 'if (false) console.error("[agent-governance-suite] peer-hook-failure " + JSON.stringify({ phase: "input", reason: "INVALID_JSON" }));\n'],
  ])("rejects a hook with %s despite exit 0 and empty stdout", async (_name, source) => {
    const { root } = await fixture();
    await writeFile(path.join(root, "mcp-server/dist/session-message-hook.mjs"), source, "utf8");
    await expect(runRuntimeSmokeCheck(root)).rejects.toThrow(/did not emit its invalid-JSON input diagnostic/u);
  });

  it.each([
    { phase: "handle", reason: "INVALID_JSON" },
    { phase: "input", reason: "INVALID_HOOK_INPUT" },
  ])("rejects a different structured hook diagnostic: %j", async diagnostic => {
    const { root } = await fixture();
    const stderr = `[agent-governance-suite] peer-hook-failure ${JSON.stringify(diagnostic)}\n`;
    await writeFile(path.join(root, "mcp-server/dist/session-message-hook.mjs"),
      `process.stderr.write(${JSON.stringify(stderr)});\n`, "utf8");
    await expect(runRuntimeSmokeCheck(root)).rejects.toThrow(/did not emit its invalid-JSON input diagnostic/u);
  });

  it("requires the structured hook diagnostic instead of matching words in stderr", async () => {
    const { root } = await fixture();
    await writeFile(path.join(root, "mcp-server/dist/session-message-hook.mjs"),
      'console.error("input INVALID_JSON");\n', "utf8");
    await expect(runRuntimeSmokeCheck(root)).rejects.toThrow(/did not emit its invalid-JSON input diagnostic/u);
  });
});
