"""Append this authorized sanitized folder only, with fresh scope and mutation receipts."""
import datetime, json, os, pathlib, shutil, subprocess
import hashlib
from runner import ROOT, run
sha=lambda b:hashlib.sha256(b).hexdigest()
audit = ROOT / 'audit'
repo = ROOT / 'evidence-repo'
prefix = 'cs280-release-prep/codex-final-2'
skills = ROOT.parent / 'official-final-3ff79982/candidate/skills'
prior = ROOT.parent / 'publication-20261006T040502Z'
encode = lambda value: (json.dumps(value, ensure_ascii=False, indent=2)+'\n').encode()
def write(name, value):
    path = audit / name
    assert not path.exists()
    path.write_bytes(encode(value))
    return path
def git(label, *args, check=True, env=None):
    code, out, err = run(label, ['git', *map(str, args)], repo, env=env, check=check)
    return out.read_text().strip()
delivery = json.loads((audit / 'DELIVERY.json').read_text())
public = pathlib.Path(delivery['publicPath'])
assert sha((public / 'MANIFEST.json').read_bytes()) == delivery['manifestSha256']
assert sha((public / 'SHA256SUMS').read_bytes()) == delivery['sumsSha256']
assert json.loads((public / 'RESIDUAL-SCAN.json').read_text())['state'] == 'PASS'
for row in json.loads((public / 'REDACTION.json').read_text())['files']:
    original = ROOT / 'frozen-raw' / row['path']
    if not original.is_file(): original = ROOT / 'frozen-correction' / row['path']
    assert sha(original.read_bytes()) == row['originalSha256']
    assert sha((public / row['path']).read_bytes()) == row['publicSha256']
assert not repo.exists()
run('P01-evidence-init', ['git', 'init', str(repo)], ROOT)
git('P02-evidence-origin', 'remote', 'add', 'origin', 'https://github.com/jaeseongs95/agent-governance-suite.git')
git('P03-evidence-fetch', 'fetch', '--no-tags', 'origin', 'refs/heads/evidence')
git('P04-evidence-checkout', 'checkout', '--detach', 'FETCH_HEAD')
base = git('P05-evidence-base', 'rev-parse', 'HEAD')
tree = git('P06-evidence-tree', 'rev-parse', 'HEAD^{tree}')
assert git('P07-evidence-clean', 'status', '--porcelain') == ''
assert git('P08-target-absent', 'ls-tree', 'HEAD', '--', prefix) == '', 'Target exists; never overwrite'
old_tree = git('P09-old-paths', 'ls-tree', '-r', '--full-tree', 'HEAD')
main_before = git('P10-main-ref', 'ls-remote', 'origin', 'refs/heads/main').split()[0]
assert main_before in ('f39501efe5dfe51d83af9afddf39dec7b7e26b01','b7341d3e6636b79217b1f3d37d7a5014fcbf47be'), 'Unknown upstream context; withhold evidence publication'
template = json.loads((prior / 'audit/scope-capture-input-supplement.json').read_text())['taskEnvelope']
template.update(taskId='cs280-final2-official-evidence-d0ce2935', objective='Append sanitized actual final-pin official metadata PASS with unchanged prior failures')
template['scope']['included'] = [prefix+'/']
template['scope']['excluded'] = ['cs280-codex-cloud/', 'cs280-claude-cloud/', 'cs280-release-prep/codex-official-1/', 'main/', 'source/']
template['workUnits'][0].update(id='append-final-official-evidence', objective='Publish exact sanitized final2 payload', writeTargets=[prefix+'/'])
template['acceptanceCriteria'] = ['Exact raw/public SHA and command/exit order retained', 'Existing failure and NOT_RUN claims preserved',
    'Only new designated final2 prefix added and all existing evidence blobs preserved', 'No main/source/tag/release/host install change']
