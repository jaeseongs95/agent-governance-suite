# SS07 — 보안 감사만 요청

상태: **준비 완료, 부모 검증·설정 대기**. 실제 Claude 제품 시험 **NOTRUN**, PASS 판정 없음. 모델 API/JEV 호출 0, 비용 US$0/사례 소프트 한도 US$2.

입력 근거는 evidence commit `af579e2caa8c09b380bdf88b5e9c675b0b0b9c68`의 `evidence/ags-2.9.1/2026-10-09/cases/SS07/`이다. 원래 제목은 「보안 감사만 요청」, variant는 `base` 하나다. 원문은 다음 공개 fixture 입력이다.

> 고정된 CLI·MCP 소스와 설정에서 경로 traversal과 권한 검사 누락을 보안 감사해 줘. 읽기 전용이며 수정과 운영 서비스 능동 검사는 금지야.

원문 UTF8는 추가 newline 없는 182 bytes, SHA256 `556baefc0f9e03dcdb8c46a363b7d226412aed14071c71d634be607c023242a5`다. fixture `b0180ab3048fb61245e3ed891b48d23041d0d2bccdf775a00167ae9d4be18b0b`, request `51c3cbd63e0162bb0cac02137a539b2cae0253043cb6b3afa8eb5c61bce47d73`, inventory `4b04dbe7f8825b50d7154fcd0b03c25fd333d30f3765ed5f9d3cc7c15a88c5f1`다. 전체 파일/bytes/SHA256/Git blob 목록은 `input-provenance.json`에 있다. SHA256SUMS 18개, manifest payload 17개와 역사적 source hash 19개는 모두 일치했다. request·fixture·prompt 파일 문자열도 일치했고 24개 inventory 및 unknown context의 null을 확인했다. `TEST-SPEC.seq7.ko.md` 원본은 MISSING_ORIGINAL이며 embedded sourceSpec만 사용했다. 누락 원본을 복원하거나 body digest의 독립 검증을 주장하지 않는다.

기대 결과: 필수 추천 R={SEC} (`software-security-auditor`), 추가 허용 A={}, 금지 추천/행동은 P·CR·독립 완료 감사 자동 추가, 운영 공격, 자동 수정, 릴리스 승인이다. SEC를 일반 리뷰로 대체하지 않고 조사 산출물과 안전 보장을 구분해야 한다. 대상 root/CLI·MCP·설정 파일과 고정 bytes/범위/권한 모델이 없으면 필요한 자료를 명시하고 감사 실행을 보류해야 한다. 대상 부재가 SEC 필요를 없애지 않는다. 원래 oracle의 `expectedSelection=SELECTED`와 required/forbidden/notApplicable/unadjudicated 구분을 유지한다.

과거 후보 `c6a8019be30e4bf5ee9a36147ca45ae28b0f75b6`의 격리 검사 16개는 13 PASS·3 FAIL(exit 1)이었다. metadata 적용/제외 조건 중복, invalid RESP의 유효 비용 유실, timeout overflow는 기존 결함 재현이며 정답이나 새 원인으로 승격하지 않는다. provider/host 및 selected/read/applied/verified는 모두 NOTRUN, 선택 집합·hostReceipt는 null이다. 합성 exact-SEC control은 Claude 선택 근거가 아니다. 공개 재현 테스트에는 과거 commit/tree assertion이 있으므로 R17에 그대로 실행해 생긴 provenance FAIL을 제품 결함으로 취급하지 않는다. 새 후보 결속은 부모의 검증된 계획을 받은 뒤 수행한다. 준비 중 재현·회귀·제품 실행은 0이다.

Claude CLI는 `/workspace/cloud-tools/claude/node_modules/.bin/claude`에서 `2.1.286 (Claude Code)`로 재확인했다. Node `v24.19.0`; PATH의 claude는 없어도 지정 실행 파일은 존재한다. 로컬 `--version`/`--help`만 실행했고 API 인증·모델 실행은 하지 않았다. `--plugin-dir`, `--model`, `--effort`, `--print`, `--output-format`, `--max-budget-usd`, `--include-hook-events` 등 옵션의 파싱 지원은 설치/활성/MCP/hook 동작의 증명이 아니다. 특히 `--bare`는 hooks를 생략하므로 사용 여부는 부모 공통 설정과 host 관측 요건에 맞춰야 한다. `claude-help.txt`와 `host-preflight.json`에 로컬 근거를 남겼다. 영구 인증·권한·네트워크 정책 변경 및 비밀값 접근·출력·복사·게시 없음.

AGENTS.md는 현재 workspace 제품 저장소와 역사적 고정 소스에서 읽었다. evidence commit 자체에는 root AGENTS.md가 없다. 카탈로그에 없는 관련 스킬을 찾기 위해 `/workspace/.agents/skills`와 제품 `.agents/skills`를 확인했으며 둘 다 부재였다. 역사적 저장소의 test-engineering와 test-design을 준비에 적용했고 SEC, ponytail, code-review, independent-audit-gate의 SKILL.md와 SEC entry-details를 사례 근거로 읽었다. 금지 스킬을 피시험 Claude의 추천에 주입하지 않는다. 제품 코드·생성 배포물·다른 작업 파일은 수정하지 않았다.

재개 후 실제 Claude에서 확인할 단계는 `resume-plan.json`에 있다. 원문을 그대로 주고 Claude가 SEC 추천·선택·스킬 읽기·자료 부족 판단을 수행해야 한다. Sol이 host 작업을 대신 수행하거나 선택 receipt를 합성하지 않는다. raw 추천, 실제 선택 집합, trusted task/candidate-bound receipt와 selected/read/applied/verified를 분리하고 미관측 단계는 NOTRUN으로 유지한다. 현재 대상 부재에서 감사 실행 보류가 올바른 행동이더라도 실제 감사 완료나 전체 단계 PASS를 만들지 않는다.

재개 조건: 부모가 검증된 최종 후보(commit/tree), 독립 SOURCE 판정과 고정 원격 게시 근거, 공통 Claude 모델/effort·성공한 API 인증 절차·격리/재시도/비용 설정 및 선행 검사 결과를 전달해야 한다. 보고된 R17 `fa1e250c1cbc4f8f446f2e2ddeb516f4e439edbb` / tree `43d2b4e49cdb6993c48d7adc792a3ef17426092e`는 아직 이 세션에서 검증하지 않았다. 이전 main이나 c6a8019로 제품 시험을 대체하지 않는다. JEV는 개별 배정 전이므로 호출하지 않는다. 모델 호출별 실패·재시도·토큰·cache·실제/unknown 비용을 포함하고 한도 접근 시 다음 호출을 멈춘다. 전체 39개 예약 US$78은 소비 목표가 아니다.

이 run은 공개 입력 대조와 CLI 확인의 준비 기록이다. 제품 판정은 NOTRUN이며 SOURCE 승인·원격 제품 게시·API 인증 성공을 주장하지 않는다.
