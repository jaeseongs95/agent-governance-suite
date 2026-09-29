#!/usr/bin/env python3
"""Run in a disposable fd3f486a worktree. Writer mutants M1-M6 (same edits as the writer's harness) plus auditor mutants A1-A11.
Each mutant runs utf8-framing.test.ts and the rest of tests/session-messaging. Usage: mutants.py <log-dir>."""
import pathlib, subprocess, sys
proto = pathlib.Path("mcp-server/src/session-message-protocol.ts")
client = pathlib.Path("mcp-server/src/session-message-client.ts")
broker = pathlib.Path("mcp-server/src/session-message-broker.ts")
RANGE = 'throw new RangeError("The session message line exceeds its limit.")'
BODY = '''  let pending = Buffer.alloc(0);
  return (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    const newline = pending.indexOf(0x0a);
    if ((newline < 0 ? pending.length : newline + 1) > limitBytes) ''' + RANGE + ''';
    if (newline < 0) return null;
    const line = pending.toString("utf8", 0, newline);
    pending = Buffer.alloc(0);
    return line;
  };'''
def body(new): return [(proto, BODY, new)]
MUTANTS = {
  "BASELINE": [],
  # Writer mutants, copied from the writer harness.
  "M1-per-chunk-decode": body('''  let text = "";
  return (chunk) => {
    text += chunk.toString("utf8");
    const newline = text.indexOf("\\n");
    if (Buffer.byteLength(newline < 0 ? text : text.slice(0, newline + 1), "utf8") > limitBytes) ''' + RANGE + ''';
    if (newline < 0) return null;
    const line = text.slice(0, newline);
    text = "";
    return line;
  };'''),
  "M2a-count-decoded-buffer": [(proto, '(newline < 0 ? pending.length : newline + 1) > limitBytes',
     'Buffer.byteLength(pending.toString("utf8", 0, newline < 0 ? pending.length : newline + 1), "utf8") > limitBytes')],
  "M2b-count-decoded-chunks": body('''  let pending = Buffer.alloc(0);
  let counted = 0;
  return (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    counted += Buffer.byteLength(chunk.toString("utf8"), "utf8");
    const newline = pending.indexOf(0x0a);
    if (counted > limitBytes) ''' + RANGE + ''';
    if (newline < 0) return null;
    const line = pending.toString("utf8", 0, newline);
    pending = Buffer.alloc(0);
    counted = 0;
    return line;
  };'''),
  "M3-limit-ge": [(proto, 'newline + 1) > limitBytes', 'newline + 1) >= limitBytes')],
  "M4-newline-excluded": [(proto, 'newline < 0 ? pending.length : newline + 1', 'newline < 0 ? pending.length : newline')],
  "M5-broker-old-reader": "broker",
  "M6-client-old-reader": "client",
  # Auditor mutants.
  "A1-pending-not-cleared-after-line": [(proto, '    pending = Buffer.alloc(0);\n    return line;', '    return line;')],
  "A2-limit-checked-only-after-newline": [(proto, '''    if ((newline < 0 ? pending.length : newline + 1) > limitBytes) ''' + RANGE + ''';
    if (newline < 0) return null;''', '''    if (newline < 0) return null;
    if (newline + 1 > limitBytes) ''' + RANGE + ''';''')],
  "A3-per-chunk-toString-raw-count": body('''  let pending = Buffer.alloc(0);
  let text = "";
  return (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    text += chunk.toString("utf8");
    const newline = pending.indexOf(0x0a);
    if ((newline < 0 ? pending.length : newline + 1) > limitBytes) ''' + RANGE + ''';
    if (newline < 0) return null;
    const line = text.slice(0, text.indexOf("\\n"));
    pending = Buffer.alloc(0); text = "";
    return line;
  };'''),
  "A4-newline-found-in-decoded-string": body('''  let pending = Buffer.alloc(0);
  return (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    const text = pending.toString("utf8");
    const newline = text.indexOf("\\n");
    if ((newline < 0 ? pending.length : Buffer.byteLength(text.slice(0, newline + 1), "utf8")) > limitBytes) ''' + RANGE + ''';
    if (newline < 0) return null;
    const line = text.slice(0, newline);
    pending = Buffer.alloc(0);
    return line;
  };'''),
  "A5-keep-bytes-after-line": [(proto, '    pending = Buffer.alloc(0);\n    return line;', '    pending = pending.subarray(newline + 1);\n    return line;')],
  "A6-count-bytes-after-line-too": [(proto, '(newline < 0 ? pending.length : newline + 1) > limitBytes', 'pending.length > limitBytes')],
  "A7-never-reject": [(proto, 'limitBytes) ' + RANGE + ';', 'limitBytes) return null;')],
  "A8-limit-plus-one": [(proto, 'newline + 1) > limitBytes', 'newline + 1) > limitBytes + 1')],
  "A9-broker-destroys-instead-of-refusal": [(broker, 'socket.end(`${JSON.stringify({ ok: false, error: "Request exceeds the broker limit." })}\\n`);\n          return;', 'socket.destroy();\n          return;')],
  "A10-client-limit-as-rejection": [(client, 'return finish(new Error("The broker response exceeded its limit."));', 'return finish(new BrokerRequestRejected("The broker response exceeded its limit."));')],
  "A11-client-reads-with-request-limit-halved": [(client, 'sessionMessageLineReader(SESSION_MESSAGE_MAX_RESPONSE_BYTES)', 'sessionMessageLineReader(SESSION_MESSAGE_MAX_RESPONSE_BYTES / 2)')],
}
TESTS = ["tests/session-messaging/"]
logs = pathlib.Path(sys.argv[1]); logs.mkdir(parents=True, exist_ok=True)
def git_show(path): return subprocess.run(["git", "show", "9e76a07b:" + str(path)], capture_output=True, text=True, check=True).stdout
originals = {p: p.read_text(encoding="utf-8") for p in (proto, client, broker)}
try:
    for name, spec in MUTANTS.items():
        for p, t in originals.items(): p.write_text(t, encoding="utf-8")
        if spec == "broker": broker.write_text(git_show(broker), encoding="utf-8")
        elif spec == "client": client.write_text(git_show(client), encoding="utf-8")
        else:
            for path, old, new in spec:
                text = path.read_text(encoding="utf-8"); assert text.count(old) == 1, (name, old[:80]); path.write_text(text.replace(old, new), encoding="utf-8")
        run = subprocess.run(["pnpm", "exec", "vitest", "run", "--reporter=verbose", *TESTS], capture_output=True, text=True, timeout=900)
        out = run.stdout + run.stderr
        (logs / f"mutant-{name}.log").write_text(out, encoding="utf-8")
        failed = [l.strip()[2:] for l in run.stdout.splitlines() if l.strip().startswith("× ")]
        utf8 = sum(1 for f in failed if "utf8-framing" in f)
        verdict = ("PASS" if run.returncode == 0 else "FAIL") if name == "BASELINE" else ("KILLED" if run.returncode != 0 else "SURVIVED")
        print(f"{name}\t{verdict}\trc={run.returncode}\tfailed={len(failed)}\tutf8-framing={utf8}\t" + " | ".join(f.split(" > ", 1)[-1][:70] for f in failed[:4]), flush=True)
finally:
    for p, t in originals.items(): p.write_text(t, encoding="utf-8")