capture = write('scope-capture-input.json', dict(schemaVersion='1.0.0', mode='capture', repositoryRoot=str(repo), comparisonTarget='index', taskEnvelope=template))
_, out, _ = run('P11-scope-baseline', ['node', str(skills/'change-scope-guardian/scripts/capture-workspace-baseline.mjs'), str(capture)], repo)
baseline = json.loads(out.read_text())
assert baseline['head'] == base and all(row['status']=='clean' for row in baseline['entries'])
write('scope-baseline.json', baseline)
frozen = write('scope-baseline-frozen.json', dict(digest=baseline['manifestSha256'], head=base))
frozen.chmod(0o400)
dest = repo / prefix
dest.parent.mkdir(parents=True, exist_ok=True)
shutil.copytree(public, dest)
git('P12-stage-only-new-prefix', 'add', '--', prefix+'/')
verify = write('scope-verify-input.json', dict(schemaVersion='1.0.0', mode='verify', repositoryRoot=str(repo), comparisonTarget='index',
    taskEnvelope=template, baseline=baseline, baselineArtifactDigest=json.loads(frozen.read_text())['digest']))
_, out, _ = run('P13-scope-verify', ['node', str(skills/'change-scope-guardian/scripts/compare-change-scope.mjs'), str(verify)], repo)
scope = json.loads(out.read_text())
assert scope['verdict'] == 'PASS'
write('scope-report.json', scope)
temp_index = audit / 'restore.index.private'
shutil.copyfile(repo / '.git/index', temp_index)
env = os.environ.copy()
env['GIT_INDEX_FILE'] = str(temp_index)
paths = git('P14-new-paths', 'ls-files', '--', prefix+'/').splitlines()
assert len(paths) == delivery['publicFiles']
git('P15-restore-rehearsal-remove', 'update-index', '--force-remove', '--', *paths, env=env)
restored = git('P16-restore-tree', 'write-tree', env=env)
assert restored == tree
restore = write('restore-rehearsal.json', dict(baseTree=tree, restoredTree=restored, exact=True,
    method='Only separate temporary index removes ownnew new paths; actual index/worktree/existing folders untouched'))
state = dict(evidenceTip=base, evidenceTree=tree, mainRef=main_before, newPrefix=prefix, newPrefixAbsent=True,
             existingPaths=len(baseline['entries']), payloadManifest=delivery['manifestSha256'])
state_path = write('current-state.json', state)
fingerprint = 'sha256:'+sha(json.dumps(state, sort_keys=True, separators=(',',':')).encode())
target = 'https://github.com/jaeseongs95/agent-governance-suite/tree/evidence/'+prefix
operation = 'cs280-final2-official-evidence-d0ce2935'
auth = write('authorization.json', dict(operationId=operation, actionClass='publish', target=target, environment='external',
    userAuthorizationMessageIds=['83b9158e-65f8-41a9-9034-517a82850bcf','0a4424c4-3881-45d6-a256-85c0ab961681','d0ce2935-ef6b-45b5-b3d0-68b4fc2a1c75'],
    basis='Current explicit delegation permits finalfollowup append only at this exact prefix under user evidence-posting authorization. Existing official1/final1 files unchanged; this explicit changed-input final2 append is authorized.',
    receiptWindow='Adapter imposes local15-minute freshness bound, not a new grant/renewal or user authorization expiry.'))
intent = json.loads((prior / 'audit/mutation-intent-supplement.json').read_text())
intent['operationId'] = operation
intent['targets'][0].update(locator=target, expectedFingerprint=fingerprint)
intent['plannedCommandOrTool']['action'] = 'git push origin HEAD:refs/heads/evidence (nonforce; append only '+prefix+'/)'
intent['scopeRef'].update(locator=str(capture), digest='sha256:'+sha(capture.read_bytes()), includedTargets=[target],
    excludedTargets=['https://github.com/jaeseongs95/agent-governance-suite/tree/main', 'https://github.com/jaeseongs95/agent-governance-suite/tree/evidence/cs280-codex-cloud',
                     'https://github.com/jaeseongs95/agent-governance-suite/tree/evidence/cs280-claude-cloud', 'https://github.com/jaeseongs95/agent-governance-suite/tree/evidence/cs280-release-prep/codex-official-1'])
intent['authorizationRef'].update(locator=str(auth), digest='sha256:'+sha(auth.read_bytes()), allowedTargets=[target])
intent['approvalEvidenceRefs'][0].update(locator=str(auth), digest='sha256:'+sha(auth.read_bytes()), operationId=operation,
    targetLocators=[target], expiresAt=(datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(minutes=15)).isoformat())
