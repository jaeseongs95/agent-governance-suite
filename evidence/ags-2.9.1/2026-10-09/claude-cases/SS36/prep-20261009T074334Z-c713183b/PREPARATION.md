# SS36 — 과다선택을 이용한 recall 부풀리기 방지

준비 완료 / 실제 Claude 시험 NOT_RUN / 제품 PASS 판정 없음.

고정 공개 입력은 `af579e2caa8c09b380bdf88b5e9c675b0b0b9c68`의 `evidence/ags-2.9.1/2026-10-09/cases/SS36/`에서 직접 읽었다. SHA256SUMS의 28개 항목과 manifest의 27개 항목을 모두 원격 Git 객체에서 가져온 바이트와 대조했고 일치했다. 원래 SS36 추출본과 완전 동결 fixture의 SS36 값, SS14에서 빌린 control oracle 및 24개 inventory ID도 일치한다. 세부 파일 해시는 `input-hash-verification.json`에 보관했다. 원본 spec과 판정 기준은 `original-input-and-criteria.json`, 일곱 control의 원래 입력·수작업 기대값은 `expected-controls.json`에 보관했다.

입력 fixture SHA256: `17ade7e27cc11ffee8cc0b7b2070785617861d4c3384448cf24fce75f40d87e9`. SS36 추출본 SHA256: `a00f52469928d8a2d239028e120b8c0b5dcfe524d56768334dc02b4fd97b666c`. Control oracle 파일 SHA256: `fd58d02ba9f0370b0375457980cf86fe184f7b8ff33125d44e2ed815154d135d`. 동결 자료가 선언한 oracle digest는 `sha256:5db1d67cef8719c40b17b0ab07003f01f765746d34ced0b326e59fadb2efe055`이며 이번 준비에서 제품 evaluator를 실행해 재계산하지 않았다. 누락된 standalone `TEST-SPEC.seq7.ko.md`를 재구성하지 않았으며 embedded spec만 사용했다.

SS36은 mock·오프라인 평가기 검증이다. `originalPrompt`, SS36의 의미적 `oracle`, `semanticAccuracy`는 null이다. 새로운 스킬 추천이 기대 결과가 아니다. 동일 control의 R은 cs-engineering, test-engineering, orchestrator이며 A는 비어 있고 금지 ID는 ponytail이다. notApplicable 3개와 unadjudicated 17개도 원래 구분을 유지한다. SS14는 평가기 입력 벡터로만 빌리며 SS14의 실제 모델 시험을 실행하지 않는다.

| Control | 동결 기대 결과 |
| --- | --- |
| select-all | recall 1이어도 FAIL. TP 3, FP 4, 불필요 3, 금지 위반 1, unadjudicated 17, precision null, 완전집합 성공 0. |
| required-only | 정확한 R만 선택하면 PASS. recall/precision/완전집합 성공 1, 불필요·금지 0. |
| missing-required | orchestrator만 선택하면 FAIL. recall 1/3, cs-engineering·test-engineering 누락. |
| forbidden-extra | R + ponytail은 FAIL. recall 1, precision 0.75, 금지 위반 1. |
| both-hosts-wrong | 동일 오답의 host 일치율 1이어도 두 golden 판정 FAIL, 목적 성공 0. 고정 API pair key는 SS14/jev-on/1이며 실제 host pair가 아니다. |
| all-abstain | 답할 수 있는 2개를 전부 NEEDS_INPUT으로 보내면 FAIL. 분모 2, requiredTotal 6, recall/coverage/목적 성공 0, abstention 1. |
| failure-denominators | PASS·FAIL·BLOCKED·명시 NOT_RUN·누락을 모두 분모 5에 유지. requiredTotal 15, recall/coverage/목적 성공 0.2, notRun 2. |

raw(jevRaw), vendorRaw, combined, selected를 각각 채점하며 rules의 보정을 raw 적중으로 계산하지 않는다. 각 layer의 실패·보류 분모, null 대 [] 및 receipt 없음의 stage coverage 0을 함께 확인한다. Mock receipt는 실제 host selected/read/applied/verified 근거가 될 수 없다. R·A·금지 조건 또는 실패 분모가 없으면 보류한다.

기존 결과는 c6a8019 / tree 28f2f2ed의 역사적 오프라인 PASS다. 기존 scoped regression 5 PASS / 10 skipped, 최종 isolated 12 PASS / 0 FAIL이다. 초기 8 PASS / 3 FAIL도 보존되며 SS03의 notApplicable을 forbidden으로 오해한 시험 작성 오류였다. 기존 실패를 정답으로 삼지 않으며 동결 기준을 바꾸지 않는다. 별도 stdout/stderr와 중간 11-test green report는 MISSING_ORIGINAL이다. 기존 actual-host 단계는 모두 NOTRUN이며 이번 준비에서 승격하지 않았다.

## 재개 뒤 실제 Claude Code가 수행할 단계

