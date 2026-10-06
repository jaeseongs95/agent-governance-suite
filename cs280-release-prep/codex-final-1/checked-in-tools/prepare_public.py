import collections, datetime, importlib.util, json, pathlib, re, zipfile
from environment import ROOT, sha
from runner import run, write
_, out, _ = run('36-preparation-tools-pin', ['git', 'rev-parse', 'HEAD', 'HEAD^{tree}'], ROOT / 'tools')
pins = out.read_text().splitlines()
_, out, _ = run('37-preparation-tools-clean', ['git', 'status', '--porcelain'], ROOT / 'tools')
assert not out.read_bytes()
cutoff = datetime.datetime.now(datetime.timezone.utc).isoformat()
encode = lambda value: (json.dumps(value, ensure_ascii=False, indent=2)+'\n').encode()
audit = ROOT / 'audit'
audit.mkdir(exist_ok=True)
prior = ROOT.parent / 'publication-20261006T040502Z'
spec = importlib.util.spec_from_file_location('redactor', prior / 'redact.py')
redactor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(redactor)
known = json.loads((prior / 'audit/known-private-resource-ids.json').read_text())
redactor.ids = set(known)
(audit / 'known-private-resource-ids.json').write_bytes(encode(known))
public = ROOT / 'public/cs280-release-prep/codex-final-1'
public.mkdir(parents=True)
frozen = ROOT / 'frozen-raw'
frozen.mkdir()
sources = [(p, 'raw/' + p.relative_to(ROOT / 'raw').as_posix()) for p in sorted((ROOT / 'raw').rglob('*'))
           if p.is_file() and p.name not in ('35-public-preparation-driver.stdout.log', '35-public-preparation-driver.stderr.log')]
sources += [(p, 'checked-in-tools/' + p.name) for p in sorted((ROOT / 'tools').glob('*.py'))]
sources += [(ROOT / 'tools/.gitignore', 'checked-in-tools/.gitignore')]
supplied = json.loads((ROOT / 'raw/SUPPLIED.json').read_text())
sources += [(ROOT / 'codex-home-disposable' / row['temporaryPath'], 'supplied-official/' + row['temporaryPath']) for row in supplied['verifiedFiles']]
ledger = []
for source, name in sources:
    data = source.read_bytes()
    snap = frozen / name
    snap.parent.mkdir(parents=True, exist_ok=True)
    snap.write_bytes(data)
    snap.chmod(0o400)
    if name.startswith('supplied-official/'):
        output, counts = data, {}
    else:
        output, counts = redactor.redacted_bytes(data, source.suffix)
        text, n = re.subn(r'\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b', '[REDACTED:EMAIL_STYLE_VALUE]', output.decode())
        output = text.encode()
        if n: counts['EMAIL_STYLE_VALUE'] = n
    nul = output.count(b'\0')
    if nul:
        assert name.endswith('-paths.stdout.log') and nul == 1344
        output = output.replace(b'\0', b'\\u0000')
    dest = public / name
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(output)
    ledger.append(dict(path=name, sourcePath=str(source.relative_to(ROOT)), originalBytes=len(data), originalSha256=sha(data),
        publicBytes=len(output), publicSha256=sha(output), removalsByKind=counts, removalCount=sum(counts.values()),
        nulDelimitersEscaped=nul, transformation='NUL -> literal \\u0000, path order retained with separately logged redaction' if nul else None))
counts = collections.Counter()
for row in ledger: counts.update(row['removalsByKind'])
inventory = dict(cutoffUtc=cutoff, sourceCount=len(ledger), files=ledger,
    scope='Current final-pin CS Codex Cloud task only. Old official1 raw evidence preserved separately; no other sessions or inner reasoning collected.',
    excluded='Active35/later scan/seal/scope/preflight/push/Library delivery captures are outside this initial cutoff; no DB/key/store payload/node_modules/private ZIP or Git bundle payload published.')
