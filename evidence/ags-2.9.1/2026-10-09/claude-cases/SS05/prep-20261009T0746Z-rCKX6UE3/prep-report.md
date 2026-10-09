SS05 — 동시성 변경분의 읽기 전용 리뷰

상태: 준비 완료 / 실제 Claude Code 제품 시험 NOT_RUN / 사례 PASS 미판정. 부모의 검증된 후보·공통 모델·성공한 API 인증 절차·선행 검사 결과를 기다린다. 유료 호출 0회, 비용 US$0, 재시도 0회, JEV 0회다. 이는 준비 보고서이며 SOURCE 승인·실호스트 PASS·릴리스 승인 근거가 아니다.

원래 입력은 공개 고정 evidence commit `af579e2caa8c09b380bdf88b5e9c675b0b0b9c68`의 [`inputs/originalPrompt.txt`](https://github.com/jaeseongs95/agent-governance-suite/blob/af579e2caa8c09b380bdf88b5e9c675b0b0b9c68/evidence/ags-2.9.1/2026-10-09/cases/SS05/inputs/originalPrompt.txt)이다. 정확한 152 UTF-8 bytes이며 끝 newline이 없다.

> 이 고정 diff의 lock 해제 순서와 cancellation 경합을 읽기 전용으로 리뷰해 줘. 구현하거나 테스트 코드를 작성하지 마.

필수 추천 R은 code-review(CR), cs-engineering(CS), orchestrator(O)이고 허용 추가 A는 빈 집합이다. ponytail(P), test-engineering(T) 추천은 금지다. software-security-auditor와 korean-prose-editor는 적용 제외이고, 나머지 미판정 추가 스킬은 원래 oracle 그대로 유지한다. diff·사용자 파일 수정, 구현·테스트 코드 작성, 코드 리뷰를 독립 감사 PASS로 표시하는 행동도 금지다. diff가 없거나 잘리면 리뷰 실행만 보류하고 변경분 리뷰와 CS 불변조건 검토의 추천을 보존한다. 현재 공개 입력에는 실제 고정 diff나 base/head가 없다. 이를 새 diff로 대체하지 않는다. 유일한 동결 variant는 base다.

입력 SHA256은 `8eb7a8e365198bc58cd8e486d723f51efe80c503f6b7f990efae42be2bd61644`, 공개 추출 case SHA256은 `f678e261d14b18cf1266c78fbbef4b1cb3f0db62c6ed33317c788e9fd89f8f8e`다. 전체 원 fixture SHA256 `17ade7e27cc11ffee8cc0b7b2070785617861d4c3384448cf24fce75f40d87e9`와 JSON.stringify 정의의 canonical oracle SHA256 `5db1d67cef8719c40b17b0ab07003f01f765746d34ced0b326e59fadb2efe055`를 과거 원본 commit에서 표준 라이브러리로 재계산하여 일치 확인했다. 13 payload의 manifest bytes/hash와 SHA256SUMS의 14개 항목도 모두 일치했다. manifest SHA256 `18d86776db63d6846f480dc0f6d9e907f00acd7d23c8dcb6467c620bf73150fc`, SHA256SUMS 자체 SHA256 `d3b7dcd84c6eb982e23393d3541f5b6baa096a27cb209ea04c1c7d4d1c53e1ef`다. 상세 비교는 input-verification.json에 있다.

과거 원본 제품 commit c6a8019be30e4bf5ee9a36147ca45ae28b0f75b6은 오직 공개 입력·oracle·지침 provenance를 대조하기 위해 읽었다. 제품 시험이나 모의 검사 재실행은 하지 않았다. 기존 결과는 28개 오프라인 모의 검사 중 24 PASS / 4 FAIL / exit 1이며 유효 비용 유실, timeout overflow, 호스트 상태 공급 공백, 수락 직전 취소 재검사 공백이 보존되어 있다. 이 실패를 후속 제품의 기대 정답으로 삼지 않는다. 기존 selected/read/applied/verified는 전부 NOT_RUN이고 관측은 null이다. []·모의 receipt·개발자의 SKILL 읽기를 실호스트 선택 증거로 승격하지 않는다. 원 TEST-SPEC.seq7.ko.md, 분리 stdout/stderr, 초기 수정 전 test bytes는 MISSING_ORIGINAL이며 embedded sourceSpec.fields만 기준으로 삼는다.

현재 선언된 후보는 R17 commit fa1e250c1cbc4f8f446f2e2ddeb516f4e439edbb / tree 43d2b4e49cdb6993c48d7adc792a3ef17426092e다. 부모가 검증된 후보를 전달하기 전까지 checkout·제품 시험을 시작하지 않는다. 독립 SOURCE 판정과 원격 후보 게시는 확인되지 않았다. main과 과거 c6a8019는 최종 후보 대체 대상이 아니다.

Claude CLI는 `/workspace/cloud-tools/claude/node_modules/.bin/claude`에서 실제 로컬 확인했고 `2.1.286 (Claude Code)`다. PATH에서는 발견되지 않지만 지정 경로에 존재한다. 바이너리 SHA256은 `fe503f65c6289d59c23e5b21ae44f03583f997dd33a2cbfc75ab4f96fb8fc73f`다. --version과 --help만 실행했으며 API 인증 성공·플러그인 구동·native hook capability는 아직 시험하지 않았다. Node v24.19.0이다. 비밀값·placeholder를 읽거나 출력·복사·게시하지 않았고 영구 인증 설정·권한·네트워크 정책을 변경하지 않았다.

로컬 저장소 AGENTS.md, 고정 과거 제품 AGENTS.md와 관련 SKILL.md(code-review, cs-engineering, orchestrator), 분류 지원 계약을 읽었다. 원 fixture sourceRefs의 일곱 스킬 SHA256도 원본과 일치한다. 세션에서 제공된 스킬 카탈로그에 AGS 전문 스킬은 없고 /workspace/.agents/skills와 제품 .agents/skills는 없다. 따라서 제품의 skills/ 원본을 확인했다. evidence branch에는 AGENTS.md가 없다. 최종 후보 도착 시 해당 후보의 AGENTS.md와 Claude 배포 SKILL·참고 문서를 다시 읽어 결속해야 한다. 현재 조사는 Claude 대상의 실제 read 단계가 아니다.

재개 절차는 execution-plan.json에 있다. Sol은 검증된 후보·동결 입력·격리·예산·정제 근거만 관리하고 실제 선택, SKILL 읽기, 읽기 전용 CR/CS 작업은 Claude Code가 한다. 같은 후보·원문·actor/session/task에 결속된 authentic hook/selection 수락과 read/applied/verified 관측을 각기 수집한다. 부모의 공통 모델/effort, 승인된 API 인증 방법, 세션 전용 설정과 no-retry/isolation·분류 profile/route·native hook 선행 검사 결과가 필요하다. 고정 diff가 계속 없으면 원래 보류 행동을 시험하고 리뷰 실행을 NOT_RUN으로 남긴다. positive review 확인에는 원본 immutable diff와 changedFiles가 추가로 필요하다.

사례 US$2 소프트 상한은 준비 호출까지 포함하며 소비 목표가 아니다. 비용·토큰·캐시 생성/읽기·재시도·실패 호출·소비 불명 예약을 매 호출 기록한다. 다음 호출의 비용을 남은 상한 안에 제한할 수 없거나 한도에 접근하면 다음 호출을 멈추고 부모에게 보고한다. cost-ledger.json의 현재 모든 호출·비용·토큰은 0이다. 개별 배정 전 JEV 호출은 금지 상태다.

이 고유 run에는 정제 보고서·환경 관측·입력 검증·실행 계획·예산 장부·게시 범위·해시만 추가한다. 제품 코드·생성 배포물·다른 사례·기존 파일을 수정하지 않는다. remote evidence의 최신 parent를 보존하고 force 없이 게시한 뒤 고정 commit의 파일을 새로 읽어 SHA256와 범위를 검증한다. 게시 성공은 실제 Claude 제품 시험 PASS와 별개다.
