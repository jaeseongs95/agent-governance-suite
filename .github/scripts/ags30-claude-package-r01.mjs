import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { retainFailureSecondary } from '../../runtime/failure-diagnostics.mjs';

// Official CI only. Generate in a separate checkout; never rewrite consumed source.
const [sourceArg, outputArg] = process.argv.slice(2);
assert(sourceArg && outputArg && process.platform === 'linux');
assert.equal(process.env.GITHUB_ACTIONS, 'true');
assert.equal(process.env.AGS_CI_SHARD_INDEX, '1');
const source = path.resolve(sourceArg), output = path.resolve(outputArg);
assert.equal(await fs.realpath(fileURLToPath(import.meta.url)),
  await fs.realpath(path.join(source, '.github/scripts/ags30-claude-package-r01.mjs')));
const cap = 8 * 1024 * 1024;
// R19 left 1,783,374 bytes; reserve 283,374 for new receipts and observations.
const maximumExportBytes = 1_500_000;
const archiveName = 'claude-package.actual.tar.gz';
const manifestName = 'claude-package.manifest.json';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const ordinal = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const portable = rows => sha(Buffer.from([...rows].sort((a, b) => ordinal(a.relativePath, b.relativePath))
  .map(row => `${row.relativePath}\t${row.bytes}\t${row.sha256}\n`).join('')));
const safe = name => typeof name === 'string' && name.length > 0 && !/[\\:\0\r\n]/u.test(name)
  && !name.startsWith('/') && name.split('/').every(part => part && part !== '.' && part !== '..');