(audit / 'RAW-INVENTORY.json').write_bytes(encode(inventory))
(audit / 'RAW-INVENTORY.json').chmod(0o400)
inventory_sha = sha((audit / 'RAW-INVENTORY.json').read_bytes())
(public / 'INVENTORY.json').write_bytes(encode(dict(**inventory, frozenPrivateInventorySha256=inventory_sha)))
(public / 'REDACTION.json').write_bytes(encode(dict(files=ledger, sourceCount=len(ledger), publicCopies=len(ledger),
    removalCount=sum(counts.values()), removalsByKind=dict(counts), nulDelimitersEscaped=sum(r['nulDelimitersEscaped'] for r in ledger))))
(public / 'STATUS.json').write_bytes((ROOT / 'raw/ANNOTATED-RESULT.json').read_bytes())
(public / 'TOOLS-PIN.json').write_bytes(encode(dict(commit=pins[0], tree=pins[1], clean=True, checkedIn=True)))
(public / 'COLLECTION.json').write_bytes(encode(dict(cutoffUtc=cutoff, candidate='b7341d3e6636b79217b1f3d37d7a5014fcbf47be',
    tree='5648f76558e923244cedf78a8263892d00df8299', sourceTrackedFiles=1344, sourceByteExactPrePost=True,
    supplier='10382da79a2a2d6e8ae221fa63077215389c1ad2', supplierFilesByteExact=5,
    install='ONE private frozen-lockfile install exit0; verified workspace/modules state and same effective store',
    official='ONE final wrapper exit1, unsupported store-dir for pnpm run. Official plugin/22 skill Python NOT_RUN. No retry.',
    initialFailures='00 path allowlist omission and17 SyntaxError captured; changed evidence-only scripts corrected before actual install22.',
    firstOfficial1='Prior frozen4ba implicit-install ENOENT failure retained and not relabeled; its no-publication boundary remains.',
    rawNative='Full native transcript/read-only exploratory tool exports NOT_VERIFIABLE; nested runner split stdout/stderr and metadata are actual captures, not reconstructed reasoning.',
    publication='New authorized evidence-only prefix cs280-release-prep/codex-final-1; no first official1 publication, main/tag/release/install authority.',
    remaining='Original Linux plain full3F not rerun/promoted; signed whole lifecycle/global acceptance NOT_IMPLEMENTED; model quality A/B/C and independent SOURCE audit not performed.',
    postCutoff='38 onward and final delivery/Library receipts are outside this sealed collection; actual local captures retained and reported separately.')))
(public / 'README.ko.md').write_text(
    '최종 후보 b7341d3/tree5648f765를 원격 지정 branch에서 fetch했고 clean·1344 source pins를 확인했다. 4ba 대비 차이는 테스트2/문서4/release metadata1이며 공식 plugin/skills/runner/package/lock 및 production runtime/bundle은 바뀌지 않았다. README의 공개2.8 문구는 준비된 metadata이며 실제 main/tag/release/install 증거가 아니다.\n\n'
    'private --store-dir frozen-lockfile 설치1회 exit0, workspace state/modules 준비 확인, 소스·lock 불변. 그러나 pnpm --store-dir ... validate:official 1회는 pnpm run parser의 Unknown option store-dir로 exit1이었다. 실제 공식 Python plugin/22 skill validator는 NOT_RUN. PASS나 공식 validator FAIL로 바꾸지 않는다. child PNPM_CONFIG_STORE_DIR 결속은 다음 변경 입력 후보이며 자동 재시도0.\n\n'
    '준비 중 좁은 path allowlist 및 Python SyntaxError 실패와 보정을 함께 보존했다. 실제 설치 전에 중단됐던 시도이며 원 로그를 삭제하지 않았다. 공급 공식3 Python/LICENSE/NOTICE는 동일pin raw/blob exact 상태로 새로운 CODEX_HOME에 제공했다. global/user pnpm 설정·기존HOME repair·운영DB/key/profile·호스트 설치·공유권한 변경0. 배포용 host install과 이번 locked 개발 의존성 설치를 구분한다.\n\n'
    '원본→공개SHA, 제거횟수, Git NUL delimiter의 공개 escape 바이트와 기록 순서, 정확한 inventory/cutoff/manifest/SUMS를 제공한다. 비공개 원본 frozen copies는 별도다. full tests/build/runtime/원Linux3F 재실행0, 독립감사·릴리스승인 아님.\n')
