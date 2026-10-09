# SS20 — vendor adapter의 JEV 분리

상태: **준비 완료 / 부모 입력 대기**. 실제 Claude Code 제품 시험·API 인증 시험·호스트 선택/적용/검증은 **NOT_RUN**이며 PASS를 주장하지 않는다. 유료 호출 0, JEV 호출 0, 소비 US$0.00 / 사례 소프트 예산 US$2.00.

고정 입력 근거: evidence commit `af579e2caa8c09b380bdf88b5e9c675b0b0b9c68`, `evidence/ags-2.9.1/2026-10-09/cases/SS20/`. 17개 공개 payload/manifest의 SHA256SUMS가 모두 일치했다. 공개 원문 입력은 SS20이 지정한 SS03 benchmark 문자열 220 UTF-8 bytes(추가 개행 없음), SHA256 `3dd99a26ff73a9e8b8a933ec3ac9f67845003f0910fa3c0d56978e0a6d55a972`이다. [원래 입력](https://github.com/jaeseongs95/agent-governance-suite/blob/af579e2caa8c09b380bdf88b5e9c675b0b0b9c68/evidence/ags-2.9.1/2026-10-09/cases/SS20/inputs/original-prompt.utf8.txt)과 [내장 판정 기준](https://github.com/jaeseongs95/agent-governance-suite/blob/af579e2caa8c09b380bdf88b5e9c675b0b0b9c68/evidence/ags-2.9.1/2026-10-09/cases/SS20/inputs/SS20.embedded-source.json)을 사용한다. SS20 originalPrompt/semantic oracle은 null이며 TEST-SPEC 원문은 없다. 전체 비공개 fixture/oracle 원본의 해시는 선언된 고정 해시로 보존했고 이번에 독립 재해시한 것으로 주장하지 않는다.

기대 결과는 JEV OFF와 승인된 vendor profile로 정상 분류 1회, JEV 키 조회/호출 0회, 실제 model/effort와 중앙 profile의 일치, 공통 RESP와 별도의 실제 AGENT 최종 선택 확인이다. 정상 P·CS·T·O 분류 지원, 실패 세 변형의 구체적 보류 사유, 자동 모델/벤더/reasoning 상향 및 JEV 재활성화 금지를 유지한다. mock 정상 모델 문자열은 live 모델 승인의 대용이 아니다. 미지원 응답의 judgments=[]는 selected=[]가 아니다.

기존 c6a8019 결과는 오프라인 필수 변형 4/4 PASS, 표적 파일 11 PASS / 2 FAIL(exit 1), 기존 회귀 2 PASS / 61 skipped이다. 유효 비용 0.70이 잘못된 RESP와 함께 유실되는 결함과 timer overflow 결함은 기존 실패 기록이며 기대값을 바꾸지 않는다. 기존 selected/read/applied/verified는 NOTRUN, receipt/선택은 null이다. 새 후보 시험·수정 후 green·실제 호스트 PASS 근거로 재사용하지 않는다.

현재 로컬 CLI는 `/workspace/cloud-tools/claude/node_modules/.bin/claude`, **2.1.286 (Claude Code)**이며 PATH에서는 발견되지 않았다. --version과 --help만 실행했다. API 인증, 연결, 키 유효성은 시험하지 않았다. Node v24.19.0, Git 2.52.0. AGENTS.md와 관련 SKILL.md 및 .agents fallback을 읽었다. 지침 checkout 56fef8b는 준비 지침 출처일 뿐 최종 후보가 아니다.

후보 R17 `fa1e250c1cbc4f8f446f2e2ddeb516f4e439edbb` / tree `43d2b4e49cdb6993c48d7adc792a3ef17426092e`는 전달받은 제안이며 독립 SOURCE 판정·원격 게시를 아직 확인하지 않았다. 부모의 검증된 후보, 공통 Claude 모델/effort·성공한 API 인증 절차, 선행 검사 결과를 기다린다. 승인 profile/route/qualification/현재 budget과 실제 호스트 signed receipt 관측 경로가 없으면 보류한다. JEV 호출은 별도 배정 전까지 0이다.

실제 Claude는 고정 입력으로 inventory→classify→독립 선택→receipt, 스킬 읽기/적용/검증을 직접 수행해야 한다. session-handoff 작업은 제품을 변경하지 않는 격리 합성 작업 공간에서 수행한다. 세 중단/중복 조건의 회귀 근거를 남긴다. 구체 단계와 변형 기대값은 execution-plan.json, 원래 기준·해시는 source-provenance.json, 현재 상태는 preparation.json, 비용은 cost-ledger.json에 있다. 실행 argv와 인증은 부모 입력 전까지 미설정이다.

게시 범위는 이 고유 SS20 run 경로의 정제된 보고서·근거·해시 목록뿐이다. 제품/생성 배포물·기존 작업 파일·영구 인증·권한·네트워크 정책은 변경하지 않았다. 비밀값이나 인증 placeholder, 개인정보, 원본 채팅은 포함하지 않았다. 원격 게시 및 고정 commit 재읽기 검증의 결과는 게시자가 별도로 보고한다.
