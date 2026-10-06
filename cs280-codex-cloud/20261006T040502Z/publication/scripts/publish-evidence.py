import collections, datetime, hashlib, ipaddress, json, os, pathlib, re, shutil, subprocess, sys, urllib.parse, zipfile

root = pathlib.Path(sys.argv[1]).resolve()
cs = pathlib.Path('/workspace/ags-cs-2x')
prefix = 'cs280-codex-cloud/' + root.name.removeprefix('publication-')
rawroot, public = root / 'private', root / 'public' / prefix
sha = lambda b: hashlib.sha256(b).hexdigest()
encode = lambda j: (json.dumps(j, ensure_ascii=False, indent=2) + '\n').encode()
records, exclusions, ids = [], [], set()
stage_dirs = {'original': cs, 'r1': cs / 'linux-lifecycle-r1', 'r2': cs / 'linux-lifecycle-r2'}
secret_key = re.compile(r'^(?:password|passwd|secret|client_secret|credential|credentials|access_token|refresh_token|token|authorization|auth|integrityToken|nonce|signature|privateKey|private_key|publicKey|public_key|key|api_key|apiKey|hmac_key|encrypted_key|download_url|b64_string)$', re.I)
resource_key = re.compile(r'^(?:id|file_?id|folder_?id|directory_?id|library_?file_?id|parent_?id|parent_?ids|parentFolderId|fileParentId|parents|drive_?id)$', re.I)
email_key = re.compile(r'^(?:email|emailAddress|account|accountName|displayName|userName)$', re.I)

def discover_ids(value, key=''):
    if isinstance(value, dict):
        for k, v in value.items(): discover_ids(v, k)
    elif isinstance(value, list):
        for v in value: discover_ids(v, key)
    elif isinstance(value, str) and resource_key.match(key):
        if re.fullmatch(r'1[A-Za-z0-9_-]{24,43}', value) and not re.fullmatch(r'[0-9a-f]{40}', value): ids.add(value)

def capture(stage, relative, data, source_locator):
    p = rawroot / stage / relative
    assert not p.exists()
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(data); p.chmod(0o400)
    records.append(dict(stage=stage, path=stage + '/' + relative, originalBytes=len(data), originalSha256=sha(data), source=source_locator))
    try: discover_ids(json.loads(data))
    except (ValueError, UnicodeError): pass

for stage, directory in stage_dirs.items():
    for p in sorted((directory / 'evidence').iterdir()):
        if p.is_file(): capture(stage, 'evidence/' + p.name, p.read_bytes(), str(p))
    for p in sorted((directory / 'output').iterdir()):
        if not p.is_file(): continue
        if p.suffix in ('.json', '.md', '.log', '.jsonl'):
            capture(stage, 'reports/' + p.name, p.read_bytes(), str(p))
        else:
            exclusions.append(dict(stage=stage, path=stage + '/excluded/' + p.name, bytes=p.stat().st_size,
                                   originalSha256=sha(p.read_bytes()), reason='Private archive/bundle or source patch; excluded from evidence-only publication'))
    for p in sorted(directory.glob('*.py')):
        capture(stage, 'postprocessing/' + p.name, p.read_bytes(), str(p))
for p in cs.glob('*.bundle'):
    exclusions.append(dict(stage='original', path='original/excluded/' + p.name, bytes=p.stat().st_size,
                           originalSha256=sha(p.read_bytes()), reason='Private Git bundle'))
with zipfile.ZipFile(cs / 'output/AGS-2.8.0-CS-RC-review.zip') as z:
    for name in ('source-pin.json', 'verification-status.json', 'source-manifest.json', 'change-list.json', 'release-notes.ko.md'):
        if name in z.namelist(): capture('original', 'reports/archive-' + name, z.read(name), 'private ZIP entry:' + name)

