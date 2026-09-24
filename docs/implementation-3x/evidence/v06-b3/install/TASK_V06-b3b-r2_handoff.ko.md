# TASK_V06-b3b-r2 handoff

- **TASK_ID**: V06-b3b-r2 (Linux 보호 runtime 입력 신뢰 경계 복구)
- **결과**: F1(source 자식 미검사)과 F2(caller JSON 부모 대조)를 보완했다. 기존 root `32a825d9…`를 읽기 전용으로 재검증했다(새 설치 아님).
- **브랜치**: `claude/v3x-v06-b3b-r1`, 부모 커밋 `c584e0a46493d3cf937323b12bd3dbdc9737a046`(r1, 총괄 감사 FAIL)
- 이 handoff는 자기 커밋 SHA를 담을 수 없다. 최종 SHA와 독립 감사 판정은 세션 최종 보고에 적는다.

## 원 결함 재현 (`c584e0a4` 코드)

- r2 테스트 4건 실패: pin 상수 없음, 0666 manifest 수락(`Missing expected exception: manifest 0666`), pin 없는 host digest 수락, caller JSON 부모 재사용 수락
- 진단 fixture: 쓰기 가능한 source 입력과 위조 부모 manifest가 모두 `ACCEPTED`

## 변경 파일

- `scripts/qualification/v06-b3-linux-install.mjs`: `TRUST_PINS`, `readTrustedSourceFile`, `verifyContractPins`, `readTrustedParentManifest` 추가, 설치·검증 경로와 CLI를 pin 기반으로 전환
- `tests/coordinate-subagents/v3x/V06-b3b-r2.test.mjs` (신규)
- `tests/coordinate-subagents/v3x/V06-b3b-r1.test.mjs`: fixture source에 V03-i·v2 계약 파일을 넣고, pin을 라이브러리 옵션으로 전달한다. 부모 재사용은 pin된 root 전용 manifest 파일로 바꿨다. host-integration 변조 사례는 두 digest를 모두 pin해 결합 ID 검사까지 도달하게 했다.
- `README.ko.md`, 이 handoff

## 검사 결과 (Node v24.21.0, 검증된 archive에서 추출)

- r2+r1+b3b env 없음: 8 passed, 13 skipped
- r2+r1+b3b fixture: 18 passed, 3 skipped
- r2+r1+b3b fixture + live 읽기 전용: 21 passed (재설치 없음, nobody r2 18건·r1 19건 거절)
- V06-b3a 회귀: 4 passed
- 변이(fixture): 자식 검사 해제, package pin 해제, 부모 pin 해제, V03-i·v2 pin 해제, caller JSON 수락, gate를 source 읽기 뒤로 이동 — 각각 1건 실패. 원복 후 cmp 동일
- eslint(대상 js 3개), `node scripts/validate-repository.mjs`, `node scripts/check-source-lock.mjs`, `node scripts/check-bundle.mjs`, `git diff --check`: 통과
- Windows 실행: 이 VM에서 불가, NOT_RUN

## 보정 (7da3139c 감사 이후)

- arch 검사 추가: `x64`가 아니면 `/usr` gate → linux-only 다음, host 접근 전에 거절한다(설치·검증·사용 직전). 7da3139c 코드에서는 새 arch 회귀가 실패했고, 검사를 빼는 변이도 실패했다.
- r1 fixture의 계약 파일 복사본을 0644로 고정했다. 파일 전부를 664로 바꾼 checkout 복사본에서 r1+r2 fixture가 12 passed, 2 skipped다.
- 보정 후: env 없음 9 passed, 13 skipped. fixture 19 passed, 3 skipped. live 읽기 전용 22 passed(재설치 없음, `bin/node` ino·ctime 불변).
- mount 경계는 기록만 하며 거절 조건이 아니다.

## 남은 문제

- V03-i·v2 pin 검사는 source 트리에 그 계약 파일이 있어야 한다(현재 source는 `git archive 0724bb2b` 전체).
- loader closure 측정(V06-b3c), 원시 증거 전달(r3), 운영 host 적격은 범위 밖이다.
- `r1-live/` 미추적 파일은 r3 입력으로 커밋하지 않고 남겨 두었다.
