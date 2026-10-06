"""Bounded final delivery log collection, without product execution or publication."""
import collections, datetime, hashlib, importlib.util, json, pathlib, re, zipfile
from runner import ROOT, run
encode = lambda v: (json.dumps(v, ensure_ascii=False, indent=2) + '\n').encode()
sha = lambda b: hashlib.sha256(b).hexdigest()
_, out, _ = run('45-terminal-tools-pin', ['git', 'rev-parse', 'HEAD', 'HEAD^{tree}'], ROOT / 'tools')
pins = out.read_text().splitlines()
_, out, _ = run('46-terminal-tools-clean', ['git', 'status', '--porcelain'], ROOT / 'tools')
assert not out.read_bytes()
cutoff = datetime.datetime.now(datetime.timezone.utc).isoformat()
prior = ROOT.parent / 'publication-20261006T040502Z'
spec = importlib.util.spec_from_file_location('redactor', prior / 'redact.py')
redactor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(redactor)
redactor.ids = set(json.loads((ROOT / 'audit/known-private-resource-ids.json').read_text()))
public = ROOT / 'terminal-public'
public.mkdir()
frozen = ROOT / 'frozen-terminal'
frozen.mkdir()
labels = ['36-corrected-prepare-driver', '38-corrected-residual-scan', '39-corrected-payload-sums',
          '40-delivery-verifier', '41-final-candidate-pin', '42-final-candidate-clean', '43-final-original-clean',
          '44-corrected-delivery-verifier', '45-terminal-tools-pin', '46-terminal-tools-clean']
sources = [(ROOT / 'raw/logs' / (label + ext), 'logs/' + label + ext)
           for label in labels for ext in ('.stdout.log', '.stderr.log', '.command.json')]
sources += [(ROOT / 'raw/logs/commands.jsonl', 'logs/commands.jsonl'),
            (ROOT / 'audit/DELIVERY.json', 'COLLECTION-DELIVERY.json'),
            (ROOT / 'audit/FINAL-VERIFICATION.json', 'COLLECTION-VERIFICATION.json'),
            (ROOT / 'tools/verify_delivery.py', 'tools/verify_delivery.py'),
            (ROOT / 'tools/freeze_terminal.py', 'tools/freeze_terminal.py')]
ledger = []
for source, name in sources:
    data = source.read_bytes()
    snap = frozen / name
    snap.parent.mkdir(parents=True, exist_ok=True)
    snap.write_bytes(data)
    snap.chmod(0o400)
    output, counts = redactor.redacted_bytes(data, source.suffix)
    text, n = re.subn(r'\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b', '[REDACTED:EMAIL_STYLE_VALUE]', output.decode())
    output = text.encode()
    if n: counts['EMAIL_STYLE_VALUE'] = n
    dest = public / name
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(output)
    ledger.append(dict(path=name, sourcePath=str(source.relative_to(ROOT)), originalBytes=len(data), originalSha256=sha(data),
                       publicBytes=len(output), publicSha256=sha(output), removalsByKind=counts, removalCount=sum(counts.values())))
counts = collections.Counter()
for row in ledger: counts.update(row['removalsByKind'])
(public / 'INVENTORY.json').write_bytes(encode(dict(cutoffUtc=cutoff, files=ledger, originalCount=len(ledger), publicCopies=len(ledger),
    scope='Current CS post-collection commands completed before terminal cutoff only. Active47 and later scan/seal/Library delivery excluded; no internal reasoning or other session transcripts.')))
(public / 'REDACTION.json').write_bytes(encode(dict(files=ledger, removalsByKind=dict(counts), removalCount=sum(counts.values()))))
(public / 'COLLECTION.json').write_bytes(encode(dict(cutoffUtc=cutoff, toolsCommit=pins[0], toolsTree=pins[1], clean=True,
    postprocessingFailures='40 exit1 is preserved: verifier omitted the documented path redaction before NUL escape. Changed verifier44 exit0. Product validator19 remains exit1/official NOT_RUN.',
    commands='All actual stdout/stderr and command metadata for listed10 post-cutoff commands; full cumulative command log retained with record order/exit.',
    excluded='Active47 and later48/49/current driver/Library receipt are terminal delivery only, outside this cutoff. No recursive publication.',
    publication='LOCAL ONLY, PUSH0. This is a review-transport supplement; it does not alter the sealed209-file collection. Parent controls any future designated-folder publication.')))
run('48-terminal-residual-scan', ['python', str(prior / 'scan-public.py'), str(ROOT), str(public)], ROOT)
files = [dict(path=p.relative_to(public).as_posix(), bytes=p.stat().st_size, sha256=sha(p.read_bytes()))
         for p in sorted(public.rglob('*')) if p.is_file()]
(public / 'MANIFEST.json').write_bytes(encode(dict(files=files, cutoffUtc=cutoff,
    hashCycleRule='MANIFEST excludes itself and SHA256SUMS; SUMS includes MANIFEST and excludes itself.')))
mh = sha((public / 'MANIFEST.json').read_bytes())
(public / 'SHA256SUMS').write_text('\n'.join(r['sha256'] + '  ' + r['path'] for r in files) + '\n' + mh + '  MANIFEST.json\n')
run('49-terminal-sums', ['sha256sum', '--check', '--quiet', 'SHA256SUMS'], public)
delivery = json.loads((ROOT / 'audit/DELIVERY.json').read_text())
original_public = pathlib.Path(delivery['publicPath'])
packet = ROOT / 'AGS-CS280-Codex-official-1-delivery.zip'
assert not packet.exists()
with zipfile.ZipFile(packet, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for root, prefix in ((original_public, 'collection/cs280-release-prep/codex-official-1/'), (public, 'delivery-terminal/')):
        for p in sorted(root.rglob('*')):
            if p.is_file(): z.write(p, prefix + p.relative_to(root).as_posix())
with zipfile.ZipFile(packet) as z:
    assert len(z.namelist()) == 209 + len(files) + 2
    for name in z.namelist():
        if name.startswith('collection/cs280-release-prep/codex-official-1/'):
            path = original_public / name.removeprefix('collection/cs280-release-prep/codex-official-1/')
        else:
            assert name.startswith('delivery-terminal/')
            path = public / name.removeprefix('delivery-terminal/')
        assert z.read(name) == path.read_bytes()
result = dict(status='PREPARED_BLOCKED_NO_PUSH', cutoffUtc=cutoff, collectionFiles=209, terminalFiles=len(files)+2,
    terminalOriginalFiles=len(ledger), terminalRedactionMatches=sum(counts.values()), residualFindings=0,
    terminalManifestSha256=mh, terminalSumsSha256=sha((public / 'SHA256SUMS').read_bytes()), toolsCommit=pins[0],
    zip=dict(path=str(packet), bytes=packet.stat().st_size, sha256=sha(packet.read_bytes())),
    originalSealedReviewZip=delivery['reviewZip'],
    remainingOutOfCutoff='48,49,47 completion and Library receipt. Actual captures retained locally; not claimed in frozen ZIP.')
(ROOT / 'audit/FINAL-DELIVERY.json').write_bytes(encode(result))
print(json.dumps(result, ensure_ascii=False, indent=2))
