import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
const [source, output] = process.argv.slice(2);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const file = path.join(source, 'mcp-server/src/session-message-store.ts');
const original = await fs.readFile(file);
const sourceDigest = hash(original);
const expectedMutantDigest = new Map([
  ['8a4796f9e19f977e4275999f5743f1a4598436ab4bdaf847b66f7e4f2af5075e', 'd10b11b83bd4191de245dd8a6a1b9329550d7541e93b859b92df2f18ceae6d2f'],
  ['b9856206e10b039c5f5dfc9f16ff9144bcd00fe73c460a74ce1d88e6021e82c0', '82d2be89a6960dddf21027d8c71cb69125d132be43f9fbeb07efc1ae54c1aa3a'],
  ['8720482bd3d9bee0f76ab9206de4d2ab043c69b3f8dd2caffdbca0c2b4d20a6d', '1bba2bd9eeba2ffce90f1ab09a70f705c5cb26ede16e6806b54f0cf271eaf88a'],
  // D0354·인수 영수증 수리 뒤에도 claimHostWake 본문과 네 결함 치환은 동일하다.
  ['8afc6279fca23f1a2bd475de56f64eb80044de71391f8d78523835f1b370ec0f', '007b1d11ed3a7bd39716c1c0af6fe841a9df062ed4b0750f10a44af00f8b7ef5'],
  ['e5227b3e2d229e3e429b0d4e8e0d01879777337b6fc79c531fe1ebdee2c9b3ad', '1c76a06445226d491241c42866b0b062a2c82caf8a4e14aff679ad30f24f0e1a'],
  // D0354의 부모 세대 보존은 원 깨우기 함수와 네 결함 치환을 보존한다.
  ['44f8668045c5faeec389045ff52d43d7ee014d593ed1b3ac300246abd7c8dcdd', '1d7deadabde34c5c34c368292e435893fcd230966ef8d4700d7a2e327759588e'],
]).get(sourceDigest);
assert.ok(expectedMutantDigest, `UNKNOWN_WAKE_MIXED_RED_SOURCE:${sourceDigest}`);
const baseline = Buffer.from(original.toString('utf8')
  .replace("// A proven, already consumed arrival may recur beside a new marker in a\n      // fresh receipt. It is inert history, never authority for another body.\n      const alreadyObserved = (row: Record<string, unknown>) => row.state === \"observed\"\n        && typeof row.observed_at === \"string\" && typeof row.consumed_at === \"string\"\n        && typeof row.nonce === \"string\" && row.nonce_digest === nonceDigest(row.nonce);\n      if (rows.some((row) => !row || (!alreadyObserved(row)\n        && ![\"legacy\", \"started\", \"submitted\", \"unknown\", \"expired-unobserved\"].includes(String(row.state))))) {", "if (rows.some((row) => !row || ![\"legacy\", \"started\", \"submitted\", \"unknown\", \"expired-unobserved\"].includes(String(row.state)))) {")
  .replace('      if (rows.every((row) => alreadyObserved(row!))) return rejected;\n', '')
  .replace('const live = rows.filter((row) => row!.state !== "expired-unobserved" && !alreadyObserved(row!));',
    'const live = rows.filter((row) => row!.state !== "expired-unobserved");')
  .replace('if (live.length === 0) return rows.every((row) => row!.state === "expired-unobserved") ? { ...rejected, retired: true } : rejected;',
    'if (live.length === 0) {  return { ...rejected, retired: true }; }'));
assert.equal(hash(baseline), expectedMutantDigest);
const name = 'fresh verified observed A plus current B receipt claims only B once and preserves A';
const report = path.join(output, '07e-wake-mixed-red.vitest.json');
let result;
try {
  await fs.writeFile(file, baseline);
  result = spawnSync(process.execPath, [path.join(source, 'node_modules/vitest/vitest.mjs'), 'run',
    'tests/session-messaging/wake-lifecycle.test.mjs', '-t', name, '--reporter=json', '--outputFile=' + report],
    { cwd: source, env: process.env, shell: false, windowsHide: true, timeout: 30_000, maxBuffer: 512 * 1024 });
} finally {
  await fs.writeFile(file, original);
  assert.equal(hash(await fs.readFile(file)), hash(original));
}
await fs.writeFile(path.join(output, '07e-wake-mixed-red.child.stdout.bin'), result.stdout ?? Buffer.alloc(0));
await fs.writeFile(path.join(output, '07e-wake-mixed-red.child.stderr.bin'), result.stderr ?? Buffer.alloc(0));
assert.equal(result.status, 1);
assert.equal(result.signal, null);
assert.equal(result.error, undefined);
const data = JSON.parse(await fs.readFile(report, 'utf8'));
assert.equal(data.numFailedTests, 1);
const failed = data.testResults.flatMap(row => row.assertionResults).filter(row => row.status === 'failed');
assert.equal(failed.length, 1);
assert.equal(failed[0].fullName, name);
assert.match(failed[0].failureMessages.join('\n'), /false.*true|false !== true/s);
const proof = { status: 'EXPECTED_RED_BASELINE', test: name, baselineSha256: hash(baseline),
  restoredCandidateSha256: hash(await fs.readFile(file)), originalAssertionsChanged: false,
  actualFailedTests: data.numFailedTests, childExitCode: result.status };
await fs.writeFile(path.join(output, '07e-wake-mixed-red.proof.json'), JSON.stringify(proof, null, 2) + '\n');
console.log(JSON.stringify(proof));