1. 부모에게서 독립 SOURCE 판정, 원격 게시가 검증된 최종 후보 commit/tree, 공통 Claude 모델·effort·API 인증·선행 검사 결과를 받는다. 현재 전달된 R17은 commit `fa1e250c1cbc4f8f446f2e2ddeb516f4e439edbb` / tree `43d2b4e49cdb6993c48d7adc792a3ef17426092e`이고 로컬 고정 보고만 확인된 상태다. main 또는 c6a8019를 제품 시험 대상으로 대체하지 않는다.
2. Sol이 승인된 후보의 격리 checkout, fixture·control의 동결 동일성, 적용 AGENTS.md와 관련 SKILL.md, CLI 경로 및 쓰기 가능한 evidence 실행 디렉터리를 준비한다. 후보 fixture가 동결 바이트와 다르면 시험을 멈춰 부모에게 보고하고 기준·고정 assertion을 바꾸지 않는다. 의존성과 plugin/MCP 연결은 공통 선행 검사에 따라 준비하며 제품 코드·생성 배포물을 변경하지 않는다.
3. 부모가 검증한 프로세스 한정 API 인증 방식과 모델 설정으로 실제 Claude Code를 실행한다. 이 준비 보고서의 procedure는 원래 의미적 prompt가 아닌 실행용 절차다. --bare/--safe-mode 등의 flag를 임의 선택해 plugin·hook·MCP를 꺼 버리지 않는다. 영구 로그인·인증 설정, 권한, 네트워크 정책은 변경하지 않는다.
4. Claude가 실제 host 도구로 원본 입력·판정 기준·관련 스킬 본문을 읽고, 후보 evaluator의 scoreCase/aggregate/evaluateLayers/scorePairs 공개 경계를 확인하고, 기존 Vitest runner로 동결 7개 mock과 5개 경계를 실행한다. Sol이 대신 실행한 제품 테스트를 Claude 실행으로 보고하지 않는다. 원격 패키지의 reproduce/SS36.test.ts와 config는 public 경로만 보정된 NOT_RUN 재현 자료이며, 복사본을 별도의 실행 evidence 디렉터리에 두고 원본을 덮어쓰지 않는다. 기존 테스트의 suite 내 apiCalls:0은 오프라인 evaluator 호출 수이며 Claude 호스트 API 비용은 별도 ledger로 기록한다.
5. Claude의 실제 tool-use, 실행 명령, 시작·종료 시각, exit, 별도 stdout/stderr, 관측·기대값 및 후보·입력 해시를 보존한다. offline control이 정상적으로 잘못된 mock을 FAIL로 판정하는 결과와 실제 Claude 수행 성공을 구별한다. 별도 live skill selection 또는 signed host receipt를 요구하는 경우 공통 연결과 승인된 추가 입력이 필요하며 없는 근거를 합성하지 않는다. 의미적 정확도는 계속 null이고 실제 단계는 직접 근거가 있는 만큼만 판정한다.
6. US$2 소프트 한도에 준비·실패·재시도를 모두 포함해 비용, input/output, cache read/write, model, retry를 기록한다. --max-budget-usd는 CLI help에서 지원 확인했으며 공통 절차에 맞춰 남은 한도로 적용한다. 누적 비용과 추가 호출 여유를 매번 확인하고 한도 접근 또는 비용 미확인 시 다음 호출을 중지한다. JEV는 별도 배정 전까지 실행하지 않는다.
7. Sol이 정제된 결과·근거·해시 목록만 이 evidence branch의 새 고유 run 경로에 게시하고 고정 원격 commit에서 재독 검증한다. 제품 코드, 다른 작업 파일, 원본 채팅, 비밀값, 개인정보는 게시하지 않는다.

현재 완료: 원본 대조, 해시 검증, 제어 기대값 정리, 로컬 Claude CLI `2.1.286 (Claude Code)` 및 Node `v24.19.0` / pnpm `11.19.0` 확인. CLI는 PATH에 없지만 지정 절대경로에 존재한다. CLAUDE_API_KEY는 존재 여부만 확인했고 인증은 미시험이다. AGENTS.md 및 Test Engineering 지침을 읽었으며 `/workspace/.agents/skills`와 로컬 저장소 `.agents/skills`는 없어 `skills/`를 확인했다. 로컬 checkout의 지침을 준비 근거로만 읽었고 그 checkout을 제품 시험하지 않았다.

현재 막힘 / 재개 조건: 검증된 최종 후보, 공통 Claude 모델·effort·API 인증 절차, 공통 선행 검사 결과가 아직 없다. 부모가 이를 전달하기 전에는 제품 시험과 유료 호출을 시작하지 않는다. 새 제품 테스트 0, Claude API 0, JEV 0, retries 0, 비용 US$0, 잔여 소프트 예산 US$2. 준비 완료는 시험 PASS가 아니다.