patterns = [
    ('PEM_KEY_OR_CERTIFICATE', re.compile(r'-----BEGIN (?:[A-Z0-9 ]*(?:KEY|CERTIFICATE))-----.*?-----END [A-Z0-9 ]+-----', re.S)),
    ('CREDENTIAL_TOKEN', re.compile(r'\b(?:gh[pousr]_[A-Za-z0-9_]{10,}|github_pat_[A-Za-z0-9_]{10,}|sk-[A-Za-z0-9_-]{10,}|AKIA[A-Z0-9]{16}|ASIA[A-Z0-9]{16})\b')),
    ('BEARER_VALUE', re.compile(r'(?i)\bBearer\s+[A-Za-z0-9._~+/-]+=*')),
    ('JWT_VALUE', re.compile(r'\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b')),
    ('ACCOUNT_EMAIL', re.compile(r'\b[A-Za-z0-9.!#$%&*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b')),
    ('PRIVATE_RESOURCE', re.compile(r'\b(?:libfile|libdir|file)_[A-Za-z0-9_-]{10,}\b|[REDACTED:PRIVATE_RESOURCE]"\'<>]+')),
    ('PRIVATE_HOME', re.compile(r'(?:[REDACTED:PRIVATE_HOME]/\s"\'<>]+|[REDACTED:PRIVATE_HOME]/\s"\'<>]+|[REDACTED:PRIVATE_HOME](?=/|\b)|[REDACTED:PRIVATE_HOME]|[A-Z]:[/\\](?:Users[/\\][^/\\\s"\'<>]+|codex|claude))', re.I)),
    ('PRIVATE_ATTACHMENT', re.compile(r'/workspace/attachments/[A-Za-z0-9_-]+')),
    ('SOCKET_PATH', re.compile(r'(?:/[A-Za-z0-9_.-]+)+\.(?:sock|socket)\b|\\\\\.\\pipe\\[^\s"\'<>]+')),
    ('ACCOUNT_NAME', re.compile(r'(?<![A-Za-z0-9_])(?:[REDACTED:ACCOUNT_NAME]|[REDACTED:ACCOUNT_NAME])(?![A-Za-z0-9_])')),
]
ipv4 = re.compile(r'(?<![A-Za-z0-9.])(?:\d{1,3}\.){3}\d{1,3}(?![A-Za-z0-9.])')
ipv6 = re.compile(r'(?<![A-Za-z0-9])(?:[A-Fa-f0-9]{0,4}:){2,}[A-Fa-f0-9:]{0,39}(?![A-Za-z0-9])')
urls = re.compile(r'https?://[^\s"\'<>`]+')
assignment = re.compile(r'(?i)(\b(?:token|password|passwd|client_secret|api_key|authorization|nonce|private_key|public_key|hmac_key)\s*[=:]\s*)([A-Za-z0-9_+/.~-]{8,})')

def redact_text(text, counts):
    for kind, pattern in patterns:
        text, n = pattern.subn('[REDACTED:' + kind + ']', text); counts[kind] += n
    for resource in ids:
        text, n = re.subn(re.escape(resource), '[REDACTED:PRIVATE_RESOURCE]', text); counts['PRIVATE_RESOURCE'] += n
    def strip_url(match):
        value = match.group(0); parsed = urllib.parse.urlsplit(value)
        if parsed.username is not None or parsed.password is not None:
            value = parsed._replace(netloc=parsed.hostname or '').geturl(); counts['URL_CREDENTIAL'] += 1
        if urllib.parse.urlsplit(value).query:
            value = value.split('?', 1)[0] + '?REDACTED_QUERY'; counts['URL_QUERY'] += 1
        if re.search(r'https?://(?:docs|drive)\.google\.com/(?:file/d/|drive/folders/|document/d/|spreadsheets/d/|presentation/d/)', value):
            value = re.sub(r'((?:file|document|spreadsheets|presentation)/d/|drive/folders/)[^/?#]+', r'\1REDACTED_RESOURCE', value); counts['PRIVATE_RESOURCE_URL'] += 1
        return value
    text = urls.sub(strip_url, text)
    def mask_ip(match):
        value = match.group(0)
        try: ipaddress.ip_address(value)
        except ValueError: return value
        counts['IP_ADDRESS'] += 1; return '[REDACTED:IP_ADDRESS]'
    text = ipv4.sub(mask_ip, text); text = ipv6.sub(mask_ip, text)
    text, n = assignment.subn(r'\1[REDACTED:SECRET_ASSIGNMENT]', text); counts['SECRET_ASSIGNMENT'] += n
    return text

def walk(value, counts, key=''):
    policy_object = key == 'authorization' and isinstance(value, dict) and set(value) <= {'allowedActions', 'prohibitedActions', 'approvalRequired'}
    if value is not None and secret_key.match(key) and not policy_object:
        counts['SECRET_FIELD'] += 1; return '[REDACTED:SECRET_FIELD]'
    if value is not None and email_key.match(key) and isinstance(value, str):
        counts['ACCOUNT_FIELD'] += 1; return '[REDACTED:ACCOUNT_FIELD]'
    if isinstance(value, dict): return {k:walk(v, counts, k) for k, v in value.items()}
    if isinstance(value, list): return [walk(v, counts, key) for v in value]
    if isinstance(value, str): return redact_text(value, counts)
    return value

