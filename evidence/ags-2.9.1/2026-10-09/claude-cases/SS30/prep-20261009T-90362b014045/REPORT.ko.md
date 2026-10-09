# SS30 — 모델과 API 실패 분류

상태: **준비 완료 / 후보·공통 실행 설정 대기**. 제품 시험과 실제 Claude Code 시험은 **NOTRUN**이며 PASS가 아니다. 새 테스트·과거 시험 재실행·Claude API·JEV 호출은 모두 0회, 소비 비용은 US$0이다.

고정 입력은 `af579e2caa8c09b380bdf88b5e9c675b0b0b9c68`의 `evidence/ags-2.9.1/2026-10-09/cases/SS30/`에서 읽었다. `inputs/source.SS30.json` SHA-256은 `73c7cf4024f55cdf22823c086aa1c457f03b554ff47e62836acc57d585cbc588`이다. 공개 SHA256SUMS 24개 항목과 manifest 23개 항목의 바이트·해시가 전부 일치했다. 상세 결과는 `source-hash-verification.json`에 있다. embedded source bodyDigest는 `sha256:5c11db9b4720ae8be49fd34de54a5a85af0851f44d78623b28eb31d30de6c304`로 기록되어 있으나 누락된 원 TEST-SPEC 문서 자체를 다시 해시한 것으로 주장하지 않는다. 공개 derivative와 원본 provenance 해시는 서로 구분했다.

원래 입력은 401/403, 5xx, 연결 전 실패, 모델 거절·빈 응답, malformed JSON, 필수 질문 일부 누락의 개별 주입이다. 인증·서버 불가는 UNAVAILABLE/error, 구조 불량은 INVALID/error, 의미 미확정은 PARTIAL 또는 UNCERTAIN/unresolvedItems로 매핑해야 한다. attempt 진단과 공통 RESP의 error/unresolvedItems가 결속해야 하며 B를 보존하고 B의 실패와 AGENT의 S를 따로 판정한다. HTTP 200의 의미 PASS 오인, refusal/empty의 no-skill 은폐, 정책 밖 vendor·미승인 경로 전환은 금지다. 명시된 JEV 실패→사용자 vendor fallback은 별도 attempt로 기록한다. 정확한 원래 문구와 각 synthetic probe의 기대값은 `inputs/source.SS30.json`과 `expectations.json`에 보존했다.

기존 결과는 과거 후보 `c6a8019be30e4bf5ee9a36147ca45ae28b0f75b6` / tree `28f2f2ed8a864405320f6d20e7bc5004e8466ad3`의 **FAIL**이다. 기존 회귀는 7 PASS·56 skipped, 새 오프라인 검사는 21개 중 19 PASS·2 FAIL이었다. 유효 비용 유실과 uncertain/unresolvedItems 결속 누락이 기록되어 있다. host-live 및 selected/read/applied/verified는 NOTRUN, sensitivity proof는 NOTRUN/INCOMPLETE다. 이 결과는 현재 후보의 판정이나 정답이 아니다. 기존 실패를 허용하도록 기준을 바꾸지 않았다. originalPrompt와 oracle는 null이고 TEST-SPEC.seq7.ko.md는 공개 패키지에 없다. semantic golden과 정확도 점수를 만들지 않는다.

실제 환경에서 `/workspace/cloud-tools/claude/node_modules/.bin/claude --version`은 exit 0 및 `2.1.286 (Claude Code)`를 반환했다. PATH 탐색에서는 발견되지 않았지만 지정 경로의 CLI는 존재한다. Node는 v24.19.0이다. `--help`만 추가로 읽었으며 인증 또는 모델 API를 실행하지 않았다. CLI receipt와 실행 파일 해시는 `cli-inspection.json`에 있다. repository AGENTS.md와 관련 SKILL.md를 읽었고 repo·workspace `.agents/skills`가 모두 없는 것을 확인했다. 준비자가 읽은 지침은 SS30 Claude 대상 호스트의 read 증거로 계산하지 않았다.

현재 전달된 R17 후보는 `fa1e250c1cbc4f8f446f2e2ddeb516f4e439edbb` / tree `43d2b4e49cdb6993c48d7adc792a3ef17426092e`이며 로컬 고정 보고만 있다. 독립 SOURCE 판정·고정 원격 게시가 확인되지 않았으므로 설치·시험하지 않았다. 부모가 검증된 최종 후보, 공통 모델·effort·성공한 API 인증 방식, 선행 검사 결과 및 실행 재개 지시를 보내야 진행한다. 원래 mock 입력을 실제 Claude가 수행할 절차, 별도의 AGENT S/receipt 조건, 누락 context 처리와 비용 중단 규칙은 `claude-host-procedure.md`에 있다. 인증·권한·네트워크의 영구 설정 및 제품 코드·생성 배포물은 변경하지 않았다.

산출물은 이 고유 경로의 보고서·정제 근거·해시 목록뿐이다: `evidence/ags-2.9.1/2026-10-09/claude-cases/SS30/prep-20261009T-90362b014045/`. `cost-ledger.json`은 준비 호출을 포함한 SS30 US$2 소프트 한도를 추적하며 현재 모든 API·토큰·캐시·재시도·실패 호출 카운터는 0이다. 원격 게시와 고정 commit 바이트 재검증은 게시 후 별도 확인하며 그 결과도 제품 시험 PASS를 뜻하지 않는다.
