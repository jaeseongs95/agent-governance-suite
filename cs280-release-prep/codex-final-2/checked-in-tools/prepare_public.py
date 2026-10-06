import collections, datetime, importlib.util, json, pathlib, re, zipfile
import hashlib
from runner import ROOT, run, write
sha=lambda b:hashlib.sha256(b).hexdigest()
PRIOR=ROOT.parent/'official-final-3ff79982'
_, out, _ = run('11-preparation-tools-pin', ['git', 'rev-parse', 'HEAD', 'HEAD^{tree}'], ROOT / 'tools')
pins = out.read_text().splitlines()
_, out, _ = run('12-preparation-tools-clean', ['git', 'status', '--porcelain'], ROOT / 'tools')
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
public = ROOT / 'public/cs280-release-prep/codex-final-2'
public.mkdir(parents=True)
frozen = ROOT / 'frozen-raw'
frozen.mkdir()
sources = [(p, 'raw/' + p.relative_to(ROOT / 'raw').as_posix()) for p in sorted((ROOT / 'raw').rglob('*'))
           if p.is_file() and p.name not in ('10-public-preparation-driver.stdout.log', '10-public-preparation-driver.stderr.log')]
sources += [(p, 'checked-in-tools/' + p.name) for p in sorted((ROOT / 'tools').glob('*.py'))]
sources += [(ROOT / 'tools/.gitignore', 'checked-in-tools/.gitignore')]
supplied = json.loads((PRIOR / 'raw/SUPPLIED.json').read_text())
sources += [(PRIOR / 'codex-home-disposable' / row['temporaryPath'], 'supplied-official/' + row['temporaryPath']) for row in supplied['verifiedFiles']]

# Include actual completed final1 post-cutoff worklogs and their proof inputs.
# Drive/Library provider responses and raw service values remain private.
initial=json.loads((PRIOR/'audit/DELIVERY.json').read_text())['cutoffUtc']
records=[json.loads(line) for line in (PRIOR/'raw/logs/commands.jsonl').read_text().splitlines()]
for record in records:
    if record['finishedUtc'] > initial:
        for suffix in ('.stdout.log','.stderr.log','.command.json'):
            p=PRIOR/'raw/logs'/(record['label']+suffix)
            sources.append((p,'prior-final1/post-cutoff/logs/'+p.name))
sources.append((PRIOR/'raw/logs/commands.jsonl','prior-final1/post-cutoff/logs/commands.jsonl'))
for p in sorted((PRIOR/'audit').glob('*.json')):
    if '.private.' not in p.name and p.name!='known-private-resource-ids.json':
        sources.append((p,'prior-final1/post-cutoff/audit/'+p.name))
for name in ('SOURCE-PIN.json','SUPPLIER-PIN.json','SUPPLIED.json','INSTALL-RESULT.json','ENVIRONMENT.json','PNPM-WORKSPACE-STATE.json','OFFICIAL-RESULT.json','ANNOTATED-RESULT.json'):
    sources.append((PRIOR/'raw'/name,'prior-final1/prerequisites/'+name))
for suffix in ('.stdout.log','.stderr.log','.command.json'):
    p=PRIOR/'raw/logs'/('30-final-validate-official'+suffix)
    sources.append((p,'prior-final1/prerequisites/'+p.name))
