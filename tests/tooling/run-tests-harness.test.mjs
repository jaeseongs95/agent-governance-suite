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
  const code = `import {runTests} from ${JSON.stringify(runner)};try{process.exitCode=await runTests([],['ags-harness-command-that-does-not-exist']);}catch(cause){console.error(cause.code);process.exitCode=69;}`;
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
    class Scan:
        def __init__(self,name):self.name=name
        def __enter__(self):return self
        def __exit__(self,*args):pass
        def __next__(self):
            calls[0]+=1
            assert calls[0]<2000,'changing descendants monopolized cleanup'
            if mode=='deadline':clock[0]+=0.01
            return types.SimpleNamespace(path=self.name+'/changing-thread')
    m.os.scandir=Scan
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

it("H11 actual Python directory primitive stays lazy and closes partial, matched, and faulted iterators", () => {
  const python = findPython();
  const script = `
import importlib.util, inspect, json, os, pathlib, sys, tempfile
spec=importlib.util.spec_from_file_location('subreaper',sys.argv[1])
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
primitive=inspect.getsource(pathlib.Path.iterdir)
native_scan=os.scandir; native_listdir=os.listdir; native_clock=m.time.monotonic
native_ports={name:getattr(m.os,name,None) for name in ['getpid','pidfd_open','close']}
native_send=getattr(m.signal,'pidfd_send_signal',None)
traces=[]
with tempfile.TemporaryDirectory(prefix='native-scan-') as root:
    large=pathlib.Path(root)/'large'; large.mkdir()
    empty=pathlib.Path(root)/'empty'; empty.mkdir()
    for index in range(384):
        thread=large/str(index); thread.mkdir(); (thread/'children').write_text('20 ')
    for phase in ['work','deadline','exception','complete']:
        clock=[0.0]; calls=[0]; listdir_calls=[0]; scans=[]; opened=[]; closed=[]; signals=[]
        class NativeScan:
            def __init__(self,directory):
                self.native=native_scan(directory); self.closed=False; scans.append(self)
            def __enter__(self):return self
            def __iter__(self):return self
            def __next__(self):
                calls[0]+=1
                assert calls[0]<=80,'native iterator eagerly exceeded per-item work bound'
                if phase=='exception' and calls[0]==3:raise RuntimeError('controlled native iterator fault')
                entry=next(self.native)
                if phase=='deadline':clock[0]+=0.01
                return entry
            def __exit__(self,*args):
                self.native.close(); self.closed=True
                try:next(self.native)
                except StopIteration:pass
                else:raise AssertionError('actual native iterator failed to close')
        def scan(directory):
            target=large if str(directory)=='/proc/10/task' and phase!='complete' else empty
            return NativeScan(target)
        def eager(directory):
            listdir_calls[0]+=1
            raise AssertionError('actual Path.iterdir eagerly entered os.listdir before item budget')
        def close_fd(fd):
            closed.append(fd)
            assert all(item.closed for item in scans[1:]),'matched membership iterator not closed before pidfd close'
        m.os.scandir=scan; m.os.listdir=eager; m.os.getpid=lambda:10
        m.os.pidfd_open=lambda pid:opened.append(pid) or pid; m.os.close=close_fd
        m.time.monotonic=lambda:clock[0]
        m.signal.pidfd_send_signal=lambda fd,sig:signals.append(fd)
        fault=False
        try:
            try:result=m.signal_owned(m.signal.SIGTERM,0.08 if phase=='deadline' else 1000000)
            except RuntimeError as cause:
                assert phase=='exception' and str(cause)=='controlled native iterator fault'
                fault=True; result=None
            assert listdir_calls[0]==0,'eager listdir boundary used'
            assert scans and all(item.closed for item in scans),'native iterator leaked on partial/exception/complete'
            assert opened==closed,'pidfd leaked with native iterator fault'
            if phase=='complete':assert result is True
            elif phase=='exception':assert fault,'controlled native iterator exception not reached'
            else:
                assert result is False,'partial native scan cannot claim complete'
                assert 20 in signals,'owned membership must permit PID20 signal'
            if phase=='deadline':assert clock[0]<=0.09,'native iterator deadline ignored'
            traces.append({'phase':phase,'complete':result,'fault':fault,'items':calls[0],'clock':clock[0],
                'listdirCalls':listdir_calls[0],'iterators':len(scans),'allClosed':all(item.closed for item in scans),
                'opened':opened,'closed':closed,'signals':signals})
        finally:
            m.os.scandir=native_scan; m.os.listdir=native_listdir; m.time.monotonic=native_clock
            for name,value in native_ports.items():
                if value is None:delattr(m.os,name)
                else:setattr(m.os,name,value)
            if native_send is None:delattr(m.signal,'pidfd_send_signal')
            else:m.signal.pidfd_send_signal=native_send
print(json.dumps({'kernelExecution':False,'python':sys.version.split()[0],'PathIterdirSource':primitive,'traces':traces}))
`;
  const result = spawnSync(python.command, [...python.prefix, "-c", script, path.join(root, "scripts/test-subreaper.py")],
    { encoding: "utf8", timeout: 10_000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  const trace = JSON.parse(result.stdout);
  expect(trace.kernelExecution).toBe(false);
  expect(trace.traces).toHaveLength(4);
  for (const item of trace.traces) {
    expect(item.listdirCalls).toBe(0);
    expect(item.allClosed).toBe(true);
  }
});

const linklessProc = mode => {
  const python = findPython();
  const script = `
import contextlib, importlib.util, json, os, pathlib, sys, tempfile
spec=importlib.util.spec_from_file_location('subreaper',sys.argv[1])
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
mode=sys.argv[2]; real_path=pathlib.Path; real_scan=os.scandir; real_close=os.close
real_pid=os.getpid; native_open=getattr(os,'pidfd_open',None); native_send=getattr(m.signal,'pidfd_send_signal',None)
real_clock=m.time.monotonic; clock=[0.0]; unobserved=[True]; pending_fault=[False]
opened=[]; attempted=[]; closed=[]; signals=[]; reads=[]; scans=[]; advances=[0]; faults=[0]
with tempfile.TemporaryDirectory(prefix='linkless-proc-') as base:
    base=real_path(base); foreign=base/'foreign'; owned=base/'owned'; task=base/'task'
    for directory in (foreign,owned,task):directory.mkdir()
    (task/'thread').mkdir() # deliberately no optional children file
    def status(directory,pid,ppid):
        folder=directory/str(pid); folder.mkdir(exist_ok=True)
        (folder/'status').write_text('Name: ignored\\nPid: '+str(pid)+'\\nPPid: '+str(ppid)+'\\n')
    for pid in range(1000,1384 if mode=='progress' else 1002):status(foreign,pid,1)
    for pid,ppid in [(20,10),(21,20),(22,20),(23,20),(99999,10)]:status(owned,pid,ppid)
    class Scan:
        def __init__(self,directory):
            self.parts=[real_scan(foreign),real_scan(owned)] if directory=='/proc' else [real_scan(task)]
            self.index=0; self.closed=False; scans.append(self)
        def __enter__(self):return self
        def __exit__(self,*args):self.close()
        def __next__(self):
            while self.index<len(self.parts):
                try:
                    entry=next(self.parts[self.index]); advances[0]+=1
                    if mode=='fault' and faults[0]==0 and advances[0]==2:
                        faults[0]+=1; raise OSError('controlled transient iterator fault')
                    return entry
                except StopIteration:self.index+=1
            raise StopIteration
        def close(self):
            for part in self.parts:part.close()
            self.closed=True
    def path(value):
        value=str(value)
        if not value.startswith('/proc/'):return real_path(value)
        assert value.endswith('/status'),'unexpected private process data access'
        pid=int(value.split('/')[2]); reads.append(pid)
        folder=(owned if pid in [20,21,22,23,99999] else foreign)/str(pid)
        if pid==20 and ((mode=='unknown' and unobserved[0]) or (mode=='fdunknown' and 20 in opened)):
            raise PermissionError('controlled ownership unknown')
        if mode=='progress' and pid==99999 and not pending_fault[0]:
            pending_fault[0]=True; clock[0]+=6 # deadline after cursor consumption, before ownership read
        return folder/'status'
    def acquire(pid):
        attempted.append(pid)
        if pid==23:raise ProcessLookupError('controlled already exited PID')
        opened.append(pid)
        if pid==22:status(owned,22,1) # ownership withdrawn after pidfd_open
        return pid
    m.Path=path; m.os.scandir=Scan; m.os.getpid=lambda:10
    m.os.pidfd_open=acquire; m.os.close=lambda fd:closed.append(fd)
    m.time.monotonic=lambda:clock[0]
    m.signal.pidfd_send_signal=lambda fd,sig:signals.append(fd)
    try:
        with contextlib.closing(m.ProcScan((20,23))) as state:
            results=[]
            for _ in range(80):
                complete=m.signal_owned(m.signal.SIGTERM,m.time.monotonic()+5,state);results.append(complete)
                if mode=='progress':assert sum(len(scan.parts)==2 for scan in scans)==1,'partial batches restarted global prefix'
                if complete:break
                if mode in ['unknown','fdunknown'] and state.iterator is None:break
            assert signals or mode in ['unknown','fdunknown'],'missing children was treated as empty ownership'
            recovered=None; initial_signals=signals[:]
            if mode in ['unknown','fdunknown']:
                assert not any(results),'unknown ownership was falsely complete'
                assert 20 not in signals,'unobserved known PID signalled'
                if mode=='fdunknown':assert 20 in opened and 20 in closed,'post-open unknown ownership leaked fd'
                if mode=='unknown':
                    unobserved[0]=False
                    recovered=m.signal_owned(m.signal.SIGTERM,m.time.monotonic()+5,state)
                    assert recovered is True and 20 in signals,'new scan cycle retained stale unknown result'
            else:
                assert results[-1] is True,'lazy fallback did not complete with supported metadata'
                assert signals[0]==20,'known main PID starved behind unrelated prefix'
                assert 21 in signals and 99999 in signals,'owned descendant not found after partial batches'
                assert 22 not in signals and 23 not in signals,'changed or exited PID signalled'
                assert not any(pid>=1000 and pid<2200 for pid in signals),'foreign PID signalled'
            # An exited PID has no descriptor; all successfully acquired fd close.
            assert opened==closed,'pidfd leaked'
            if mode not in ['unknown','fdunknown']:assert 23 in attempted and 23 not in opened,'known exited PID acquired a descriptor'
            global_scans=sum(len(scan.parts)==2 for scan in scans)
            if mode=='progress':
                assert len(results)>1 and False in results,'large prefix not exercised'
                assert global_scans==1,'partial batches restarted global prefix'
                assert advances[0]>=389,'native lazy prefix did not progress'
                assert pending_fault[0] and reads.count(99999)>=2,'deadline-consumed PID was not retried'
            if mode=='fault':assert faults[0]==1 and global_scans==2,'transient fault cursor was not closed/recovered'
        assert all(scan.closed for scan in scans),'partial/fault cursor leaked'
        main_exit=None
        if mode=='fdunknown':
            import types
            handlers={}; waits=[0]
            m.sys.platform='linux'; m.sys.argv=['subreaper','controlled-no-process']
            m.ctypes.CDLL=lambda *args,**kwargs:types.SimpleNamespace(prctl=lambda *args:0)
            m.subprocess.Popen=lambda argv:types.SimpleNamespace(pid=20,returncode=None)
            m.os.WNOHANG=1; m.signal.SIGKILL=9
            m.signal.signal=lambda sig,handler:handlers.update({sig:handler})
            def wait(*args):
                waits[0]+=1; clock[0]+=0.05
                assert waits[0]<300,'unknown ownership ignored cleanup deadline'
                if waits[0]==2:handlers[m.signal.SIGTERM](m.signal.SIGTERM,None)
                return (0,0)
            m.os.waitpid=wait; m.time.sleep=lambda seconds:clock.__setitem__(0,clock[0]+seconds)
            with contextlib.redirect_stderr(__import__('io').StringIO()) as captured:main_exit=m.main()
            main_receipt=json.loads(captured.getvalue())
            assert main_exit==70 and main_receipt['remainingChildren'] is True,'unknown active child falsely completed'
            assert main_receipt['cancelled'] is True and all(scan.closed for scan in scans),'cancel cursor close failed'
            assert opened==closed,'main unknown path leaked fd'
        print(json.dumps({'mode':mode,'kernelExecution':False,'results':results,'recovered':recovered,
            'mainExit':main_exit,
            'initialSignals':initial_signals,'pendingDeadlineRetried':pending_fault[0],'advances':advances[0],
            'globalScans':global_scans,'signals':signals,'pidfdAttempts':attempted,'opened':opened,'closed':closed,'allIteratorsClosed':True}))
    finally:
        m.os.scandir=real_scan; m.os.close=real_close; m.os.getpid=real_pid; m.time.monotonic=real_clock
        if native_open is None:delattr(m.os,'pidfd_open')
        else:m.os.pidfd_open=native_open
        if native_send is None:delattr(m.signal,'pidfd_send_signal')
        else:m.signal.pidfd_send_signal=native_send
`;
  const result = spawnSync(python.command, [...python.prefix, "-c", script, path.join(root, "scripts/test-subreaper.py"), mode],
    { encoding: "utf8", timeout: 10_000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
};

it("H12 missing child links use live ancestry and never signal withdrawn, exited, or foreign PIDs", () => {
  expect(linklessProc("linkless").allIteratorsClosed).toBe(true);
});

it("H13 persistent native cursor progresses beyond a large unrelated prefix without starving the known runner", () => {
  const trace = linklessProc("progress");
  expect(trace.globalScans).toBe(1);
  expect(trace.results.at(-1)).toBe(true);
});

it("H14 unknown ownership remains partial and transient iterator fault closes before recovery", () => {
  const unknown = linklessProc("unknown");
  expect(unknown.results.every(value => value === false)).toBe(true);
  expect(unknown.recovered).toBe(true);
  expect(linklessProc("fdunknown").results.every(value => value === false)).toBe(true);
  expect(linklessProc("fault").allIteratorsClosed).toBe(true);
});
