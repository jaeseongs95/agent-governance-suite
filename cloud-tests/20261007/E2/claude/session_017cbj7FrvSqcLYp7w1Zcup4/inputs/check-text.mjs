import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const expected = { E4: '저장됐습니다\n', E9: '대기 목록\n항목: 0\n' };
try {
  assert.ok(Object.hasOwn(expected, process.argv[2]), 'case는 E4 또는 E9');
  assert.equal(readFileSync(process.argv[3], 'utf8'), expected[process.argv[2]]);
  console.log(JSON.stringify({ case: process.argv[2], verdict: 'PASS' }));
} catch (error) { console.error(JSON.stringify({ verdict: 'FAIL', error: error.message })); process.exitCode = 1; }
