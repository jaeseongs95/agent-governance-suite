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

const expectedIds = [
  ...Array.from({ length: 49 }, (_, i) => `T${String(i + 1).padStart(2, '0')}`),
  ...Array.from({ length: 8 }, (_, i) => `V${String(i + 1).padStart(2, '0')}`),
];

// Each carried condition must still read as the hard condition in its first target clause.
const keyText = {
  T01: '시스템 부모의 owner/ACE·mode를 시스템 전체에서 바꾸지 않는다',
  T02: 'rename/delete/replace, reparse/junction·symlink 전환, mount/bind-mount, ACL/owner 변경을 할 수 없어야 한다',
  T03: 'SID·group·deny/allow·상속·privilege를 포함한 **실효 권한**으로 평가한다',
  T04: '단순 ACL 비트 목록이나 subtree 파일 ACL만으로 판정하지 않는다',
  T05: 'root부터 보호 subtree와 파일까지 owner, mode, ACL, mount/bind-mount, symlink를 확인하고',
  T06: '열린 파일의 identity를 다시 확인해 TOCTOU를 닫는다',
  T07: '열린 handle의 volume/file identity와 각 부모의 교체 불가를 검사한다',
  T08: 'metadata 조회 실패는 거부한다',
  T09: 'caller 입력이 아니라 installer가',
  T10: 'self-reported JSON만으로 실효 ACL·token·hash 확인을 대체하지 않는다',
  T11: '임의 `--db`·`--artifacts`·argv·환경 변수',
  T12: '역할은 특정 SID/uid/서비스 이름을 강제하는 식별자가 아니다',
  T13: '같은 실효 SID/uid, 같은 group을 통한 쓰기 권한, 또는 서로의 프로세스 제어·읽기 권한을 가지면 실패다',
  T14: 'SID 이름만 다른지 또는 restricted token 명칭만 있는지로 통과시키지 않는다',
  T15: '명시적 환경 블록과 최소 handle 상속을 사용한다',
  T16: 'uid/euid/gid/egid/groups/capability를 실제 프로세스에서 관측한다',
  T17: '그 설정 이름만으로 접근 거부를 대체하지 않는다',
  T18: '일반 `Popen`으로 다른 uid로 바꾸는 경로는 권한 없이 성립하지 않는다',
  T19: '실제 설치 환경에서 마련되지 않으면 운영 판정은 `BLOCKED_CONTRACT`',
  T20: '파일 ACL만으로 둘 사이의 OS 분리를 주장하지 않는다',
  T21: '같은 SID/uid의 공개 pipe ACL, caller가 고르는 IPC 주소나 token',
  T22: '조작 가능한 불신 입력',
  T23: 'staging 자료',
  T24: '상속·duplication·재연결할 수 없어야 한다',
  T25: 'argv·환경 변수·stdin·caller JSON·로그·fixture·메시지로 전달하거나 고르게 하지 않는다',
  T26: 'caller가 그런 필드를 보내면 무시하지 않고 거부한다',
  T27: '생산자 leaf(B14-q-a/B14-q, B14-r)의 필수 책임이다',
  T28: '허용된 동일 설치임을 증명하기 전에는 덮어쓰지 않는다',
  T29: '사용자 선점 디렉터리는 실패다',
  T30: '설치 기록과 서비스 정의의 revision·경로·principal을 동시에 고정한다',
  T31: '완전한 검증 후 원자적으로 교체·동기화한다',
  T32: '비밀 원문은 로그·fixture·메시지·worker 환경에 넣지 않는다',
  T33: '`.cmd` wrapper',
  T34: '선택 경로는 측정된 interpreter closure다',
  T35: '`NEEDS_SPLIT`으로 보고하고 지원 OS를 추정하지 않는다',
  T36: '불일치·조회 불가·서비스 재시작·회전 중간 상태는 fail-closed다',
  T37: '자동 권한 완화, root ACL 수정, 환경 변수 경로 우회는 복구가 아니다',
  T38: '**한 묶음으로**',
  T39: 'caller·argv·환경 변수가 revision이나 digest를 제공하는 방식은 허용하지 않는다',
  T40: 'V03-i의 VM key/pin/worker fixture digest',
  T41: '같은 SID/uid·서비스 계정을 요구하지 않는다',
  T42: '운영 `host-supported/configured/observed`가 아니다',
  T43: '`UNKNOWN`을 PASS로 올리지 않는다',
  T44: '읽기·쓰기·복제를 포함한 모든 접근을 거부해야 한다',
  T45: '설치 기록의 필수 필드는',
  T46: '실행 형식(상주 서비스, 요청 단위 보호 helper 등)과 접근 행렬은 소비 Task가 정한다',
  T47: 'user/group·enabled privileges·integrity를 실제로 측정한다',
  T48: '`no_new_privs` 등 재상승 방어를 적용하되',
  T49: '동시 확인과 재qualification으로만 한다',
};

const clauseText = (clause) => {
  const bullet = contract.split('\n').find((line) => line.startsWith(`- **${clause}** `));
  if (bullet) return bullet;
  const start = contract.indexOf(`## ${clause}. `);
  return start < 0 ? '' : contract.slice(start, contract.indexOf('\n## ', start + 1));
};

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
    expect(rows.map((row) => row.id)).toEqual(expectedIds);
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

  test('keeps each carried hard condition in its target clause', () => {
    for (const row of rows.filter(({ id }) => id.startsWith('T'))) {
      const [first] = row.targets.split(', ');
      expect(clauseText(first), `${row.id} → ${first}`).toContain(keyText[row.id]);
    }
    expect(clauseText('P3.2')).toMatch(/하나라도 없거나 조회하지 못하면 fail-closed다/);
    expect(clauseText('P4.4')).toMatch(/읽기 거부는 소비 계약이 요구할 때만 요구한다\(B14-m registry는 요구하지 않음\)/);
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
