# AGS 2.8.1 세 번째 full CI 실패 원로그

run `37446534789`, attempt 1, source `1209b3e9a0307c4cd28a7ffa0cccd1ff7e80d132`는 `completed/failure`다. 실패 위치는 Test 단계 번호 14이며 실패 14개라는 뜻이 아니다. Ubuntu Test Files는 1 failed / 68 passed / 1 skipped (70), Tests는 1 failed / 924 passed / 5 skipped (930)다. Windows Test Files는 2 failed / 67 passed / 1 skipped (70), Tests는 3 failed / 922 passed / 5 skipped (930)다.

공통 실패는 `tests/test-engineering/suite-integration.test.mjs` 37행의 stdout 기대 `/# fail 0/u`와 실제 Node reporter 출력 `ℹ fail 0`의 불일치다. 원출력 자체는 inner fail 0을 기록하지만 outer assertion 실패를 PASS로 바꾸지 않는다. Windows 추가 두 실패는 `tests/session-messaging/broker-lifecycle.test.ts`의 transient endpoint publication retry와 permanent failure recovery 사례다. 실제 startup deadline 이전 ready가 되지 않았다는 오류 및 후자의 `/exited before it was ready/u` 기대 불일치를 보존한다. Windows broker 원인은 UNKNOWN이고 로컬 재현이나 타이밍 원인을 단정하지 않는다.

official 단계 17은 skipped/NOT_RUN, upload 단계 18은 evidence 디렉터리 미생성으로 실패했다. artifact API count는 0이며 supplier 5개 파일과 official stdout/stderr/exit receipt는 이번 실행에서 NOT_PROVIDED다. 이전 실행의 supplier/QA 증거를 이번 실행으로 재사용하지 않는다. 전체 QA PASS가 아니다.

setup/install 원로그의 실제 Node는 양OS v24.21.0, pnpm v11.19.0, CPython은 Ubuntu 3.12.14, Windows 3.12.10이다. 모든 검사 fresh/reuse는 unknown이다. 원 API JSON 3개와 전체 ZIP 로그 38개를 private에 보존했고, 공개 사본은 원 commands/stdout/stderr/실패와 CRLF/BOM을 민감 치환 외에 유지한다. 절대 runner 경로·hostname·UUID·계정/opaque context 제거 기준과 원/공개 SHA·size·위치 mapping은 MANIFEST에 있다. 원 ZIP/로그 digest는 RUN-LOG-CONTENTS에 있다.

evidence base `a04e3d5ce113aebb7a61da9d5c7ed5a50d86f418`에서 새 prefix만 추가했다. 이전 두 실패 episode와 게시 후 2.8.0 성공 episode를 별도로 유지한다. 원자료·기존 payload·source 변경, 제품 로컬 실행과 원격 변경은 0이다.
