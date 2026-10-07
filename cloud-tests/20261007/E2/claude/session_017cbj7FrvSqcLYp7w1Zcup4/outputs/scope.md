# E2 수정 범위와 완료 기준 (구현 전 작성)

## 수정 범위
- 쓰기 허용: `output/e2/` 아래 파일만. 수정 후보는 `output/e2/candidate.mjs`.
- 보존(읽기 전용): `e2/target-original.mjs`, `e2/checker.mjs`, `e2/contract.json`, `e2/prompt.txt`, `manifest.json`, `verify-inputs.mjs`, `check-text.mjs`, `e4/*`, `e9/*`.
- 런타임: 표준 Node.js 모듈만. 외부 패키지 없음.
- 범위 밖: 운영 DB, 외부 API, 재시작 내구성, cross-process claim, 호스트 기능, E4/E9.

## 원본 결함(계약 대비)
1. 신규 ID를 `beforeCommit` 전에 예약하지 않음 → 동시 같은 요청이 각각 효과를 반영(중복 금액).
2. 기존 ID 조회 시 amount를 비교하지 않음 → 같은 ID의 다른 금액을 받아들임(completed는 이전 결과 반환, pending은 새 효과 반영).
3. completed 재요청이 저장된 result 객체를 그대로 반환 → 호출자가 고치면 후속 재시도 결과가 바뀜.
4. 재요청에서 `loseAck`를 무시 → 해당 호출의 ACK_LOST가 사라짐.
5. `snapshot().pending`이 항상 0, `keys`에 pending 미포함.

## 완료 기준
- A1 `node e2/checker.mjs output/e2/candidate.mjs` exit 0, verdict PASS, 11/11 PASS.
- A2 같은 checker가 원본에서 FAIL(실제 실패 재현).
- A3 `output/e2/extra-checks.mjs` 보강 검사가 후보에서 모두 PASS, 원본에서 결함 관련 항목 FAIL.
- A4 `node verify-inputs.mjs` 작업 전후 PASS(불변 입력 무수정).
- A5 원본 대비 후보 diff를 저장하고 검토 결과 기록.
- A6 표준 Node.js만 사용(import 없음 또는 `node:` 모듈만).