sources.append((PRIOR/'tools/publish.py','prior-final1/executed-tools/publish.py'))

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
    ledger.append(dict(path=name, sourcePath=str(source), originalBytes=len(data), originalSha256=sha(data),
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
(public / 'STATUS.json').write_bytes((ROOT / 'raw/STATUS.json').read_bytes())
(public / 'TOOLS-PIN.json').write_bytes(encode(dict(commit=pins[0], tree=pins[1], clean=True, checkedIn=True)))
(public / 'COLLECTION.json').write_bytes(encode(dict(
    cutoffUtc=cutoff,candidate='b7341d3e6636b79217b1f3d37d7a5014fcbf47be',tree='5648f76558e923244cedf78a8263892d00df8299',
    sourceTrackedFiles=1344,sourceByteExactPrePost=True,supplier='10382da79a2a2d6e8ae221fa63077215389c1ad2',supplierFilesByteExact=5,
    actualOfficial='ONE authorized child-store binding pnpm run validate:official, exit0, plugin PASS plus22 skill PASS',
    priorWrapperFailures='First official1 user-store ENOENT and final1 unsupported run store-dir retained; original FAIL/NOT_RUN not overwritten',
    dependencyInput='Reused locked final1 private store/node_modules. Child config get store-dir and store path matched; workspace/module state and lock unchanged',
    internalPnpmPrefix='Already up to date / Done observed; detailed invocation path untraced, raw narrow implicitInstallObserved flag not a zero-call claim',
    priorFinal1='Existing187-file remote folder c46f20c283a9a31198dcea262e0b65b2f9eafefe unchanged. Its actual post-cutoff worklogs/proof inputs included in prior-final1 subtree, metadata only for other existing evidence; no other session transcript/body copied.',
    unavailable='Full native transcript and unexported read-only exploratory tool stdout NOT_VERIFIABLE. No internal reasoning reconstructed. Drive/Library provider signed URL/service values excluded.',
    publication='Only new authorized cs280-release-prep/codex-final-2 subtree; no first official1 publication, main/tag/release/host install writes',
    remaining='Plain fullLinux3F not rerun/promoted, quality A/B/C NOT_RUN, signed whole lifecycle/global acceptance NOT_IMPLEMENTED, SOURCE/release audit separate parent responsibility',
    postCutoff='13,14 and10 completion, scope/preflight/push/Library delivery outside initial packet; actual local captures retained with final delivery cutoff separately')))
(public / 'README.ko.md').write_text(
    '최종 source b7341d3/tree5648f765에서 공식 metadata 검사는 PASS다. child pnpm_config_store_dir로 검증된 private store를 결속하고 config get/store path 두 관측을 대조한 뒤 pnpm run validate:official 1회 exit0, plugin과22 skill 모두 PASS. gate override/--config.unknown[REDACTED:PRIVATE_HOME] config repair0, 새 명시적 install 명령0. source1344/lock/workspace-module state/supplier5 bytes 전후 동일하다.\\n\\n'
    'stdout Already up to date/Done 문구를 보존한다. 내부 경로는 process trace로 확정하지 않았고 기존 heuristic false를 내부 호출0의 근거로 쓰지 않는다. 전체 node_modules payload는 사전 hash하지 않았다. 공식 plugin/skills metadata 범위 PASS이며 full regression/runtime/품질/독립감사/실호스트 설치/출시 승인과 구분한다.\\n\\n'
    '과거 official1/final1의 실제 pnpm 실패·NOT_RUN 및 준비 실패/보정을 그대로 유지했다. 새 final2에는 final1 게시 후처리/scope/preflight/push 실제 캡처와 raw/public SHA도 포함하며 기존 final1 파일은 수정하지 않는다. 첫 sanitized ZIP Drive 전달과 provider 서비스값은 별도 private receipt이며 raw ZIP/key/DB/store payload/internal reasoning/다른 세션 원문은 공개 제외다. cutoff 뒤 자기 배달로그는 별도 경량 receipt로 남겨 무한 재게시하지 않는다.\\n')
run('13-public-residual-scan', ['python', str(prior / 'scan-public.py'), str(ROOT), str(public)], ROOT)
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
(public / 'MANIFEST.json').write_bytes(encode(dict(prefix='cs280-release-prep/codex-final-2', cutoffUtc=cutoff, files=files,
    hashCycleRule='MANIFEST excludes own bytes and SHA256SUMS; SUMS includes MANIFEST but excludes itself; external delivery ZIP receipt binds final bytes.')))
manifest_sha = sha((public / 'MANIFEST.json').read_bytes())
(public / 'SHA256SUMS').write_text('\n'.join(r['sha256']+'  '+r['path'] for r in files)+'\n'+manifest_sha+'  MANIFEST.json\n')
run('14-public-sums', ['sha256sum', '--check', '--quiet', 'SHA256SUMS'], public)
packet = ROOT / 'AGS-CS280-Codex-final-2-review.zip'
with zipfile.ZipFile(packet, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for p in sorted(public.rglob('*')):
        if p.is_file(): z.write(p, 'cs280-release-prep/codex-final-2/'+p.relative_to(public).as_posix())
with zipfile.ZipFile(packet) as z:
    assert len(z.namelist()) == len(files)+2
    for name in z.namelist(): assert z.read(name) == (ROOT / 'public' / name).read_bytes()
private = ROOT / 'private-original-evidence.zip'
with zipfile.ZipFile(private, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for p in sorted(frozen.rglob('*')):
        if p.is_file(): z.write(p, p.relative_to(frozen).as_posix())
private.chmod(0o400)
delivery = dict(status='PREPARED_OFFICIAL_METADATA_PASS', cutoffUtc=cutoff, publicPath=str(public), publicFiles=len(files)+2, rawSourceFiles=len(ledger),
    rawInventorySha256=inventory_sha, redactionMatches=sum(counts.values()), nulDelimitersEscaped=sum(r['nulDelimitersEscaped'] for r in ledger), residualFindings=0,
    manifestSha256=manifest_sha, sumsSha256=sha((public / 'SHA256SUMS').read_bytes()), toolsCommit=pins[0],
    reviewZip=dict(path=str(packet), bytes=packet.stat().st_size, sha256=sha(packet.read_bytes())),
    privateOriginalZip=dict(path=str(private), bytes=private.stat().st_size, sha256=sha(private.read_bytes()), uploaded=False),
    rawPath=str(ROOT/'raw'), afterCutoff='13,14,10 completion, publication/preflight/scope/push/Library receipt outside this initial packet')
(audit / 'DELIVERY.json').write_bytes(encode(delivery))
print(json.dumps(delivery, ensure_ascii=False, indent=2))