def redacted_bytes(data, suffix):
    text = data.decode('utf-8'); counts = collections.Counter()
    if suffix == '.json':
        text = json.dumps(walk(json.loads(text), counts), ensure_ascii=False, indent=2) + '\n'
    elif suffix == '.jsonl':
        text = ''.join(json.dumps(walk(json.loads(line), counts), ensure_ascii=False) + '\n' for line in text.splitlines() if line.strip())
    else:
        lines = []
        for line in text.splitlines(keepends=True):
            try:
                if line.lstrip().startswith(('{', '[')):
                    item = json.loads(line); lines.append(json.dumps(walk(item, counts), ensure_ascii=False) + '\n'); continue
            except ValueError: pass
            lines.append(redact_text(line, counts))
        text = ''.join(lines)
    return text.encode(), {k:v for k,v in counts.items() if v}

redaction = []
for record in records:
    p = rawroot / record['path']; data = p.read_bytes()
    assert sha(data) == record['originalSha256']
    published, counts = redacted_bytes(data, p.suffix)
    target = public / record['path']; target.parent.mkdir(parents=True, exist_ok=True); target.write_bytes(published)
    redaction.append(dict(path=record['path'], originalBytes=len(data), originalSha256=sha(data),
                          publicBytes=len(published), publicSha256=sha(published),
                          removalsByKind=counts, removalCount=sum(counts.values()),
                          formattingNormalized=data != published and not counts))

claims = {
    'original': {'sourcePin':'4ba47558020bd5e501fa9718f09d562dcf573713','wholeSuite':{'passed':911,'failed':3,'skipped':5,'total':919},'baselineMessaging':{'passed':133,'failed':3,'total':136},'officialValidator':'BLOCKED missing script','R042':'Lead-supplied selected-csstage STATIC PASS metadata; no runtime/release approval; verdict contents not supplied here'},
    'r1': {'sourcePin':'3b9c34b0dc0ca65d74db1631cc5fdd4898b7f2d7','supervisedWholeSuite':{'passed':914,'failed':0,'skipped':5,'total':919},'affectedFiles':{'passed':136,'failed':0},'unsupervisedFailures':'Original FAIL3 remains; never relabeled PASS','sourceAudit':'Stored implementation report says NOT_RUN. Lead references a separate static SOURCE result, but its verdict file is NOT_VERIFIABLE here.'},
    'r2': {'sourcePin':'f7912c452483ddc67ba874a185c08fa0038a38e7','result':'Six target PIDs retain starttime and Z/PPID1 with successful original kill-zero: scoped fixture orphan reaping cause confirmed','candidateSelectedCases':{'passed':1,'failed':3,'notSelected':132},'baselineSessionAttempt':{'failed':2,'workerError':1},'baselineHistoryCompletion':{'passed':1,'failed':1,'notSelected':63},'fullRegression':'NOT_RUN on this source pin; r1 PASS not reused','sourceAudit':'NOT_RUN on this source pin'},
    'common': {'signed1.1FullLifecycle':'NOT_IMPLEMENTED','globalAcceptance':'NOT_IMPLEMENTED','windows':'Different failure cluster; not resolved by Linux result','claudeCloudRuntime':'No actual execution observed by this Codex Cloud owner','productChangesForPublication':False,'newProductTestsForPublication':False,'releasePermission':False}
}
coverage = []
for stage, directory in stage_dirs.items():
    rows = [json.loads(x) for x in (directory/'evidence/commands.jsonl').read_text().splitlines()]
    bylog = {r.get('log',r['label']+'.log'):r for r in rows}
    for p in sorted((directory/'evidence').glob('*.log')):
        r = bylog.get(p.name); first = None
        try: first = json.loads(p.read_text().splitlines()[0])
        except (ValueError,IndexError): pass
        source = r or (first if isinstance(first,dict) and 'command' in first else None)
        coverage.append(dict(path=stage+'/evidence/'+p.name,
                             commandMetadata='AVAILABLE' if source else 'NOT_VERIFIABLE',
                             exit='AVAILABLE' if r and 'exitCode' in r else 'NOT_VERIFIABLE',
                             commandRecord=source,
                             stdoutStderr='MERGED_AS_CAPTURED; split originals NOT_VERIFIABLE'))
