# SS30 독립 개발 검증

고정 후보 `c6a8019be30e4bf5ee9a36147ca45ae28b0f75b6`, tree `28f2f2ed8a864405320f6d20e7bc5004e8466ad3`에서 SS30만 검증했다. 오프라인 판정은 **FAIL**이다. 기존 회귀 7개는 PASS였지만, 새 격리 검사 21개 중 19개 PASS·2개 FAIL이다. 기존 runner가 수집한 다른 이름의 56개 테스트는 건너뛰었고 전체 suite를 실행하지 않았다.

fixture SHA256 `17ade7e27cc11ffee8cc0b7b2070785617861d4c3384448cf24fce75f40d87e9`와 동결 oracle digest `5db1d67cef8719c40b17b0ab07003f01f765746d34ced0b326e59fadb2efe055`가 일치했다. SS30 originalPrompt와 oracle는 모두 null이다. `TEST-SPEC.seq7.ko.md`는 없으며 `fixtures.json`의 SS30 embedded fields 전체를 근거로 사용했다. 분류 정확도나 목적 정답 점수를 만들지 않았다.

| variant | 입력과 기대 | 실제 관측 | 판정 |
|---|---|---|---|
| 401 | HTTP 401 → UNAVAILABLE/AUTH_UNAVAILABLE, started | JEV 실패 후 vendor mock 1회 성공; vendor 자체 실패에서는 error/unresolvedItems 보존 | PASS_OFFLINE |
| 403 | HTTP 403 → UNAVAILABLE/AUTH_UNAVAILABLE, started | 동일; retry 0 | PASS_OFFLINE |
| 5xx | 대표 HTTP 500 → UNAVAILABLE/API_UNAVAILABLE, started | 동일; 실제 서버 설정 변경 0 | PASS_OFFLINE |
| not-dispatched | availability 뒤 credential 소멸 → not-started, 전송 0 | CREDENTIAL_UNAVAILABLE; 예약 해제. 추가 fetch reject는 TRANSPORT_UNAVAILABLE/unknown과 예약을 보존 | PASS_OFFLINE |
| refusal | 구조가 없는 HTTP200 refusal payload → INVALID; 완전한 공통 semantic refusal RESP → UNCERTAIN/PARTIAL와 unresolvedItems | 구조 불량은 INVALID로 fallback. 완전한 semantic refusal은 unresolvedItems를 보존. 추가 PARTIAL/uncertain+unresolvedItems=[] 입력을 검증기가 수락 | **FAIL** |
| empty | HTTP200 빈 body → INVALID/error; no-skill로 은폐 금지 | INVALID_PROVIDER_RESPONSE, judgments=[], error 존재; 최종 AGENT 선택은 null | PASS_OFFLINE |
| malformed | HTTP200 불완전 JSON → INVALID/error | INVALID_PROVIDER_RESPONSE; 별도 vendor fallback attempt | PASS_OFFLINE |
| missing-questions | alpha·beta 중 beta 응답 누락 → INVALID/error | 누락은 탐지. 추가 공통 RESP 검사에서 유효 비용 .1이 유실 | **FAIL** |

모든 기본 variant를 JEV→vendor mock 성공 경로와 JEV OFF/vendor 자체 실패 최종 RESP 경로로 각각 실행했다. 이 시험의 alpha/beta inventory, prompt, profile PASS, approval reference와 credential은 공개 합성 입력이다. 원래 null prompt를 복원한 것이 아니며, vendor 역할에도 오직 합성 wire 경계를 사용했다. 모든 HTTP 호출은 주입한 fetch 함수이며 실제 fetch를 호출하지 않았다. 거절 payload는 JEV noul 계약을 만족하지 않는 구조 오류이며 실제 서비스가 해당 거절 형식을 제공한다는 주장이 아니다.

## 재현된 결함과 추가 경계

1. **기존 발견 연결: valid-cost-lost-with-invalid-RESP.** beta judgment가 누락된 ProviderEvaluation에 검증 가능한 usage(inputTokens=10, outputTokens=2, actualCostUsd=.1)를 전달했다. `service.ts:194`의 응답 검증 예외가 `:204`의 unknownUsage 반환으로 연결되면서 attempt 실제 비용은 null, JEV spent는 0, 미확정 예약 .4가 남았다. 유효 비용을 보존해 .1로 정산해야 한다는 assertion이 실패했다. 예약은 보수적으로 남으므로 이 재현만으로 예산 초과 사용을 주장하지 않는다. 같은 원인을 새 결함으로 중복 집계하지 않는다.

