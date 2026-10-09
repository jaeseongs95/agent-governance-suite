SS19 — JEV OFF에서도 벤더 분류 계속

준비 완료, 부모의 검증 후보·공통 Claude 설정·선행 검사 결과를 기다리는 상태다. 실제 제품 시험과 Claude 추론/API 호출은 NOTRUN이며 US$0, 0 tokens, 재시도 0이다. 준비 완료는 실제 시험 PASS를 뜻하지 않는다.

고정 입력 근거: [원래 SS19 공개 자료](https://github.com/jaeseongs95/agent-governance-suite/tree/af579e2caa8c09b380bdf88b5e9c675b0b0b9c68/evidence/ags-2.9.1/2026-10-09/cases/SS19) (commit `af579e2caa8c09b380bdf88b5e9c675b0b0b9c68`). SHA256SUMS의 29개 파일과 manifest의 28개 payload가 모두 일치하고, 네 prompt의 UTF-8 bytes와 frozen fixture가 일치한다. oracle digest는 역사적 digest recipe만 읽어 로컬 무결성 계산으로 재확인했다. 원래 외부 TEST-SPEC 문서는 MISSING_ORIGINAL이고 sourceSpec body digest는 기록된 값으로만 보존한다. 입력·판정 기준은 expectations.json, 모든 근거의 해시는 source-hashes.json에 있다.

fixture SHA256: `17ade7e27cc11ffee8cc0b7b2070785617861d4c3384448cf24fce75f40d87e9`
oracle digest: `sha256:5db1d67cef8719c40b17b0ab07003f01f765746d34ced0b326e59fadb2efe055`

SS19 자체 originalPrompt와 oracle은 null이다. SS03·SS04·SS09·SS10은 SS19의 네 subinput이며 각각 독립 사례 시험으로 집계하지 않는다. jevEnabled=false에서 허용된 현재 벤더의 고정 qualified 모델 분류와 실제 B 선택을 확인해야 한다. 허용 변형은 vendor 실제 분류 시도 수와 receipt를 확인하고, 차단/no-native 변형은 두 remote classifier 경로와 JEV credential lookup 모두 0을 요구한다. SS09의 성공 no-skill []와 미실행/보류 null을 구별한다.

원래 기대 결과: SS03은 ponytail·cs-engineering·test-engineering·orchestrator, SS04는 cs-engineering·test-engineering·orchestrator (구체 코드 설계에는 ponytail 허용), SS09는 전문 스킬 없음, SS10은 code-review만 추천하고 구현/보안 감사 제외. 상세 frozen 허용·금지·미판정 집합을 그대로 보존한다. 외부 전송 금지를 fallback으로 우회하거나 JEV OFF를 모든 분류 중단으로 해석하면 안 된다.

기존 결과는 historical-results.json에 보존했다: 과거 c6a8019 후보의 final mock 14 PASS / 3 FAIL, 변형 8/8과 hold 6/6 mock PASS, 기존 regression 1 PASS / 39 skipped. 알려진 세 실패는 invalid RESP에서 유효 비용 유실, timeout overflow, pre-dispatch 재검사 공백이다. 실패는 정답으로 승격하지 않는다. 실제 selected/read/applied/verified 및 provider semantic quality는 NOTRUN, hostReceipt와 selection은 null, whole-case PASS 없음, sensitivity proof INCOMPLETE다. 이 턴에서는 과거 제품을 재시험하지 않았다.

CLI는 명시적 알려진 설치 위치에서 다시 확인했고 `2.1.286 (Claude Code)`였다. --version/--help만 실행했다. 이는 API 인증·profile qualification·plugin 로딩·호스트 선택 성공 근거가 아니다. 로컬 main의 AGENTS.md와 관련 skills/ 지침을 준비용으로 읽었고 .agents/skills는 없었다. 후보 전용 지침은 R17 검증 handoff 뒤에 다시 확인해야 한다. 인증 설정·권한·네트워크 정책 변경과 비밀값 조회·출력은 하지 않았다.

현재 대기 후보는 R17 `fa1e250c1cbc4f8f446f2e2ddeb516f4e439edbb` / tree `43d2b4e49cdb6993c48d7adc792a3ef17426092e`. 부모가 보고한 로컬 고정 상태만 있으며 독립 SOURCE와 원격 후보 게시를 아직 확인하지 않았다. 부모의 공통 모델·effort·API 인증 절차·MCP/plugin 설정, qualified profile/route/지원 옵션·가격 상한, 선행 검사 결과가 필요하다. SS10의 실제 patch bytes도 원래 공개 subinput에 없어 실제 리뷰는 별도 보류다. 이전 main 또는 c6a8019를 최종 후보 대신 시험하지 않는다.

실제 Claude가 확인할 단계와 재개 조건은 procedure.md와 preparation.json에 있다. Sol은 환경·근거를 관리하고 Claude가 실제 선택·읽기·적용·검증을 수행한다. judge의 goldens와 과거 mock 결과를 Claude classifier 입력에 넣지 않는다. 사례 soft budget US$2에는 host·classifier·준비 호출, 토큰·캐시·실패·재시도 모두 포함하며 접근 시 다음 호출을 멈춘다. JEV 호출은 별도 배정 전이므로 금지 상태다.

이 run은 `evidence/ags-2.9.1/2026-10-09/claude-cases/SS19/prep-20261009T074251Z-8b442ab3549f`에 새 파일만 추가한다. 제품 코드·생성 배포물·원래 evidence는 수정하지 않는다. 게시 commit과 고정 원격 파일 재읽기 결과는 완료 handoff에 별도로 제공한다.
