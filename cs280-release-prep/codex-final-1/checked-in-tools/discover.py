import ast, hashlib, json, os, pathlib, re
import yaml
from runner import ROOT, run, write
HEAD = 'b7341d3e6636b79217b1f3d37d7a5014fcbf47be'
TREE = '5648f76558e923244cedf78a8263892d00df8299'
BASE = '4ba47558020bd5e501fa9718f09d562dcf573713'
ORIGIN = 'https://github.com/jaeseongs95/agent-governance-suite.git'
REF = 'refs/heads/codex/release-candidate-2.8.0'
prior = ROOT.parent / 'official-validator-26c6c9d9'
sha = lambda b: hashlib.sha256(b).hexdigest()
candidate = ROOT / 'candidate'
if not candidate.exists():
    _, out, _ = run('01-remote-ref', ['git', 'ls-remote', '--heads', ORIGIN, REF], ROOT)
    assert out.read_text().splitlines() == [HEAD + '\t' + REF], 'Exact source ref not available'
    run('02-candidate-init', ['git', 'init', str(candidate)], ROOT)
    run('03-candidate-origin', ['git', 'remote', 'add', 'origin', ORIGIN], candidate)
    run('04-candidate-lf', ['git', 'config', 'core.autocrlf', 'false'], candidate)
    run('05-candidate-fetch', ['git', 'fetch', '--no-tags', 'origin', REF], candidate)
    run('06-candidate-checkout', ['git', 'checkout', '--detach', HEAD], candidate)
    prefix = 'initial'
else:
    # Resume only supplier preparation after our incomplete path allowlist stopped the initial driver.
    # Do not repeat the fetch or checkout; all original command captures remain intact.
    assert json.loads((ROOT / 'raw/logs/00-discovery-driver.command.json').read_text())['exitCode'] == 1
    prefix = 'resume'
_, out, _ = run('13-' + prefix + '-candidate-pin', ['git', 'rev-parse', 'HEAD', 'HEAD^{tree}'], candidate)
assert out.read_text().splitlines() == [HEAD, TREE]
_, out, _ = run('14-' + prefix + '-candidate-clean', ['git', 'status', '--porcelain'], candidate)
assert not out.read_bytes()
_, out, _ = run('15-' + prefix + '-delta-paths', ['git', 'diff', '--name-status', BASE, HEAD], candidate)
delta = out.read_text().splitlines()
assert len(delta) == 7, 'Unexpected source delta count; withhold install'
paths = [line.split('\t')[-1] for line in delta]
assert set(paths) == {'README.en.md', 'README.md', 'docs/release-notes-2.8.0-rc.ko.md', 'docs/roadmap.md', 'release/version.json',
                      'tests/cs-engineering/files.node.mjs', 'tests/session-messaging/session-message.test.ts'}, 'Unreviewed source delta'
_, out, _ = run('16-reviewed-delta-patch', ['git', 'diff', '--no-ext-diff', BASE, HEAD], candidate)
write('SOURCE-PIN.json', dict(origin=ORIGIN, ref=REF, commit=HEAD, tree=TREE, detached=True, clean=True, baseline=BASE, changedPaths=delta,
    productDelta='Two test files, four docs and release/version.json only. Official plugin/skills/runner/package/lock and production runtime/bundles unchanged versus4ba. Public-release wording is prepared metadata, not evidence of a release.', firstPacketDelivered=True,
    firstPacketLibraryId='[REDACTED:PRIVATE_RESOURCE]', firstPacketZipSha256='1110e6b0bea193247b66ec17e3f312f84ac6187e38b4bf57bb74c5fea690210d'))
pins = json.loads((prior / 'raw/SUPPLIER-PIN.json').read_text())
assert pins['commit'] == '10382da79a2a2d6e8ae221fa63077215389c1ad2'
home = ROOT / 'codex-home-disposable'
home.mkdir()
mapping = {'validate_plugin.py': 'skills/.system/plugin-creator/scripts/validate_plugin.py',
           'identifier_validation.py': 'skills/.system/plugin-creator/scripts/identifier_validation.py',
           'quick_validate.py': 'skills/.system/skill-creator/scripts/quick_validate.py', 'LICENSE': '.supplier/LICENSE', 'NOTICE': '.supplier/NOTICE'}
supplied = []
for index, row in enumerate(pins['files']):
    _, out, _ = run(f'11-supplier-blob-{index}', ['git', '--git-dir', str(prior / 'upstream.git'), 'cat-file', 'blob', row['gitBlob']], ROOT)
    data = out.read_bytes()
    assert sha(data) == row['rawSha256'] and hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest() == row['gitBlob']
    assert data == (prior / 'official-source' / row['path']).read_bytes()
    dest = home / mapping[pathlib.Path(row['path']).name]
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(data)
    supplied.append(dict(sourcePath=row['path'], temporaryPath=str(dest.relative_to(home)), bytes=len(data), sha256=sha(data), gitBlob=row['gitBlob']))
write('SUPPLIER-PIN.json', pins)
write('SUPPLIED.json', dict(sourceCommit=pins['commit'], suppliedHome=str(home), createdNew=True, verifiedFiles=supplied, reuse='Same previously remote-verified supplier objects; all5 blobs/raw bytes rechecked, new private home copies.', defaultHomeModified=False))
plugin_source = (home / mapping['validate_plugin.py']).read_text()
tree = ast.parse(plugin_source)
fn = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'validate_manifest_shape')
allowed = next(ast.literal_eval(n.value) for n in fn.body if isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'allowed_keys' for t in n.targets))
manifest = json.loads((candidate / '.codex-plugin/plugin.json').read_text())
assert not set(manifest) - allowed
quick = ast.parse((home / mapping['quick_validate.py']).read_text())
skill_keys = next(ast.literal_eval(n.value) for n in ast.walk(quick) if isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'allowed_properties' for t in n.targets))
skills = []
for directory in sorted((candidate / 'skills').iterdir()):
    if not directory.is_dir(): continue
    text = (directory / 'SKILL.md').read_text()
    front = yaml.safe_load(re.match(r'^---\n(.*?)\n---', text, re.S).group(1))
    assert not set(front) - skill_keys
    skills.append(directory.name)
write('COMPATIBILITY.json', dict(state='STATIC_KEY_COMPATIBLE', skillCount=len(skills), skills=skills, scope='Supported key precheck only; official result pending'))
assert len(skills) == 22
package = json.loads((candidate / 'package.json').read_text())
assert package['packageManager'] == 'pnpm@11.19.0' and package['scripts']['validate:official'] == 'node scripts/validate-official.mjs'
assert not set(package['scripts']) & {'preinstall', 'install', 'postinstall', 'prepare', 'prepublish', 'prepublishOnly'}
workspace = yaml.safe_load((candidate / 'pnpm-workspace.yaml').read_text())
assert workspace == {'allowBuilds': {'esbuild': True}}, 'Unexpected dependency lifecycle permission'
write('INSTALL-REVIEW.json', dict(packageManager=package['packageManager'], nodeEngine=package['engines']['node'], rootInstallLifecycleScripts=[],
    allowedDependencyBuilds=workspace['allowBuilds'], lockSha256=sha((candidate / 'pnpm-lock.yaml').read_bytes()),
    scope='Explicitly authorized locked development dependency install into new private checkout/store; not a host/plugin install. No global config repair or dependency gate relaxation.'))
print(json.dumps(dict(commit=HEAD, tree=TREE, clean=True, deltaPaths=delta, supplierFiles=len(supplied), skills=len(skills), readyForDirectReviewBeforeInstall=True), ensure_ascii=False))
