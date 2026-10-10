import {describe, it, expect} from "vitest";
import {spawn} from "node:child_process";
import path from "node:path";
import {mkdir, mkdtemp, writeFile} from "node:fs/promises";

describe("schema3 prepared bootstrap local physical run boundary", () => {
  it("offline preparation/issuer/authority/durable claim/IPC process regression", async () => {
    const repo = path.resolve(import.meta.dirname, "../../..");
    const directory = path.join(repo, "tests/skill-classification/live-bootstrap");
    const environment: NodeJS.ProcessEnv = {};
    for (const name of ["PATH", "Path", "SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR", "AGS_BOOTSTRAP_TEST_EVIDENCE_DIR"]) {
      if (process.env[name]) environment[name] = process.env[name];
    }
    const child = spawn(process.execPath, ["--import", "tsx",
      path.join(directory, "prepared-regression.mts"), repo, path.join(directory, "bootstrap.mts")],
      {cwd: repo, env: environment, stdio: ["ignore", "pipe", "pipe"], shell: false, windowsHide: true});
    let stdout = "", stderr = "";
    child.stdout.on("data", bytes => {stdout += String(bytes);});
    child.stderr.on("data", bytes => {stderr += String(bytes);});
    const timer = setTimeout(() => child.kill(), 240000);
    try {
      const result = await new Promise<{code: number | null; signal: NodeJS.Signals | null}>((resolve, reject) => {
        child.once("error", reject); child.once("close", (code, signal) => resolve({code, signal}));
      });
      if (process.env.AGS_BOOTSTRAP_TEST_EVIDENCE_DIR) {
        const evidence = path.resolve(process.env.AGS_BOOTSTRAP_TEST_EVIDENCE_DIR);
        await mkdir(evidence, {recursive: true});
        const run = await mkdtemp(path.join(evidence, "prepared-program-"));
        await writeFile(path.join(run, "stdout.log"), stdout, {flag: "wx"});
        await writeFile(path.join(run, "stderr.log"), stderr, {flag: "wx"});
        await writeFile(path.join(run, "exit.json"), JSON.stringify(result) + "\n", {flag: "wx"});
      }
      expect(result.code, (stderr || stdout).slice(-6000)).toBe(0);
      expect(result.signal).toBe(null);
      const observed = JSON.parse(stdout);
      expect(observed.status).toBe("OFFLINE_PREPARED_REGRESSION_PASS");
      expect(observed.actualApiCalls).toBe(0);
      expect(observed.globalAccountCrossRunAtomicity).toBe("UNSUPPORTED");
      expect(observed.scope).toBe("same-local-physical-run-output-only");
      expect(observed.checks.length).toBe(43);
      console.info(JSON.stringify(observed));
    } finally {clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill();}
  }, 260000);
});
