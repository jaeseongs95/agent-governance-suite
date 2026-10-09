# SS14 — AGS 2.9.1 기존 검증 증거

이 폴더는 기존 SS14 검증 자료의 공개용 정제본이다. 게시 중 새 시험, 모델/API 호출 또는 과거 21회 run 재실행은 하지 않았다.

- 기준 후보 commit: `c6a8019be30e4bf5ee9a36147ca45ae28b0f75b6`
- 기준 tree: `28f2f2ed8a864405320f6d20e7bc5004e8466ad3`
- fixture SHA256: `17ade7e27cc11ffee8cc0b7b2070785617861d4c3384448cf24fce75f40d87e9`
- 동결 oracle SHA256: `5db1d67cef8719c40b17b0ab07003f01f765746d34ced0b326e59fadb2efe055`
- 실제 원문 UTF8 SHA256: `7ecb7226d4cea9f67b85ef8d1deaf5bbb192d25f3c1b06367ca0f4624b2c526a`
- 변형: `base` 하나. 원문은 `input.original.txt`에 newline 없이 보존한다.
- 기존 오프라인 계약·경계 검사 12개 PASS, exit 0.
- 기존 비용 보존 재현 검사 1개 FAIL, exit 1: invalid RESP가 유효 비용 0.1을 null로 바꾸며 소비액 0, 예약 0.4를 남긴다. 기존 동일 원인 발견의 재현이며 새 결함으로 중복 집계하지 않는다.
- 기존 plan consistency 검사 READY, exit 0. 제품 PASS 또는 독립 감사가 아니다.
- 기존 SS14 전용 회귀 실행 0; 새 격리 검사와 기존 회귀를 구분한다.
- 실제 provider/host 추천·선택은 NOT_RUN; selected/read/applied/verified 모두 NOT_RUN, selected 및 hostReceipt는 null이다. mock advice는 실제 AGENT 선택이 아니다.
- JEV·외부 vendor·Claude·native Codex 모델 호출 0. 제품 소스 변경·제품 패치 없음.

`TEST-SPEC.seq7.ko.md`는 후보 저장소에 없었다. `SS14.fixture.extract.json`의 embedded 원문만 사용했다. 정확도 점수를 새로 만들거나 미실행 상태를 PASS로 승격하지 않는다. 실제 queue 명세/코드, ACK·재시도·중복 제거 정책, 승인된 분류 설정과 qualified profile, 실제 호스트 호출 및 단계 근거가 필요하다.

## 파일과 원본 구분

`SS14.result.json`은 원본 결과에서 기존 판정을 보존한 공개용 파생본이다. `provenance.json`은 원본 bytes/SHA256와 공개 bytes/SHA256의 연결 및 정제 내용을 기록한다. 개인 로컬 경로는 표시용 토큰 또는 상대 경로로 치환했다. 로그는 기존에 캡처된 stdout/stderr 합본이며, 별도의 원본 stdout·stderr 스트림은 `MISSING_ORIGINAL`이다. 합본에서 별도 스트림을 추정하여 만들지 않았다. 원본 patch 파일은 없었으므로 patch를 생성하거나 게시하지 않는다. 원본 자료 회수 누락은 없다.

## 재현 안내 — 게시 중 실행하지 않음

Node 24.19.0, pnpm 11.19.0을 사용해 위 고정 후보를 별도 개발 체크아웃에 준비한다. 제품 소스에 패치를 적용하지 않는다. 이 폴더의 `repro/*.test.ts`를 후보의 `tests/ss14-evidence/`로 복사하고 후보 루트에 `ss14-repro-output/`를 만든다. 공개 재현 파일은 기존 파일의 출력 디렉터리만 상대 경로로 정제한 것이며 게시 중 실행하지 않았다.

후보 루트에서 필요한 의존성이 이미 준비된 경우 다음 명령으로 재현할 수 있다. 이 안내는 실행 승인이나 실행 기록이 아니다.

```sh
pnpm exec vitest run tests/ss14-evidence/SS14.offline.test.ts
pnpm exec vitest run tests/ss14-evidence/SS14.cost-repro.test.ts
```

기록된 원래 argv·exit는 `commands/`, 원래 결과는 `logs/`, `reports/`, `observations/`에 있다. 두 번째 검사는 고정 후보에서 비용 보존 불일치로 실패한 원본 증거를 보존한다. 수정 후보에 대한 green 검사는 NOT_RUN이다.

## 무결성

`manifest.json`은 자신과 `SHA256SUMS`를 제외한 모든 게시 파일의 실제 bytes/SHA256를 기록한다. `SHA256SUMS`는 payload와 manifest를 포함하고 자신은 제외한다. 두 파일 자신의 최종 SHA256는 게시 완료 보고에서 별도로 전달한다. 이 구조로 순환 hash를 피한다. Git publication commit과 최종 remote blob 검증은 게시 후 별도로 보고한다.
