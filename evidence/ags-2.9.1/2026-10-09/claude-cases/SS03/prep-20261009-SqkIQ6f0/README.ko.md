# SS03 — session handoff 구현의 CS 누락 회귀

상태: **PREPARATION_COMPLETE_WAITING_FOR_PARENT**. 실제 Claude Code 제품 시험은 **NOTRUN**이며 PASS를 주장하지 않는다. API 호출·토큰·실패 API 호출·재시도·비용은 모두 0이다. 사례 전체 소프트 예산은 준비 호출 포함 US$2, 39개 예약 총합은 US$78이다.

원래 입력은 `original-input.public.utf8`에 바이트 그대로 보존했다. 공개 가능한 합성 입력으로, 정확히 220 UTF-8 바이트이며 SHA256은 `3dd99a26ff73a9e8b8a933ec3ac9f67845003f0910fa3c0d56978e0a6d55a972`다. 원본 판정 기준과 oracle은 `frozen-case.public.json`, 실제 Claude에서 확인할 단계는 `execution-plan.public.md`에 있다.

원본 공개 evidence commit은 `af579e2caa8c09b380bdf88b5e9c675b0b0b9c68`이고 SS03 패키지의 SHA256SUMS 29개 및 manifest payload 28개의 길이·해시가 모두 일치했다. 입력 fixture excerpt SHA256은 `f90494bc3334b9fa79f21f03ebf5b0d80d2d9dcf788d0273dddad07961662239`다. 전체 corpus hash와 동결 oracle hash는 원본 기록값이며 이번에 전체 파일을 재계산한 것은 아니다. `source-integrity.public.json`에 30개 파일의 독립 SHA256 목록을 보존했다. 원본 `TEST-SPEC.seq7.ko.md`는 MISSING_ORIGINAL이고 embedded sourceSpec.fields를 따른다. 누락된 초기 snapshot/첫 journal은 기존 reconstructed·후속 기록 이상의 지위로 승격하지 않는다.

동결 기대 결과는 ponytail·cs-engineering·test-engineering·orchestrator 네 개 동시 추천이다. CS의 적용 근거는 유실·중복·완료 상태의 동시성 불변조건이고, 최소 구현과 회귀 검증 책임을 함께 연결해야 한다. P만 추천하고 CS를 생략하거나 ACK를 업무 완료로 판정하거나 새 큐·DB·상시 실행기를 자동 설치하는 행동은 금지다. 추천만으로 파일 읽기·적용·검증을 PASS로 만들 수 없다.

기존 결과는 c6a8019의 오프라인 회귀 2 PASS, 독립 control 15 PASS, 알려진 결함 재현 2 FAIL이다. 반복한 control 15개를 30개 독립 표본으로 합산하지 않는다. 기존 상태는 INCOMPLETE_WITH_REPRODUCED_KNOWN_DEFECTS다. invalid RESP에서 유효 actualCostUsd 0.1이 null로 유실되는 현상과 취소 interleaving에서 mock dispatch 1회가 일어난 현상이 관측되었지만 새 root cause는 0이다. 기대 비용 기록/취소 전 호출 0이라는 기준을 실패 결과에 맞춰 바꾸지 않는다. 이 결과는 실제 Claude의 성공/실패나 R17의 결과가 아니다.

지정된 Claude CLI에서 `--version`과 `--help`를 로컬 확인했다: 2.1.286 (Claude Code), Node v24.19.0. 환경 근거는 `environment.public.json`에 있다. `.agents/skills`는 workspace와 기존 제품 작업 폴더 모두 없어서 저장소 `skills/`의 관련 SKILL.md를 읽었다. 기존 제품 checkout의 AGENTS.md/스킬 읽기는 준비자의 bootstrap 관측이며 Claude의 SS03 read 증거가 아니다. 후보의 지침·설치 상태는 실행 전에 다시 확인해야 한다. 영구 인증·권한·네트워크 정책은 바꾸지 않았다.

제품 후보 보고값은 R17 commit `fa1e250c1cbc4f8f446f2e2ddeb516f4e439edbb` / tree `43d2b4e49cdb6993c48d7adc792a3ef17426092e`다. 독립 SOURCE 판정과 고정 원격 게시가 아직 확인되지 않았다. 제품 checkout/시험은 시작하지 않았다. 이전 main이나 c6a8019를 최종 후보로 대신 시험하지 않았다.

재개하려면 부모가 검증된 최종 후보 commit/tree·독립 SOURCE 판정·원격 고정 근거, 공통 Claude 모델·effort·성공한 API 인증 절차, 선행 검사 결과를 전달해야 한다. 실제 inventory/host receipt 경로와 허용된 합성 작업 디렉터리, no-retry 및 비용 회계 절차도 확보한다. JEV는 개별 배정 전까지 호출하지 않는다.

제품 코드와 생성 배포물은 수정하지 않았다. 이번 공개 쓰기 범위는 `evidence/ags-2.9.1/2026-10-09/claude-cases/SS03/prep-20261009-SqkIQ6f0/`의 준비 보고·근거·해시 파일만이다. 원본 채팅, 비밀값, placeholder 인증값과 개인정보는 포함하지 않는다.
