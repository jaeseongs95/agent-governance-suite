# Claude SS01–SS39 공통 시험 프로필 — 캐싱 보완본

이 디렉터리는 시험 운영자와 평가자를 위한 공개 준비 자료다. 실제 시험 AGENT의 입력 자료나 host PASS 증거로 사용하지 않는다. 게시만으로 제품 시험을 시작할 수 없다.

## 파일과 기준

- `common-protocol.json`: 고정 후보, 실행 게이트, 모델·권한·증거 계약, 39개 환경의 공통 절차와 정답 격리 구조.
- `case-catalogue.json`: SS01–SS39 원래 순서·제목·원본 경로·준비 의존성·matrix 소유권. 원문 입력이나 정답을 중복 삽입하지 않는다.
- `cost-summary.json`: 보존된 합성 인증·CLI smoke·준비 리뷰의 요약과 예산 규칙. CLI 추정치와 청구 금액을 구분한다.
- `prompt-cache-profile.json`: 공식 캐싱·CLI 설정 근거, 가능한 재사용 범위, 관측 usage와 미관측 항목.
- `MANIFEST.json`, `SHA256SUMS`: 공개 파일 크기와 SHA-256.

원본 증거 commit은 `af579e2caa8c09b380bdf88b5e9c675b0b0b9c68`이다. 원래 39개 사례와 정답은 그 commit의 `evidence/ags-2.9.1/2026-10-09/cases/`에서 보존한다. 전체 frozen fixture는 `cases/SS10/inputs/fixtures.frozen.json`이며 142450바이트, SHA-256 `17ade7e27cc11ffee8cc0b7b2070785617861d4c3384448cf24fce75f40d87e9`이다. oracle corpus digest는 파일 SHA와 다른 `sha256:5db1d67cef8719c40b17b0ab07003f01f765746d34ced0b326e59fadb2efe055`이다. 정답의 null·빈 배열·필수·허용·금지·미판정 구분을 바꾸지 않는다.

## 정답과 시험 AGENT의 격리

운영자는 정답·과거 결과·리뷰·scorer·test assertion과 이 공통 자료를 평가자 전용 영역에 둔다. 시험 AGENT에는 승인된 원래 합성 요청과 실제 AGS 제품·정상 inventory만 별도 실행 공간에 제공한다. 평가자 영역은 subject 파일시스템·MCP·도구에서 접근할 수 없어야 한다. 같은 사용자 권한으로 읽을 수 있는 형제 디렉터리는 격리가 아니다.

평가자가 후보 commit/tree를 확인한 뒤 필요한 진짜 제품 구성요소를 allowlist로 내보낸다. evidence, 정답 fixture, 테스트 assertion과 이를 읽을 수 있는 Git history/objects는 subject 작업 경로에 포함하지 않는다. 필수 제품 inventory를 빼거나 가짜 mock으로 대체해서는 안 된다. 실제 실행 전에 파일·부모 경로·링크·shell·Git·MCP·원격 evidence 접근 경계를 증명한다. 결과와 exact-call 서명 receipt는 외부에서 수집하고 이후 동결 정답으로 판정한다. 정답 열람이 발생하면 `INVALID_EVALUATION`이며 자동 스킬 선택 PASS로 바꾸지 않는다. 이 게시에서는 격리 구현을 실행하거나 검증하지 않았다.

## 실행과 예산

기본 driver는 `claude-opus-5-5`, effort `high`, Claude Code `2.1.286`의 ordinary `-p`이다. 실제 AGS hooks·skills·MCP·tools가 필요하며 `--bare`나 tools-empty 인증 smoke를 제품 시험으로 삼지 않는다. 선언된 네트워크 시크릿을 기존 프록시 경로로 child 인증에 사용하며 값·요청 헤더를 기록하지 않는다. OAuth 배제는 child scope에만 적용하고 영구 인증 설정을 바꾸지 않는다. 이 문서는 실행 설정을 변경하지 않는다.

39개 사례 soft reservation은 사례당 $2, 합계 $78이다. 월 승인 envelope $200은 청구 크레딧 적용 증거가 아니다. month-to-date 잔액·미상 노출은 부모 ledger가 확인해야 한다. 각 invocation의 한도는 남은 사례·월 예산에서 기존 지출·예약·$0.25 headroom을 뺀 값으로 계산하며 매번 $2를 새로 주지 않는다. 초기 자동 retry는 0, 숨은 continuation·classifier·JEV·자식 호출까지 정산한다. 기존 JEV 별도 $5 cap도 이전 지출을 포함해 유지한다.

