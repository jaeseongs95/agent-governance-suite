# 공개 qualification bootstrap 시험 접점

동결 r2에서 파생된 개발 시험 접점이다. 제품 기준 commit/tree와 각 파일·fixture oracle의 결속은 `component-manifest.json`에 있다. 현재 revision과 원 r2는 별도 후보이며 strict TypeScript·모의 효과 검사와 SHA로 구분한다. production profile·설정·선택을 변경하지 않으며 새 의존성을 설치하지 않는다.

최초 평가는 `NOT_RUN` 후보와 승인된 공개 corpus·profile·route·예산·증거를 결속한 helper 내부 전송으로 수행한다. 기존 JEV wire codec을 재사용하며 운영 provider의 `PASS` 검사와 구분한다. config·request·profile snapshot, credential 대기와 encode 이후의 만료·취소 검사, HTTPS·redirect 거부, 실제 응답 byte 한도와 엄격한 UTF-8·JSON 검사를 유지한다. 후보 자격과 증거의 가장 빠른 만료 시각에 예약을 중단하고, timeout 뒤 늦은 응답은 원장을 갱신하지 않는다. 평가 결과 자체는 qualification이나 실제 host 적용 완료를 뜻하지 않는다.

기존 Node.js 24.19와 저장소 `tsx`가 준비된 저장소 루트에서 실행한다.

```sh
node --import tsx tests/skill-classification/live-bootstrap/contract-selfcheck.mts .
node --import tsx tests/skill-classification/live-bootstrap/expiry-regression.mts . tests/skill-classification/live-bootstrap/bootstrap.mts
node --import tsx tests/skill-classification/live-bootstrap/budget-regression.mts . tests/skill-classification/live-bootstrap/bootstrap.mts
node --import tsx tests/skill-classification/live-bootstrap/precision-regression.mts . tests/skill-classification/live-bootstrap/bootstrap.mts
node --import tsx tests/skill-classification/live-bootstrap/bootstrap.mts prepare /absolute/private/config.json
```

`pnpm test`도 `bootstrap-contract.test.mjs`를 통해 위 네 오프라인 검사 프로그램을 실제 자식 프로세스로 실행한다. 종료 코드와 각 프로그램의 최종 검사 결과를 확인하므로 bootstrap 회귀 실패가 전체 테스트에 전달된다. CLI의 `RAW_EVALUATION_RECORDED`만으로 통과를 판정하지 않는다.

`AGS_BOOTSTRAP_TEST_EVIDENCE_DIR`에 저장소 밖의 증거 경로를 지정하면 각 오프라인 검사는 임시 출력 전체를 고유 이름의 하위 폴더로 복사한 후 임시 폴더를 정리한다. 모의 응답·원장·lock을 보존하며 기존 증거는 덮어쓰지 않는다. 이 값이 없으면 기존처럼 임시 출력만 정리한다.

config는 예제를 저장소 밖 private 폴더에 복사하고 `repo`를 현재 저장소 절대 경로, `outputDirectory`를 저장소 밖 별도 private 폴더로 지정한다. 키 값·실제 승인·가격·원장은 공개 폴더에 넣지 않는다. endpoint와 credential은 ENV 이름으로만 지정한다. 공개 REQ는 frozen 원문 21개와 전체 inventory를 보존한다.

1.0.0 config는 기존 unscoped 숫자·근거·청구 상한 검사를 그대로 지원한다. 이를 run 예산으로 자동 해석하지 않는다. 새 2.0.0은 `budget.scope="run"`, 같은 `runId`, `allocatedUsd<=0.15`와 할당 근거를 요구한다. 상한은 helper의 `MAX_RUN_ALLOCATION_USD` 정책 한 곳에 명시한다. USD0.15는 전체 USD5 권한 안의 배치 할당이며 계정 잔액이 아니다. account 잔액·과거 소비·unknown 예약의 `null`은 그대로 보존한다. run의 과거 확정 비용과 unknown 예약을 모르면 0으로 채우지 말고 BLOCKED로 둔다. 전체 계정 원장 미조회 자체가 run 할당 검토를 막지는 않는다.

`reservationMode="verified-upper-bound"`는 기존 청구 상한 근거를 요구한다. `reviewed-estimate`는 `estimator`의 방법·불확실성·payload별 예약 계산, 실제 전체 wire 측정 artifact와 원자료 파일 SHA, operatorAuthorization evidence를 요구한다. operator 근거는 mode·scope·runId·budget·가격·profile·route·model·limits와 max21/retry0까지 결속한다. input artifact는 `{runId,inventoryDigest,measurements}`이며 21개 measurement는 `{caseId,requestDigest,wireDigest,utf8Bytes}` 순서로 원 wire와 일치해야 한다. method는 `utf8-bytes-as-input-tokens-v1`이며 1 UTF8 byte를 1 input token으로 가정해 실제 wire bytes×configured input price를 1e-12 USD 단위로 올림 예약한다. tokenization·청구 보장은 아니다. 경로는 private output 아래 상대 경로다. 공급자 request에 이 근거·oracle·label을 넣지 않는다.

