# AGS 2.9.1 provider 후보 게시 묶음

**기존 후보와 시험 결과를 게시하는 증거 묶음이다. 최신 승인에 따라 evidence 브랜치의 이 고유 경로만 추가한다. 새 구현·시험 재실행은 수행하지 않았다. 게시 성공과 원격 검증은 별도 publication receipt로 보고한다.**

- 원본 후보 commit: `b5a04ff82f9863383de00d75de5841af5223041b`
- 후보 tree: `f82f927c49ba368e17843abc8548ef9cea60107c`
- 기준 commit/tree: `c6a8019be30e4bf5ee9a36147ca45ae28b0f75b6` / `28f2f2ed8a864405320f6d20e7bc5004e8466ad3`
- 제품 변경 범위: `providers.ts`와 provider 테스트만, 216 additions / 10 deletions. 원본 checkout은 clean이다.
- 기존 최종 원자료: 동일 63-case red **26 PASS / 37 FAIL**, green **63 PASS**, 주변 표적 회귀 **100 PASS**. 초기 60-case 결과는 이 묶음에서 제외했다. 전체 suite는 재실행하지 않았다.
- 실제 유료 API·Claude 호출 **0**. 합성 입력, mock fetch와 로컬 callback만 사용했다.

## 적용 가능한 코드 패치

`patches/candidate.diff`는 기준→후보의 원본 binary-capable Git diff와 기존 diff에 byte 일치한다. 기준 checkout에서 `git apply --check <patch>`로 검토한 뒤 단일 구현/게시 담당자가 적용할 수 있다. 이 단계의 applicability 검사는 실제 패치 적용이나 제품 테스트가 아니다. 이미 후보인 checkout에 다시 적용하지 않는다. source/base와 source/candidate는 고정된 Git blob 원문이다.

원본 format-patch는 작성자 개인정보를 포함하므로 제외했다. 코드 diff는 수정·익명화하지 않았다. 이 diff의 적용은 원본 commit의 author/committer metadata나 동일 commit SHA 재생성을 보장하지 않는다. 후보 SHA는 provenance 식별자다.

## 시험 입력·기대·관측 및 실패 재현 자료

각 합성 입력과 기대 assertion은 `source/candidate/tests/mcp/skill-classification-providers.test.ts`, 요구사항은 `raw/test-plan.json`, 관측과 실제 실패 assertion/stack은 `raw/red-receipt.json`, `raw/green-receipt.json` 및 final logs에 있다. 두 receipt는 argv, 시작/종료, stdout/stderr와 digest, source/test/config snapshot, exit를 보존한다. 기존 source/test digest 동일성을 `raw/source-manifest.json`과 대조할 수 있다. red는 import/runner 실패가 아니라 기존 R13 제품의 assertion 실패다. 새 실행 결과로 표현하지 않는다.

후보가 다루는 경계는 credential await/encode 후 dispatch 전 route·profile·request 변경과 cancellation의 fetch 0회 차단, 429/529의 안전한 Retry-After 관측과 fetch 1회/재시도 0회, JEV answers의 중복·escaped duplicate·상충 key 거부다. 답변 RAW는 재직렬화하지 않는다. JEV 전용 raw guard를 모든 vendor protocol 지원으로 확대 주장하지 않는다. 최종 스킬 선택은 AGENT의 책임이며 분류기는 보조다. JEV OFF는 기존 vendor의 고정 저비용 quality-qualified profile 대체와 외부 호출 전체 OFF를 구분하는 기존 정책을 그대로 따른다. 중앙 모델/추론 profile, 공통 REQ/RESP, 앞단 정형화 추가 LLM 호출 없는 계약을 변경하지 않았다.

`raw/engineering-test-result.json`의 CONSISTENT는 unsigned local consistency 검사다. 독립 감사는 `review/independent-static-review.md`로 별도 제공하며, 실제 시험 재실행·설치·배포 검증과 구분한다. 독립 검토 판정은 좁은 provider 후보의 정적 게시 근거 PASS / 전체 연결 FAIL / merge·deploy·release 준비 BLOCKED다. 이것을 운영 완료나 배포 승인으로 표현하지 않는다. 원본 engineering proof의 `.provider-proof/...` 경로는 당시 실행 위치이며 이 묶음에서는 같은 bytes의 `raw/...`로 매핑된다. historical report의 format-patch 인계 참조는 개인정보 제외에 따라 이 묶음에서 제공하지 않는다. 빈 lint/typecheck 로그 자체는 exit0의 독립 증명이 아니며 기존 보고에 기록된 성공과 구분한다.

## 해결되지 않은 한계

1. **timeout 경계 미해결:** 기존 D02에서 gateway가 `2147483648`을 허용했고 Node timer clamp로 약 5.234ms에 timeout이 발생했다. prior-audit 원자료와 이후 test-only loader 경계 결과 18 PASS / 2 FAIL을 `limitations/timeout`에 보존했다. 서로 다른 고정 대상의 기존 자료이며 b5 후보의 재실행 결과가 아니다. 후보는 gateway/service를 바꾸지 않아 timeout 결함은 남는다. 제안 패치를 후보 적용 패치로 섞지 않았다.
2. **외부 snapshot no-call 연결 미구현:** signal abort 없이 외부 config revision이 credential 대기 중 바뀌면 provider는 보지 못한다. `raw/integration-gap.json`은 mock fetch 1회 후 service가 STALE_CLASSIFICATION을 반환했음을 기록한다. `beforeDispatch?: () => void` 동기 closure의 types/service/provider 연결 제안은 `review/interface-proposal.md`에만 있다.
3. **rate-limit service 전달 미구현:** provider error에 429/15s 관측이 있지만 service가 오류를 재구성하여 최종 attempt에는 필드가 없다. types/service writer가 안전한 구조 검증 후 전달해야 한다. 이 후보가 전체 service 경로의 관측 보존을 완성했다고 주장하지 않는다.
4. 기존 D01 malformed-response 비용 정산, SS31 unknown 비용·예약·환급, R14 evaluator/bootstrap, R13 harness, 배포 bundle 재생성과 통합 회귀는 후보 범위 밖이다. 새 결함 수정이나 release 승인으로 취급하지 않는다.

timeout과 두 integration gap은 이미 관측한 미해결 항목이며 이번 포장 단계에서 새로 시험 발견한 결함은 없다. 독립 정적 검토의 별도 발견사항은 해당 보고서를 따른다.

## 개인정보·비밀값 및 무결성

개인 작성자 이름/email이 담긴 format-patch, 개인 대화와 chat 식별자는 포함하지 않았다. 시험의 SYNTHETIC_ONLY / SECRET_SENTINEL은 코드에 명시된 가짜 테스트 값이며 실제 credential이 아니다. 합성 요청 원문과 코드 diff는 원형 보존했다. raw receipt의 /workspace 경로 및 runner pid는 실행 provenance로 보존했다. 실제 키·개인 이메일·private key 패턴 점검 결과는 PRIVACY-CHECK.json에 기록한다. 패턴 점검만으로 모든 형태의 비밀 부재를 증명한다고 주장하지 않는다.

`MANIFEST.json`은 모든 포함 파일의 bytes/SHA256와 원자료 출처·변환 여부를 기록한다. manifest 자체는 자기 해시 목록에서 제외하며 `MANIFEST.sha256`로 검증한다. 최종 archive는 별도 SHA256로 검증한다. raw/hashes.json은 당시 원자료 범위의 historical manifest로, 제외한 과거 파일을 참조할 수 있으므로 게시 파일 검증에는 최상위 MANIFEST.json을 사용한다.
