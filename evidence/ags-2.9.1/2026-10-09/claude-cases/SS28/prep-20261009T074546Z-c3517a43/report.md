# SS28 — compact REQ와 입력 출력 잘림

준비 상태: PREPARED_WAITING_FOR_PARENT. 실제 Claude Code 제품 시험은 NOT_RUN이며 PASS 판정을 발급하지 않았다. 유료 호출·재시도·JEV 호출은 모두 0, 이 준비 단계 지출은 US$0이다.

## 고정 입력과 기대 결과

원래 입력은 “읽기 전용, 수정 금지”. 고정 evidence commit은 `af579e2caa8c09b380bdf88b5e9c675b0b0b9c68`이다. `source-spec.json`은 고정 공개 SS28.source.json의 변경 없는 복사본이다. source SHA256는 `122cb5c66ad9f088bc04d99b58b7b26bd604c721b0957b80c25d44309d5805e1`, 내장 sourceSpec bodyDigest는 `74aab7c36f19efee9a58b8f677d1c1295ad6b4ded14a2e139b44c4567feb9799`다. 원문 TEST-SPEC.seq7.ko.md는 기존 패키지에서 부재하고 semantic oracle은 null이다. 빈 선택이나 합격 기준을 만들어 보완하지 않았다.

원본/compact가 원문 의미, 전체 후보, 적용·제외 조건, 의존성, 부정·예외를 보존해야 한다. 실제 입력 tokens 감소와 paired golden 품질·제약·실제 최종 AGENT 선택을 비교해야 한다. 앞단 원문 요약 LLM 호출 0, silent truncation 0, 불필요 로그·비밀 metadata 전송 0이어야 한다. bytes 감소나 로컬 cache hit로 provider 청구 token 감소를 주장하지 않는다. 실제 usage와 provider cache 청구 항목을 별도로 확인한다. 입력과 응답이 잘리면 완전성을 거부하고 no-skill로 오인하지 않는다. 입력 한도 초과는 INPUT_TOO_LONG 또는 명시된 무손실 분할·완전성 확인이다. unknown null과 출처가 확인된 []를 구분한다.

## 기존 공개 결과 대조

SHA256SUMS의 39개 항목 전부 일치했고 manifest의 payload 항목도 크기와 해시가 일치했다. SHA256SUMS 자체 해시는 `39bc76c9a679e82e5b0de7a48d25073d50dd25a279d59b908d24db4b894b6b72`다. 전체 입력 근거와 파일 해시는 input-hashes.json에 있다.

역사적 후보 c6a8019/tree 28f2f2e 결과는 관련 shared 회귀 17 PASS/51 SKIP, 새 구조 assertion 9 PASS 및 비용 보존 경계 1 FAIL이다. 이 결과는 현 후보나 전체 SS28의 PASS가 아니다. 유효 비용 0.1을 포함한 불완전 응답에서 usage가 null, spentUsd가 0이 된 것은 기존 결함이며 기대값은 INVALID 상태를 유지하면서 actualCostUsd=0.1, spentUsd=0.1을 보존하는 것이다. 기존 실패를 정답으로 고정하지 않았다.

역사적 원본/compact는 365,370B → 124,722B, 후보 수 24 → 24였으나 실제 model tokens/usage/cache/golden/AGENT paired 선택은 NOT_RUN이었다. cs-engineering을 inventory 마지막에 둔 자료는 synthetic 기계적 보존 검사이며 원래 읽기 전용 입력의 semantic 필수추천 정답이 아니다.

## 실제 Claude에서 확인할 단계

execution-plan.json에 9개 variant와 추가 비용 경계의 정확한 입력 참조·기대 결과 및 재개 절차를 고정했다. Sol은 환경과 근거를 관리하며 실제 AGS host 작업은 Claude Code가 해야 한다. 선택 → SKILL 읽기 → 적용 → 검증 단계는 실제 Claude 관측으로 기록하고, receipt를 Sol이 합성하지 않는다. caller hostReceipt=null에서 검증된 호스트 관측 경로가 실제 receipt를 제공해야 한다. 기존 공개 test copy는 재실행하지 않았다. 새 테스트나 제품 변경도 수행하지 않았다.

CLI는 지정 경로에서 2.1.286 (Claude Code), Node v24.19.0, pnpm 11.19.0으로 로컬 재확인했다. CLI가 PATH에 없지만 절대 경로로 실행 가능하다. --version과 --help만 실행했으며 API 인증 성공은 아직 확인하지 않았다. 인증·권한·네트워크 영구 설정은 변경하지 않았다. 저장소 AGENTS.md와 관련 SKILL.md를 읽었고 호스트/저장소 .agents/skills는 부재했다. 준비용 로컬 제품 workspace는 시험 후보로 사용하지 않는다.

## 막힘과 재개 조건

현 후보 R17 `fa1e250c1cbc4f8f446f2e2ddeb516f4e439edbb` / tree `43d2b4e49cdb6993c48d7adc792a3ef17426092e`의 독립 SOURCE 판정과 고정 원격 게시 확인이 아직 부모에게서 전달되지 않았다. 공통 Claude 모델·effort·기존 성공 API 인증 절차·선행 검사 결과도 미수신이다. 이 묶음이 오기 전에는 제품 시험과 유료 호출을 시작하지 않는다. 이전 main이나 c6a8019를 대체 후보로 실행하지 않는다.

또한 승인된 classification config/중앙 profile/providerRuntime/native adapter/isolation/retry/egress와 실제 Claude host attestation, task·revision·inventory binding이 필요하다. semantic oracle=null인 상태에서는 paired golden 정확성과 전체 PASS를 판정할 수 없다. 승인된 동결 golden 근거를 받거나 그 요구를 미확인으로 남겨야 하며 기준을 완화하지 않는다.

사례 soft budget은 준비 호출까지 US$2, 39개 예약 합계는 US$78이다. 소비 목표로 사용하지 않는다. accounting.json에 현재 0 호출과 후속 비용·토큰·캐시·실패·재시도 기록 요구를 남겼다. 한도에 접근하면 다음 호출을 멈춘다. JEV는 개별 배정 전이므로 시작하지 않는다.

## 게시 범위

기존 evidence 브랜치의 SS28 고유 run 경로에 정제된 준비 보고서·입력 근거·해시·절차·회계·로컬 환경 확인만 추가한다. 제품 코드·생성 배포물·다른 작업 파일 변경, force push, 비밀값·개인정보·원본 채팅 게시를 하지 않는다. 고정 게시 commit에서 원격 파일을 다시 읽어 해시를 검증한 결과는 부모에게 별도 전달한다.