확정 청구액이 없는 usage 비용은 `estimatedCostUsd`다. 이를 `actualCostUsd`로 바꾸거나 unknown 선예약을 해제하지 않는다. batch 전체 예약과 기존 run 소비·unknown을 할당으로 덮지 못하면 preflight BLOCKED다. 예약은 fetch 전에 원장에 저장하며 만료 경계를 예약·credential 조회·fetch 전에 확인한다. timeout/transport/auth/billing·balance 오류와 usage 불명·예측 초과는 즉시 멈추고 재송신하지 않는다. HTTP402는 billing/balance 실패로 구분하되 error body를 기록하지 않는다. persistent `wx` lock은 경합과 불명 run의 자동 재실행을 차단한다.

[공식 모델 문서](https://docs.typesafe.ai/models)의 입력 가격 USD0.042/M, output 무료와 context64k에서 21×64000×0.000000042=USD0.056448을 조건부 추정할 수 있다. 과거 준비 snapshot에서 21개 wire 총 2,866,900B에 byte당1token 검토 가정을 적용하면 약 USD0.1204098이며 .15의 로컬 run 할당 안에 들어간다. 기존 pilot의 unknown 예약 USD0.005734722까지 같은 aggregate에 포함하면 USD0.126144522다. 이 합산은 검토 가정의 예약 계획이며 확정 청구가 아니다. 이전 R6의 .06 상한·helper·원자료는 별도로 보존한다. 계획은 동일 corpus 순서의 누적 예약을 계산해 명시적 요청 수를 정하고, 나머지는 미평가로 남긴다. preflight는 자동 trim이나 새 run 분할 없이 configured batch를 검사한다. context 길이는 강제 청구 상한이 아니며 정확한 tokenization이나 byte→token 보장은 확인하지 못했다. [API 문서](https://docs.typesafe.ai/api)의 usage token을 확정 청구 자료로 취급하지 않는다. reviewed-estimate는 로컬 예약·정지만 통제하며 외부 과금을 엄밀 차단했다고 주장하지 않는다. 실제 route·가격·할당·run prior/unknown·operator 검토가 없는 예제는 BLOCKED이며, 새 후보·비용 계획·독립 검토 전 실제 API는 HOLD다.

오프라인 예산 회귀의 현재 기대값은 `budget-wire-oracle.json`의 고정 순서·request/wire digest·실제 측정 byte 수와 독립 정수 산술에 결속한다. 현재 합성 21개 입력의 2,278,543B에 기존 가정을 적용한 예약합은 USD0.095698806이다. 요청마다 picoUSD로 올린 뒤 합산하며 이 계산을 실제 tokenization이나 청구로 해석하지 않는다. 과거 USD0.1204098 및 pilot UNKNOWN USD0.005734722 예약은 새 입력 크기로 재계산하거나 감액하지 않는다. 현재 입력에서 실제로 초과하도록 별도 합성 소비량을 정의한 음성 사례는 운영 지출이나 새 호출 승인이 아니다.

A 예산 회귀는 고정 wire oracle와 예산·UNKNOWN·오류·만료·중복 실행 방지 분기를 검사한다. B 정밀도 회귀는 별도 프로그램에서 설정된 Number의 `toString()` 표준 십진 표현을 기준으로 요청마다 1e-12 USD 단위 올림을 검사한다. 원 JSON 숫자 표기를 복구한다는 뜻은 아니다. 0·아주 작은 양수·분수 단위·안전 정수 범위 초과·잘못된 가격을 별도로 검사하므로 B 실패가 A의 후속 분기를 가리지 않는다. 이 계산은 schema2 `reviewed-estimate`에만 적용하며 과거 UNKNOWN·settlement와 `verified-upper-bound` 계산은 바꾸지 않는다.

네 검사는 모의 fetch만 사용한다. 실제 API·credential 조회는 0이며 qualification과 host-live는 NOT_RUN이다. 의미 정답 18개와 운영 입력 3개를 포함한 공개 원문 21개만 다룬다. 전체 39유형·120 host paired trials와 Linux 실호출은 NOT_RUN이다. 실행 환경과 후보를 별도로 확인한 운영자가 실제 실행을 연결한다.
