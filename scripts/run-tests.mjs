import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { findPython } from "./python-runner.mjs";

const root = path.resolve(import.meta.dirname, "..");

// Git discovery in the product walks parents itself; Git environment fences
// do not isolate fixtures. Validate the physical parent before allocating.
export function createTestTempRoot() {
  const candidates = [tmpdir(), ...(process.platform === "win32"
    ? [path.join(homedir(), "AppData", "Local", "Temp")]
    : ["/tmp", "/var/tmp", "/dev/shm"])];
  for (const candidate of new Set(candidates)) {
    if (!existsSync(candidate)) continue;
    let current = realpathSync(candidate);
    let gitAncestor = false;
    while (true) {
      if (existsSync(path.join(current, ".git"))) { gitAncestor = true; break; }
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
    if (gitAncestor) continue;
    try { return mkdtempSync(path.join(realpathSync(candidate), "ags-tests-")); }
    catch (cause) {
      if (!["EACCES", "EPERM", "EROFS"].includes(cause.code)) throw cause;
    }
  }
  throw new Error("No writable Git-free test temp parent was found.");
}

// The command argument also lets the regression exercise this public process
// boundary without recursively starting Vitest. The CLI always invokes Vitest.
export async function runTests(arguments_, command = [process.execPath, path.join(root, "node_modules/vitest/vitest.mjs"), "run"]) {
  const directory = createTestTempRoot();
  const env = { ...process.env, TEMP: directory, TMP: directory, TMPDIR: directory };
  try {
    let executable = command[0];
    let args = [...command.slice(1), ...arguments_];
    if (process.platform === "linux") {
      const python = findPython();
      args = [...python.prefix, path.join(import.meta.dirname, "test-subreaper.py"), executable, ...args];
      executable = python.command;
    }
    const child = spawn(executable, args, { cwd: root, env, stdio: "inherit", shell: false });
    const forward = signal => { if (child.exitCode === null) child.kill(signal); };
    const onInt = () => forward("SIGINT");
    const onTerm = () => forward("SIGTERM");
    process.on("SIGINT", onInt);
    process.on("SIGTERM", onTerm);
    try {
      return await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => resolve(code ?? (signal === "SIGINT" ? 130 : 143)));
      });
    } finally {
      process.off("SIGINT", onInt);
      process.off("SIGTERM", onTerm);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { process.exitCode = await runTests(process.argv.slice(2)); }
  catch (cause) { console.error(cause); process.exitCode = 1; }
}