intent['currentStateEvidenceRefs'][0].update(locator=str(state_path), digest='sha256:'+sha(state_path.read_bytes()), targetLocator=target, fingerprint=fingerprint)
intent['recoveryPlan'].update(backupRef=str(frozen), restoreProcedureRef=str(restore), restoreTestEvidenceRef=str(restore))
intent_path = write('mutation-intent.json', intent)
_, out, _ = run('P17-mutation-preflight', ['node', str(skills/'mutation-risk-preflight/scripts/evaluate-preflight.mjs'), '--input', str(intent_path)], repo)
report = json.loads(out.read_text())
assert report['verdict'] == 'READY'
write('mutation-report.json', report)
receipt = write('mutation-receipt-input.json', dict(report=report, intent=intent))
_, out, _ = run('P18-mutation-receipt', ['node', str(skills/'mutation-risk-preflight/scripts/verify-preflight-receipt.mjs'), '--input', str(receipt)], repo)
assert json.loads(out.read_text())['valid'] is True
assert git('P19-remote-ref-before-commit', 'ls-remote', 'origin', 'refs/heads/evidence').split()[0] == base, 'Remote drift: stop, preserve all logs'
changes = git('P20-exact-staged-scope', 'diff', '--cached', '--name-status').splitlines()
assert len(changes)==delivery['publicFiles'] and all(row.startswith('A\t'+prefix+'/') for row in changes)
run('P21-staged-sums', ['sha256sum', '--check', '--quiet', 'SHA256SUMS'], dest)
git('P22-evidence-commit', '-c', 'user.name=Codex-Cloud-Evidence', '-c', 'user.email=redacted', '-c', 'commit.gpgsign=false',
    'commit', '-m', 'docs: append CS final official metadata pass and preserved prior worklogs')
commit = git('P23-published-commit', 'rev-parse', 'HEAD')
final_tree = git('P24-published-tree', 'rev-parse', 'HEAD^{tree}')
assert git('P25-prior-tree-exact', 'ls-tree', '-r', '--full-tree', base) == old_tree
git('P26-nonforce-evidence-push', 'push', 'origin', 'HEAD:refs/heads/evidence')
remote = git('P27-remote-ref-after-push', 'ls-remote', 'origin', 'refs/heads/evidence').split()[0]
assert remote == commit
git('P28-refetch-actual-remote', 'fetch', '--no-tags', 'origin', 'refs/heads/evidence')
assert git('P29-remote-pin', 'rev-parse', 'FETCH_HEAD') == commit
for p in sorted(public.rglob('*')):
    if not p.is_file(): continue
    relative = prefix+'/'+p.relative_to(public).as_posix()
    # Read actual refetched commit blobs as binary; no shell substitution or inline process code.
    data = subprocess.check_output(['git', 'show', commit+':'+relative], cwd=repo)
    assert data == p.read_bytes()
remote_changes = git('P30-remote-change-scope', 'diff', '--name-status', base, commit).splitlines()
assert remote_changes == changes
main_after = git('P31-main-after', 'ls-remote', 'origin', 'refs/heads/main').split()[0]
assert main_after in (main_before,'b7341d3e6636b79217b1f3d37d7a5014fcbf47be'), 'Unexpected concurrent upstream context'
result = dict(status='PUSHED_REMOTE_BYTES_EXACT_OFFICIAL_METADATA_PASS', commit=commit, tree=final_tree, parent=base, remote=remote,
    prefix=prefix, publicFiles=delivery['publicFiles'], previousPathsPreserved=len(baseline['entries']), newChangesOnly=True,
    manifestSha256=delivery['manifestSha256'], sumsSha256=delivery['sumsSha256'], sourceCandidate='b7341d3e6636b79217b1f3d37d7a5014fcbf47be',
    scopeVerdict='PASS', preflightVerdict='READY', receiptValid=True, noForce=True, mainBefore=main_before, mainAfter=main_after, mainConcurrentChange=main_after!=main_before,
    sourceBranchWrites=0, tagReleaseHostInstall=0, firstOfficial1Published=False, officialPluginPassed=True, officialSkillsPassed=22,
    verifiedRemoteBlobCount=delivery['publicFiles'], rawLogs=str(ROOT/'raw/logs'), completedAtUtc=datetime.datetime.now(datetime.timezone.utc).isoformat())
write('PUSH-RECEIPT.json', result)
print(json.dumps(result, ensure_ascii=False, indent=2))
