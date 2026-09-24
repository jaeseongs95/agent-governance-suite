# TASK_V06-b3b-r1 handoff

- **TASK_ID**: V06-b3b-r1 (Linux 보호 runtime v2 release ID·배치 복구)
- **결과**: v2 배치 후보 host 설치·검증 완료. 새 root `32a825d9da1c613e097e6246cf282b89777cc13d043fda3dd68113c1fc208edd`
- **브랜치**: `claude/v3x-v06-b3b-r1` (로컬, push 보류)
- **start SHA**: `0724bb2bc452626aba546a57d1db5c407d32feb0` (`origin/codex/v260-semantic-decision-layer` FETCH_HEAD와 일치 확인)
- 이 handoff는 자기 커밋 SHA를 담을 수 없다. 최종 SHA와 독립 감사 판정은 세션 최종 보고에 적는다.

## 원래 결함과 재현

- V06-b3b는 v2와 세 가지가 달랐다: root ID에 archive sha, `<root>/node`, `<root>/package` 없음.
- 수정 전 코드에서: 독립 계약 검사기가 기존 `fd8e59d5…` root에서 `root-id`, `node-path`, `package`, `root-entries`를 보고했다. v2 테스트 5건은 v2 함수가 없어 실패했다.

## 변경 파일

- `scripts/qualification/v06-b3-linux-install.mjs`: `releaseIdV2`, `runtimePaths`, `readPackageSource`, `installProtectedRuntime`, `verifyProtectedRuntime`, `runVerifiedRuntime` 추가, CLI를 v2로 전환. 이전 함수는 b3b 증거 root 검증용으로 남겼다.
- `tests/coordinate-subagents/v3x/V06-b3b-r1.test.mjs` (신규)
- `docs/implementation-3x/evidence/v06-b3/install/README.ko.md`, 이 handoff
- `V06-b3b.test.mjs`, Windows leaf(`v06-b2a-windows-stage.mjs`, `inspectPackage`만 import), 공유 build/manifest/`host-integration.json`은 바꾸지 않았다.

## 검사 결과 (Node v24.21.0, 검증된 archive에서 추출)

- r1+b3b env 없음: 6 passed, 9 skipped
- r1+b3b fixture: 13 passed, 2 skipped
- r1+b3b fixture + live gate env: 15 passed (새 root 설치, nobody 19건 거절)
- V06-b3a 회귀: 4 passed
- 변이(fixture): 결합 ID→archive sha 3건 실패, nodePath→`<root>/node` 4건, package exact 해제 1건, gate를 source 읽기 뒤로 1건, 부모 manifest 대조 해제 1건 실패
- 변이 생존: 자체 walker의 symlink 거절만 끄거나 자체 digest 대조만 끄면 통과한다. `inspectPackage(exact=true)`가 같은 경우를 먼저 거절하는 이중 방어이기 때문이다. exact 해제와 walker symlink 해제를 함께 하면 실패한다.
- eslint(대상 js), `node scripts/validate-repository.mjs`, `pnpm bundle:check`, `git diff --check`: 통과
- Windows 실행: 이 VM에서 불가, NOT_RUN

## 후보 host 상태

- 새 root와 새 manifest(`/root/b3bf/r1/manifest.txt`)를 감사용으로 남겼다. 기존 `fd8e59d5…` root는 바꾸지 않았다.

## 남은 문제

- loader closure 측정(V06-b3c), 후보 manifest 필수 필드 전체 기록, 운영 host 적격은 범위 밖이다.
- b3b 이전 배치 root를 지우는 결정은 이 Task 범위 밖이다.
