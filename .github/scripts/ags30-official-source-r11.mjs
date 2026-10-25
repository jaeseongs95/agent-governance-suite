import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout, clearTimeout } from 'node:timers';
import { fileURLToPath, pathToFileURL } from 'node:url';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const ordinal = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const safePath = value => typeof value === 'string' && value.length > 0 &&
  !value.includes('\\') && !value.includes(':') && !value.includes('\0') &&
  !value.startsWith('/') && value.split('/').every(p => p && p !== '.' && p !== '..');
const portable = rows => sha(Buffer.from([...rows].sort((a, b) => ordinal(a.relativePath, b.relativePath))
  .map(r => `${r.relativePath}\t${r.bytes}\t${r.sha256}\n`).join(''), 'utf8'));

export function classifyInitial(receipt, stderr, generated) {
  if (receipt.status === 'PASS') return 'PASS';
  if (receipt.status !== 'FAIL' || receipt.exitCode !== 1 || receipt.signal || receipt.errorCode) return 'UNEXPECTED_FAILURE';
  const matches = [...stderr.matchAll(/Error: ([^\r\n]+) is stale\. Run pnpm build and commit the result\./g)];
  return matches.length === 1 && generated.includes(matches[0][1]) ? 'EXPECTED_STALE_FAIL' : 'UNEXPECTED_FAILURE';
}

export function summarizeSuiteLoading(report, progressText, source) {
  assert(Array.isArray(report.testResults));
  const relative = file => {
    assert(typeof file === 'string');
    const value = path.relative(source, path.isAbsolute(file) ? file : path.resolve(source, file)).split(path.sep).join('/');
    assert(safePath(value), 'Unsafe suite-load path');
    return value;
  };
  const events = progressText.split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line));
  const collectionFailures = [...new Set(events.filter(event => event.event === 'collection-failed').map(event => relative(event.file)))].sort(ordinal);
  const files = report.testResults.map(row => {
    assert(Array.isArray(row.assertionResults));
    return { file: relative(row.name), status: row.status, cases: row.assertionResults.length,
      failedCases: row.assertionResults.filter(item => item.status === 'failed').length };
  });
  const recoveryFile = 'tests/recovery-strategy-selector/recovery-selector.test.mjs';
  const recovery = files.find(row => row.file === recoveryFile);
  return { schemaVersion: 'AgsSuiteLoadObservation.v1', basis: 'EXISTING_PROGRESS_COLLECTION_EVENTS_AND_FULL_REPORT_CASES',
    collectionFailures, failedFilesWithoutCases: files.filter(row => row.status === 'failed' && row.cases === 0).map(row => row.file).sort(ordinal),
    failedCases: files.reduce((sum, row) => sum + row.failedCases, 0),
    recovery: { file: recoveryFile, status: collectionFailures.includes(recoveryFile) ? 'COLLECTION_FAILED'
      : !recovery ? 'NOT_IN_SHARD_REPORT' : recovery.cases === 0 ? 'REPORTED_WITHOUT_CASES' : 'CASE_RESULTS_REPORTED',
      cases: recovery?.cases ?? null, failedCases: recovery?.failedCases ?? null },
    conclusion: 'OBSERVATION_ONLY_NOT_A_SUITE_LOAD_PASS_OR_NEW_GATE' };
}

export function assertRows(rows) {
  assert(Array.isArray(rows) && rows.length > 0);
  const seen = new Set();
  for (const row of rows) {
    assert(safePath(row.relativePath), `Unsafe path: ${row.relativePath}`);
    assert(Number.isSafeInteger(row.bytes) && row.bytes >= 0);
    assert(/^[a-f0-9]{64}$/.test(row.sha256));
    // Case-folded collisions are rejected on both OSes so extraction has one meaning.
    const key = row.relativePath.toLowerCase();
    assert(!seen.has(key), `Duplicate path: ${row.relativePath}`);
    seen.add(key);
  }
}

export function assertSourceInventory(manifest, config) {
  assertRows(manifest.rows);
  assert(Number.isSafeInteger(config.archive.entries) && config.archive.entries > 0);
  assert.equal(manifest.files, config.archive.entries);
  assert.equal(manifest.rows.length, config.archive.entries);
  assert.equal(portable(manifest.rows), config.portableId);
}

export async function buildHeadManifest(treeText, readBlob, binding) {
  assert(/^[a-f0-9]{40}$/.test(binding.head));
  assert(/^[a-f0-9]{40}$/.test(binding.sourceTree));
  const rows = [];
  for (const entry of treeText.split('\0').filter(Boolean)) {
    const match = /^([0-7]{6}) blob ([a-f0-9]{40}) +(\d+)\t([\s\S]+)$/.exec(entry);
    assert(match, 'Invalid Git blob inventory entry');
    const [, mode, objectId, size, relativePath] = match;
    assert(['100644', '100755'].includes(mode), 'Only regular Git blobs are allowed');
    assert(safePath(relativePath), 'Unsafe Git blob path');
    const bytes = await readBlob(relativePath);
    assert(Buffer.isBuffer(bytes), 'Blob reader must return raw bytes');
    assert(Number.isSafeInteger(Number(size)) && Number(size) >= 0);
    assert.equal(bytes.length, Number(size), 'Checkout blob size differs: ' + relativePath);
    const gitBlob = createHash('sha1').update(Buffer.from('blob ' + bytes.length + '\0')).update(bytes).digest('hex');
    assert.equal(gitBlob, objectId, 'Checkout blob bytes differ from actual HEAD: ' + relativePath);
    rows.push({ relativePath, bytes: bytes.length, sha256: sha(bytes) });
  }
  assertRows(rows);
  rows.sort((a, b) => ordinal(a.relativePath, b.relativePath));
  return { schemaVersion: 'AgsActualHeadSourceManifest.v1', ...binding, files: rows.length,
    portableId: portable(rows), gitTreeBinding: 'ALL_TRACKED_REGULAR_BLOBS_OID_AND_SIZE_VERIFIED',
    generatedRuntime: 'UNVERIFIED_COMMITTED_BYTES', rows };
}

