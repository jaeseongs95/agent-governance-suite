import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const read = (path) => readFileSync(`${repo}${path}`, 'utf8');
const contract = read('docs/implementation-3x/ags-protected-provisioning.ko.md');
const v03iPath = 'docs/implementation-3x/protected-host-installation.ko.md';
const v03iBytes = readFileSync(`${repo}${v03iPath}`);
const v03i = v03iBytes.toString('utf8');

const rows = contract
  .split('\n')
  .map((line) => /^\| ([TV]\d{2}) \| 「(.+)」 \| ([^|]+) \| ([^|]+) \|$/.exec(line))
  .filter(Boolean)
  .map(([, id, quote, targets, status]) => ({ id, quote, targets: targets.trim(), status: status.trim() }));

const sectionOf = (quote) => {
  const at = v03i.indexOf(quote);
  const heading = v03i.slice(0, at).match(/^## .+$/gm);
  return heading?.at(-1);
};

describe('B14-s AGS protected provisioning contract', () => {
  test('pins the current V03-i bytes, commit and common section', () => {
    const digest = createHash('sha256').update(v03iBytes).digest('hex');
    expect(contract).toContain(`\`${v03iPath}\``);
    expect(contract).toContain(`\`${digest}\``);
    expect(contract).toContain('`6006844e8da8bbe5d9f1aeed0a74682bd3c16928`');
    expect(contract).toContain('`protected-host-provisioning/v1`');
    expect(v03i).toContain('<a id="protected-host-provisioning-v1"></a>');
    const manifest = JSON.parse(read('tests/coordinate-subagents/v3x/fixtures/protected-host-installation/manifest.json'));
    expect(manifest.authority).toEqual({ path: v03iPath, sha256: `sha256:${digest}` });
  });

  test('traces every row to verbatim V03-i text and an existing clause', () => {
    expect(rows.length).toBeGreaterThanOrEqual(40);
    expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length);
    for (const row of rows) {
      expect(v03i, `${row.id} quote`).toContain(row.quote);
      if (row.id.startsWith('V')) {
        expect(row).toMatchObject({ targets: 'V03-i', status: 'VM 전용 유지' });
        continue;
      }
      expect(['보존', '일반화'], row.id).toContain(row.status);
      for (const clause of row.targets.split(', ')) {
        expect(contract, `${row.id} → ${clause}`).toMatch(new RegExp(`(\\*\\*${clause.replace('.', '\\.')}\\*\\*|^## ${clause}\\. )`, 'm'));
      }
    }
  });

  test('covers each normative V03-i section and records no deleted or relaxed hard condition', () => {
    const covered = new Set(rows.filter((row) => row.id.startsWith('T')).map((row) => sectionOf(row.quote)));
    for (const section of [
      '## 고정 경로와 신뢰 경계',
      '## 운영 설치 기록과 보호 상태',
      '## 주체와 접근 행렬',
      '## 설치·회전·복구 절차의 불변 조건',
      '## 현재 Core 호출과 IPC 결속',
      '## 공통 provisioning 사용 범위',
      '## fixture와 판정',
    ]) expect(covered, section).toContain(section);
    const statuses = new Set(rows.map((row) => row.status));
    expect([...statuses].sort()).toEqual(['VM 전용 유지', '보존', '일반화']);
    expect(contract).toContain('삭제·완화 상태는 없다');
  });

  test('keeps VM executables out of the AGS core prerequisites', () => {
    const p0 = contract.slice(contract.indexOf('## P0.'), contract.indexOf('## P2.'));
    for (const term of ['VM Core signer/reader', 'VM worker service', 'VM protected-state producer', 'VM interpreter', 'fixture digest'])
      expect(p0).toContain(term);
    expect(p0).toMatch(/실행 선행으로 요구하지 않는다/);
    expect(p0).toMatch(/삭제하거나 완화하지 않는다/);
  });

  test('separates OS scopes, freeze meaning and Progress mapping', () => {
    const p8 = contract.slice(contract.indexOf('## P8.'), contract.indexOf('## P9.'));
    expect(p8).toContain('`windows-linux`');
    expect(p8).toMatch(/서로 독립으로 선택·검증한다/);
    expect(p8).toMatch(/한 OS 결과를 다른 OS나 결합 완료로 전용하지 않는다/);
    expect(contract).toMatch(/OS 서비스 설치, 계정·ACL·mode 적용, 실효 권한 검증, 실제 token\/UID 관측, SQLite xOpen proof/);

    const mapping = Object.fromEntries(
      contract
        .split('\n')
        .map((line) => /^\| `([A-Z_]+)` \| [^|]+ \| ([^|]+) \|$/.exec(line))
        .filter(Boolean)
        .map(([, output, progress]) => [output, progress.trim()]),
    );
    expect(Object.keys(mapping).sort()).toEqual([
      'AGS_PROTECTED_PROVISIONING_CONTRACT_FROZEN',
      'BLOCKED_CONTRACT_SCOPE',
      'CONTRACT_FAILED',
      'NOT_RUN',
    ]);
    expect(mapping.AGS_PROTECTED_PROVISIONING_CONTRACT_FROZEN).toMatch(/^`COMPLETED`를 요청할 수 있다$/);
    for (const output of ['BLOCKED_CONTRACT_SCOPE', 'CONTRACT_FAILED', 'NOT_RUN'])
      expect(mapping[output]).toMatch(/`COMPLETED` 금지/);
  });
});
