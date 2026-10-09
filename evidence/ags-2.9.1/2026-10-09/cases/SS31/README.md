SS31 기존 증거 공개본 — 새 시험 실행 없음

기존 판정: FAIL (오프라인 기계 검증). 기존 SS31 회귀 3 PASS / 다른 37 SKIPPED. 격리 검사 14개 중 12 PASS / 2 FAIL. 타입 검사 PASS(exit 0). sensitivity proof INCOMPLETE; 실제 host/B·selected/read/applied/verified NOTRUN, 관측 null. oracle=null이므로 의미 정확도 점수 없음.

- not-dispatched: 2 PASS / 1 FAIL. HTTP 모의 전송 0회인 두 번째 credential 조회 timeout에서 unknown과 예약 0.4 유지.
- unknown-consumption: 6 PASS / 1 FAIL. timeoutMs=2147483648이 Node에서 1ms로 축소됨. 기존 timeoutoverflow 재현이며 신규 원인으로 중복 집계하지 않음.
- late-result: 4 PASS. 늦은 성공/거절, fallback 중 성공, 사용자 취소 뒤 성공의 덮어쓰기·재송신·이중 완료 방지.

기준 commit c6a8019be30e4bf5ee9a36147ca45ae28b0f75b6 / tree 28f2f2ed8a864405320f6d20e7bc5004e8466ad3.
전체 fixture SHA256 17ade7e27cc11ffee8cc0b7b2070785617861d4c3384448cf24fce75f40d87e9.
동결 oracle SHA256 5db1d67cef8719c40b17b0ab07003f01f765746d34ced0b326e59fadb2efe055.
원본 sourceSpec 파일은 MISSING_ORIGINAL. recorded/SS31.fixture.json은 기존 embedded SS31 원문·fields·oracle·variants 전체를 보존한다. input의 exact UTF8 bytes/SHA256는 manifest에 있고 recorded-request.json은 저장된 request 추출본이며 HTTP wire 원본은 아니다.

SS31.result.json은 기존 result의 개인 로컬 경로만 정제한 공개본이다. 기록의 API0/제품수정0/push0 등은 당시 검증 실행의 이력이다. 이번 evidence 게시를 당시 시험 결과나 제품 게시로 해석하지 않는다. 이 공개 포장·게시는 새 시험0, JEV/vendor/Claude/Codex 모델 API0이다. product patch는 ABSENT.

recorded/에는 기존 로그와 JSON·테스트·계획·proof/수용 보고서를 넣었다. manifest의 original.bytes/sha256는 회수 원본의 바이트 지문이고 path별 bytes/sha256는 공개본 지문이다. 원본의 snapshot/plan/acceptance/evidenceDigests와 recorded/SHA256SUMS는 원본 지문을 유지하므로 경로가 정제된 공개 파일의 새 digest와 혼용하지 않는다. unsigned local 보고서 정합성 검사 결과를 실제 AGENT 선택 또는 독립 감사로 부르지 않는다.

민감값을 공개하지 않기 위해 개인 경로를 <AGS_TEST_ROOT>, <AGS_DEPENDENCY_ROOT>, <SS31_OUTPUT_ROOT>, <LOCAL_ARTIFACT_ROOT>, <OBSERVED_CODEX_EXECUTABLE> 토큰으로 바꿨다. 실제 환경변수 값·자격정보·개인 대화는 포함하지 않는다. 테스트의 SYNTHETIC_NOT_SECRET 등은 원본 코드에 있던 모의값이다. synthetic profile PASS와 mock needed judgment는 provider qualification 또는 선택 정답이 아니다.

초기 exploratory 파일의 UNCERTAIN-only assertion 두 개는 원문이 UNAVAILABLE도 허용하여 수정한 기록이다. 이 두 실패를 제품 결함으로 집계하지 않는다. 최종 결함은 위 F1·F2뿐이며 원본 exploratory 기록은 정정 이력으로 구분했다.

재현 안내 (이번 게시에서 실행하지 않음):

1. 별도 검증 checkout에서 위 고정 commit/tree와 전체 fixture SHA를 확인한다. 이미 준비된 Node 24.19.0 / Vitest 5 / TypeScript를 사용한다.
2. repro/SS31-isolated.test.ts를 그 checkout의 tests/SS31-isolated.test.ts로 복사한다. 출력 디렉터리를 만들고 SS31_OUTPUT_DIRECTORY에 그 디렉터리 경로를 지정한다. 이 환경변수의 실제 값은 공개 기록에 포함하지 않는다.
3. checkout 루트에서 다음 명령을 실행할 수 있다. 아래는 안내이며 새 실행 결과가 아니다.

    node node_modules/vitest/vitest.mjs run tests/mcp/skill-classification-service.test.ts -t SS31 --reporter=json --outputFile=existing-regression.json
    node node_modules/vitest/vitest.mjs run tests/SS31-isolated.test.ts --reporter=json --outputFile=isolated-tests.json
    node node_modules/typescript/bin/tsc --ignoreConfig --noEmit --strict --skipLibCheck --types node --target es2023 --module nodenext tests/SS31-isolated.test.ts

기존 원본 명령/exit는 SS31.result.json.commands에 보존되어 있다. 기존 회귀 exit0, 최종 격리 exit1, 타입 검사 exit0. portable repro 파일은 출력 경로만 조정했으며 NOT_EXECUTED이다. 기존 combined stdout/stderr를 분리된 원본처럼 만들지 않았다. 누락 목록은 original-recovery.json을 참조한다.

실호스트 제한: 당시 Codex 실행파일 존재만 관측됐고 classification 설정과 AGS MCP가 없었다. 실제 host 선택·본문 읽기·적용·검증/확정 과금·취소 확인을 시행하지 않았다. 승인된 설치·profile/qualification·route/budget·실제 task/hook·host inventory 상태가 필요하다.

manifest 자체 순환 hash는 없다. manifest는 payload 파일들만 hash하고 SHA256SUMS는 payload와 manifest를 hash하며 자기 자신은 제외한다. SHA256SUMS의 실제 digest는 최종 원격 검증 보고에서 별도로 제공한다.
