import subprocess, sys, pathlib, os
root = pathlib.Path('/home/[REDACTED]/agent-governance-suite')
proto = root/'mcp-server/src/session-message-protocol.ts'
client = root/'mcp-server/src/session-message-client.ts'
broker = root/'mcp-server/src/session-message-broker.ts'
logs = pathlib.Path(sys.argv[1])
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
def body(new):
    return lambda: [(proto, BODY, new)]
mutants = {
  'M1-per-chunk-decode': body('''  let text = "";
  return (chunk) => {
    text += chunk.toString("utf8");
    const newline = text.indexOf("\\n");
    if (Buffer.byteLength(newline < 0 ? text : text.slice(0, newline + 1), "utf8") > limitBytes) ''' + RANGE + ''';
    if (newline < 0) return null;
    const line = text.slice(0, newline);
    text = "";
    return line;
  };'''),
  'M2a-count-decoded-buffer': lambda: [(proto, '(newline < 0 ? pending.length : newline + 1) > limitBytes',
     'Buffer.byteLength(pending.toString("utf8", 0, newline < 0 ? pending.length : newline + 1), "utf8") > limitBytes')],
  'M2b-count-decoded-chunks': body('''  let pending = Buffer.alloc(0);
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
  'M3-limit-ge': lambda: [(proto, 'newline + 1) > limitBytes', 'newline + 1) >= limitBytes')],
  'M4-newline-excluded': lambda: [(proto, 'newline < 0 ? pending.length : newline + 1', 'newline < 0 ? pending.length : newline')],
  'M5-broker-old-reader': 'broker',
  'M6-client-old-reader': 'client',
}
def git_show(path):
    return subprocess.run(['git','show','9e76a07:'+path], cwd=root, capture_output=True, text=True, check=True).stdout
def run(name):
    log = logs/f'{name}.log'
    r = subprocess.run(['pnpm','exec','vitest','run','--reporter=verbose','tests/session-messaging/utf8-framing.test.ts'], cwd=root, capture_output=True, text=True, timeout=600)
    log.write_text(r.stdout + r.stderr)
    failed = sum(1 for l in (r.stdout).splitlines() if l.strip().startswith('×'))
    return r.returncode, failed
rows = []
code, failed = run('BASELINE'); rows.append(('BASELINE', 'PASS' if code == 0 else 'FAIL', failed))
for name, spec in mutants.items():
    originals = {p: p.read_text(encoding='utf-8') for p in (proto, client, broker)}
    try:
        if spec == 'broker': broker.write_text(git_show('mcp-server/src/session-message-broker.ts'), encoding='utf-8')
        elif spec == 'client': client.write_text(git_show('mcp-server/src/session-message-client.ts'), encoding='utf-8')
        else:
            for path, old, new in spec():
                text = path.read_text(encoding='utf-8'); assert text.count(old) == 1, (name, old); path.write_text(text.replace(old, new), encoding='utf-8')
        code, failed = run(name)
        rows.append((name, 'KILLED' if code != 0 else 'SURVIVED', failed))
    finally:
        for p, t in originals.items(): p.write_text(t, encoding='utf-8')
    print(rows[-1], flush=True)
(logs/'mutants.tsv').write_text('mutant\tresult\tfailed_tests\n' + ''.join(f'{a}\t{b}\t{c}\n' for a,b,c in rows))
print(open(logs/'mutants.tsv').read())
