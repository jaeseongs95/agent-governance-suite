import { spawnSync } from "node:child_process";

export function findPython() {
  const candidates = process.env.PYTHON
    ? [[process.env.PYTHON, []]]
    : process.platform === "win32"
      ? [["python", []], ["py", ["-3"]], ["python3", []]]
      : [["python3", []], ["python", []]];

  for (const [command, prefix] of candidates) {
    const probe = spawnSync(command, [...prefix, "--version"], { encoding: "utf8" });
    if (probe.status === 0 && /Python\s+3\./u.test(`${probe.stdout}${probe.stderr}`)) {
      return { command, prefix };
    }
  }
  throw new Error("Python 3 was not found. Set PYTHON to an executable path.");
}

export function runPython(python, script, arguments_ = []) {
  const result = spawnSync(python.command, [...python.prefix, script, ...arguments_], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, PYTHONUTF8: "1" }
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) {
    if (result.error) throw result.error;
    throw new Error(`${script} exited with ${result.status ?? "no status"}`);
  }
}
