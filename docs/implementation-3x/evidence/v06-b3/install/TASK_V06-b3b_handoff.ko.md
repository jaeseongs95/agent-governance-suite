# TASK_V06-b3b handoff

- **TASK_ID**: V06-b3b (Linux 보호 runtime root와 byte identity)
- **결과**: 후보 host 설치·검증 완료, 상태 `CANDIDATE_HOST_INSTALLED`
- **브랜치**: 최초 `claude/v3x-v06-b3b-linux-install`(로컬), 보수 `claude/v3x-v06-b3b-fix`
- **start SHA**: `a9f3bd4a83cbb54eeccb9a143c7fcf4dad36e7d5` (`origin/codex/v260-semantic-decision-layer` FETCH_HEAD와 일치 확인)
- **보수 부모**: `af65a82e0abdde6f9de929f9943dc92047d9e67d`(최초 커밋과 같은 tree `d61f2623…`)
- 이 handoff는 자기 커밋 SHA를 담을 수 없다. 최종 SHA와 독립 감사 판정은 세션 최종 보고에 적는다.

## 보수: 원래 실패

- Windows 통합 검증(FAIL_RELEVANT): `a /usr install is refused without the explicit gate env`가 `requires AGS_V06_B3B_PROTECTED_INSTALL=1` 대신 `ENOENT <drive>:\proc\self\mountinfo`로 실패했다.
- 원인: `protectedPaths`가 호스트 `path.resolve`를 써서 Windows에서 `/usr/lib`가 `D:\usr\lib`가 됐고, `/usr` gate를 건너뛴 채 `/proc`을 읽었다.
- 수정: POSIX 경로 계산, gate → 플랫폼 → bytes → host 접근 순서, `platform` 주입과 non-linux 거절.
- Linux 재현: 새 회귀 검사를 수정 전 코드(`af65a82e`)에서 돌리면 경로가 `\usr\lib…`로 나오고 gate 없음·gate 있음·darwin 세 경우 모두 `/proc/self/mountinfo` 접근으로 실패했다.

## 변경 파일

- `scripts/qualification/v06-b3-linux-install.mjs` (신규)
- `tests/coordinate-subagents/v3x/V06-b3b.test.mjs` (신규)
- `docs/implementation-3x/evidence/v06-b3/install/README.ko.md` (신규)
- `docs/implementation-3x/evidence/v06-b3/install/TASK_V06-b3b_handoff.ko.md` (신규)
- b3a leaf, 공유 `scripts/build.mjs`·`manifest.ts`·`host-integration.json`·`package.json`은 바꾸지 않았다.

## 검사 결과 (Node v24.21.0, 검증된 archive에서 추출)

- `V06-b3b.test.mjs` env 없음: 3 passed, 5 skipped (최초 2 passed, 5 skipped)
- `V06-b3b.test.mjs` fixture + live gate env: 8 passed (새 후보 host, 수정 후 코드로 설치)
- `V06-b3a.test.mjs` 회귀: 4 passed
- 대상 파일 eslint: 오류 없음
- 변이: `nlink` 거절을 끄거나 사용 직전 identity 대조를 끄면 각각 1건 실패
- 보수 변이: 호스트 `path`로 되돌림, gate를 host 접근 뒤로 이동, install의 플랫폼 검사 제거, 플랫폼 검사 무력화 각각 새 회귀 검사 1건 실패
- Windows 실행: 이 VM에서 실행할 수 없어 NOT_RUN
- `node scripts/validate-repository.mjs`: `repository: valid`
- `git diff --check`: 출력 없음

## 후보 host 상태

- 새 후보 host(boot_id `85e6dab7…`)의 설치 트리 `/usr/lib/agent-governance-suite`를 감사용으로 남겨 두었다.
- 실제 관측값은 같은 디렉터리의 `README.ko.md`에 있다.

## 남은 문제

- 운영 host 설치와 운영 subtree 적격은 별도 leaf가 필요하다.
- fixture 검사는 Linux root와 안전한 fixture parent가 있어야 실행된다. 일반 CI(비root, sticky `/tmp`)에서는 skip으로 보인다.
- ELF loader closure(동적 링커·공유 라이브러리) 측정은 이 leaf 범위 밖이다.
