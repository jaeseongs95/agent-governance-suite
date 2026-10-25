import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
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

/** Node-native suites are intentionally separate from Vitest discovery. */
export function listNodeTestFiles(directory = path.join(root, "tests")) {
  const files = [];
  const pending = [directory];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      // Do not cross directory links/junctions or collect linked files.
      if (entry.isSymbolicLink()) continue;
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(entryPath);
      else if (entry.isFile() && entry.name.endsWith(".node-test.mjs")) files.push(entryPath);
    }
  }
  return files.sort();
}

// The command argument also lets the regression exercise this public process
// boundary without recursively starting Vitest. The CLI always invokes Vitest.
export async function runTests(arguments_, command = [process.execPath, path.join(root, "node_modules/vitest/vitest.mjs"), "run"]) {
  const directory = createTestTempRoot();
  const env = { ...process.env, TEMP: directory, TMP: directory, TMPDIR: directory };
  let failure = null;
  let cleanupFailure = null;
  let childExitCode = null;
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
      childExitCode = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => resolve(code ?? (signal === "SIGINT" ? 130 : 143)));
      });
    } finally {
      process.off("SIGINT", onInt);
      process.off("SIGTERM", onTerm);
    }
  } catch (cause) {
    failure = { error: cause };
  } finally {
    try { rmSync(directory, { recursive: true, force: true }); }
    catch (cleanup) {
      cleanupFailure = { error: cleanup };
    }
  }
  if (cleanupFailure) {
    const cleanup = cleanupFailure.error;
    if (failure) {
      // A real dual failure changes only this exceptional path to a standard, public container.
      throw new AggregateError([failure.error, cleanup], "Test execution and temporary cleanup both failed.", { cause: failure.error });
    } else if (childExitCode !== null && childExitCode !== 0) {
      // Keep the existing failed numeric outcome; cleanup remains a separate failure.
      console.error(JSON.stringify({ component: "test-runner", phase: "cleanup",
        reason: "RUNNER_CLEANUP_FAILED", childExitCode }));
      console.error(cleanup);
    } else throw Object.assign(new Error("Test temporary cleanup failed.", { cause: cleanup }),
      { code: "RUNNER_CLEANUP_FAILED" });
  }
  if (failure) throw failure.error;
  return childExitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  let phase = "vitest";
  let reason = "RUNNER_UNAVAILABLE";
  try {
    process.exitCode = await runTests(process.argv.slice(2));
    if (process.exitCode === 0) {
      phase = "node-collection";
      const files = listNodeTestFiles();
      console.log(JSON.stringify({ runner: "node:test", fileCount: files.length, files }));
      if (files.length === 0) {
        reason = "NODE_TEST_COLLECTION_EMPTY";
        throw new Error("No node:test suites were collected.");
      }
      phase = "node-run";
      process.exitCode = await runTests(files, [process.execPath, "--test"]);
    }
  } catch (cause) {
    const dual = cause instanceof AggregateError && cause.errors.length === 2 && cause.cause === cause.errors[0];
    const primary = dual ? cause.errors[0] : cause;
    if (primary?.code === "RUNNER_CLEANUP_FAILED") { phase = "cleanup"; reason = "RUNNER_CLEANUP_FAILED"; }
    console.error(JSON.stringify({ component: "test-runner", phase, reason }));
    // Native Error diagnostics keep the original public code, syscall and actionable message.
    console.error(primary);
    if (dual) {
      console.error(JSON.stringify({ component: "test-runner", phase: "cleanup", reason: "RUNNER_CLEANUP_FAILED" }));
      console.error(cause.errors[1]);
    }
    process.exitCode = 1;
  }
}
