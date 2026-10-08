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

// Controlled Python exercises the actual source's scheduler on every platform.
// Only kernel/clock/process ports are fake; this is not a Linux reap receipt.
const controlledCleanup = mode => {
  const python = findPython();
  const script = `
import contextlib, importlib.util, io, json, sys, types
spec=importlib.util.spec_from_file_location('subreaper',sys.argv[1])
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
mode=sys.argv[2]; clock=[0.0]; calls=[0]; signals=[]; opened=[]; closed=[]
m.os.getpid=lambda:10
m.os.pidfd_open=lambda pid: opened.append(pid) or pid
m.os.close=lambda fd:closed.append(fd)
m.time.monotonic=lambda:clock[0]
m.signal.pidfd_send_signal=lambda fd,sig:signals.append((fd,sig,clock[0]))
if mode=='drain':
    handlers={}; m.signal.signal=lambda sig,handler:handlers.update({sig:handler})
    m.sys.platform='linux'; m.sys.argv=['subreaper','controlled-no-process']
    m.ctypes.CDLL=lambda *a,**k:types.SimpleNamespace(prctl=lambda *a:0)
    m.subprocess.Popen=lambda argv:types.SimpleNamespace(pid=20,returncode=None)
    m.os.WNOHANG=1; m.signal.SIGKILL=9
    def wait(*args):
        calls[0]+=1; clock[0]+=0.01
        assert calls[0]<2000,'wait-ready stream monopolized cancellation/deadline'
        if calls[0]==2:handlers[m.signal.SIGTERM](m.signal.SIGTERM,None)
        return (1000+calls[0],0)
    m.os.waitpid=wait
    m.time.sleep=lambda seconds:clock.__setitem__(0,clock[0]+seconds)
    def send(sig,*args):signals.append((10,sig,clock[0]));return True
    m.signal_owned=send
    with contextlib.redirect_stderr(io.StringIO()) as captured:result=m.main()
    receipt=json.loads(captured.getvalue())
    assert receipt['remainingChildren'] is True and receipt['cancelled'] is True,'unreaped state lost'
    assert result==70,'unreaped wait-ready stream must fail closed'
    assert clock[0]<=5.15,'cleanup deadline exceeded'
    assert any(sig==m.signal.SIGTERM and t<0.5 for _,sig,t in signals),'TERM delayed by drain'
    assert any(sig==9 and 3<=t<=3.5 for _,sig,t in signals),'KILL delayed by drain'
    print(json.dumps({'mode':mode,'exit':result,'calls':calls[0],'clock':clock[0],'signals':signals}))
else:
    class Proc:
        def __init__(self,name):self.name=name
        def __truediv__(self,part):return Proc(self.name+'/'+part)
        def iterdir(self):
            while True:
                calls[0]+=1
                assert calls[0]<2000,'changing descendants monopolized cleanup'
                if mode=='deadline':clock[0]+=0.01
                yield Proc(self.name+'/changing-thread')
        def open(self):
            if mode=='deadline':clock[0]+=0.01
            class Stream(io.StringIO):
                def read(self,size=-1):
                    calls[0]+=1
                    assert calls[0]<2000,'descendant reads exceeded finite work'
                    assert 0<size<=4096,'unbounded proc read'
                    return super().read(size)
            return Stream(' '.join(str(pid) for pid in range(20,20020)
                if not(mode=='work' and pid==21 and 21 in opened))+' ')
    m.Path=Proc
    deadline=0.25 if mode=='deadline' else 1000000
    result=m.signal_owned(m.signal.SIGTERM,deadline)
    assert result is False,'partial traversal must return control, not claim complete'
    assert calls[0]<300,'finite work bound exceeded'
    assert set(opened)==set(closed),'pidfd leaked at budget/deadline boundary'
    assert all(fd>=20 for fd,_,_ in signals),'unowned pid signalled'
    if mode=='deadline':assert clock[0]<=0.27,'traversal/recheck exceeded deadline'
    else:
        assert any(fd==20 for fd,_,_ in signals),'owned PID20 must be signalled before yielding'
        assert 21 in opened and 21 in closed,'ownership change must close acquired PID21 fd'
        assert all(fd!=21 for fd,_,_ in signals),'no signal after PID21 leaves owned descendants'
    print(json.dumps({'mode':mode,'complete':result,'calls':calls[0],'clock':clock[0],'signals':signals,'opened':opened,'closed':closed}))
`;
  const result = spawnSync(python.command, [...python.prefix, "-c", script, path.join(root, "scripts/test-subreaper.py"), mode],
    { encoding: "utf8", timeout: 10_000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  const trace = JSON.parse(result.stdout.trim());
  console.log(JSON.stringify({ kind: "controlled-python-subreaper", kernelExecution: false, trace }));
  return trace;
};

it("H08 controlled wait-ready stream reaches cancellation and deadline without false PASS", () => {
  const result = controlledCleanup("drain");
  expect(result.exit).toBe(70);
  expect(result.calls).toBeLessThan(520);
});

it("H09 controlled large changing descendants yield after finite work and close every pidfd", () => {
  const result = controlledCleanup("work");
  expect(result.complete).toBe(false);
  expect(result.calls).toBeLessThan(300);
});

it("H10 controlled descendant traversal and ownership recheck honor cleanup deadline", () => {
  const result = controlledCleanup("deadline");
  expect(result.complete).toBe(false);
  expect(result.clock).toBeLessThanOrEqual(0.27);
});
