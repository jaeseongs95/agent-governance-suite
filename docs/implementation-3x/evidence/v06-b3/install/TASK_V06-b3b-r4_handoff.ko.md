# TASK_V06-b3b-r4 handoff

- **TASK_ID**: V06-b3b-r4 (Linux 보호 runtime mount 교체 경계 복구)
- **결과**: mount와 bind-mount 경계를 install·verify·use에서 fail-closed로 거절한다. 실제 mount 재현은 private mount namespace 안에서 했다. 기존 두 root는 읽기 전용으로 재검증했다.
- **브랜치**: `claude/v3x-v06-b3b-r1`, 부모 커밋 `56750d196bf498506f9e4e02cd8025ef5cd7d27c`(r2, BLOCKED). 통합 기준은 `c7e8049d541e5779ce99793a99832cc9413532bb`다.
- 이 handoff는 자기 커밋 SHA를 담을 수 없다. 최종 SHA와 감사 판정은 세션 최종 보고에 적는다.

## 변경 파일

- `scripts/qualification/v06-b3-linux-install.mjs`: `parseMountinfo`, `inspectMountBoundary`, device 대조, 검증 record의 `boundary`, use 시점 경계 재확인(두 번). 이전 배치의 install·verify·use에도 적용했다.
- `tests/coordinate-subagents/v3x/V06-b3b-r4.test.mjs` (신규): mount table 주입 사례, 실제 mount 재현(namespace 자식 프로세스), live 읽기 전용 검증
- `README.ko.md`, 이 handoff

## 검사 결과 (Node v24.21.0)

- r4+r2+r1+b3b env 없음: 9 passed, 16 skipped
- r4+r2+r1+b3b fixture(실제 namespace mount 포함): 21 passed, 4 skipped
- r4+r2+r1+b3b live 읽기 전용: 25 passed(재설치 없음, 두 root ino·ctime 불변)
- V06-b3a 회귀: 4 passed
- 수정 전(`56750d19`): r4 테스트 2건 실패, 같은 device bind를 `ACCEPTED`
- 변이: mountpoint 검사 해제는 2건 실패, dev 비교 해제는 2건 실패, use 시점 재확인 해제는 1건 실패, mountinfo 실패 허용은 1건 실패. 원복 후 cmp 동일
- eslint, `validate-repository`, `check-source-lock`, `check-bundle`, `git diff --check`: 통과
- Windows 실행: 이 VM에서 불가, NOT_RUN

## 남은 문제

- 검사는 경로 기반 mountinfo 시점 스냅샷이다. mount namespace를 바꿀 권한이 있는 주체(root, CAP_SYS_ADMIN)의 경합은 이 leaf가 막지 않는다. 운영 host 적격은 별도 과제다.
- r3 원시 근거, V06-b3c loader 측정은 범위 밖이다. `r1-live/`는 커밋하지 않았다.