10개 semantic case의 4경로 × 3회 반복은 Claude 120 slot이다. 전체 짝 비교는 Codex counterpart와 합쳐 120 pair/240 host trial이다. 각 semantic case Cloud가 12개 Claude slot 비용과 receipt를 소유하고 SS38은 참조로 집계한다. 같은 canonical slot을 SS19나 집계 사례에서 중복 실행·계상하지 않는다. $2로 전체 조건을 충족할 수 없으면 남은 항목을 BUDGET_BLOCKED/NOT_RUN으로 보고한다.

## 캐시 운영

캐시 사용은 시험 의미·권한·정답 격리를 바꾸지 않는다. 정답을 공통 prefix에 넣지 않는다. 첫 유효 시험 요청을 활용하고 warm-up·keep-alive·추가 반복을 늘리지 않는다. 39개 환경의 지출은 모두 cold 상태를 가정해 예약하며, 절감 예상액으로 다음 사례를 먼저 실행하지 않는다.

Anthropic API 워크스페이스와 Codex Cloud의 `/workspace`는 별개다. 같은 API 워크스페이스·모델·정확한 접두사·유효 TTL이면 환경 간 재사용 가능성이 있지만 아직 39개 환경의 공유 적중은 관측되지 않았다. CWD·plugin 경로·도구 inventory·case 요청·history 등 실제 세션 차이를 없애려고 원문을 고치거나 세션을 복사하지 않는다.

Claude Code는 요청을 직접 구성한다. raw API `cache_control`을 임의 CLI 인수로 전달하지 않는다. 문서상 지원되는 main/outside-main TTL 제안은 각각 5m이며 실제 설정에는 미적용이다. 1h는 필요한 후속 요청 간격과 높은 write 비용이 남은 예산에 맞을 때만 사전 선언한다. 실제 보존 usage에서 일반 입력·생성·읽기를 따로 기록하고, TTL별 생성량이 없으면 미상으로 둔다.

현재 공식 Opus 5.5 단가는 백만 토큰당 일반 입력 $4, 출력 $20, 5m 쓰기 $5, 1h 쓰기 $8, 읽기 $0.20이다. 이전 계획의 읽기 $0.40을 수정했다. 가격 예외·speed·geography·route는 `prompt-cache-profile.json`을 따른다. 보존된 과거 CLI 추정 지출은 다시 청구 금액으로 계산하거나 수정하지 않는다.

공식 근거: [프롬프트 캐싱](https://platform.claude.com/docs/ko/build-with-claude/prompt-caching), [Claude Code 비용](https://code.claude.com/docs/en/costs), [Claude Code 환경 변수](https://code.claude.com/docs/en/env-vars), [가격](https://platform.claude.com/docs/en/about-claude/pricing), [캐시 진단](https://platform.claude.com/docs/en/build-with-claude/cache-diagnostics).

## 남은 게이트와 알려진 입력 부족

R17 commit `fa1e250c1cbc4f8f446f2e2ddeb516f4e439edbb`, tree `43d2b4e49cdb6993c48d7adc792a3ef17426092e`를 제품 후보로 지정한다. 전달된 독립 감사는 한정된 로컬 SOURCE AC001–003 PASS와 F16 해결 범위다. exact remote candidate, 해당 범위 Linux qualification, qualified provider/JEV route, 실제 설치·지원·활성 inventory, authentic hook/session/task receipts, 월 잔액과 사례별 입력·권한은 여전히 확인해야 한다. 게시 commit은 evidence commit이며 제품 candidate가 아니다.

외부 `TEST-SPEC.seq7.ko.md`와 SS39 counterexample 01–12 원본은 MISSING_ORIGINAL이다. 기존 22 scenario로 누락 입력을 대체하지 않는다. SS39 runtime catalog/가격 탐색은 0회로 유지한다. 실제 diff·구현 대상·DB·권한이 필요한 사례에서 원문 자료가 없으면 임의로 만들어 통과시키지 않는다.

이번 게시에는 유료 호출·리뷰 재실행·제품 시험·제품 코드·main·런타임 설정 변경이 없다. 기존 준비 리뷰는 1 invocation, CLI reported 3 turns, wire call count 미상, 추정 $1.005893이며 최종 보고 앞부분이 없어 완전한 독립 PASS를 주장하지 않는다. API 성공·SOURCE PASS·offline mock·실제 AGS host PASS는 별개다.
