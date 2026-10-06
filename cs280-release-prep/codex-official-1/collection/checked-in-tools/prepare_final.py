"""Changed-input correction of publication only; never invokes a product validator."""
import collections, datetime, hashlib, importlib.util, json, pathlib, re, zipfile
from runner import ROOT, run

raw = ROOT / 'raw'
audit = ROOT / 'audit'
sha = lambda b: hashlib.sha256(b).hexdigest()
encode = lambda v: (json.dumps(v, ensure_ascii=False, indent=2) + '\n').encode()
prior = pathlib.Path('/workspace/ags-cs-2x/publication-20261006T040502Z')
_, out, _ = run('35-corrected-tools-pin', ['git', 'rev-parse', 'HEAD', 'HEAD^{tree}'], ROOT / 'tools')
pins = out.read_text().splitlines()
_, out, _ = run('37-corrected-tools-clean', ['git', 'status', '--porcelain'], ROOT / 'tools')
assert not out.read_bytes()
cutoff = datetime.datetime.now(datetime.timezone.utc).isoformat()
frozen = ROOT / 'frozen-corrected'
frozen.mkdir()
public = ROOT / 'public-corrected/cs280-release-prep/codex-official-1'
public.mkdir(parents=True)
spec = importlib.util.spec_from_file_location('redactor', prior / 'redact.py')
redactor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(redactor)
redactor.ids = set(json.loads((audit / 'known-private-resource-ids.json').read_text()))
excluded_active = {'36-corrected-prepare-driver.stdout.log', '36-corrected-prepare-driver.stderr.log'}
sources = [(p, 'raw/' + p.relative_to(raw).as_posix()) for p in sorted(raw.rglob('*'))
           if p.is_file() and p.name not in excluded_active]
supplied = json.loads((raw / 'SUPPLIED.json').read_text())
sources += [(ROOT / 'codex-home-disposable' / r['temporaryPath'], 'supplied-official/' + r['temporaryPath'])
            for r in supplied['files']]
sources += [(p, 'checked-in-tools/' + p.name) for p in sorted((ROOT / 'tools').glob('*.py'))]
sources += [(ROOT / 'tools/.gitignore', 'checked-in-tools/.gitignore')]
sources += [(audit / 'RAW-INVENTORY.json', 'prior-preparation/RAW-INVENTORY.json')]
sources += [(audit / 'FINAL-RAW-INVENTORY.json', 'prior-preparation/SECOND-RAW-INVENTORY.json')]
sources += [(ROOT / 'public-final/cs280-release-prep/codex-official-1/RESIDUAL-SCAN.json', 'prior-preparation/SECOND-RESIDUAL-SCAN.json')]
for name in ('commands.jsonl', '29-prepare-driver.stdout.log', '29-prepare-driver.stderr.log'):
    sources.append((ROOT / 'frozen-raw/raw/logs' / name, 'prior-preparation/cutoff-captures/' + name))
inventory, ledger = [], []
for source, name in sources:
    data = source.read_bytes()
    snap = frozen / name
    snap.parent.mkdir(parents=True, exist_ok=True)
    snap.write_bytes(data)
    snap.chmod(0o400)
    row = dict(sourcePath=str(source.relative_to(ROOT)), path=name, originalBytes=len(data), originalSha256=sha(data))
    inventory.append(row)
    if name.startswith('supplied-official/'):
        output, counts = data, {}
    else:
        output, counts = redactor.redacted_bytes(data, source.suffix)
        text, extra_email = re.subn(r'\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b', '[REDACTED:EMAIL_STYLE_VALUE]', output.decode('utf-8'))
        output = text.encode('utf-8')
        if extra_email: counts['EMAIL_STYLE_VALUE'] = extra_email
    nul_count = output.count(b'\0')
    if nul_count:
        # Git ls-files -z logs contain 1344 ordered path delimiters, not an encoded payload.
        # Escape delimiters visibly; raw binary streams and their hashes stay immutable.
        assert name in ('raw/logs/16-source-pre-paths.stdout.log', 'raw/logs/20-source-post-paths.stdout.log')
        assert nul_count == 1344
        output = output.replace(b'\0', b'\\u0000')
    dest = public / name
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(output)
    ledger.append(dict(**row, publicBytes=len(output), publicSha256=sha(output), removalsByKind=counts,
                       removalCount=sum(counts.values()), nulDelimitersEscaped=nul_count,
                       delimiterTransformation='NUL -> literal \\u0000; preserve ordered 1344 Git paths' if nul_count else None))
