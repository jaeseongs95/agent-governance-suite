SS31 독립 Cloud 오프라인 검증 결과: FAIL (실제 host/full-case 수용은 NOTRUN)

고정 후보 c6a8019be30e4bf5ee9a36147ca45ae28b0f75b6 / tree 28f2f2ed8a864405320f6d20e7bc5004e8466ad3.
fixture SHA256 17ade7e27cc11ffee8cc0b7b2070785617861d4c3384448cf24fce75f40d87e9.
동결 oracle SHA256 5db1d67cef8719c40b17b0ab07003f01f765746d34ced0b326e59fadb2efe055: 재계산 일치.
sourceSpec.path의 TEST-SPEC.seq7.ko.md는 없으며 SS31.fixture.json의 embedded 전체 fields만 사용했다.
originalPrompt=null, oracle=null: 의미 정확도 점수와 선택 정답을 만들지 않았다.
AGENTS.md, test-engineering/ponytail/orchestrator 분류지원/acceptance-evidence-validator 지침과 관련 참고를 읽었다. repo 및 <LOCAL_ARTIFACT_ROOT>의 .agents/skills는 없다.

기존 회귀: SS31 name filter에 매칭한 3개 PASS, 다른 37개 SKIPPED. 다른 case와 전체 suite를 실행하지 않았다.
격리 검증: 14개 중 12 PASS / 2 FAIL. 타입 검사는 exit 0.
- not-dispatched: 2 PASS / 1 FAIL. availability 미완료와 typed not-started는 통과. 두 번째 credential 조회 중 timeout은 HTTP 모의 전송 0회임에도 unknown/UNCERTAIN과 JEV 예약 0.4를 유지한다.
- unknown-consumption: 6 PASS / 1 FAIL. started/unknown 비용 예약, 승인된 고정 vendor fallback, fallback 불가와 양쪽 timeout은 통과. timeoutMs=2147483648은 거부되지 않아 Node가 1ms로 줄인다.
- late-result: 4 PASS. fallback 완료 후 성공/거절, fallback 진행 중 성공, 사용자 취소 뒤 성공 모두 기존 결과와 비용 예약을 덮지 않는다. 같은 operation 재접수도 재송신하지 않는다.

발견 F1: service.ts:184가 provider 내부 credential 조회보다 먼저 unknown을 설정한다. provider는 :80에서 credential을 기다린 뒤 :87에서 aborted를 확인하므로 실제 mock fetch는 0회다. timeout race의 결과만 :210에서 정산하여 뒤늦게 확인된 not-started는 예약을 해제하지 못한다. 신규 미전송 진단·예약 경계이며 다른 case에 같은 원인이 있으면 중복 집계하지 않는다.
발견 F2: service.ts:127에는 Node timer 상한 검사가 없고 :166에서 해당 값을 전달한다. TimeoutOverflowWarning과 1ms 축소를 원시 로그로 재현했다. 이미 알려진 timeoutoverflow의 재현이며 신규 결함 수에 더하지 않는다.

초기 탐색에서 fallback 불가의 최종 상태를 UNCERTAIN으로만 제한한 두 assertion은 원문이 UNAVAILABLE도 허용하여 바로잡았다. 이전 JEV attempt와 예약은 보존되므로 두 경로를 결함으로 집계하지 않았다. exploratory-* 파일은 이 정정을 확인하기 위한 이전 기록이다. 제품 source는 전혀 수정하지 않았다.

재현 (이미 준비된 Node v24.19.0 / repo Vitest 5 / 의존성 사용):

    cd <AGS_TEST_ROOT>
    <AGS_DEPENDENCY_ROOT>/node_modules/.bin/vitest run tests/mcp/skill-classification-service.test.ts -t SS31 --reporter=json --outputFile=<SS31_OUTPUT_ROOT>/existing-regression.json
    <AGS_DEPENDENCY_ROOT>/node_modules/.bin/vitest run tests/SS31-isolated.test.ts --reporter=json --outputFile=<SS31_OUTPUT_ROOT>/isolated-tests.json
    node node_modules/typescript/bin/tsc --ignoreConfig --noEmit --strict --skipLibCheck --types node --target es2023 --module nodenext tests/SS31-isolated.test.ts

첫 명령 exit 0 / 둘째 exit 1 (F1·F2의 의도한 assertion 실패) / 셋째 exit 0.
기존 fixture helper를 재사용했고 의미 입력 carrier에는 sourceSpec.fields.입력을 그대로 넣었다. inventory·qualification·needed judgment는 기계적 시험용 합성값으로 실제 qualification 또는 AGENT 선택 근거가 아니다. ApprovedRouteClassificationProvider의 fetcher만 모의 대체하여 실제 HTTP0이며 포트 호출과 모의 HTTP 횟수는 구분했다.

결과와 근거:
- SS31.result.json: identity, variant별 입력/기대/관측/상태, command/exit, API0, 결함 및 누락 입력.
- isolated-observations.json 및 SS31-*.observation.json: null 비용·취소 요청·reservations·attempts를 보존한 원시 관측.
- isolated-tests.json / isolated-tests.log: 두 실제 assertion 실패와 timeout 경고.
- existing-regression.json: 기존 SS31 3개만 실행한 결과.
- plan.json / candidate.snapshot.json: 고정 테스트와 소스 바이트 결속.
- acceptance-report.json: 오프라인 기준 1·2 unsatisfied / 기준 3 satisfied / 실제 host·B 기준 insufficient-evidence, 판정 FAIL. 생성 CLI exit 0은 보고서 생성 성공이며 수용 통과가 아니다.
- acceptance-report-check.json: 동결 요청과 생성 보고서의 정합성만 valid=true.
- proof-check.json: INCOMPLETE. 제품 mutation·수정 후보가 없으므로 red/green sensitivity 증명 NOT_RUN; 보고서를 독립 감사로 부르지 않았다.

현재 환경의 실제 host 경로:
Codex 실행파일 <OBSERVED_CODEX_EXECUTABLE>는 있다. Claude CLI와 AGS get_skill_inventory/classify_skills/record_skill_selection MCP 도구는 노출되지 않았고 AGENT_GOVERNANCE_CLASSIFICATION_CONFIG도 없다. CLI 존재를 설치 활성화·실행 성공으로 표현하지 않았다.
저장소에서 index.ts:88 → readClassificationRuntime → providerRuntimeRef / nativeAdapterDefinitionsRef → approved remote/native provider → hooks/hooks.json의 signed host-attestation → gateway.accept 경로를 지원한다.
실호스트 시험에는 승인된 설치·classification 설정·고정 profile registry·실제 qualification·route/adapter·현재 vendor·예산/unknown 예약·외부 전송 승인 또는 검증된 native allowance, native capability/retry/isolation evidence와 exact isolationArgs, 실제 session/task revision 및 signed hook 관측, 전체 inventory 활성/설치/host 상태, AGENT의 실제 선택 ID·이유·적용/제외 근거가 필요하다. 원 호출 hostReceipt는 null이어야 한다. E0/E1/E2의 지정 형식 및 실제 호스트 증거도 미제공이다.
B의 목적 적합성과 selected/read/applied/verified는 실제 원문·스킬 실행 산출물 관측 없으므로 전부 NOTRUN, 관측값은 null이다. []로 바꾸지 않았다.

JEV/vendor/Claude 외부 API 호출0. 과거 21회 run 재실행0. 실제 host 시험0. 제품 수정/push/PR/릴리스0.
