import hashlib, io, json, pathlib, re, subprocess, tarfile, zipfile

root = pathlib.Path(__file__).resolve().parent
repo, out = root.parent / 'repo', root / 'output'
head = 'f7912c452483ddc67ba874a185c08fa0038a38e7'
parent = '3b9c34b0dc0ca65d74db1631cc5fdd4898b7f2d7'
original = '4ba47558020bd5e501fa9718f09d562dcf573713'
baseline = 'f39501efe5dfe51d83af9afddf39dec7b7e26b01'
git = lambda *args: subprocess.check_output(['git', *args], cwd=repo)
sha = lambda raw: hashlib.sha256(raw).hexdigest()
encoded = lambda value: (json.dumps(value, ensure_ascii=False, indent=2) + '\n').encode()
assert git('rev-parse', 'HEAD').decode().strip() == head and not git('status', '--porcelain')
payload, modes, source = {}, {}, []
with tarfile.open(fileobj=io.BytesIO(git('archive', '--format=tar', head))) as tar:
    for entry in tar:
        if entry.isdir(): continue
        assert entry.isfile() and not entry.name.startswith('/') and '..' not in pathlib.PurePosixPath(entry.name).parts
        raw = tar.extractfile(entry).read()
        name = 'source/' + entry.name
        payload[name], modes[name] = raw, entry.mode
        source.append(dict(path=entry.name, bytes=len(raw), sha256=sha(raw), mode=oct(entry.mode)))
original_zip = root.parent / 'output/AGS-2.8.0-CS-RC-review.zip'
r1_zip = root.parent / 'linux-lifecycle-r1/output/AGS-2.8.0-CS-Linux-lifecycle-r1-review.zip'
assert sha(original_zip.read_bytes()) == '2f4067919ec83cccef39650cdac61d4dca61d47e9c8ccdf4558fe0f011f06fc4'
assert sha(r1_zip.read_bytes()) == '06305d4faa2ac07f14170c2742185c4e2564f50b48bee66cd0ed070341867317'
with zipfile.ZipFile(original_zip) as z:
    old_manifest = json.loads(z.read('source-manifest.json'))
    differences = [f['path'] for f in old_manifest['files'] if sha(payload['source/' + f['path']]) != f['sha256']]
    assert differences == ['tests/session-messaging/historical-wake.test.mjs', 'tests/session-messaging/session-message.test.ts']
    for name in ('source-pin.json', 'verification-status.json', 'verification-report.ko.md',
                 'evidence/13d-full-tests.log', 'evidence/19-baseline-fixtures.log', 'evidence/15-official.log'):
        payload['original-r0/' + name] = z.read(name)
with zipfile.ZipFile(r1_zip) as z:
    for name in ('source-pin.json', 'verification-status.json', 'verification-report.ko.md',
                 'evidence/01-unreaped.observations.json', 'evidence/03-harness-fixtures.observations.json',
                 'evidence/07-full-process-only.log'):
        payload['original-r1/' + name] = z.read(name)
payload['original-r1/delivery-receipt.json'] = (r1_zip.parent / 'delivery-receipt.json').read_bytes()
changes = [dict(status=s, path=p) for s, p in (line.split('\t') for line in git('diff', '--name-status', parent, head).decode().splitlines())]
assert len(changes) == 4 and all(c['path'].startswith('tests/') for c in changes)
all_changes = [dict(status=s, path=p) for s, p in (line.split('\t') for line in git('diff', '--name-status', original, head).decode().splitlines())]
assert len(all_changes) == 6 and all(c['path'].startswith('tests/') for c in all_changes)
commands = [json.loads(x) for x in (root / 'evidence/commands.jsonl').read_text().splitlines()]
assert len(commands) == 7
classification = json.loads((root / 'evidence/fixture-lifecycle-classification.json').read_text())
assert classification['repeatedExecutedCases'] == 0
baseline_manifest = json.loads((root / 'evidence/baseline-source-manifest.json').read_text())
assert not baseline_manifest['unexpectedOtherSourceByteDifferences']
pin = dict(revision='Linux-lifecycle-r2', requestId='c1a7252a-c8ed-4fd4-8d49-c744043e91d3',
           messageId='22dbddf1-56a8-4711-8356-3870c12de69e', leadThread='01a1023f-b277-7ef1-bb48-4b90770caf13',
           sourceCommit=head, sourceTree=git('rev-parse', head + '^{tree}').decode().strip(),
           parentCommit=parent, productReference=original, baselineReference=baseline,
           worktree=str(repo), branch='codex/cs-engineering-2x', worktreeClean=True,
           changedFiles=changes, allChangesSinceOriginal=all_changes, sourceFiles=len(source),
           originalSourceFilesCompared=len(old_manifest['files']), originalSourceByteDifferences=differences,
           productionSourceDifferences=[], productionChanges=False,
           baselineOverlay='Same four observer/fixture files as candidate; recorded f395 worktree has declared fixture modifications.',
           baselineSourceManifest='evidence/baseline-source-manifest.json',
           originalZipUnmodified=True, originalZipSha256=sha(original_zip.read_bytes()),
           r1ZipUnmodified=True, r1ZipSha256=sha(r1_zip.read_bytes()),
           remoteWrites=False, assertionsTimeoutsSkipsChanged=False,
           fullRegressionOnThisPin='NOT_RUN', priorFullRegressionPin=parent)
