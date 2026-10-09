# SS23 — AGENT 최종 선택과 추천 강제 주입 금지

준비 상태: **PREPARED_WAITING_PARENT**. 실제 Claude 제품 시험: **NOTRUN**. PASS 판정 없음.

원래 입력은 공개 `SS23.input.txt`의 “endpoint 최소 구현과 회귀 테스트 설계, 보안 감사, CS 불변조건 검토를 연결해 줘”이다. UTF-8 105 bytes, SHA256 `b390c3ba30b1f1cb30bd35fda0d2e0e7220aa0aa61332f0eba927e1e7e98737a`이며 끝 개행을 추가하지 않는다. 이는 기존 embedded originalPrompt 추출본이고 provider wire capture가 아니다.

입력 권위는 evidence commit `af579e2caa8c09b380bdf88b5e9c675b0b0b9c68`의 `cases/SS23/SS23.source.json`과 원래 내장 sourceSpec.fields이다. 정확한 제목과 원래 기준을 보존했다. 공개 manifest payload 25개와 SHA256SUMS 26개 항목 모두 일치했고 입력이 originalPrompt UTF-8과 일치했다. 상세 파일 bytes/SHA256/Git blob은 `input-evidence.json`에 있다. `TEST-SPEC.seq7.ko.md`, 원래 provider wire, full saved force-copy request 및 실제 호스트 근거가 없는 점은 그대로 유지한다.

기대 집합 S={ponytail, cs-engineering, software-security-auditor, test-engineering, orchestrator}, 제외 K=korean-prose-editor. explicit={CS}, rules={SEC}, 검증 advice={P,T,O}, mode=select, ON+JEV 정상이라는 원래 조건을 보존한다. 실제 JEV 통합은 provider-live로 별도 구분하며 배정 전 호출하지 않는다. 부모가 승인한 mock advice로 host-live를 진행할 경우 mock임을 명시한다. oracle와 semanticAccuracyScore는 null이다.

Claude가 실제 목적·적용·제외 조건으로 선택하고 raw·explicit·rule 출처와 근거를 기록해야 한다. K의 자동 union, 추천 receipt의 선택 receipt 복사, 선택을 read/apply/approval로 간주하는 행동은 금지된다. 필요 SEC의 실행 권한이 없더라도 needed에서 제거하지 않는다. 같은 ID는 한 번 선택하되 모든 출처를 보존한다. 미해결 필수 충돌은 NEEDS_INPUT, 독립적으로 수락된 부분은 PARTIAL로 구분한다. optional K 불확실성만으로 전체를 보류하지 않는다. 최종 S 강제 복사 음성대조는 구조 검사가 수락해도 behavioral FAIL이다.

기존 결과는 이전 후보 `c6a8019be30e4bf5ee9a36147ca45ae28b0f75b6`에 대한 `FAIL_BOUNDARY_AND_HOST_NOTRUN`이다. 변형/계약 7 PASS, 표적 회귀 6 PASS/58 skipped, 취소 경합 1 FAIL이었다. 전부 offline synthetic host receipt이며 실제 selected/read/applied/verified는 NOTRUN, 실제 선택은 null이다. 이전 경합 실패를 R17에 그대로 전이하거나 기대값으로 바꾸지 않는다. 이번에는 재실행하지 않았다.

대기 중 제품 후보는 R17 commit `fa1e250c1cbc4f8f446f2e2ddeb516f4e439edbb`, tree `43d2b4e49cdb6993c48d7adc792a3ef17426092e`이다. 이는 전달된 후보 기대값이며 검증된 최종 후보로 선언하지 않는다. 독립 SOURCE 판정과 고정 원격 게시 확인, 공통 Claude 모델·effort·설정, 선행 검사 결과, 성공한 공통 API 인증 절차를 부모에게 받은 뒤 재개한다. 이전 main 또는 c6a8019를 대신 시험하지 않는다.

지정 Claude CLI `/workspace/cloud-tools/claude/node_modules/.bin/claude`에서 `2.1.286 (Claude Code)`을 로컬 확인했다. PATH lookup은 실패했지만 지정 경로의 CLI가 존재한다. Node v24.19.0, pnpm 11.19.0이다. 버전/도움말 조회만 수행했다. API 인증 성공은 미확인이다. 준비 시 AGS classification config/host-attestation 환경은 관측되지 않았다. 키는 존재 여부만 확인했고 값은 읽거나 출력·복사·게시하지 않았다. 영구 인증, 권한, 네트워크 정책은 변경하지 않았다.

현재 workspace의 AGENTS.md와 관련 SKILL.md·test-design/test-proof/CLI를 읽었다. 카탈로그에 없는 저장소 스킬을 로컬 skills에서 확인했고 workspace/repository `.agents/skills`는 없었다. 이 지침 소스는 준비용 기존 checkout이며 최종 후보가 아니다. 재개 시 검증된 후보 지침과 Claude overlay/생성물의 해시를 다시 확인한다. evidence 전용 checkout에는 AGENTS 파일이 없다.

`resume-plan.json`에 변형별 기대 결과, 실제 Claude 확인 순서와 필요한 host configuration을 정리했다. Sol의 읽기는 Claude의 read 단계가 아니다. Claude가 승인된 isolated fixture에서 직접 호스트 작업을 수행해야 하며 genuine exact-call hook과 실제 후속 산출물이 있어야 한다. 제품 코드와 생성 배포물 변경, 합성 호스트 근거 발급, 판정 기준 수정은 하지 않는다.

준비 API 호출 0회, 비용 US$0, 토큰·캐시·재시도·실패 호출 0회. 사례 소프트 예산 US$2는 준비 호출 포함이며 소비 목표가 아니다. JEV는 배정 전이어서 호출하지 않았다. 이후 모든 시도와 실패·재시도·캐시를 기록하고 한도 접근 또는 비용 불명확 시 다음 호출을 멈춘다.

이 run은 정제된 준비 보고서·관측 메타데이터·해시 목록만 추가한다. 원본 대화, 키, 개인 정보, 제품 코드 또는 생성 배포물은 포함하지 않는다. 게시 commit과 고정 원격 재읽기 검증은 최종 응답에서 별도로 보고한다.
