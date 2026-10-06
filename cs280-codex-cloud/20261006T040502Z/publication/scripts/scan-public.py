import collections, hashlib, ipaddress, json, pathlib, re, sys

root, public = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
known = json.loads((root/'audit/known-private-resource-ids.json').read_text())
checks = {
    'PEM': re.compile(r'-----BEGIN [A-Z ]*(?:KEY|CERTIFICATE)-----'),
    'API_CREDENTIAL': re.compile(r'\b(?:github_pat_|gh[pousr]_|sk-|AKIA|ASIA)[A-Za-z0-9_+/-]{12,}'),
    'JWT': re.compile(r'eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+'),
    'EMAIL': re.compile(r'\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b'),
    'PRIVATE_HOME': re.compile(r'[REDACTED:PRIVATE_HOME]/\s]+|[REDACTED:PRIVATE_HOME]/\s]+|[REDACTED:PRIVATE_HOME](?:/|\b)|[REDACTED:PRIVATE_HOME]|[A-Za-z]:[\\/]+(?:Users|codex|claude)[\\/]+', re.I),
    'PRIVATE_RESOURCE': re.compile(r'\b(?:libfile|libdir|file)_[A-Za-z0-9_-]{10,}\b|sediment://'),
    'SOCKET_PATH': re.compile(r'(?:/[A-Za-z0-9_.-]+)+\.(?:sock|socket)\b|\\\\\.\\pipe\\[^\s]+'),
    'ACCOUNT_NAME': re.compile(r'(?<![A-Za-z0-9_])(?:[REDACTED:ACCOUNT_NAME]|[REDACTED:ACCOUNT_NAME])(?![A-Za-z0-9_])'),
    'BEARER': re.compile(r'(?i)\bBearer\s+[A-Za-z0-9._~+/-]{8,}'),
    'UNREDACTED_URL_QUERY': re.compile(r'https?://[^\s"\'<>]+\?(?!REDACTED_QUERY\b)[^\s"\'<>]+'),
}
ip4 = re.compile(r'(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?![\w.])')
ip6 = re.compile(r'(?<![\w])(?:[0-9a-fA-F]{0,4}:){2,}[0-9a-fA-F:]{0,39}(?![\w])')
findings, inventory = [], []
denied = re.compile(r'\.(?:sqlite3?|db|wal|shm|key|pem|p12|pfx|bundle|zip|patch)(?:-(?:wal|shm))?$', re.I)
def add(path, check, count):
    if count: findings.append(dict(path=path, check=check, count=count))
for p in sorted(public.rglob('*')):
    if not p.is_file(): continue
    relative = p.relative_to(public).as_posix()
    if relative in ('RESIDUAL-SCAN.json', 'MANIFEST.json', 'SHA256SUMS'): continue
    assert not p.is_symlink() and not denied.search(relative), relative
    data = p.read_bytes(); assert b'\0' not in data
    text = data.decode('utf-8')
    if p.suffix == '.json': json.loads(text)
    if p.suffix == '.jsonl':
        for line in text.splitlines():
            if line.strip(): json.loads(line)
    # Postprocessing code contains pattern definitions by design; do not label a
    # regex fixture as an actual credential. Those files still receive exact-id,
    # PEM-material, IP, URL-query and structured-value checks below.
    code = p.suffix == '.py'
    for label, pattern in checks.items():
        if code and label in ('PEM','PRIVATE_HOME','PRIVATE_RESOURCE','ACCOUNT_NAME','SOCKET_PATH'): continue
        add(relative, label, len(pattern.findall(text)))
    for value in known: add(relative, 'KNOWN_PRIVATE_RESOURCE_VALUE', text.count(value))
    for pattern in (ip4,ip6):
        count=0
        for match in pattern.finditer(text):
            try: ipaddress.ip_address(match.group(0));count+=1
            except ValueError: pass
        add(relative,'IP_ADDRESS',count)
    inventory.append(dict(path=relative, bytes=len(data), sha256=hashlib.sha256(data).hexdigest()))
result=dict(state='PASS' if not findings else 'FAIL', scannedFiles=len(inventory), findings=findings,
            checks=list(checks)+['IP_ADDRESS','KNOWN_PRIVATE_RESOURCE_VALUE','DENIED_FILE_TYPES','JSON_VALIDITY'],
            scope='Only the new public subtree; existing evidence contents are not modified or scanned for republishing.',
            caveat='Pattern-and-value scan plus direct review; not an independent security or SOURCE audit.')
(root/'audit/residual-scan-attempts.jsonl').open('a').write(json.dumps(result)+'\n')
(public/'RESIDUAL-SCAN.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
print(json.dumps(result));sys.exit(0 if not findings else 1)
