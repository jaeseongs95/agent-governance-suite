# SS14 — 한영 혼합 복수 전문 판단

준비 상태: **PREPARATION_READY_WAITING_FOR_PARENT**. 실제 Claude Code 제품 시험: **NOT_RUN**. 유료 호출 0, 비용 US$0, JEV 0.

고정 공개 근거 commit은 `af579e2caa8c09b380bdf88b5e9c675b0b0b9c68`이며 `cases/SS14/`의 20개 파일을 회수했다. 18개 payload와 manifest의 SHA256SUMS 및 20개 Git blob 해시를 재계산해 모두 일치했다. 원문은 UTF-8 158바이트, BOM·마지막 newline 없음, SHA256 `7ecb7226d4cea9f67b85ef8d1deaf5bbb192d25f3c1b06367ca0f4624b2c526a`. 개별 값은 `source-hashes.json`에 있다.

원래 입력: “Read-only로 queue의 duplicate delivery와 retry invariant를 분석하고, 누락을 잡는 test cases를 설계해 줘. No implementation, no code changes.” base 한 사례만 사용한다. `TEST-SPEC.seq7.ko.md` 원본 파일은 기존 후보에 없었다는 공개 기록에 따라 embedded sourceSpec.fields를 기준으로 유지한다. 공개 excerpt 해시와 원래 전체 fixture/oracle의 기록된 해시는 서로 다른 대상이다.

동결 기준은 CS(`cs-engineering`), T(`test-engineering`), O(`orchestrator`) 동시 추천과 역할·입출력 연결이다. CS는 queue duplicate/retry 불변조건과 검증 의무, T는 이를 받는 테스트 설계, O는 CS → T 전달 및 읽기 전용 결과 통합을 맡는다. 허용 추가 선택 A={}, 금지 P=`ponytail`; `code-review`, `software-security-auditor`, `korean-prose-editor`는 notApplicable이다. 기타 unadjudicated 라벨은 임의 금지·허용으로 바꾸지 않는다. 언어 혼합 때문에 역할을 하나만 추천하거나 자동 구현하거나 설계를 실행 완료로 표현하면 실패 기준이다. 분석 대상이 없으면 필요한 입력을 요청하고 구체 실행을 보류하되 세 역할의 필요를 지우지 않는다.

기존 `c6a8019...` 기록은 오프라인 계약·경계 12 PASS, 비용 보존 재현 1 FAIL, plan consistency READY, 실제 호스트와 selected/read/applied/verified NOT_RUN이다. 유효 비용 0.1이 invalid RESP에서 null로 소실되어 spent=0과 reservation=0.4가 남은 과거 결함을 그대로 기록한다. 기대 결과는 비용 0.1 보존·settle·reservation 해제이며 기존 실패를 정답으로 취급하지 않는다. 기존 검사나 21회 run을 재실행하지 않았다.

로컬 Claude CLI `/workspace/cloud-tools/claude/node_modules/.bin/claude`의 버전 `2.1.286 (Claude Code)`, Node `v24.19.0`, pnpm `11.19.0`을 확인했다. version/help만 실행했다. CLI 존재는 API 인증·호스트 실행 성공 증거가 아니다. 영구 인증·권한·네트워크 정책은 변경하지 않았고 비밀값을 캡처하지 않았다. `--max-budget-usd`, `--plugin-dir`, `--model`, JSON 출력 옵션을 help에서 확인했으며 실제 옵션·모델·인증 방식은 부모의 검증된 공통 절차를 기다린다.

후보 R17 `fa1e250c1cbc4f8f446f2e2ddeb516f4e439edbb` / tree `43d2b4e49cdb6993c48d7adc792a3ef17426092e`는 전달받은 로컬 보고 식별자이며 SOURCE 독립 판정과 원격 게시가 아직 전달되지 않았다. main이나 `c6a8019...`을 최종 제품 시험에 사용하지 않았다. 작업 지침 AGENTS.md 및 관련 SKILL.md를 읽었고 카탈로그에 없는 스킬은 저장소 `skills/`에서 확인했다. `.agents/skills`의 추가 설치 스킬은 없었다. 과거 기준 CS/T/O 원문 해시도 공개 sourceRefs와 대조했다. 부모 후보를 받은 뒤 해당 후보와 생성 Claude 스킬의 지침·해시를 다시 확인해야 한다.

실제 시험 단계는 `execution-plan.json`의 G0–E5에 고정했다. Sol은 환경·oracle·근거·비용을 관리하고 실제 추천·선택·읽기·적용은 Claude Code에서 관측해야 한다. 원문 입력은 바꾸지 않으며 expected labels나 과거 mock 결과를 Claude 프롬프트에 주입하지 않는다. 설계·추천 판정과 실제 대상 실행·검증 완료는 구분한다. 대상이 없으면 단계별 보류 상태를 유지하고 호스트 증거 없이 전체 PASS를 선언하지 않는다.

사례 API 소프트 한도 US$2는 준비·실패·재시도·캐시 사용을 모두 포함한다. 전체 39개 예약 US$78은 소비 목표가 아니다. 다음 호출 전에 누적 비용을 확인하고 한도 접근 시 중단한다. 불명확한 비용을 0으로 기록하지 않는다. JEV는 개별 배정 전이므로 시작하지 않는다.

재개 조건: 부모의 검증된 최종 후보 commit/tree·원격 파일, 독립 SOURCE 결과, 공통 Claude 모델/추론·성공한 API 인증 절차, 선행 검사·profile qualification·비용 기록 설정을 받은 후 G0 결속 확인. 실제 queue 구현/명세·ACK·재시도·중복 제거 경계는 아직 없다. 이는 원래 보류 동작을 관측할 조건이며 구현을 만들어 채우지 않는다.

게시 범위는 기존 `evidence` 브랜치의 `evidence/ags-2.9.1/2026-10-09/claude-cases/SS14/prep-20261009T073944Z-b78f23ac/` 아래 정제된 보고서·근거·해시 목록뿐이다. 제품 코드·생성 배포물·다른 작업 경로를 수정하지 않는다. 이 보고서는 준비 결과이며 실제 시험 PASS·독립 감사·릴리스 승인 근거가 아니다.
