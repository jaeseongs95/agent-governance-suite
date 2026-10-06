"""Verify the sealed evidence artifact; never executes any product code."""
import hashlib, importlib.util, json, pathlib, re, zipfile
from runner import ROOT, run
sha = lambda b: hashlib.sha256(b).hexdigest()
delivery = json.loads((ROOT / 'audit/DELIVERY.json').read_text())
public = pathlib.Path(delivery['publicPath'])
inventory = json.loads((public / 'INVENTORY.json').read_text())
ledger = json.loads((public / 'REDACTION.json').read_text())
manifest = json.loads((public / 'MANIFEST.json').read_text())
assert len(inventory['files']) == len(ledger['files']) == 200
assert {r['path'] for r in inventory['files']} == {r['path'] for r in ledger['files']}
assert {p.relative_to(public).as_posix() for p in public.rglob('*') if p.is_file()} == {r['path'] for r in manifest['files']} | {'MANIFEST.json', 'SHA256SUMS'}
records = []
spec = importlib.util.spec_from_file_location('redactor', ROOT.parent / 'publication-20261006T040502Z/redact.py')
redactor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(redactor)
redactor.ids = set(json.loads((ROOT / 'audit/known-private-resource-ids.json').read_text()))
for row in ledger['files']:
    original = (ROOT / 'frozen-corrected' / row['path']).read_bytes()
    published = (public / row['path']).read_bytes()
    assert sha(original) == row['originalSha256'] and len(original) == row['originalBytes']
    assert sha(published) == row['publicSha256'] and len(published) == row['publicBytes']
    if row['path'].startswith('supplied-official/'):
        assert original == published
    if row['nulDelimitersEscaped']:
        expected, _ = redactor.redacted_bytes(original, '.log')
        expected = re.sub(r'\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b', '[REDACTED:EMAIL_STYLE_VALUE]', expected.decode()).encode()
        assert expected.replace(b'\0', b'\\u0000') == published
        assert len(original.split(b'\0')) == len(published.split(b'\\u0000')) == 1345
    if row['path'].endswith('commands.jsonl'):
        before = [json.loads(line) for line in original.splitlines() if line.strip()]
        after = [json.loads(line) for line in published.splitlines() if line.strip()]
        assert len(before) == len(after)
        for a, b in zip(before, after):
            for key in ('label', 'exitCode', 'startedUtc', 'finishedUtc', 'cwd'):
                assert a[key] == b[key]
        records.append(dict(path=row['path'], records=len(before), orderAndExitExact=True))
for row in manifest['files']:
    data = (public / row['path']).read_bytes()
    assert sha(data) == row['sha256'] and len(data) == row['bytes']
packet = pathlib.Path(delivery['reviewZip']['path'])
assert sha(packet.read_bytes()) == delivery['reviewZip']['sha256']
with zipfile.ZipFile(packet) as z:
    assert len(z.namelist()) == delivery['publicFiles']
    for name in z.namelist():
        assert name.startswith('cs280-release-prep/codex-official-1/')
        assert z.read(name) == (ROOT / 'public-corrected' / name).read_bytes()
for label in ('19-validate-official', '27-public-residual-scan', '29-prepare-driver', '31-final-prepare-driver', '33-final-residual-scan'):
    # Actual completed failure command records must survive publication.
    meta = json.loads((public / 'raw/logs' / (label + '.command.json')).read_text())
    assert meta['exitCode'] == 1, (label, meta)
_, out, _ = run('41-final-candidate-pin', ['git', 'rev-parse', 'HEAD', 'HEAD^{tree}'], ROOT / 'candidate')
assert out.read_text().splitlines() == ['4ba47558020bd5e501fa9718f09d562dcf573713', '5fcc66de8aa37e6a347511c2def0eae54a0ed1e5']
_, out, _ = run('42-final-candidate-clean', ['git', 'status', '--porcelain'], ROOT / 'candidate')
assert not out.read_bytes()
_, out, _ = run('43-final-original-clean', ['git', 'status', '--porcelain'], ROOT.parent / 'repo')
assert not out.read_bytes()
result = dict(status='VERIFIED_BLOCKED_NO_PUSH', frozenCopiesVerified=200, publicFiles=209,
              zipBytes=packet.stat().st_size, zipSha256=sha(packet.read_bytes()), commandRecordConservation=records,
              officialSupplierByteExactFiles=5, nulPathOrderPreserved=2688, preservedFailedCommands=5,
              sourceHead='4ba47558020bd5e501fa9718f09d562dcf573713', sourceTree='5fcc66de8aa37e6a347511c2def0eae54a0ed1e5',
              sourceClean=True, officialAttempts=1, officialPythonValidators='NOT_RUN', productRetest=False,
              preparedArtifactToolsCommit=delivery['toolsCommit'],
              postCutoffCommandLabels=['38-corrected-residual-scan', '39-corrected-payload-sums', '36-corrected-prepare-driver',
                                     '40-delivery-verifier', '44-corrected-delivery-verifier', '41-final-candidate-pin', '42-final-candidate-clean', '43-final-original-clean'],
              priorVerificationAttempt='40 exit1 because verifier incorrectly expected NUL escaping without the recorded path redaction. Original failure preserved; changed verifier validates documented redaction plus delimiter order without changing product or sealed packet.',
              note='This verifier and Library receipt are terminal delivery evidence outside the sealed collection cutoff.')
(ROOT / 'audit/FINAL-VERIFICATION.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
print(json.dumps(result, ensure_ascii=False, indent=2))
