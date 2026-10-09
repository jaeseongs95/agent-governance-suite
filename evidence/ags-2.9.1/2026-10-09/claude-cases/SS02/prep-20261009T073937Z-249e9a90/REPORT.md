# SS02 — 영어 단일 코드 수정

상태: **PREPARED_WAITING_FOR_PARENT**. 실제 Claude Code 제품 시험은 **NOTRUN**이며 PASS를 주장하지 않는다.

원래 입력(117 UTF-8 bytes, 끝 개행 없음):

> Simplify this function so it returns the largest integer using the standard library. No database work or code review.

고정 입력 근거는 evidence commit `af579e2caa8c09b380bdf88b5e9c675b0b0b9c68`의 `cases/SS02/`이다. Prompt SHA256은 `d1471f31cebd10f45bb7deed9d54178683dbb7fc1378d54d321acd7ff1c64374`, case SHA256은 `d97b9e323f8bbb9445bda0029d3f85543bf7b3d75c2e38f7111d4c3c08d3c3ee`다. SHA256SUMS 대상 14개 모두 일치했고 manifest publicFiles 13개의 byte count와 SHA256도 일치했다. 별도 해시 목록과 JSON에 Git blob 및 전체 파일 해시를 보존했다.

기존 fixture SHA256 `17ade7e27cc11ffee8cc0b7b2070785617861d4c3384448cf24fce75f40d87e9`, 동결 oracle SHA256 `5db1d67cef8719c40b17b0ab07003f01f765746d34ced0b326e59fadb2efe055`를 읽기 전용으로 독립 재계산했다. 원래 oracle에 연결된 SKILL.md 8개를 읽고 digest 모두 확인했다. 과거 `c6a8019be30e4bf5ee9a36147ca45ae28b0f75b6`는 이 입력 provenance 대조에만 사용했고 시험하지 않았다. 로컬 AGENTS.md도 읽었다. evidence의 해당 상위 경로에는 AGENTS.md가 없고, .agents/skills도 없어 저장소의 원래 스킬 경로를 사용했다.

기대 결과는 required={ponytail}, allowed={}, forbidden={cs-engineering, code-review, software-security-auditor, orchestrator}이다. notApplicable와 unadjudicated 목록도 JSON에 원래대로 보존했다. 별칭 P를 canonical ID로 바꾸어 정답 처리하거나 unadjudicated 추가를 자동 PASS 처리하지 않는다. SS01과 SS02는 integer-max family의 언어 쌍이며 분할하지 않는다. 문장 유사도 점수를 확률로 출력하면 안 된다. SS01의 상속 보류조건은 대상 코드가 없어도 요청 유형의 ponytail 필요성을 유지하고 구현만 보류하는 것이다. 외부 TEST-SPEC 원본과 E0 정의는 없으며 창작하지 않았다.

기존 결과는 offline-mock 17개, 15 PASS / 2 FAIL, exit 1이다. known-cost-invalid-response 및 host-membership-supply-gap 실패를 보존한다. 이 실패는 이전 후보의 관측이며 R17의 결과가 아니다. 실제 selected/read/applied/verified는 전부 NOTRUN이고 skillIds 및 hostReceipt는 null이다. 기존 plan READY와 synthetic raw PASS는 실호스트 선택·모델 정확도·제품 PASS를 증명하지 않는다. 준비 단계에서 기존 테스트를 재실행하지 않았다.

Claude CLI를 `/workspace/cloud-tools/claude/node_modules/.bin/claude`에서 `2.1.286 (Claude Code)`으로 재확인했다. PATH에는 없다. 실행한 CLI 명령은 로컬 `--version`, `--help`뿐이며 인증/API 사전 호출은 하지 않았다. help의 --bare는 플러그인 hook을 생략하므로 이 옵션을 무조건 공통 인증 해법으로 채택하지 않는다. 영구 인증 설정·권한·네트워크 정책 변경은 없다.

현재 보고된 후보 R17 `fa1e250c1cbc4f8f446f2e2ddeb516f4e439edbb` / tree `43d2b4e49cdb6993c48d7adc792a3ef17426092e`의 독립 SOURCE 판정과 원격 고정은 부모 확인을 기다린다. 이전 main이나 c6a8019를 대신 실행하지 않았다. 공통 Claude 모델·effort·API 인증·가격·재시도 설정과 선행 검사 결과도 대기 중이다.

재개 후 Sol은 검증된 후보와 격리된 설치·설정을 고정하고, Claude가 실제 호스트에서 inventory → classify → canonical 선택 → record를 수행해야 한다. host-owned hook과 actor/session/task 결속을 확인하고 caller-made receipt를 허용하지 않는다. Claude의 실제 ponytail 읽기·적용·검증은 별개 단계로 기록한다. 원래 함수/코드 대상이 없으므로 적용·검증은 현재 BLOCKED이며 임의 예제 함수를 만들어 통과시키지 않는다. 동결 oracle과 기대 집합은 모델 입력에서 분리한다. 언어 일치의 live 판정은 실제 SS01 근거가 오기 전까지 NOTRUN이다.

API 소프트 예산은 준비 호출 포함 US$2다. 이번 준비의 유료 호출·토큰·캐시·재시도·실패 호출·지출은 모두 0이다. 이후 매 호출의 비용·토큰·캐시·실패 및 예약 비용을 기록하며 불명 비용을 0으로 처리하지 않는다. 한도 접근 시 다음 호출을 멈춘다. JEV 배정 전 호출은 금지된다.

게시 범위는 `evidence` 브랜치의 `evidence/ags-2.9.1/2026-10-09/claude-cases/SS02/prep-20261009T073937Z-249e9a90/` 아래 정제된 이 보고서·근거 JSON·SHA256SUMS 세 파일만이다. 새 파일 추가만 사용하고 제품 코드·생성 배포물·기존 결과·다른 작업 파일은 수정하지 않는다. 범위/위험 지침을 읽어 기존 명시적 게시 권한, 고유 경로 부재, 추가 파일만의 영향과 복구용 이전 commit을 대조했다. 별도 formal skill receipt나 독립 감사 PASS는 발급하지 않았다. 게시 후 최종 고정 원격 commit의 세 파일을 다시 받아 byte/hash를 검증한다.
