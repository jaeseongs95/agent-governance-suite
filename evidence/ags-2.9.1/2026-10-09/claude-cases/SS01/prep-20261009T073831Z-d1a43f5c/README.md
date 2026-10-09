# SS01 — 한국어 단일 코드 수정

상태: **PREPARATION_COMPLETE_WAITING_FOR_PARENT**. 실제 Claude Code 제품 시험: **NOT_RUN**. 준비 완료는 PASS가 아니다. API·JEV·인증 탐색·제품 테스트 호출 0회, 비용 US$0 / 사례 소프트 한도 US$2.

원래 입력(공개 합성 fixture, UTF-8 148바이트, 끝 개행 없음):

> 정수 리스트의 최댓값을 반환하는 함수를 표준 라이브러리로 간단히 고쳐 줘. 동시성·DB 변경이나 리뷰는 없어.

고정 입력 근거: evidence commit `af579e2caa8c09b380bdf88b5e9c675b0b0b9c68`의 `cases/SS01/`. 입력 SHA-256 `c41025f56b16711d241f2b5fd8956da7b23b404aba0225d9b55489da1782c0de`. embedded-source SHA-256 `7153331edeef8fd84ea85c4d5777756ef4e82e45b47f297a0af8909f046f7ca8`. 공개 payload·manifest 28개 SHA-256과 manifest 파일 크기·해시를 대조했다. 이전 후보의 원본 skill reference 8개도 일치한다. fixture SHA-256 `17ade7e27cc11ffee8cc0b7b2070785617861d4c3384448cf24fce75f40d87e9`, 재계산한 oracle `sha256:5db1d67cef8719c40b17b0ab07003f01f765746d34ced0b326e59fadb2efe055`. 외부 `TEST-SPEC.seq7.ko.md` 원본은 **MISSING_ORIGINAL**이며 embedded 동결 필드만 사용한다.

기대 결과: 공식 `base`에서 raw 추천은 `ponytail`만 포함하며 실제 AGENT 선택에도 반영되어야 한다. `cs-engineering`, `code-review`, `software-security-auditor`, 목적 없는 `orchestrator`·workflow를 추가하지 않는다. 구현 대상이 없어도 요청 유형은 P이며 no-skill로 바꾸지 않는다. OFF·vendor fallback에도 같은 목적 정답을 적용한다. 판정 기준은 Claude에 추가 prompt 힌트로 주입하지 않는다.

이전 결과: 회귀 1 PASS / 14 NOT_RUN; mock 격리 검사 20 PASS / 3 FAIL. 유효 비용 손실·수락 중 취소·타이머 overflow의 세 결함을 보존한다. 실제 provider 의미 품질과 호스트 selected/read/applied/verified는 모두 미실행이었다. 기존 실패를 기대 정상 동작으로 삼거나 mock 성공을 이번 실호스트 PASS로 해석하지 않는다.

현재 확인: `/workspace/cloud-tools/claude/node_modules/.bin/claude`에서 `2.1.286 (Claude Code)`. PATH에는 없지만 설치되어 있다. Node v24.19.0, pnpm 11.19.0. 시크릿 존재 여부만 확인했고 값은 읽거나 출력·복사하지 않았다. CLI --help의 model/effort/max-budget/stream/hook/plugin 관련 옵션은 로컬 확인했으나 인증 성공·route qualification은 확인하지 않았다. 영구 인증·권한·네트워크 정책과 제품 코드를 바꾸지 않았다.

재개 조건: 부모가 검증한 최종 후보 commit/tree, 독립 SOURCE 판정·고정 원격 게시 근거, 공통 정확한 Claude 모델·effort, 성공한 API 인증 공통 절차와 선행 검사 결과가 먼저 필요하다. 현재 R17 `fa1e250c1cbc4f8f446f2e2ddeb516f4e439edbb` / tree `43d2b4e49cdb6993c48d7adc792a3ef17426092e`는 전달받은 로컬 보고만 있고 독립 SOURCE·원격 상태는 미확인이다. 이전 main 또는 c6a8019를 제품 후보로 사용하지 않는다. 승인된 classification config/profile/runtime·route·budget, 진짜 Claude hook/session-board 관측과 설치/지원 inventory도 필요하다.

재개 후 실제 단계는 `preparation.json`의 `stepsAfterResume`에 고정했다. Claude가 exact prompt·전체 inventory로 raw 추천과 AGENT 선택을 수행하고, 서명된 exact-call 호스트 수락을 관측한 뒤 ponytail 본문 읽기·적용·검증을 각각 기록한다. Sol의 준비용 읽기는 실호스트 단계 근거가 아니다. 원래 입력에 구현 함수·언어가 없어 수정/검증은 보류될 수 있으며 대상을 임의로 만들지 않는다. JEV는 개별 배정 전 호출하지 않는다.

`cost-ledger.json`은 준비 호출을 포함한 누적 비용·토큰·캐시·재시도·실패와 소비 미상 예약을 기록한다. 한도 접근 시 다음 호출을 멈춘다. 39개 예약 US$78은 소비 목표가 아니다. 이 run에는 정제된 보고서·공개 입력 근거·해시만 있고 비밀·개인정보·원본 채팅은 없다.