inv = dict(schema='AGSOfficialPrepInventory.v1', cutoffUtc=cutoff, sourceCount=len(inventory), files=inventory,
           excludedActiveCaptureLabels=sorted(excluded_active),
           scope='Current CS official task only; active final delivery driver and post-cutoff delivery excluded. No native internal reasoning, DB, key, bundle or private ZIP payload.')
(audit / 'CORRECTED-RAW-INVENTORY.json').write_bytes(encode(inv))
(audit / 'CORRECTED-RAW-INVENTORY.json').chmod(0o400)
inventory_hash = sha((audit / 'CORRECTED-RAW-INVENTORY.json').read_bytes())
(public / 'INVENTORY.json').write_bytes(encode(dict(**inv, frozenPrivateInventorySha256=inventory_hash)))
counts = collections.Counter()
for row in ledger:
    counts.update(row['removalsByKind'])
(public / 'REDACTION.json').write_bytes(encode(dict(files=ledger, rawFiles=len(ledger), publicCopies=len(ledger),
    removalCount=sum(counts.values()), removalsByKind=dict(counts), nulDelimitersEscaped=sum(r['nulDelimitersEscaped'] for r in ledger),
    note='Official supplied upstream files are exact bytes. Secret removal and visible NUL escaping are separately counted; original versions are immutable.')))
(public / 'STATUS.json').write_bytes((raw / 'ANNOTATED-RESULT.json').read_bytes())
(public / 'TOOLS-PIN.json').write_bytes(encode(dict(commit=pins[0], tree=pins[1], clean=True,
    branch='codex/cs280-official-validator-evidence', checkedInScripts=True, inlineProcessCode=False)))
(public / 'COLLECTION.json').write_bytes(encode(dict(cutoffUtc=cutoff,
    candidate='4ba47558020bd5e501fa9718f09d562dcf573713', candidateTree='5fcc66de8aa37e6a347511c2def0eae54a0ed1e5',
    officialCommandAttempts=1, officialPythonValidators='NOT_RUN', unexpectedInstallAttempt=True,
    originalCandidateFilesExact=1344, sourceCleanPrePost=True,
    correctedPostprocessing='First scanner exit1 on two Git ls-files -z logs containing NUL. Second scanner exit1 on an email-shaped public upstream snapshot filename. All 27/29/31/33 failure captures and inventory retained. Changed-input corrections escape 2688 delimiters and redact the email-shaped filename; no scanner check relaxed.',
    partialPriorCaptures='prior-preparation/cutoff-captures/29 stdout/stderr were empty while that driver was still running at its first cutoff; not complete streams. Completed actual 29 stdout/stderr are separately retained in raw/logs.',
    activeDriver='36-corrected-prepare-driver is excluded while active; completed stdout/stderr and command metadata remain outside this packet in raw/logs. No complete stream claimed for an active capture.',
    postCutoff='38-corrected-residual-scan onward and final delivery/ZIP/Library receipts retained separately; not claimed inside the frozen packet. No recursive self-publication.',
    unavailable='Full native transcript and initial read-only native exports/outer acquire-supply wrapper stdout NOT_VERIFIABLE. Actual nested supplier captures retained; no reconstructed reasoning.',
    publication='LOCAL PREPARATION ONLY; no remote push/main/tag/release/install. Existing evidence442 untouched.',
    environment='Workspace/runtime reused; container lifecycle and outside jobs UNKNOWN. Isolated new candidate/TMP/state/CODEX_HOME. No database/key/profile queries.',
    compatibility='STATIC_KEY_COMPATIBLE only, no full official PASS. pnpm original FAIL/exit1 retained and classified as pre-script dependency blocker.')))