limitations = dict(nativeTranscript='NOT_VERIFIABLE: full native transcript export is not supplied by this environment; no reconstructed transcript is represented as native.',
                   standaloneToolStdoutStderr='NOT_VERIFIABLE except the existing captured merged execution logs and newly recorded publication commands.',
                   earlyCommandGaps='Listed per log in COMMAND-COVERAGE.json; no cwd/exit/timestamp invented.',
                   operationalHostLogs='NOT_VERIFIABLE; user PC/MCP/Claude Cloud was not queried.',
                   rawDatabaseKeyTrustFiles='EXCLUDED; no mutable fixture/operational DB/WAL/key/trust file is published or enumerated for values.',
                   privateArchivesBundles='EXCLUDED with raw SHA256 only; no raw ZIP/Git bundle/source patch is published.',
                   sourceAuditFiles='External lead-referenced verdict contents NOT_VERIFIABLE here; preserve available local reports and metadata scope.')
for name, value in [('CLAIMS.json',claims),('COMMAND-COVERAGE.json',coverage),('NOT-VERIFIABLE.json',limitations),('EXCLUSIONS.json',exclusions),('REDACTION.json',{'files':redaction,'totals':dict(originalFiles=len(records),publicCopies=len(redaction),excludedFiles=len(exclusions),removals=sum(r['removalCount'] for r in redaction))})]:
    # Generated metadata also passes the same public sanitizer.
    data, _ = redacted_bytes(encode(value), '.json'); (public/name).write_bytes(data)

readme = '''# CS 2.8.0 Codex Cloud 공개 증거 사본

original/r1/r2는 서로 다른 source pin의 실행·진단·후처리 자료다. 후보별 claim은 CLAIMS.json을 따른다. 실패·보정·exit7·worker 오류·공식 validator BLOCKED와 NOT_RUN을 보존했다. 이번 게시에서 새 제품 테스트나 제품 변경은 실행하지 않았다.

원본은 비공개 동결 사본으로 보존했다. REDACTION.json은 파일별 원본/공개 bytes·SHA256과 제거 종류/횟수를 고정한다. MANIFEST.json은 공개 payload의 exact 파일 집합을 고정하며 자체 해시는 별도 SHA256SUMS에 있다. removalCount는 제거된 raw 토큰 수가 아니라 규칙의 매칭·필드 제거 횟수다. JSON/log header의 표기 정규화도 원본 hash 차이를 만들 수 있다. 원 SHA가 있다는 사실만으로 제거된 원문이나 원 transcript를 공개 검증할 수 있다는 뜻은 아니다.

native 전체 transcript와 분리된 tool stdout/stderr는 제공되지 않았다. COMMAND-COVERAGE.json과 NOT-VERIFIABLE.json에 실제 보유·미제공 범위를 적었다. ZIP/Gitbundle/DB/WAL/key/trustfile/sourcepatch는 공개 제외다. SQLite fixture/PID/queue 관측 JSONL·JSON은 데이터베이스 파일이 아니며 민감 필드 제거 후 포함했다. 공개 payload만 residual scan과 직접 검토했다. 기존 evidence 폴더와 main/source branch는 수정하지 않는다.

r1 supervised PASS는 3b9c pin의 조건부 Linux 결과다. r2 f791 전체 회귀는 NOT_RUN이다. 외부 static SOURCE metadata는 실행·출시 권한이 아니며 확인하지 못한 verdict는 NOT_VERIFIABLE다. signed1.1 전체 lifecycle·전역 acceptance는 NOT_IMPLEMENTED를 유지한다.
'''
(public/'README.ko.md').write_text(readme)
(root/'audit/raw-inventory.json').write_bytes(encode(records))
(root/'audit/known-private-resource-ids.json').write_bytes(encode(sorted(ids)))
(root/'audit/redaction-preparation-summary.json').write_bytes(encode(dict(originalFiles=len(records),publicCopies=len(redaction),excludedFiles=len(exclusions),removalCount=sum(r['removalCount'] for r in redaction),prefix=prefix)))
print(json.dumps(json.loads((root/'audit/redaction-preparation-summary.json').read_text())))