status = dict(state='SCOPED_LINUX_FIXTURE_CAUSE_CONFIRMED',
              confirmedCause=classification['confirmedCause'],
              candidate=dict(passed=1, failed=3, notSelected=132, exitCode=1, sourcePin=head),
              baselineSessionAttempt=dict(passed=0, failed=2, notSelected=69, workerErrors=1, exitCode=1),
              baselineHistoryCompletion=dict(passed=1, failed=1, notSelected=63, exitCode=1),
              distinctBaselineExecutedCases=dict(passed=1, failed=3, repeatedExecutedCases=0),
              targetsConfirmed=6, databaseObserver=False, supervisorEnabled=False,
              staticChecks=dict(typecheck='PASS', lint='PASS', sourceLock='PASS', bundle='PASS', gitDiff='PASS', gitBundle='PASS'),
              fullRegression='NOT_RUN on f791; prior r1 whole-suite result is pinned separately to 3b9c',
              windows='NOT_RUN here; separate original failure cluster unresolved by this result',
              claudeCloudRuntime='NOT_RUN here', independentSourceAudit='NOT_RUN on new pin',
              officialValidator='BLOCKED: original official script absent',
              remainingNotImplemented=['signed1.1 full-lifecycle CS binding', 'global acceptance/applicability'],
              releasePublished=False)
for p in sorted((root / 'evidence').iterdir()):
    if p.is_file(): payload['evidence/' + p.name] = p.read_bytes()
for name in ('run-recorded.py', 'analyze.py', 'build-review.py'):
    payload['evidence/scripts/' + name] = (root / name).read_bytes()
for name in ('verification-report.ko.md', 'AGS-2.8.0-CS-Linux-lifecycle-r2.patch', 'AGS-2.8.0-CS-Linux-lifecycle-r2.bundle'):
    payload[name] = (out / name).read_bytes()
payload['AGS-2.8.0-CS-Linux-lifecycle-combined.patch'] = git('format-patch', '--stdout', '--binary', original + '..' + head)
payload['source-pin.json'], payload['verification-status.json'] = encoded(pin), encoded(status)
payload['change-list.json'] = encoded(changes)
payload['source-manifest.json'] = encoded(dict(sourceCommit=head, files=source))
payload['evidence-manifest.json'] = encoded(dict(sourceCommit=head, files=[dict(path=n, bytes=len(b), sha256=sha(b)) for n, b in sorted(payload.items()) if n.startswith('evidence/')]))
for name, raw in payload.items():
    for pattern in (rb'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----', rb'gh[pousr]_[A-Za-z0-9]{20,}', rb'sk-[A-Za-z0-9]{20,}', rb'Bearer [A-Za-z0-9_-]{32,}'):
        assert not re.search(pattern, raw), 'Secret pattern in ' + name
manifest = dict(sourceCommit=head, scope='Every entry except MANIFEST.json itself; ZIP hash is external.',
                files=[dict(path=n, bytes=len(b), sha256=sha(b)) for n, b in sorted(payload.items())])
payload['MANIFEST.json'] = encoded(manifest)
zip_path = out / 'AGS-2.8.0-CS-Linux-lifecycle-r2-review.zip'
assert not zip_path.exists()
with zipfile.ZipFile(zip_path, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for name, raw in sorted(payload.items()):
        info = zipfile.ZipInfo(name, (2026, 10, 6, 3, 36, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = ((0o100000 | modes.get(name, 0o644)) << 16)
        z.writestr(info, raw, compresslevel=9)
with zipfile.ZipFile(zip_path) as z:
    assert z.testzip() is None and set(z.namelist()) == set(payload)
    for f in manifest['files']:
        raw = z.read(f['path'])
        assert len(raw) == f['bytes'] and sha(raw) == f['sha256']
result = dict(path=str(zip_path), bytes=zip_path.stat().st_size, sha256=sha(zip_path.read_bytes()),
              entries=len(payload), sourceCommit=head, sourceFiles=len(source),
              original1344SourceByteDifferences=differences, manifestVerified=True, secretPatternMatches=0)
for name in ('source-pin.json', 'verification-status.json', 'change-list.json', 'AGS-2.8.0-CS-Linux-lifecycle-combined.patch'):
    (out / name).write_bytes(payload[name])
(out / 'zip-verification.json').write_bytes(encoded(result))
print(json.dumps(result))