(public / 'README.ko.md').write_text(
    '공식 공급원은 rust-v0.158.0-alpha.2 / 10382da79a2a2d6e8ae221fa63077215389c1ad2로 동결했고 원격 Git·raw HTTPS의 blob 및 LF 바이트를 대조했다. 공식 세 Python 파일과 Apache-2.0 LICENSE·NOTICE를 임시 CODEX_HOME에 그대로 제공했다. Windows CRLF SHA는 원격 LF SHA로 재사용하지 않았다.\n\n'
    '후보4ba/tree5fcc에서 pnpm validate:official은 1회 exit1. pnpm11.19 기본 verify-deps-before-run=install이 implicit install을 시도했고 기본 사용자 store 초기화 ENOENT로 실패했다. plugin 및 22개 skill 공식 validator는 NOT_RUN이며 출시 게이트는 BLOCKED다. 예상 밖 설치 시도와 FAIL을 숨기지 않았다. 동일 입력 재실행·직접 Python 대체 검사0. 1344 소스 바이트와 clean/tree 상태는 전후 동일하다.\n\n'
    '첫 공개 스캔은 두 Git ls-files -z 로그의 NUL 때문에 exit1이었다. 두 번째 스캔은 공식 저장소의 이메일 형태 snapshot 파일명 때문에 exit1이었다. 모든 실패 로그·원본을 유지하고 공개 사본의 2688 경계 바이트를 가시적으로 escape하고 해당 형태 문자열을 제거했다. 검사 기준은 그대로다. 명령/exit, 원본→공개 SHA, cutoff, 제거 ledger 및 정확한 파일 집합을 동봉한다. 현재 전달 드라이버와 cutoff 이후 배달 로그는 범위 밖이며 원본 경로에 따로 남긴다.\n\n'
    '새 의존성 입력을 별도로 검토해 준비하기 전 공식 PASS로 주장할 수 없다. full test/build/runtime/r1-r2통합/main/tag/release/호스트 설치/push를 수행하지 않았다. 기존 evidence는 변경하지 않은 로컬 게시 준비본이다. 비공개 원 ZIP·키·DB·내부 reasoning·다른 세션 원문은 공개하지 않는다.\n')
run('38-corrected-residual-scan', ['python', str(prior / 'scan-public.py'), str(ROOT), str(public)], ROOT)
assert json.loads((public / 'RESIDUAL-SCAN.json').read_text())['state'] == 'PASS'
files = [dict(path=p.relative_to(public).as_posix(), bytes=p.stat().st_size, sha256=sha(p.read_bytes()))
         for p in sorted(public.rglob('*')) if p.is_file()]
(public / 'MANIFEST.json').write_bytes(encode(dict(schema='AGSOfficialPrepPublicManifest.v1', prefix='cs280-release-prep/codex-official-1',
    cutoffUtc=cutoff, files=files, hashCycleRule='MANIFEST excludes itself and SHA256SUMS. SUMS includes MANIFEST and excludes itself. External ZIP receipt binds final bytes.')))
manifest_hash = sha((public / 'MANIFEST.json').read_bytes())
(public / 'SHA256SUMS').write_text('\n'.join(r['sha256'] + '  ' + r['path'] for r in files) + '\n' + manifest_hash + '  MANIFEST.json\n')
run('39-corrected-payload-sums', ['sha256sum', '--check', '--quiet', 'SHA256SUMS'], public)
packet = ROOT / 'AGS-CS280-Codex-official-1-review.zip'
assert not packet.exists()
with zipfile.ZipFile(packet, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for p in sorted(public.rglob('*')):
        if p.is_file(): z.write(p, 'cs280-release-prep/codex-official-1/' + p.relative_to(public).as_posix())
with zipfile.ZipFile(packet) as z:
    assert len(z.namelist()) == len(files) + 2
    for name in z.namelist(): assert z.read(name) == (ROOT / 'public-corrected' / name).read_bytes()
private_zip = ROOT / 'private-original-evidence.zip'
assert not private_zip.exists()
with zipfile.ZipFile(private_zip, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for directory in ('frozen-raw', 'frozen-final', 'frozen-corrected'):
        for p in sorted((ROOT / directory).rglob('*')):
            if p.is_file(): z.write(p, p.relative_to(ROOT).as_posix())
private_zip.chmod(0o400)
result = dict(status='PREPARED_BLOCKED_NO_PUSH', publicPath=str(public), publicFiles=len(files) + 2,
    rawSourceFiles=len(inventory), cutoffUtc=cutoff, rawInventorySha256=inventory_hash, manifestSha256=manifest_hash,
    sha256SumsSha256=sha((public / 'SHA256SUMS').read_bytes()), redactionMatches=sum(counts.values()),
    nulDelimitersEscaped=sum(r['nulDelimitersEscaped'] for r in ledger), residualFindings=0,
    reviewZip=dict(path=str(packet), bytes=packet.stat().st_size, sha256=sha(packet.read_bytes())),
    privateOriginalZip=dict(path=str(private_zip), bytes=private_zip.stat().st_size, sha256=sha(private_zip.read_bytes()), uploaded=False),
    supplierPin='10382da79a2a2d6e8ae221fa63077215389c1ad2', candidatePin='4ba47558020bd5e501fa9718f09d562dcf573713',
    toolsCommit=pins[0], postCutoffLogs='38,39 and completed36 driver are outside the sealed payload; no product retry')
(audit / 'DELIVERY.json').write_bytes(encode(result))
print(json.dumps(result, ensure_ascii=False, indent=2))
