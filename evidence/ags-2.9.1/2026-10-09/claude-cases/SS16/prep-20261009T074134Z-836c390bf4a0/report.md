# SS16 — 전체 inventory의 덜 빈번한 스킬

상태: **PREPARED_WAITING_PARENT**. 입력·로컬 CLI 준비 완료이며 제품 시험 PASS가 아니다. 실제 Claude 호스트 selected/read/applied/verified, provider-live, R17 제품 시험은 모두 NOT_RUN이다. 제품 코드·생성 배포물을 변경하지 않았다.

## 고정 입력과 출처

저장소: https://github.com/jaeseongs95/agent-governance-suite

고정 evidence commit: `af579e2caa8c09b380bdf88b5e9c675b0b0b9c68`, 원래 경로: `evidence/ags-2.9.1/2026-10-09/cases/SS16/`.

원래 제목: **전체 inventory의 덜 빈번한 스킬**.

원래 입력: “이 한국어 안내문의 사실·수치·링크·주장 강도를 보존하며 자연스럽게 편집하고 검증해 줘.”

입력 UTF-8 124바이트, 최종 newline·정규화 없음. SHA256: `6d0c8db213a015636577c23521d4075459f37bcb16284da0e1ad54ebd49b70be`.

Fixture excerpt SHA256: `6b8ec8999656668b252ce536a115a278117170bdfa9ae0903667f443943a5ba2`. 기존 전체 fixture digest: `17ade7e27cc11ffee8cc0b7b2070785617861d4c3384448cf24fce75f40d87e9`; 기존 frozen oracle digest: `5db1d67cef8719c40b17b0ab07003f01f765746d34ced0b326e59fadb2efe055`. 마지막 두 digest는 원래 공개 자료의 선언을 보존한 것이며, 현재 후보 파일을 재계산한 값으로 주장하지 않는다.

18개 공개 파일을 고정 commit에서 추출했다. SHA256SUMS의 17개 항목, manifest의 16개 payload hash·길이, fixture 원문과 입력 바이트 모두 일치했다. 자세한 실제 재계산 값은 `input-hash-verification.json`에 있다. 외부 TEST-SPEC 전체 파일과 안내문 본문·기존 host 증거는 MISSING_ORIGINAL이며 복원하지 않았다.

## 변하지 않은 기대 결과

전체 inventory를 original-order / reversed-order / required-at-tail 세 순서로 전달한다. 기존 inventory는 24개, K 위치는 각각 14/11/24였다. 후보 전체 수와 inventory digest가 순서와 무관하게 일치해야 한다. 새 검증 후보 inventory의 실제 값은 재개 시 따로 고정한다. 과거 digest를 새 후보에 재결합하지 않는다.

K=`korean-prose-editor`는 반드시 추천한다. O=`orchestrator`는 네 한국어 capability 단계 연결이 실제로 필요하고 그 연결을 설명하는 추천 사유가 있을 때만 허용한다. 무관한 nonempty 사유는 실패다. 대표 엔지니어링 스킬로 후보를 줄이거나 K가 top-k 앞에 없다는 이유로 빠뜨리면 실패다. 전체 inventory를 보낼 수 없으면 잘림을 알리고 보류한다.

승인된 실제 적용 시험은 `korean-prose-selection → korean-prose-editing → korean-prose-verification → korean-prose-finalization` 네 capability와 artifact 의존성을 확인한다. K 한 스킬의 네 단계를 네 스킬로 세지 않는다. 모델 추천, AGENT 최종 선택, SKILL 읽기, 실제 적용, 검증은 각각 실제 근거가 필요하다. 관측되지 않은 단계는 NOT_RUN이다.

## 기존 결과와 이번 준비의 구분

기존 대상은 `c6a8019be30e4bf5ee9a36147ca45ae28b0f75b6` / tree `28f2f2ed8a864405320f6d20e7bc5004e8466ad3`였다. 이 commit은 역사적 지침과 근거 확인에만 읽었고 시험하거나 최종 후보로 사용하지 않았다.