2. **추가 경계: uncertain 판단과 unresolvedItems 결속 누락.** 공통 RESP에 alpha=not-needed, beta=uncertain/uncertaintyReason=MODEL_REFUSAL, status=PARTIAL, unresolvedItems=[]를 전달했다. `validateClassificationResponse`는 오류 []를 반환하고 service는 해당 PARTIAL을 그대로 반환하여 vendor mock 호출 0회였다. SS30의 semantic unresolvedItems 결속 조건을 충족하지 않는다. beta 판단의 uncertaintyReason 자체는 남아 있으므로 불확실성이 완전히 지워졌다는 주장은 하지 않는다. 코드 근거는 `validation.ts:44-52` 및 `service.ts:152`이다.

입력·기대·전체 관측 RESP/attempt·budget은 `observations.json`, assertion 실패와 개별 테스트 결과는 `new-vitest.json`, variant별 결속은 `SS30.result.json`에 기록했다. B의 실패와 fallback의 지원 응답을 구분했고, 지원 응답을 AGENT의 S로 복사하거나 host receipt를 만들지 않았다. 실패 RESP의 judgments=[]와 관측하지 못한 agentSelectedSkillIds=null을 구분했다.

## 실행 명령과 상태

```sh
cd <REPO_ROOT>
node evidence/SS30/run.mjs
node evidence/SS30/finalize.mjs
```

첫 명령은 기존 SS30 관련 7개 회귀와 이 사례의 신규 검사만 실행하며 현재 결함 때문에 exit 1이다. 두 번째는 관측·최종 결과·digest를 정리하며 제품 테스트를 재실행하지 않는다. 개별 정확한 argv, exit, stdout/stderr, 시각은 `*.command.json`에 있다. 초기 pnpm 실행은 workspace dependency setup 단계에서 실패해 테스트 수집 0이었다. 해당 기록은 `*.setup-error.json`에 SPAWN_ERROR로 보존했다. 기존 설치 Vitest 5 CLI를 직접 호출하여 검증을 완료했다.

`AGENTS.md`, `skills/test-engineering/SKILL.md`, test-design/test-proof/CLI 참조, orchestrator와 분류 계약을 읽었다. repo와 workspace의 `.agents`도 확인했으나 `.agents/skills`는 없다. 계획을 공통 checker로 검사했다. 제품 수정·mutation 및 수정 후보의 green 실행이 허용되지 않았으므로 sensitivity proof는 NOT_RUN이며 `engineering-test-result.json`은 INCOMPLETE다. 이는 실제 21개 검사 실행 결과와 별개의 회귀 감도 증명 상태다. 제품 tracked diff는 없으며 push/PR/릴리스는 하지 않았다.

## 실제 호스트와 남은 입력

JEV 0, 외부 vendor API 0, Claude 0; 과거 21회 완료 run 재실행 0. SS30 실행종류는 mock이며 이 배정에서 host-live는 수행하지 않았다. **selected/read/applied/verified 모두 NOTRUN**이다. 이 보고서를 작성하는 개발 에이전트가 스킬 지침을 읽은 사실은 SS30 대상 호스트의 실제 selection/read/applied/verified 증거가 아니다.

현재 도구 목록에는 AGS의 get_skill_inventory/classify_skills/record_skill_selection이 없고 `AGENT_GOVERNANCE_CLASSIFICATION_CONFIG`도 설정되지 않았다. 실제 지원 경로는 `index.ts:88`의 설정 로딩→중앙 qualified profile registry→승인된 providerRuntimeRef→등록된 remote vendor adapter 또는 qualified native adapter이다. native 경로는 executable/workingDirectory, host-vetted isolationArgs, capability·retry·isolation evidence, 호출 allowance를 요구한다. 단순 CLI 설치는 가용한 승인 경로 증거가 아니다.

호스트 단계가 추가로 요구될 때 필요한 것은 실제 승인된 AGS 설치와 MCP 노출, 원문/context/inventory, 동결 qualified model·effort profile, route/egress/budget 또는 native allowance, 실제 actor/task/call 관측이다. AGENT가 원문·규칙·B를 검토한 뒤 hostReceipt=null로 record_skill_selection에 전달하고 서버가 실제 호출 관측과 결속해야 한다. selected 이후 read/applied/verified는 동일 대상·산출물의 별도 실제 근거가 필요하다. 해당 입력 없이 host 완료를 선언하지 않는다.
