import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { findPython } from "../../scripts/python-runner.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const runner = pathToFileURL(path.join(root, "scripts/run-tests.mjs")).href;
const owned = [];
afterEach(() => { for (const directory of owned.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const probe = `console.log(JSON.stringify({temp:require('node:os').tmpdir(),vars:[process.env.TEMP,process.env.TMP,process.env.TMPDIR],cwd:process.cwd(),args:process.argv.slice(1),marker:process.env.AGS_HARNESS_MARKER}));console.error('child-stderr');process.exitCode=23`;
const launch = (body, args = [], env = process.env) => spawnSync(process.execPath,
  ["--input-type=module", "-e", `import {runTests} from ${JSON.stringify(runner)};process.exitCode=await runTests(${JSON.stringify(args)},[process.execPath,'-e',${JSON.stringify(body)}]);`],
  { env, encoding: "utf8", timeout: 20_000 });
const childData = result => JSON.parse(result.stdout.trim().split("\n")[0]);

it("H01 rejects inherited Git ancestors and preserves parent environment", () => {
  const ancestor = mkdtempSync(path.join(tmpdir(), "harness-git-")); owned.push(ancestor);
  mkdirSync(path.join(ancestor, ".git"));
  const nested = path.join(ancestor, "nested"); mkdirSync(nested);
  const env = { ...process.env, TEMP: nested, TMP: nested, TMPDIR: nested, AGS_HARNESS_MARKER: "preserved" };
  const before = { ...env };
  const result = launch(probe, [], env);
  expect(result.status, result.stderr).toBe(23);
  const data = childData(result);
  expect(path.relative(ancestor, data.temp).startsWith("..") || path.isAbsolute(path.relative(ancestor, data.temp))).toBe(true);
  let current = data.temp;
  while (true) {
    expect(existsSync(path.join(current, ".git"))).toBe(false);
    const parent = path.dirname(current); if (parent === current) break; current = parent;
  }
  expect(data.vars).toEqual([data.temp, data.temp, data.temp]);
  expect(data.marker).toBe("preserved");
  expect(env).toEqual(before);
  expect(existsSync(data.temp)).toBe(false);
});

it("H02 forwards exact arguments, cwd, streams, and a nonzero exit without retry", () => {
  const result = launch(probe, ["spaces retained", "$(never-executed)", "--flag"]);
  expect(result.status, result.stderr).toBe(23);
  expect(result.stdout.trim().split("\n")).toHaveLength(1);
  expect(result.stderr).toContain("child-stderr");
  const data = childData(result);
  expect(data.args).toEqual(["spaces retained", "$(never-executed)", "--flag"]);
  expect(data.cwd).toBe(root);
  expect(existsSync(data.temp)).toBe(false);
});

it("H03 does not mutate the runner process environment", () => {
  const code = `import {runTests} from ${JSON.stringify(runner)};const before=[process.env.TEMP,process.env.TMP,process.env.TMPDIR];await runTests([],[process.execPath,'-e','process.exitCode=0']);console.log(JSON.stringify({before,after:[process.env.TEMP,process.env.TMP,process.env.TMPDIR]}));`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8", timeout: 20_000 });
  expect(result.status, result.stderr).toBe(0);
  const data = childData(result);
  expect(data.after).toEqual(data.before);
});

it("H04 concurrent invocations have distinct owned temp roots", async () => {
  const run = () => new Promise((resolve, reject) => {
    const code = `import {runTests} from ${JSON.stringify(runner)};process.exitCode=await runTests([],[process.execPath,'-e',${JSON.stringify(probe)}]);`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", code]);
    let stdout = ""; let stderr = "";
    child.stdout.on("data", bytes => { stdout += bytes; }); child.stderr.on("data", bytes => { stderr += bytes; });
    child.once("error", reject); child.once("close", status => resolve({ status, stdout, stderr }));
  });
  const results = await Promise.all([run(), run()]);
  for (const result of results) expect(result.status, result.stderr).toBe(23);
  const roots = results.map(result => childData(result).temp);
  expect(new Set(roots).size).toBe(2);
  for (const directory of roots) expect(existsSync(directory)).toBe(false);
});

it("H05 propagates spawn failure without rerunning a command", () => {
  const code = `import {runTests} from ${JSON.stringify(runner)};try{await runTests([],['ags-harness-command-that-does-not-exist']);}catch(cause){console.error(cause.code);process.exitCode=69;}`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8", timeout: 20_000 });
  expect(result.status).toBe(process.platform === "linux" ? 1 : 69);
  expect(result.stderr).toContain(process.platform === "linux" ? "FileNotFoundError" : "ENOENT");
});

it.skipIf(process.platform !== "linux")("H06 reaps an adopted orphan while original kill(pid,0) observes actual disappearance", () => {
  const orphan = "setTimeout(()=>process.exit(0),100)";
  const intermediate = `const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e',${JSON.stringify(orphan)}],{detached:true,stdio:'ignore'});console.log(child.pid);child.unref();`;
  const main = `const {spawnSync}=require('node:child_process');const pid=Number(spawnSync(process.execPath,['-e',${JSON.stringify(intermediate)}],{encoding:'utf8'}).stdout.trim());const until=performance.now()+3000;const timer=setInterval(()=>{try{process.kill(pid,0);}catch(cause){if(cause.code==='ESRCH'){clearInterval(timer);console.log(JSON.stringify({pid,gone:true}));return;}throw cause;}if(performance.now()>until){clearInterval(timer);console.error('orphan PID still exists');process.exitCode=7;}},20);`;
  const result = launch(main);
  expect(result.status, result.stderr).toBe(0);
  const data = childData(result);
  expect(data.gone).toBe(true);
  const receipt = JSON.parse(result.stderr.trim().split("\n").at(-1));
  expect(receipt.reapedPids).toContain(data.pid);
  expect(receipt.remainingChildren).toBe(false);
  expect(() => process.kill(data.pid, 0)).toThrow();
});

it.skipIf(process.platform !== "linux")("H07 cancellation drains only owned descendants and leaves an independent sentinel alive", async () => {
  const python = findPython();
  const sentinel = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
  const sentinelExit = new Promise(resolve => sentinel.once("close", resolve));
  try {
    const main = "console.log(process.pid);setInterval(()=>{},1000)";
    const child = spawn(python.command, [...python.prefix, path.join(root, "scripts/test-subreaper.py"), process.execPath, "-e", main]);
    let stderr = ""; child.stderr.on("data", bytes => { stderr += bytes; });
    const done = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", status => resolve(status)); });
    const pid = await new Promise((resolve, reject) => { child.stdout.once("data", bytes => resolve(Number(bytes.toString().trim()))); child.once("error", reject); });
    child.kill("SIGTERM");
    expect(await done, stderr).toBe(143);
    const receipt = JSON.parse(stderr.trim().split("\n").at(-1));
    expect(receipt.reapedPids).toContain(pid);
    expect(receipt.remainingChildren).toBe(false);
    expect(() => process.kill(pid, 0)).toThrow();
    expect(() => process.kill(sentinel.pid, 0)).not.toThrow();
  } finally { sentinel.kill(); await sentinelExit; }
});