const sourceArchiveVerifier = String.raw`import hashlib, json, pathlib, re, sys, tarfile
archive, manifest_path, inventory_path = map(pathlib.Path, sys.argv[1:4])
manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
rows = {row['relativePath']: row for row in manifest['rows']}
assert len(rows) == len(manifest['rows']) == manifest['files']
expected = {}
for entry in inventory_path.read_bytes().decode('utf-8').split('\0'):
    if not entry:
        continue
    match = re.fullmatch(r'([0-7]{6}) blob ([a-f0-9]{40}) +(\d+)\t([\s\S]+)', entry)
    assert match, 'Invalid Git inventory'
    mode, oid, size, name = match.groups()
    assert mode in ('100644', '100755') and name not in expected
    expected[name] = (mode, oid, int(size))
assert set(expected) == set(rows)
seen, folded, files, total = set(), set(), 0, 0
with tarfile.open(archive, 'r:gz') as packed:
    assert packed.pax_headers.get('comment') == manifest['head'], 'Archive HEAD differs'
    for member in packed:
        name = member.name
        assert name and not any(ord(c) < 32 for c in name)
        assert not any(c in name for c in '\\:') and not name.startswith('/')
        assert all(part and part not in ('.', '..') for part in name.split('/'))
        assert name.casefold() not in folded, 'Archive duplicate/collision'
        folded.add(name.casefold())
        if member.isdir():
            assert member.size == 0 and any(p.startswith(name + '/') for p in rows)
            continue
        assert member.isfile() and name in rows and name not in seen, 'Archive member is not an expected regular blob'
        mode, oid, size = expected[name]
        row = rows[name]
        assert member.size == size == row['bytes']
        assert not member.mode & ~0o777 and member.mode & 0o111 == int(mode, 8) & 0o111
        digest, git = hashlib.sha256(), hashlib.sha1(b'blob ' + str(size).encode('ascii') + b'\0')
        length = 0
        with packed.extractfile(member) as stream:
            while block := stream.read(1024 * 1024):
                length += len(block)
                assert length <= size
                digest.update(block)
                git.update(block)
        assert length == size and digest.hexdigest() == row['sha256'] and git.hexdigest() == oid, 'Archive blob bytes differ'
        seen.add(name)
        files += 1
        total += length
assert seen == set(rows), 'Archive omitted Git blobs'
archive_hash = hashlib.sha256()
with archive.open('rb') as stream:
    while block := stream.read(1024 * 1024):
        archive_hash.update(block)
print(json.dumps({'bytes': archive.stat().st_size, 'sha256': archive_hash.hexdigest(), 'files': files, 'sourceBytes': total, 'head': manifest['head'], 'sourceTree': manifest['sourceTree'], 'portableId': manifest['portableId'], 'gitBlobVerification': 'ALL_PATHS_SIZES_SHA256_GIT_OIDS_AND_EXECUTABILITY_MATCH'}))
`;

export function planSourceArchive(existingRows, record, archive, cap) {
  assertRows(existingRows);
  assert(Number.isSafeInteger(cap) && cap >= 1 && cap <= 8 * 1024 * 1024);
  const bytes = value => Buffer.byteLength(JSON.stringify(value, null, 2) + '\n');
  const row = (relativePath, size) => ({ relativePath, bytes: size, sha256: '0'.repeat(64) });
  const maximum = descriptor => {
    const rows = [...existingRows, row('source-archive.json', bytes(descriptor)),
      row('result.json', bytes({ ...record, sourceArchive: descriptor }))];
    if (descriptor.status === 'RETURNED') rows.push(row('source.actual-head.tar.gz', archive.bytes));
    rows.sort((a, b) => ordinal(a.relativePath, b.relativePath));
    rows.push(row('result-files.json', bytes({ rows: [...rows], manifestSelfExcluded: true })));
    // cancelled is the longest Actions step outcome; timestamps and SHA-256 strings have fixed lengths.
    const outcome = 'cancelled';
    const finalization = { outcome, finalizedAt: '0000-00-00T00:00:00.000Z',
      evidenceState: 'OBSERVED_FILES_MAY_BE_PARTIAL', collectorCompletionRequired: false,
      hardKillOrRunnerLossRecovery: 'NOT_GUARANTEED', artifactMaximumBytes: cap };
    rows.push(row('finalization.json', bytes(finalization)));
    rows.sort((a, b) => ordinal(a.relativePath, b.relativePath));
    return rows.reduce((sum, entry) => sum + entry.bytes, 0) +
      bytes({ rows, manifestSelfExcluded: true, collectorOutcome: outcome, partialEvidencePossible: true });
  };
  let descriptor = { schemaVersion: 'AgsConsumedSourceArchive.v1', status: 'RETURNED',
    unit: record.unit, nonce: record.nonce, role: 'SNAPSHOT_OF_ACTUAL_CONSUMED_PREBUILD_GIT_SOURCE', ...archive,
    sourceBinding: record.sourceBinding,
    locator: { kind: 'same-result-artifact-member', member: 'source.actual-head.tar.gz',
      runId: record.sourceBinding.runId, attempt: record.sourceBinding.attempt,
      runnerOs: 'Linux', shardIndex: 2 } };
  if (maximum(descriptor) > cap) descriptor = { ...descriptor, status: 'NOT_RETURNED_CAP', locator: null };
  return { descriptor, maximumBytes: maximum(descriptor) };
}