기존 오프라인 기록: 18 PASS / 2 FAIL / 20 tests, exit 1. 실패는 무관한 O 사유를 evaluator가 허용하는 조건 검사 공백과, K 판단이 없는 invalid response에서 유효한 synthetic cost 0.003이 null로 손실되는 기존 공통 finding의 SS16 witness다. 이 실패를 올바른 기대 동작으로 승격하지 않는다. 기존 compact request projection 124567바이트는 완전한 wire 측정이 아니다. 기존 mock 추천은 미리 정해져 있어 실제 provider 의미 품질을 입증하지 않는다. 기존 plan READY는 계획 구조 일관성만 뜻한다. 이번에 이 테스트·과거 live batch·formal red/green을 재실행하지 않았다.

## 로컬 준비

`/workspace/cloud-tools/claude/node_modules/.bin/claude --version`의 실제 결과는 **2.1.286 (Claude Code)**, exit 0이다. PATH에는 없지만 지정 경로에서 실행 가능하다. Node는 v24.19.0이다. `--help`도 exit 0이며 `--print`, `--output-format`, `--model`, `--effort`, `--max-budget-usd`, `--plugin-dir` 등 지원을 확인했다. help 지원은 인증·모델 접근·MCP 작동의 검증이 아니다.

로컬 checkout과 원래 역사적 source의 AGENTS.md, 관련 SKILL.md, test-design을 읽었다. catalog에 관련 스킬이 없어서 `.agents/skills`도 점검했고 workspace/로컬 checkout에는 없었다. 저장소 `skills/`에서 관련 지침을 찾았다. verified 후보 지침·Claude overlay는 재개 후 다시 고정해야 한다. 준비 계획은 test-engineering의 요구/공개 경계/독립 oracle 원칙을 적용했다. 게시 범위와 사전 조건은 change-scope-guardian·mutation-risk-preflight 지침으로 수동 점검하며, 이 준비에서 제품 스킬 CLI를 실행해 PASS를 주장하지 않는다.

## 실제 Claude Code 확인 절차와 재개 조건

`execution-plan.prepared.json`에 요구별 기대/증거와 실행 순서를 기록했다. Sol은 환경·입력·근거만 관리하고 실제 Claude가 호스트 선택·읽기·적용·검증을 수행해야 한다. 모델-facing 입력에 정답 K/O를 주입하지 않는다. 전체 후보와 원문 전달 바이트, 모델/설정, 세 순서별 추천, 실제 선택 receipt, SKILL 읽기와 네 단계 artifact/검증을 연결한다. 모델 자기 보고만으로 호스트 완료를 인정하지 않는다.

R17 후보 `fa1e250c1cbc4f8f446f2e2ddeb516f4e439edbb` / tree `43d2b4e49cdb6993c48d7adc792a3ef17426092e`는 부모 전달 기준 로컬 고정 보고만 있고 독립 SOURCE 판정·원격 게시가 미확인이다. 현재 준비는 이를 검증한 것으로 표현하지 않는다. 부모의 검증된 최종 commit/tree·SOURCE/원격 근거·선행 검사와 공통 Claude 모델/effort·성공한 임시 API 인증 방식·plugin/MCP/profile/host receipt 설정을 받아야 제품 시험을 시작한다. 영구 인증 설정·권한·네트워크 정책은 변경하지 않았다. 키나 placeholder를 출력·복사·게시하지 않았다.

실제 편집·검증에는 원래 입력에 없는 승인된 안내문 본문, 보호 구간/source-unit manifest, 용어집 조회 결과와 frozen rubric이 필요하다. 본문이 없으면 분류 intake와 적용/검증의 상태를 나누고 후자를 보류한다. 본문을 임의로 만들거나 기존 결과에 끼워 넣지 않는다.

## 비용과 게시 범위

준비를 포함한 Claude API 호출 0회, 실패/재시도 0회, JEV 0회, 토큰/캐시/실제 비용 모두 0, SS16 소프트 예산 잔액 US$2다. 39개 예약 합계 US$78은 소비 목표가 아니다. `budget-ledger.json`은 모든 호출·실패·캐시·재시도 비용 기록 필드와 다음 호출 중단 조건을 보존한다. CLI budget 옵션만으로 단일 요청의 초과 방지를 보장하지 않으며, 공통 모델 요율과 headroom 확인 전에 호출하지 않는다.

게시 대상은 기존 evidence 브랜치의 이 고유 SS16 run 경로다. 기존 파일·다른 사례·제품·배포물을 덮어쓰지 않는다. 정제한 보고서·준비 근거·해시만 추가한다. 원격 push 성공과 고정 commit 파일 바이트 재확인은 별도의 게시 근거로 보고하며 제품 PASS와 구분한다.