const run = (command, args, cwd) => {
  const env = { ...process.env, AGENT_GOVERNANCE_ROOT: cwd };
  delete env.NODE_OPTIONS;
  delete env.NODE_PATH;
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 60_000, shell: false });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} failed: ${result.stderr}`);
  return result.stdout.trim();
};
const json = async file => JSON.parse(await fs.readFile(file, 'utf8'));
async function rowsAt(root, names) {
  const folded = new Set(), rows = [];
  for (const relativePath of [...names].sort(ordinal)) {
    assert(safe(relativePath), 'Unsafe package input path');
    assert(!folded.has(relativePath.toLowerCase()), 'Duplicate package input path');
    folded.add(relativePath.toLowerCase());
    let current = root;
    for (const part of relativePath.split('/')) {
      current = path.join(current, part);
      assert(!(await fs.lstat(current)).isSymbolicLink(), 'Package input link rejected');
    }
    const info = await fs.lstat(current);
    assert(info.isFile(), 'Package input must be a regular file');
    const bytes = await fs.readFile(current);
    assert.equal(bytes.length, info.size);
    rows.push({ relativePath, bytes: bytes.length, sha256: sha(bytes), mode: (info.mode & 0o777).toString(8).padStart(4, '0') });
  }
  return rows;
}
async function fileNames(root, prefix = '') {
  const names = [];
  for (const entry of await fs.readdir(path.join(root, prefix), { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    assert(safe(relative) && !entry.isSymbolicLink(), 'Unsafe package output path or link');
    if (entry.isDirectory()) names.push(...await fileNames(root, relative));
    else { assert(entry.isFile(), 'Nonregular package output'); names.push(relative); }
  }
  return names.sort(ordinal);
}

const config = await json(path.join(source, '.github/ci/ags30-r11/execution-config.json'));
assert.equal(config.artifactMaximumBytesPerJob, cap);
assert.equal(config.generated.length, 11);
const sourceManifest = await json(path.join(output, 'source-manifest.json'));
const executionSources = ['.github/scripts/ags30-claude-package-r01.mjs', 'runtime/failure-diagnostics.mjs',
  'scripts/build-claude-plugin.mjs', 'scripts/lib.mjs'].map(relativePath => {
  const row = sourceManifest.rows.find(row => row.relativePath === relativePath);
  assert(row, 'Packaging execution source is missing from actual HEAD manifest');
  return row;
});
const generated = await json(path.join(output, 'generated-runtime.json'));
assert.equal(generated.status, 'GENERATED_NOT_ACCEPTED');
assert.deepEqual(generated.rows.map(row => row.relativePath).sort(ordinal), [...config.generated].sort(ordinal));
assert.equal(portable(generated.rows), generated.portableId);
const head = run('git', ['rev-parse', 'HEAD'], source);
const sourceTree = run('git', ['rev-parse', 'HEAD^{tree}'], source);
assert.equal(head, sourceManifest.head);
assert.equal(sourceTree, sourceManifest.sourceTree);
const generatedPaths = new Set(config.generated);
const bodyNames = sourceManifest.rows.filter(row => !generatedPaths.has(row.relativePath)).map(row => row.relativePath);
const bodyBefore = await rowsAt(source, bodyNames);
assert.deepEqual(bodyBefore.map(({ relativePath, bytes, sha256 }) => ({ relativePath, bytes, sha256 })), sourceManifest.rows.filter(row => !generatedPaths.has(row.relativePath)));
const generatedBefore = await rowsAt(source, config.generated);
assert.deepEqual(generatedBefore.map(({ relativePath, bytes, sha256 }) => ({ relativePath, bytes, sha256 })), generated.rows);
const work = await fs.mkdtemp(path.join(tmpdir(), 'ags-claude-package-'));
let primaryFailure = null;
try {
  const checkout = path.join(work, 'source');
  run('git', ['clone', '--local', '--no-hardlinks', '--no-checkout', source, checkout], work);
  run('git', ['checkout', '--detach', head], checkout);
  assert.equal(run('git', ['rev-parse', 'HEAD'], checkout), head);
  for (const row of generatedBefore) {
    const destination = path.join(checkout, row.relativePath);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(path.join(source, row.relativePath), destination);
  }
  const cloneInputNames = sourceManifest.rows.map(row => row.relativePath).filter(name => !name.startsWith('claude-plugin/'));
  const cloneBefore = await rowsAt(checkout, cloneInputNames);
  assert.deepEqual(cloneBefore, await rowsAt(source, cloneInputNames));
  const buildOutput = run(process.execPath, ['scripts/build-claude-plugin.mjs'], checkout);
  const checkOutput = run(process.execPath, ['scripts/build-claude-plugin.mjs', '--check'], checkout);
  assert.deepEqual(await rowsAt(checkout, cloneInputNames), cloneBefore, 'Claude generation changed shared inputs');
  const packageRoot = path.join(checkout, 'claude-plugin');
  await assert.rejects(fs.access(path.join(packageRoot, 'node_modules')), { code: 'ENOENT' });
  const environment = { ...process.env };
  for (const key of ['AGENT_GOVERNANCE_ROOT', 'NODE_OPTIONS', 'NODE_PATH']) delete environment[key];
  for (const [key, file] of [
    ['AGENT_GOVERNANCE_DB_PATH', 'workflows.sqlite3'],
    ['AGENT_GOVERNANCE_CONTINUITY_DB_PATH', 'continuity.sqlite3'],
    ['AGENT_GOVERNANCE_SESSION_BOARD_DB_PATH', 'session-board.sqlite3'],
    ['AGENT_GOVERNANCE_TRUST_DB_PATH', 'trust.sqlite3'],
    ['AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR', 'messaging'],
  ]) environment[key] = path.join(work, 'probe-state', file);
  // Reuse the existing runtime-smoke STDIO initialize boundary; list public tools only.
  const input = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'runtime-smoke', version: '1.0.0' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized', params: {} },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  ].map(message => JSON.stringify(message)).join('\n') + '\n';
  const probe = spawnSync(process.execPath, [path.join(packageRoot, 'mcp-server/dist/server.mjs')], {
    cwd: packageRoot, env: environment, input, encoding: 'utf8', maxBuffer: 5 * 1024 * 1024, timeout: 10_000, shell: false });
  if (probe.error) throw probe.error;
  assert.equal(probe.status, 0, `Packaged MCP STDIO startup failed: ${probe.stderr}`);
  const messages = probe.stdout.split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line));
  assert.equal(messages.find(message => message.id === 1)?.result?.protocolVersion, '2025-03-26');
  const tools = messages.find(message => message.id === 2)?.result?.tools;
  assert(Array.isArray(tools) && tools.length > 0 && tools.every(tool => typeof tool.name === 'string'), 'Packaged tools/list failed');
  const names = (await fileNames(path.join(checkout, 'claude-plugin'))).map(name => `claude-plugin/${name}`);
  assert(names.length > 0);
  const rows = await rowsAt(checkout, names);
  assert(rows.reduce((sum, row) => sum + row.bytes, 0) <= 64 * 1024 * 1024, 'Uncompressed package exceeds bound');
  const list = path.join(work, 'members.list'), tar = path.join(work, 'package.tar');
  await fs.writeFile(list, Buffer.from(names.join('\0') + '\0'), { flag: 'wx' });
  run('tar', ['--format=ustar', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner',
    '--no-recursion', '--null', '-cf', tar, '-C', checkout, '-T', list], work);
  const archive = gzipSync(await fs.readFile(tar), { level: 9 });
  assert.deepEqual(await rowsAt(checkout, names), rows, 'Claude bytes changed during packing');
  const bodyAfter = await rowsAt(source, bodyNames), generatedAfter = await rowsAt(source, config.generated);
  assert.deepEqual(bodyAfter, bodyBefore, 'Consumed source body changed');
  assert.deepEqual(generatedAfter, generatedBefore, 'Consumed runtime changed');
  assert.equal(run('git', ['rev-parse', 'HEAD'], source), head);
  assert.equal(run('git', ['rev-parse', 'HEAD^{tree}'], source), sourceTree);
  const manifest = {
    schemaVersion: 'AgsOfficialClaudePackage.v1', status: 'GENERATED_NOT_ACCEPTED',
    unit: config.unit, nonce: config.nonce, runId: sourceManifest.runId, attempt: sourceManifest.attempt,
    job: sourceManifest.job, runnerOs: 'Linux', shardIndex: 1,
    generator: { path: 'scripts/build-claude-plugin.mjs', build: 'PASS', check: 'PASS', execution: 'OFFICIAL_CI_LINUX_SHARD_1',
      buildOutputSha256: sha(Buffer.from(buildOutput)), checkOutputSha256: sha(Buffer.from(checkOutput)) },
    loaderValidation: { status: 'PASS', scope: 'PACKAGED_STDIO_INITIALIZE_TOOLS_LIST_ONLY',
      tools: tools.map(tool => tool.name), fullRuntimeSmoke: 'NOT_RUN_EXCLUDED_CODEX_CLI', liveHostAndModelCapability: 'NOT_CLAIMED' },
    sourceBinding: { head, sourceTree, originalSourcePortableId: sourceManifest.portableId,
      bodyBeforePortableId: portable(bodyBefore), bodyAfterPortableId: portable(bodyAfter),
      generatedRuntimePortableId: generated.portableId, executionSources },
    archive: { member: archiveName, bytes: archive.length, sha256: sha(archive), format: 'ustar+gzip', root: 'claude-plugin/' },
    files: rows.length, portableId: portable(rows),
    modePortableId: sha(Buffer.from(rows.map(row => `${row.relativePath}\t${row.mode}\t${row.bytes}\t${row.sha256}\n`).join(''))),
    rows, wholeAcceptance: 'NOT_CLAIMED'
  };
  const existing = await rowsAt(output, await fileNames(output));
  const existingBytes = existing.reduce((sum, row) => sum + row.bytes, 0);
  const budget = Math.min(maximumExportBytes, cap - existingBytes);
  manifest.exportBudget = { maximumBytes: maximumExportBytes, existingBytesAtPacking: existingBytes,
    availableBytesAtPacking: budget, finalCollectorCapStillRequired: true };
  manifest.archive.status = 'RETURNED';
  let manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
  if (archive.length + manifestBytes.length > budget) {
    manifest.status = 'NOT_RETURNED_CAP';
    manifest.archive.status = 'NOT_RETURNED_CAP';
    manifest.archive.plannedMember = archiveName;
    manifest.archive.member = null;
    manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
  }
  assert(manifestBytes.length <= budget, 'Package manifest alone exceeds remaining export budget');
  if (manifest.archive.status === 'RETURNED') await fs.writeFile(path.join(output, archiveName), archive, { flag: 'wx' });
  await fs.writeFile(path.join(output, manifestName), manifestBytes, { flag: 'wx' });
  console.log(JSON.stringify({ status: manifest.status, files: rows.length, portableId: manifest.portableId,
    archiveBytes: archive.length, archiveSha256: manifest.archive.sha256 }));
} catch (error) {
  primaryFailure = { error };
}
try { await fs.rm(work, { recursive: true, force: true }); }
catch (cleanup) {
  if (primaryFailure === null) throw cleanup;
  retainFailureSecondary(primaryFailure.error, cleanup);
}
if (primaryFailure !== null) throw primaryFailure.error;
