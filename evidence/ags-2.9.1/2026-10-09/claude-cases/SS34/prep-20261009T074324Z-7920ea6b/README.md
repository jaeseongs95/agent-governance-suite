# SS34 — 선택 읽기 적용 검증의 구분

상태: **PREPARATION_COMPLETE / ACTUAL_CLAUDE_TRIAL_NOT_RUN**. Claude API·JEV·외부 vendor 호출과 비용은 모두 0이다. 준비 완료는 제품 PASS나 독립 SOURCE 판정이 아니다.

고정 입력은 evidence commit `af579e2caa8c09b380bdf88b5e9c675b0b0b9c68`의 `evidence/ags-2.9.1/2026-10-09/cases/SS34/`에서 읽었다. SHA256SUMS의 18개 항목과 manifest의 모든 payload 바이트 수·해시가 일치했다. 원격 고정 URL의 19개 파일도 다시 읽어 Git blob과 같은 바이트임을 확인했다. `source-verification.json`과 `remote-input-verification.json`에 근거가 있다.

입력 `SS34.fixture.json`의 SHA256은 `a544c140804ffcb7bc06971c3b16020cbee64ca8cdf4a1a343e0e3f40b426e1d`, trace/기대값 `SS34.observations.json`은 `726254312c89127854395671a460a6df2fb45d100b04956a822aea5f46e78b86`이다. 두 파일을 원래 바이트 그대로 보존했다. 전체 과거 fixture 해시 `17ade7e27cc11ffee8cc0b7b2070785617861d4c3384448cf24fce75f40d87e9`와 oracle digest `5db1d67cef8719c40b17b0ab07003f01f765746d34ced0b326e59fadb2efe055`는 과거 provenance이며 현재 후보를 검사했다는 주장이 아니다. 누락된 원본 `TEST-SPEC.seq7.ko.md`는 재작성하지 않았다. SS34 originalPrompt/oracle/semanticAccuracy는 null을 유지한다.

원래 입력은 CS 추천·선택 trace, SKILL.md 읽기 추가 trace, 의무와 산출물이 연결된 trace, 동일 후보에서 계획대로 검증된 trace를 순서대로 제공한다. 다른 후보 검증과 필수 K capability 누락 변형을 포함한다. 기대값은 다음과 같다.

| 변형 | selected | read | applied | verified |
| --- | --- | --- | --- | --- |
| recommend-only | false | false | false | false |
| selected | true | false | false | false |
| read | true | true | false | false |
| applied | true | true | true | false |
| verified | true | true | true | true |
| wrong-candidate | true | true | true | false |
| missing-k-phase | true | true | false | false |

`no-admission-negative`는 선택 receipt만 있고 admission 없이 실행을 시작한 trace를 FAIL로 판정해야 한다. 추천, 실제 호스트 선택, needed/runnable, admission과 selected/read/applied/verified를 각각 기록한다. 이름·HTTP 성공·파일 읽기만으로 적용 완료를 인정하지 않는다. 후보·환경·source digest·의무/산출물·계획된 검증 근거의 결합이 없으면 단계 승격을 보류하고 직접 관측되지 않은 상태는 NOT_OBSERVED/NOT_RUN으로 남긴다. K 단계는 descriptor에서 독립적으로 도출하며 짧아진 requiredPhases 목록을 신뢰하지 않는다. 별도 독립 감사 PASS를 자동 생성하지 않는다.

과거 후보 c6a8019의 결과는 FAIL, Vitest exit 1, 19 assertions 중 13 PASS/6 FAIL이었다. 동결 8개 변형은 7 PASS/1 FAIL이었다. no-admission-negative의 과거 관측 PASS는 기대값 FAIL을 위반한 결함 근거다. wrong-environment, wrong-source-digest, unplanned-missing-evidence, wrong-obligation-artifact, omitted-required-k-phase-list도 기존 실패로 보존한다. 운영 evaluator의 NO_SEMANTIC_ORACLE/UNKNOWN_CASE_OBSERVATION, engineering proof INCOMPLETE, 실제 호스트 단계·독립 감사·red/green NOT_RUN을 통과로 바꾸지 않았다. synthetic sentinel과 mocked gateway는 실제 호스트 성공을 증명하지 않는다.

Claude CLI는 `/workspace/cloud-tools/claude/node_modules/.bin/claude`에서 실제 `--version` exit 0으로 **2.1.286 (Claude Code)**을 확인했다. Node v24.19.0, pnpm 11.19.0도 확인했다. `--help`로 세션별 plugin/MCP/settings, model/effort/output 및 `--max-budget-usd` 옵션 존재를 확인했다. 모델·인증·MCP·hook 실행은 아직 확인하지 않았다. 비밀값을 읽거나 출력하지 않았고 영구 인증·권한·네트워크 정책을 바꾸지 않았다.

현재 제품 후보 R17은 `fa1e250c1cbc4f8f446f2e2ddeb516f4e439edbb` / tree `43d2b4e49cdb6993c48d7adc792a3ef17426092e`로 전달되었지만 독립 SOURCE 판정과 원격 게시 검증은 부모가 전달해야 한다. 이 준비에서 R17, main, c6a8019 어느 후보도 제품 시험하지 않았다. 검증된 후보와 공통 exact Claude 모델/effort/API 인증 절차·선행검사·per-run AGS plugin/MCP/hook 설정을 기다린다. 원래 prompt가 null이므로 실제 호스트 작업 입력·허용 artifact 대상도 원래 명세와 구별해 동결해야 한다.

재개 시 Claude가 실제 호스트 도구 호출·선택·읽기·CS 의무 산출물·계획 검증을 수행하고 Sol은 입력, 비용, 정제 근거와 해시를 관리한다. `resume-protocol.json`에 단계와 선행조건을 고정했다. 후보 지침과 descriptor를 다시 읽고 실세션 attestation, 독립 admission, 파일/의무/산출물/후보/환경 결합을 확보하기 전에는 호스트 완료를 주장하지 않는다. --bare/--safe-mode로 필수 AGS hooks를 누락시키지 않는다. Claude 실행 명령은 공통 인증·모델 설정 도착 후에만 구성한다.

사례 소프트 예산 US$2는 준비·실패·재시도·캐시를 포함한다. 39개 총 예약 US$78는 소비 목표가 아니다. `cost-ledger.json`에 호출별 token/cache/cost/retry/failure 항목과 누적 한도 정지 규칙을 준비했다. 현재 사용액 US$0. 한도 접근 또는 비용 미확인 시 다음 호출을 멈춘다. JEV 배정은 아직 없으므로 호출하지 않는다.

공개 산출물은 이 고유 SS34 run의 정제 보고서·이미 공개된 정확한 입력·근거·해시 목록뿐이다. 제품 코드와 생성 배포물, 다른 작업 파일은 수정하지 않는다. 원본 채팅·개인정보·비밀값을 게시하지 않는다. 게시 대상은 기존 evidence 브랜치이며 fast-forward만 허용한다. 원격 갱신 경합이 있으면 최신 evidence 위로 이 additive commit만 재적용하고 범위를 재확인한다. 게시 후 고정 원격 commit 파일을 다시 읽어 해시를 검증한다.