run('38-public-residual-scan', ['python', str(prior / 'scan-public.py'), str(ROOT), str(public)], ROOT)
assert json.loads((public / 'RESIDUAL-SCAN.json').read_text())['state'] == 'PASS'
for row in ledger:
    assert sha((frozen / row['path']).read_bytes()) == row['originalSha256']
    assert sha((public / row['path']).read_bytes()) == row['publicSha256']
    if row['path'].endswith('commands.jsonl'):
        original = [json.loads(line) for line in (frozen / row['path']).read_text().splitlines()]
        copy = [json.loads(line) for line in (public / row['path']).read_text().splitlines()]
        assert len(original) == len(copy)
        for a, b in zip(original, copy):
            assert (a['label'], a['cwd'], a['exitCode'], a['startedUtc'], a['finishedUtc']) == (b['label'], b['cwd'], b['exitCode'], b['startedUtc'], b['finishedUtc'])
files = [dict(path=p.relative_to(public).as_posix(), bytes=p.stat().st_size, sha256=sha(p.read_bytes())) for p in sorted(public.rglob('*')) if p.is_file()]
(public / 'MANIFEST.json').write_bytes(encode(dict(prefix='cs280-release-prep/codex-final-1', cutoffUtc=cutoff, files=files,
    hashCycleRule='MANIFEST excludes own bytes and SHA256SUMS; SUMS includes MANIFEST but excludes itself; external delivery ZIP receipt binds final bytes.')))
manifest_sha = sha((public / 'MANIFEST.json').read_bytes())
(public / 'SHA256SUMS').write_text('\n'.join(r['sha256']+'  '+r['path'] for r in files)+'\n'+manifest_sha+'  MANIFEST.json\n')
run('39-public-sums', ['sha256sum', '--check', '--quiet', 'SHA256SUMS'], public)
packet = ROOT / 'AGS-CS280-Codex-final-1-review.zip'
with zipfile.ZipFile(packet, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for p in sorted(public.rglob('*')):
        if p.is_file(): z.write(p, 'cs280-release-prep/codex-final-1/'+p.relative_to(public).as_posix())
with zipfile.ZipFile(packet) as z:
    assert len(z.namelist()) == len(files)+2
    for name in z.namelist(): assert z.read(name) == (ROOT / 'public' / name).read_bytes()
private = ROOT / 'private-original-evidence.zip'
with zipfile.ZipFile(private, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for p in sorted(frozen.rglob('*')):
        if p.is_file(): z.write(p, p.relative_to(frozen).as_posix())
private.chmod(0o400)
delivery = dict(status='PREPARED_OFFICIAL_BLOCKED', cutoffUtc=cutoff, publicPath=str(public), publicFiles=len(files)+2, rawSourceFiles=len(ledger),
    rawInventorySha256=inventory_sha, redactionMatches=sum(counts.values()), nulDelimitersEscaped=sum(r['nulDelimitersEscaped'] for r in ledger), residualFindings=0,
    manifestSha256=manifest_sha, sumsSha256=sha((public / 'SHA256SUMS').read_bytes()), toolsCommit=pins[0],
    reviewZip=dict(path=str(packet), bytes=packet.stat().st_size, sha256=sha(packet.read_bytes())),
    privateOriginalZip=dict(path=str(private), bytes=private.stat().st_size, sha256=sha(private.read_bytes()), uploaded=False),
    rawPath=str(ROOT/'raw'), afterCutoff='38,39,35 completion, publication/preflight/scope/push/Library receipt outside this initial packet')
(audit / 'DELIVERY.json').write_bytes(encode(delivery))
print(json.dumps(delivery, ensure_ascii=False, indent=2))