export async function finalizePartial(output, githubOutput, outcome, cap = 8 * 1024 * 1024) {
  assert(Number.isSafeInteger(cap) && cap >= 1 && cap <= 8 * 1024 * 1024);
  const root = path.resolve(output);
  const info = await fs.lstat(root);
  assert(info.isDirectory() && !info.isSymbolicLink(), 'Result directory must be a real directory');
  const write = (name, value) => fs.writeFile(path.join(root, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  // No PASS is inferred from a cancelled process or from files left by a partial write.
  await write('finalization.json', { outcome, finalizedAt: new Date().toISOString(),
    evidenceState: 'OBSERVED_FILES_MAY_BE_PARTIAL', collectorCompletionRequired: false,
    hardKillOrRunnerLossRecovery: 'NOT_GUARANTEED', artifactMaximumBytes: cap });
  const rows = [];
  let total = 0;
  async function visit(dir, prefix = '') {
    for (const item of await fs.readdir(dir, { withFileTypes: true })) {
      const relativePath = prefix + item.name;
      assert(!item.isSymbolicLink(), 'Unexpected result link');
      const full = path.join(dir, item.name);
      if (item.isDirectory()) await visit(full, relativePath + '/');
      else {
        const stat = await fs.lstat(full);
        assert(stat.isFile(), 'Unexpected result file type');
        total += stat.size;
        assert(total <= cap, 'Artifact cap exceeded');
        const bytes = await fs.readFile(full);
        assert.equal(bytes.length, stat.size, 'Result changed while finalizing');
        rows.push({ relativePath, bytes: bytes.length, sha256: sha(bytes) });
      }
    }
  }
  let artifactOk = false;
  let failure = null;
  try {
    await visit(root);
    await write('finalization-files.json', { rows: rows.sort((a, b) => ordinal(a.relativePath, b.relativePath)),
      manifestSelfExcluded: true, collectorOutcome: outcome, partialEvidencePossible: true });
    total += (await fs.stat(path.join(root, 'finalization-files.json'))).size;
    artifactOk = total <= cap;
  } catch (error) { failure = error.message; }
  await fs.appendFile(githubOutput, `result_path=${root}\nartifact_ok=${artifactOk}\nartifact_bytes=${total}\n`);
  if (!artifactOk) console.error('UNVERIFIED_ARTIFACT_BYTES: finalization failed or exceeded cap; no upload');
  return { artifactOk, bytes: total, failure, outcome };
}

async function finalizeFromRunner() {
  assert(['Linux', 'Windows'].includes(process.env.RUNNER_OS));
  const work = path.join(path.resolve(process.env.RUNNER_TEMP), `ags30-2a2a440b-080a-4c0b-bb99-ad4975eecfd0-${process.env.RUNNER_OS}`);
  try { await fs.mkdir(work); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const info = await fs.lstat(work);
  assert(info.isDirectory() && !info.isSymbolicLink(), 'Unsafe work directory');
  const output = path.join(work, 'result');
  try { await fs.mkdir(output); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const result = await finalizePartial(output, process.env.GITHUB_OUTPUT, process.argv[3] ?? 'unknown');
  console.log(JSON.stringify(result));
  if (!result.artifactOk) process.exitCode = 1;
}


export function observeCommand(executable, args, options) {
  return new Promise((resolve) => {
    const startedAt = new Date().toISOString();
    const child = spawn(executable, args, { cwd: options.cwd, env: options.env,
      shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [], stderr = [];
    let outBytes = 0, errBytes = 0, failure = null, finished = false;
    let directExit = null, directClose = null, grace;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout); clearTimeout(grace);
      child.stdout.destroy(); child.stderr.destroy();
      if (directExit === null && failure) child.kill('SIGKILL');
      child.unref();
      resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr),
        status: directExit?.code ?? null, signal: directExit?.signal ?? null, error: failure,
        lifecycle: { startedAt, directPid: child.pid ?? null, collectorPid: process.pid,
          directExit, directClose, returnedAt: new Date().toISOString(),
          descendantTermination: 'OWNED_WRAPPER; verify wrapper receipt and same-invocation lifetime checks' } });
    };
    const stop = (code) => {
      if (failure) return;
      failure = Object.assign(new Error(code), { code });
      child.kill('SIGTERM');
      grace = setTimeout(finish, 7000);
    };
    child.stdout.on('data', bytes => {
      const remaining = 512 * 1024 - outBytes;
      if (remaining > 0) stdout.push(bytes.subarray(0, remaining));
      outBytes += bytes.length;
      if (outBytes > 512 * 1024) stop('ENOBUFS');
    });
    child.stderr.on('data', bytes => {
      const remaining = 512 * 1024 - errBytes;
      if (remaining > 0) stderr.push(bytes.subarray(0, remaining));
      errBytes += bytes.length;
      if (errBytes > 512 * 1024) stop('ENOBUFS');
    });
    child.once('error', error => { failure = error; finish(); });
    child.once('exit', (code, signal) => { directExit = { at: new Date().toISOString(), code, signal }; });
    child.once('close', (code, signal) => { directClose = { at: new Date().toISOString(), code, signal }; finish(); });
    const timeout = setTimeout(() => stop('ETIMEDOUT'), options.timeout);
  });
}

async function main() {
  const configPath = path.resolve(process.argv[2]);
  const dataRoot = path.dirname(configPath);
  const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
  const shardIndex = Number(process.env.AGS_CI_SHARD_INDEX);
  assert(Number.isInteger(shardIndex) && shardIndex >= 1 && shardIndex <= config.shardCount && config.shardCount === 4);
  const shardRef = `${shardIndex}/${config.shardCount}`;
  const work = path.join(path.resolve(process.env.RUNNER_TEMP), `ags30-${config.nonce}-${process.env.RUNNER_OS}`);
  // mkdir without recursive is the create-once guard; reruns cannot reuse this workspace.
  await fs.mkdir(work);
  const output = path.join(work, 'result');
  const source = path.join(work, 'source');
  await fs.mkdir(output);
  const record = { schemaVersion: 'AgsBoundedCiResult.v1', unit: config.unit, nonce: config.nonce,
    startedAt: new Date().toISOString(), shardIndex, shardCount: config.shardCount, status: 'FAIL', sourceFreshness: 'NOT_RUN',
    runtimeCandidate: 'NOT_GENERATED', originalJev: { tasks: 3, cases: 125, acceptanceCriteria: 10, completionIncrease: 0 },
    mutationSensitivity: 'NOT_RUN', formalEngineeringProof: 'NOT_COLLECTED', phases: [] };
  let artifactOk;
  let beforeRows = null;
  let afterBuildRows = null;
  let sourceArchive = null;
  record.sourceArchive = { status: process.env.RUNNER_OS === 'Linux' && shardIndex === 2 ? 'NOT_PREPARED' : 'NOT_SELECTED_SHARD',
    owner: { runnerOs: 'Linux', shardIndex: 2 }, locator: null };
  const writeJson = (name, value) => fs.writeFile(path.join(output, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  const deadline = Date.now() + 12 * 60_000;
  async function command(name, executable, args, cwd, maxMs, extraEnv = {}) {
    const remaining = deadline - Date.now();
    if (remaining < 1_000) throw new Error('Collector deadline exhausted');
    const startedAt = new Date().toISOString();
    const env = { ...process.env, ...extraEnv, PYTHONDONTWRITEBYTECODE: '1' };
    const ownedWrapper = fileURLToPath(new URL('./ags30-owned-command-r06.py', import.meta.url));
    const linuxReaper = fileURLToPath(new URL('./ags30-linux-subreaper-r06.py', import.meta.url));
    const owned = executable === process.execPath && args[0] !== undefined && !name.startsWith('02-');
    const launchExecutable = owned ? 'python' : executable;
    const launchArgs = owned ? ['-B', ownedWrapper, linuxReaper, executable, ...args] : args;
    delete env.NODE_TEST_CONTEXT;
    const result = owned
      ? await observeCommand(launchExecutable, launchArgs, { cwd, env, timeout: Math.min(maxMs, remaining) })
      : spawnSync(launchExecutable, launchArgs, { cwd, env, shell: false, windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'], timeout: Math.min(maxMs, remaining),
        maxBuffer: 512 * 1024, encoding: null });
    const stdout = result.stdout ?? Buffer.alloc(0);
    const stderr = result.stderr ?? Buffer.alloc(0);
    await fs.writeFile(path.join(output, `${name}.stdout.bin`), stdout, { flag: 'wx' });
    await fs.writeFile(path.join(output, `${name}.stderr.bin`), stderr, { flag: 'wx' });
    const receipt = { name, executable, argv: args, cwd, startedAt, endedAt: new Date().toISOString(),
      status: result.error ? 'EXECUTION_ERROR' : result.signal ? 'SIGNALLED' : result.status === 0 ? 'PASS' : 'FAIL',
      exitCode: result.status, signal: result.signal, errorCode: result.error?.code ?? null,
      stdout: { bytes: stdout.length, sha256: sha(stdout) }, stderr: { bytes: stderr.length, sha256: sha(stderr) },
      timeoutMs: Math.min(maxMs, remaining), outputMaximumPerStream: 512 * 1024,
      lifecycle: result.lifecycle ?? null,
      ownership: owned ? { wrapper: ownedWrapper, wrapperSha256: sha(await fs.readFile(ownedWrapper)), linuxSubreaper: linuxReaper } : null,
      descendantTermination: owned ? 'INVOCATION_WRAPPER_CONFIGURED; see lifecycle and check receipts' : 'NOT_PROVEN_BY_COLLECTOR' };
    record.phases.push(receipt);
    if (owned) {
      const ownerPid = result.lifecycle?.directPid;
      const observations = stderr.toString('utf8').split(/\r?\n/).flatMap(line => {
        try { return [JSON.parse(line)]; } catch { return []; }
      });
      const owner = observations.filter(item => item?.ownerPid === ownerPid).at(-1);
      const drained = result.lifecycle?.directClose !== null && (process.platform === 'win32'
        ? owner?.harness === 'windows-job-owner' && owner.jobEstablishedBeforeSpawn === true
        : owner?.harness === 'test-subreaper' && owner.remainingChildren === false && owner.runnerExitCode !== null);
      receipt.ownershipObservation = { owner: owner ?? null, drained: Boolean(drained),
        basis: process.platform === 'win32' ? 'unnamed no-breakaway KILL_ON_JOB_CLOSE owner exited; same-run synthetic check required' : 'outer invocation subreaper absence and reap observation' };
      await writeJson(`${name}.ownership.json`, receipt.ownershipObservation);
    }
    await writeJson(`${name}.receipt.json`, receipt);
    if (owned && !receipt.ownershipObservation.drained) throw new Error('Invocation ownership cleanup unverified: ' + name);
    return { receipt, stdout, stderr };
  }
  const mustPass = result => { assert.equal(result.receipt.status, 'PASS', `Phase failed: ${result.receipt.name}`); return result; };
  async function tree(root) {
    const rows = [];
    async function visit(dir, prefix = '') {
      for (const item of await fs.readdir(dir, { withFileTypes: true })) {
        if (!prefix && ['node_modules', '.git'].includes(item.name)) continue;
        const rel = prefix + item.name;
        assert(!item.isSymbolicLink(), `Unexpected link: ${rel}`);
        if (item.isDirectory()) await visit(path.join(dir, item.name), `${rel}/`);
        else {
          assert(item.isFile(), `Unexpected file type: ${rel}`);
          const bytes = await fs.readFile(path.join(root, rel));
          rows.push({ relativePath: rel, bytes: bytes.length, sha256: sha(bytes) });
        }
      }
    }
    await visit(root);
    return rows.sort((a, b) => ordinal(a.relativePath, b.relativePath));
  }
  function sameNonGenerated(before, after) {
    const generated = new Set(config.generated);
    const optional = new Set(config.generated.filter(p => p.endsWith('.mjs')).map(p => p + '.LEGAL.txt'));
    assert.deepEqual(after.filter(r => !generated.has(r.relativePath) && !optional.has(r.relativePath)),
      before.filter(r => !generated.has(r.relativePath) && !optional.has(r.relativePath)), 'Non-generated source changed');
  }
  try {
    assert.equal(config.nonce, '2a2a440b-080a-4c0b-bb99-ad4975eecfd0');
    for (const [name, expected] of Object.entries(config.ownershipHelpers)) {
      const helper = await fs.readFile(new URL('./' + name, import.meta.url));
      assert.equal(helper.length, expected.bytes); assert.equal(sha(helper), expected.sha256);
    }
    assert.equal(process.env.GITHUB_REPOSITORY, config.repository);
    assert.equal(process.env.GITHUB_REPOSITORY_ID, String(config.repositoryId));
    assert.equal(process.env.GITHUB_REF, `refs/heads/${config.branch}`);
    assert.equal(process.env.GITHUB_EVENT_NAME, 'push');
    assert.equal(process.env.GITHUB_RUN_ATTEMPT, '1');
    assert.equal(config.liveExternalAiCalls, 0);
    assert.equal(process.env.JEV_API_KEY, undefined);
    assert.equal(process.env.AGS_JEV_ENDPOINT, undefined);
    assert(['Linux', 'Windows'].includes(process.env.RUNNER_OS));
    assert.equal(process.version, `v${config.node}`);
    assert.equal(config.sourceMode, 'GITHUB_SHA');
    const actualHead = process.env.GITHUB_SHA;
    assert(/^[a-f0-9]{40}$/.test(actualHead));
    const git = (name, args, cwd = work, ms = 60_000) => command(name, 'git', ['-c', 'core.autocrlf=false', ...args], cwd, ms);
    const checkoutRoot = path.resolve(process.env.GITHUB_WORKSPACE);
    assert.equal(path.resolve(dataRoot), path.join(checkoutRoot, '.github', 'ci', 'ags30-r11'));
    const checkoutHead = mustPass(await git('01b-observe-workflow-head', ['rev-parse', 'HEAD'], checkoutRoot)).stdout.toString('utf8').trim();
    assert.equal(checkoutHead, actualHead, 'Runner checkout must equal the triggering push HEAD');
    mustPass(await git('01a-clone-official-checkout', ['clone', '--no-hardlinks', '--no-checkout', checkoutRoot, source]));
    mustPass(await git('01c-checkout-official-source', ['checkout', '--detach', actualHead], source));
    const head = mustPass(await git('01d-observe-head', ['rev-parse', 'HEAD'], source)).stdout.toString('utf8').trim();
    assert.equal(head, actualHead);
    const sourceTree = mustPass(await git('01e-observe-source-tree', ['rev-parse', 'HEAD^{tree}'], source)).stdout.toString('utf8').trim();
    mustPass(await git('01f-observe-skill-baseline', ['cat-file', '-e', config.gitContext.skillBaseline + ':skills'], source));
    const sourceBlobs = mustPass(await git('01i-source-blobs', ['ls-tree', '-r', '-l', '-z', head], source)).stdout.toString('utf8');
    const workflowBlobs = mustPass(await git('01j-workflow-blobs', ['ls-tree', '-r', '-l', '-z', actualHead], checkoutRoot)).stdout.toString('utf8');
    assert.equal(sourceBlobs, workflowBlobs, 'Actual HEAD Git blob inventories differ');
    const binding = { runId: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT,
      job: process.env.GITHUB_JOB, shardIndex, head, sourceTree };
    const manifest = await buildHeadManifest(sourceBlobs, relative => fs.readFile(path.join(source, relative)), binding);
    const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
    const transport = { bytes: manifestBytes.length, sha256: sha(manifestBytes) };
    Object.assign(config, { archive: { entries: manifest.files }, portableId: manifest.portableId, transport,
      gitContext: { ...config.gitContext, checkoutCommit: head, sourceTree }, sourceBinding: binding });
    assertSourceInventory(manifest, config);
    await fs.writeFile(path.join(output, 'source-manifest.json'), manifestBytes, { flag: 'wx' });
    const returnedManifest = await fs.readFile(path.join(output, 'source-manifest.json'));
    assert.equal(returnedManifest.length, config.transport.bytes);
    assert.equal(sha(returnedManifest), config.transport.sha256);
    assert.deepEqual(JSON.parse(returnedManifest), manifest);
    await writeJson('effective-config.json', config);
    const tracked = mustPass(await git('01h-observe-index', ['ls-files', '-z'], source)).stdout.toString('utf8').split('\0').filter(Boolean).sort(ordinal);
    assert.deepEqual(tracked, manifest.rows.map(row => row.relativePath).sort(ordinal));
    const assertHeadBytes = (relative, bytes) => {
      const row = manifest.rows.find(item => item.relativePath === relative);
      assert(row, 'Executing input missing from actual HEAD: ' + relative);
      assert.equal(bytes.length, row.bytes); assert.equal(sha(bytes), row.sha256);
    };
    const helperRelative = '.github/scripts/' + path.basename(fileURLToPath(import.meta.url));
    const executingHelperBytes = await fs.readFile(fileURLToPath(import.meta.url));
    const configBytes = await fs.readFile(configPath);
    assertHeadBytes(helperRelative, executingHelperBytes);
    assertHeadBytes('.github/ci/ags30-r11/execution-config.json', configBytes);
    const helperClosure = { ...config.ownershipHelpers, 'ags30-os-mutation-r01.mjs': config.osMutationCollector,
      'ags30-wake-mixed-red-r07.mjs': config.wakeMixedRed, 'ags30-shard-evidence-r09.mjs': config.shardEvidence };
    for (const [name, expected] of Object.entries(helperClosure)) {
      const bytes = await fs.readFile(new URL('./' + name, import.meta.url));
      assertHeadBytes('.github/scripts/' + name, bytes);
      assert.equal(bytes.length, expected.bytes); assert.equal(sha(bytes), expected.sha256);
    }
    const planBytes = await fs.readFile(path.join(dataRoot, 'os-test-plan.json'));
    assertHeadBytes('.github/ci/ags30-r11/os-test-plan.json', planBytes);
    assert.equal(planBytes.length, config.osPlan.bytes); assert.equal(sha(planBytes), config.osPlan.sha256);
    const sourcePins = { ...binding, files: manifest.files, portableId: config.portableId, transport };
    record.sourceBinding = sourcePins;
    await writeJson('environment.json', { node: process.version, platform: process.platform, arch: process.arch,
      runnerOs: process.env.RUNNER_OS, runnerImage: process.env.ImageOS ?? null, runnerImageVersion: process.env.ImageVersion ?? null,
      repository: process.env.GITHUB_REPOSITORY, repositoryId: process.env.GITHUB_REPOSITORY_ID,
      ref: process.env.GITHUB_REF, headSha: head, event: process.env.GITHUB_EVENT_NAME,
      runId: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT, job: process.env.GITHUB_JOB,
      helperSha256: sha(executingHelperBytes), configSha256: sha(configBytes), sourcePins,
      osVersionNote: 'Runner image identifiers are observations; no OS behavior inferred from labels.' });
    await writeJson('git-context.json', { repository: config.gitContext.repository, ...sourcePins,
      skillBaseline: config.gitContext.skillBaseline, candidateIsOverlayNotHeadCommit: false,
      historyCreatedBy: 'NORMAL_LOCAL_CLONE_ACTUAL_PUSH_HEAD', indexCreatedBy: 'UNCHANGED_ACTUAL_PUSH_HEAD',
      allWorkflowBlobsEqualSource: true, ciOnlyOverrides: [] });
    const before = await tree(source);
    beforeRows = before;
    assert.deepEqual(before, manifest.rows);
    await writeJson('source-before.json', { files: before.length, portableId: portable(before), rows: before });
    if (process.env.RUNNER_OS === 'Linux' && shardIndex === 2) {
      try {
        const archivePath = path.join(work, 'actual-head.tar.gz');
        mustPass(await git('01k-pack-source-archive', ['archive', '--format=tar.gz', '--output=' + archivePath, head], source, 60_000));
        const verified = mustPass(await command('01l-verify-source-archive', 'python', ['-B', '-c', sourceArchiveVerifier,
          archivePath, path.join(output, 'source-manifest.json'), path.join(output, '01i-source-blobs.stdout.bin')], work, 30_000));
        const metadata = JSON.parse(verified.stdout.toString('utf8'));
        assert.equal(metadata.head, head); assert.equal(metadata.sourceTree, sourceTree);
        assert.equal(metadata.files, manifest.files); assert.equal(metadata.portableId, manifest.portableId);
        assert(Number.isSafeInteger(metadata.bytes) && metadata.bytes >= 0 && /^[a-f0-9]{64}$/.test(metadata.sha256));
        sourceArchive = { path: archivePath, metadata };
        record.sourceArchive = { status: 'PREPARED_NOT_RETURNED', ...metadata, locator: null };
      } catch (error) {
        record.sourceArchive = { status: 'PREPARATION_FAILED', locator: null,
          error: { name: error.name, message: error.message, code: error.code ?? null } };
      }
    }
    const tools = path.join(work, 'tools');
    await fs.mkdir(tools);
    // The .cmd shim is never invoked through shell; npm's JS entry point is supplied by setup-node.
    const npmCli = path.join(path.dirname(process.execPath), process.platform === 'win32' ? 'node_modules/npm/bin/npm-cli.js' : '../lib/node_modules/npm/bin/npm-cli.js');
    mustPass(await command('02-pnpm-bootstrap', process.execPath, [npmCli, 'install', '--prefix', tools,
      `pnpm@${config.pnpm}`, '--ignore-scripts', '--package-lock=false', '--no-audit', '--no-fund', '--fetch-retries=0'], work, 120_000));
    // pnpm itself may invoke pnpm again while checking dependency state.
    // Updating the collector environment also reaches the independent proof runner.
    process.env.PATH = path.join(tools, 'node_modules', '.bin') + path.delimiter + (process.env.PATH ?? '');
    const pnpmCli = path.join(tools, 'node_modules/pnpm/bin/pnpm.cjs');
    const pnpm = async (name, args, ms, extraEnv = {}) => command(name, process.execPath, [pnpmCli, ...args], source, ms, extraEnv);
    const version = mustPass(await pnpm('03-pnpm-version', ['--version'], 10_000));
    assert.equal(version.stdout.toString('utf8').trim(), config.pnpm);
    mustPass(await pnpm('04-install', ['install', '--frozen-lockfile', '--store-dir', path.join(work, 'store'),
      '--config.fetch-retries=0'], 240_000));
    mustPass(await command('04a-new-test-syntax', process.execPath, ['--check', 'antigravity-connector/hooks/antigravity-hook-runner.test.mjs'], source, 10_000));
    mustPass(await command('04b-owned-lifetime', process.execPath,
      [fileURLToPath(new URL('./ags30-owned-command-check-r06.mjs', import.meta.url)),
       fileURLToPath(new URL('./ags30-owned-command-r06.py', import.meta.url)),
       fileURLToPath(new URL('./ags30-linux-subreaper-r06.py', import.meta.url)), path.join(output, 'owned-lifetime')], work, 30_000));
    record.jevR04Offline = { status: 'NOT_INCLUDED_SEPARATE_HISTORICAL_UNIT', original125CompletionIncrease: 0, live: false };
    const initial = await pnpm('05-initial-freshness', ['bundle:check'], 120_000);
    record.sourceFreshness = classifyInitial(initial.receipt, initial.stderr.toString('utf8'), config.generated);
    if (record.sourceFreshness === 'UNEXPECTED_FAILURE') throw new Error('Unexpected initial freshness failure; generation blocked');
    const drift = await pnpm('05a-claude-drift', ['claude:drift'], 90_000);
    const lint = await pnpm('05b-full-lint', ['lint'], 120_000);
    mustPass(await pnpm('06-official-build', ['build'], 180_000));
    const afterBuild = await tree(source);
    afterBuildRows = afterBuild;
    sameNonGenerated(before, afterBuild);
    const generatedRows = afterBuild.filter(r => config.generated.includes(r.relativePath) ||
      config.generated.some(p => p.endsWith('.mjs') && r.relativePath === p + '.LEGAL.txt'));
    assert(config.generated.every(p => generatedRows.some(r => r.relativePath === p)));
    record.runtimeCandidate = { status: 'GENERATED_NOT_ACCEPTED', portableId: portable(generatedRows), rows: generatedRows };
    await writeJson('generated-runtime.json', record.runtimeCandidate);
    // Preserve actual generated bytes in the result; the per-OS artifact budget is checked below.
    for (const row of generatedRows) {
      const destination = path.join(output, 'generated-runtime', row.relativePath);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.copyFile(path.join(source, row.relativePath), destination);
    }
    let testsPass = lint.receipt.status === 'PASS' && drift.receipt.status === 'PASS';
    let independentNodeStatus = 'DELEGATED_SHARD_1';
    if (shardIndex === 1) {
    mustPass(await command('07a-path-normalization', process.execPath, ['--test', 'tests/mutation-risk-preflight/path-normalization.node-test.mjs'], source, 60_000));
    mustPass(await command('07b-change-scope', process.execPath, ['--test', 'tests/change-scope-guardian/change-scope.node.mjs'], source, 60_000));
    // All selected regression files are included in full shard discovery; do not execute duplicate subsets.
    assert.equal(config.selectors.at(-1), 'tests/session-messaging/broker-process-lock.os.test.ts');
    const mutationModule = new URL('./ags30-os-mutation-r01.mjs', import.meta.url);
    const mutationBytes = await fs.readFile(mutationModule);
    assert.equal(mutationBytes.length, config.osMutationCollector.bytes);
    assert.equal(sha(mutationBytes), config.osMutationCollector.sha256);
    const planFile = path.join(dataRoot, 'os-test-plan.json');
    const planBytes = await fs.readFile(planFile);
    assert.equal(planBytes.length, config.osPlan.bytes);
    assert.equal(sha(planBytes), config.osPlan.sha256);
    const { collectOSMutations } = await import(mutationModule.href);
    const osEvidence = await collectOSMutations({ sourceRoot: source, pnpmCli, planFile,
      outputRoot: path.join(output, 'os-proof'), deadline, wholeSourcePortableId: config.portableId });
    record.mutationSensitivity = osEvidence;
    record.formalEngineeringProof = osEvidence.verdict;
    if (osEvidence.verdict !== 'CONSISTENT') testsPass = false;
    // Independent collection is evidence in its own right, including when full Vitest never emits JSON.
    const nodeRunner = 'import {listNodeTestFiles,runTests} from ' + JSON.stringify(pathToFileURL(path.join(source, 'scripts/run-tests.mjs')).href) + '; const files=listNodeTestFiles(); if(!files.length)throw Error("No Node suites"); console.log(JSON.stringify({files})); process.exitCode=await runTests(files,[process.execPath,"--test"]);';
    const nodeSuites = await command('08b-all-node-suites', process.execPath, ['--input-type=module', '-e', nodeRunner], source, 120_000);
    independentNodeStatus = nodeSuites.receipt.status;
    if (independentNodeStatus !== 'PASS') testsPass = false;
    const skillReport = await command('08g-skill-context', process.execPath, ['scripts/check-skill-context-optimization.mjs'], source, 30_000);
    if (skillReport.receipt.status !== 'PASS') testsPass = false;
    mustPass(await command('07d-instruction-scope', process.execPath,
      ['--test', 'tests/instruction-scope-resolver/resolve-instruction-files.node.mjs'], source, 60_000));
    const wakeRedHelper = fileURLToPath(new URL('./ags30-wake-mixed-red-r07.mjs', import.meta.url));
    const wakeRedBytes = await fs.readFile(wakeRedHelper);
    assert.equal(wakeRedBytes.length, config.wakeMixedRed.bytes);
    assert.equal(sha(wakeRedBytes), config.wakeMixedRed.sha256);
    mustPass(await command('07e-wake-mixed-red', process.execPath, [wakeRedHelper, source, output], source, 45_000));
    const previous = config.previousBroker;
    assert.equal(previous.version,'2.9.1');
    const previousFile = path.join(work, 'previous-release-v2.9.1-broker.mjs');
    const previousOriginal = mustPass(await git('07p0-original-broker-blob', ['show', previous.releaseCommit + ':mcp-server/dist/session-message-broker.mjs'], source));
    await fs.writeFile(previousFile, previousOriginal.stdout, {flag:'wx'});
    const previousBytes = await fs.readFile(previousFile);
    assert.equal(previousBytes.length,previous.bytes);assert.equal(sha(previousBytes),previous.sha256);
    assert.equal(createHash('sha1').update(Buffer.from('blob '+previousBytes.length+'\0')).update(previousBytes).digest('hex'),previous.gitBlob);
    const previousReport = path.join(output,'07p-previous-broker.vitest.json');
    const previousRun = await pnpm('07p-previous-broker',['exec','vitest','run','tests/session-messaging/previous-broker.test.ts',
      '--pool=forks','--maxWorkers=1','--fileParallelism=false','--reporter=json','--outputFile='+previousReport],120_000,
      {AGS_PREVIOUS_BROKER_PATH:previousFile,AGS_PREVIOUS_BROKER_VERSION:previous.version});
    let previousStatus = 'FAIL';
    try {
      const report=JSON.parse(await fs.readFile(previousReport,'utf8'));
      assert.equal(report.numTotalTests,5);assert.equal(report.numPassedTests,5);assert.equal(report.numFailedTests,0);
      assert.equal(report.numPendingTests,0);assert.equal(report.numTodoTests,0);assert.equal(report.numFailedTestSuites,0);
      if(previousRun.receipt.status==='PASS')previousStatus='PASS';
    } catch(error) {record.previousBrokerFailure=error.message;}
    record.previousBrokerCompatibility={status:previousStatus,expectedCases:5,version:previous.version,sha256:previous.sha256,gitBlob:previous.gitBlob};
    if(previousStatus!=='PASS')testsPass=false;
    if (process.env.RUNNER_OS === 'Windows') {
      const windowsOutput = path.join(output, 'windows-argv');
      await fs.mkdir(windowsOutput);
      const windowsReport = path.join(output, '07w-windows-real-argv.vitest.json');
      const windowsRun = await pnpm('07w-windows-real-argv', ['exec','vitest','run','tests/session-messaging/windows-real-argv.test.ts',
        '--pool=forks','--maxWorkers=1','--fileParallelism=false','--reporter=json','--outputFile='+windowsReport],90_000,
        {AGS_WINDOWS_ARGV_OPT_IN:'1',AGS_WINDOWS_ARGV_OUTPUT:windowsOutput});
      let windowsStatus = 'FAIL';
      try {
        const report = JSON.parse(await fs.readFile(windowsReport,'utf8'));
        assert.equal(report.numTotalTests,11);assert.equal(report.numPassedTests,11);assert.equal(report.numFailedTests,0);
        assert.equal(report.numPendingTests,0);assert.equal(report.numTodoTests,0);assert.equal(report.numFailedTestSuites,0);
        const expectedCases = Array.from({length:11},(_,i)=>'WARGV-'+String(i+1).padStart(3,'0'));
        assert.deepEqual((await fs.readdir(windowsOutput)).sort(),expectedCases.map(id=>id+'.json'));
        for (const id of expectedCases) {
          const witness = JSON.parse(await fs.readFile(path.join(windowsOutput,id+'.json'),'utf8'));
          assert.equal(witness.caseId,id);assert.equal(witness.platform,'win32');assert.equal(witness.childCloseObserved,true);
          assert.equal(witness.standInOnly,true);
        }
        if(windowsRun.receipt.status==='PASS')windowsStatus='PASS';
      } catch(error) {record.windowsArgvFailure=error.message;}
      record.windowsRealArgv = {status:windowsStatus,expectedCases:11,kind:'REAL_WINDOWS_NODE_EXECUTABLE_STAND_IN_NOT_NATIVE_SESSION_WAKE'};
      if(windowsStatus!=='PASS')testsPass=false;
    }
    } else {
      record.independentChecks = {status:'DELEGATED_SHARD_1', ownerShard:1};
    }
    const helperFile = fileURLToPath(new URL('./ags30-shard-evidence-r09.mjs', import.meta.url));
    const helperBytes = await fs.readFile(helperFile);
    assert.equal(helperBytes.length,config.shardEvidence.bytes);assert.equal(sha(helperBytes),config.shardEvidence.sha256);
    const {parseFileList,bindShardReport} = await import(pathToFileURL(helperFile).href);
    const discovery = mustPass(await command('07f-vitest-discovery',process.execPath,
      [path.join(source,'node_modules/vitest/vitest.mjs'),'list','--filesOnly','--no-color'],source,60_000));
    const sourcePaths = new Set(manifest.rows.map(row=>row.relativePath));
    const allFiles = parseFileList(discovery.stdout.toString('utf8'),source,sourcePaths);
    const regressionFiles = [...config.selectors,'antigravity-connector/hooks/antigravity-hook-runner.test.mjs',
      'tests/session-messaging/wake-liveness.test.mjs','tests/session-messaging/hook-queue-read-close.test.ts',
      'tests/tooling/skill-context-optimization.test.mjs','antigravity-connector/hooks/antigravity-hook-warm-ensure.test.mjs',
      'tests/mcp/host-attestation-d0179-sink.test.ts','tests/mcp/skill-classification-gateway.test.ts',
      'tests/session-messaging/wake-lifecycle.test.mjs','tests/mcp/skill-classification-providers.test.ts'];
    assert(regressionFiles.every(file=>allFiles.includes(file)),'Previously selected file missing from full discovery');
    await writeJson('vitest-discovery.json',{allFiles,shardIndex,shardCount:config.shardCount,regressionFiles,partitionSource:'OFFICIAL_FULL_RUN_JSON'});
    const fullReportFile = path.join(output, '08-full-test.vitest.json');
    const progressReporter = path.join(output, '08-full-test.progress-reporter.mjs');
    const progressFile = path.join(output, '08-full-test.progress.jsonl');
    await fs.copyFile(new URL('./ags30-progress-r06.mjs', import.meta.url), progressReporter);
    await fs.writeFile(progressFile, '', { flag: 'wx' });
    const full = await pnpm('08-full-test', ['test', '--shard='+shardRef, '--maxWorkers=2', '--fileParallelism=true', '--reporter=default', '--reporter=json', `--reporter=${progressReporter}`, `--outputFile=${fullReportFile}`], Math.min(480_000, Math.max(1_000, deadline - Date.now() - 120_000)), { AGS_CI_PROGRESS_FILE: progressFile });
    if (full.receipt.status !== 'PASS') testsPass = false;
    let fullCounts;
    let suiteLoading = { status: 'NO_VERIFIED_SUITE_LOAD_REPORT' };
    try {
      const fullReport = JSON.parse(await fs.readFile(fullReportFile, 'utf8'));
      try { suiteLoading = summarizeSuiteLoading(fullReport, await fs.readFile(progressFile, 'utf8'), source); }
      catch (error) { suiteLoading = { status: 'NO_VERIFIED_SUITE_LOAD_REPORT', error: error.message }; }
      const moduleBinding = bindShardReport(fullReport,allFiles,source,shardIndex,config.shardCount);
      await writeJson('08-full-test.module-binding.json',moduleBinding);
      if(moduleBinding.status!=='COMPLETE_SHARD_PASS')testsPass=false;
      const selectedCases = moduleBinding.cases.filter(item=>regressionFiles.includes(item.file) && item.file!==config.selectors.at(-1));
      record.selectedRegression = {cases:selectedCases.length, pendingOrTodo:selectedCases.filter(item=>['pending','todo','skipped'].includes(item.status)).length};
      if(record.selectedRegression.pendingOrTodo!==0)testsPass=false;
      record.shardCoverage = {status:moduleBinding.status,allFilesDigest:moduleBinding.allFilesDigest,shardFilesDigest:moduleBinding.shardFilesDigest};
      fullCounts = Object.fromEntries(['numTotalTests', 'numPassedTests', 'numFailedTests', 'numPendingTests', 'numTodoTests', 'numTotalTestSuites', 'numFailedTestSuites'].map(key => [key, fullReport[key] ?? null]));
    } catch (error) { fullCounts = { error: error.message, status: 'NO_VERIFIED_FULL_COUNTS' }; testsPass = false; }
    await writeJson('08-full-test.counts.json', fullCounts);
    await writeJson('08-full-test.suite-load.json', suiteLoading);
    const repositoryChecks = {};
    const officialHome = path.join(work, 'official-validation', 'codex-home');
    for (const [name, script] of [['08c-runtime-check', 'runtime:check'], ['08d-validate-all', 'validate:all'], ['08e-validate-official', 'validate:official']]) {

      if (script === 'validate:official') {
        const preparation = { supplier: 'openai/codex', commit: '10382da79a2a2d6e8ae221fa63077215389c1ad2',
          status: 'NOT_RUN', files: [], error: null };
        try {
          mustPass(await command('08e1-python-yaml', 'python', ['-m', 'pip', 'install',
            '--disable-pip-version-check', '--no-cache-dir', 'PyYAML==6.0.3', '--retries', '0'], work, 90_000));
          mustPass(await command('08e2-python-version', 'python', ['-c',
            'import sys,yaml; print(sys.version); print(yaml.__version__); assert sys.version_info[:2] == (3,12) and yaml.__version__ == "6.0.3"'], work, 10_000));
          for (const item of [{"source":"codex-rs/skills/src/assets/samples/plugin-creator/scripts/validate_plugin.py","destination":"skills/.system/plugin-creator/scripts/validate_plugin.py","sha256":"f4eeadb733b28b0c3e714de263a76d6542866a672f3e99bdffcf4dbcdf85e944"},{"source":"codex-rs/skills/src/assets/samples/plugin-creator/scripts/identifier_validation.py","destination":"skills/.system/plugin-creator/scripts/identifier_validation.py","sha256":"a6d51ce4a9a7e8f85626ff5808a467a67574e7f8cdf1167ffb467c5f67e57223"},{"source":"codex-rs/skills/src/assets/samples/skill-creator/scripts/quick_validate.py","destination":"skills/.system/skill-creator/scripts/quick_validate.py","sha256":"ee6dba90f44d37171c5a6edb8095979c54919ff6822c1a907afca2e78c48738c"},{"source":"LICENSE","destination":".supplier/LICENSE","sha256":"d17f227e4df5da1600391338865ce0f3055211760a36688f816941d58232d8dc"},{"source":"NOTICE","destination":".supplier/NOTICE","sha256":"9d71575ecfd9a843fc1677b0efb08053c6ba9fd686a0de1a6f5382fd3c220915"}]) {
            const response = await globalThis.fetch('https://raw.githubusercontent.com/openai/codex/' + preparation.commit + '/' + item.source,
              { redirect: 'error', signal: globalThis.AbortSignal.timeout(Math.min(30_000, Math.max(1, deadline - Date.now()))) });
            assert.equal(response.status, 200, 'Official validator supplier download failed');
            const chunks = []; let length = 0;
            for await (const bytes of response.body) {
              length += bytes.length;
              assert(length <= 1024 * 1024, 'Official supplier file exceeds bounded size');
              chunks.push(bytes);
            }
            const bytes = Buffer.concat(chunks);
            assert.equal(sha(bytes), item.sha256, 'Official supplier digest differs');
            const destination = path.join(officialHome, item.destination);
            await fs.mkdir(path.dirname(destination), { recursive: true });
            await fs.writeFile(destination, bytes, { flag: 'wx' });
            preparation.files.push({ ...item, bytes: bytes.length });
          }
          preparation.status = 'PASS';
        } catch (error) {
          preparation.status = 'FAIL';
          preparation.error = { name: error.name, code: error.code ?? null, message: error.message };
        }
        await writeJson('08e-official-supplier.preparation.json', preparation);
        if (preparation.status !== 'PASS') {
          repositoryChecks[script] = 'NOT_RUN_PREPARATION_FAILED'; testsPass = false; continue;
        }
      }
      const check = await pnpm(name, [script], 90_000, script === 'validate:official'
        ? { CODEX_HOME: officialHome, PYTHONUTF8: '1' } : { PYTHONUTF8: '1' });
      repositoryChecks[script] = check.receipt.status;
      if (check.receipt.status !== 'PASS') testsPass = false;
    }
    const diffCheck = await git('08f-git-diff-check', ['diff', '--check'], source);
    repositoryChecks.gitDiffCheck = diffCheck.receipt.status;
    if (diffCheck.receipt.status !== 'PASS') testsPass = false;
    const finalFreshness = await pnpm('09-final-freshness', ['bundle:check'], 120_000);
    record.fullValidation = { claudeDrift: drift.receipt.status, repositoryChecks, lint: lint.receipt.status, officialTest: full.receipt.status, independentNodeSuites: independentNodeStatus, counts: fullCounts, suiteLoading };
    const after = await tree(source);
    await writeJson('source-after.json', { files: after.length, portableId: portable(after), rows: after });
    sameNonGenerated(before, after);
    assert.deepEqual(after, afterBuild, 'Files changed after official generation');
    const finalVersion = mustPass(await pnpm('10-pnpm-version-after', ['--version'], 10_000));
    assert.equal(finalVersion.stdout.toString('utf8').trim(), config.pnpm);
    await writeJson('environment-after.json', { node: process.version, platform: process.platform,
      pnpm: finalVersion.stdout.toString('utf8').trim(), helperSha256: sha(await fs.readFile(fileURLToPath(import.meta.url))),
      configSha256: sha(await fs.readFile(configPath)) });
    record.runtimeValidation = testsPass && finalFreshness.receipt.status === 'PASS' ? 'SELECTED_CHECKS_PASS' : 'FAIL';
    record.status = record.sourceFreshness === 'PASS' && record.runtimeValidation === 'SELECTED_CHECKS_PASS' ? 'SELECTED_CHECKS_PASS' : 'FAIL';
    record.wholeAcceptance = 'NOT_CLAIMED';
  } catch (error) {
    record.failure = { name: error.name, message: error.message, code: error.code ?? null };
  } finally {
    if (beforeRows) {
      try {
        const finalSource = await tree(source);
        await writeJson('source-final.json', { files: finalSource.length, portableId: portable(finalSource), rows: finalSource });
        sameNonGenerated(beforeRows, finalSource);
        if (afterBuildRows) assert.deepEqual(finalSource, afterBuildRows, 'Generated candidate changed');
        record.finalSourceBinding = 'MATCH_NON_GENERATED_AND_GENERATED_IF_BUILT';
      } catch (error) {
        record.finalSourceBinding = { status: 'FAIL', message: error.message };
        record.status = 'FAIL';
      }
    }
    record.endedAt = new Date().toISOString();
    if (sourceArchive) {
      const planned = planSourceArchive(await tree(output), record, sourceArchive.metadata, config.artifactMaximumBytesPerJob);
      if (planned.descriptor.status === 'RETURNED') {
        const archiveBytes = await fs.readFile(sourceArchive.path);
        assert.equal(archiveBytes.length, sourceArchive.metadata.bytes);
        assert.equal(sha(archiveBytes), sourceArchive.metadata.sha256, 'Prepared source archive changed');
        await fs.writeFile(path.join(output, 'source.actual-head.tar.gz'), archiveBytes, { flag: 'wx' });
      }
      record.sourceArchive = planned.descriptor;
      await writeJson('source-archive.json', planned.descriptor);
    }
    await writeJson('result.json', record);
    const rows = await tree(output);
    await writeJson('result-files.json', { rows, manifestSelfExcluded: true });
    const finalRows = await tree(output);
    const bytes = finalRows.reduce((sum, row) => sum + row.bytes, 0);
    artifactOk = bytes <= config.artifactMaximumBytesPerJob;
    await fs.appendFile(process.env.GITHUB_OUTPUT, `result_path=${output}\nartifact_ok=${artifactOk}\nartifact_bytes=${bytes}\n`);
    if (!artifactOk) console.error('UNVERIFIED_ARTIFACT_BYTES: result exceeds per-job artifact cap; no upload');
    console.log(JSON.stringify({ status: record.status, sourceFreshness: record.sourceFreshness,
      runtimeValidation: record.runtimeValidation ?? 'NOT_RUN', bytes, artifactOk,
      phases: record.phases.map(({name,status,exitCode,errorCode}) => ({name,status,exitCode,errorCode})),
      failureType: record.failure?.name ?? null, failureCode: record.failure?.code ?? null }));
    if (record.status !== 'SELECTED_CHECKS_PASS' || !artifactOk) process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === '--finalize') await finalizeFromRunner();
  else await main();
}
