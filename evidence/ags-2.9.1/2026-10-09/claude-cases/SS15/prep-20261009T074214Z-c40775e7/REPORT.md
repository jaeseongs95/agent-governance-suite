# SS15 — 존재하지 않거나 사용할 수 없는 명시 스킬

준비 완료 · 부모 실행 조건 대기. 실제 Claude Code 제품 시험은 **NOTRUN**이며 PASS를 주장하지 않는다. 유료 API/JEV/재시도 호출 0, 비용 US$0, 사례 소프트 예산 US$2 전액 잔여.

고정 공개 입력은 commit `af579e2caa8c09b380bdf88b5e9c675b0b0b9c68`의 `evidence/ags-2.9.1/2026-10-09/cases/SS15/`다. SHA256SUMS의 24개 항목과 manifest payload 23개의 hash·bytes가 모두 일치했다. 원래 명세 파일 `TEST-SPEC.seq7.ko.md`는 공개 자료에 없으므로 embedded fields·oracle를 그대로 사용한다. 전체 과거 fixture·oracle digest는 기록값이며 이번에 원본 전체 bytes를 재검증했다고 주장하지 않는다. 상세 대조는 `source-integrity.json`에 있다.

| 변형 | 정확한 입력 | 기대 결과 |
| --- | --- | --- |
| typo | `$cs-enginering 으로 검토해 줘.` | NEEDS_INPUT, selected=null, 원문 unresolved reference와 unknown-explicit-skill 사유; 교정 후보는 질문만 허용 |
| disabled | `$cs-engineering 으로 검토해 줘.` + enabled=false | CS 필요 유지, runnable=[], blockedItems=DISABLED, admissionStatus=NOT_EVALUATED |
| unsupported | `$cs-engineering 으로 검토해 줘.` + hostSupported=false | CS 필요 유지, runnable=[], blockedItems=HOST_UNSUPPORTED, admissionStatus=NOT_EVALUATED |

모든 변형은 실행 승인·완료를 주장하지 않는다. 정확한 입력 bytes와 각 SHA256는 `inputs/`와 `variant-plan.json`에 고정했다. 잘못된 기존 결과를 정답으로 채택하거나 null을 []로 바꾸지 않는다.

기존 c6a8019 결과는 회귀 2 PASS/24 skipped, 격리 검사 17개 중 12 PASS/5 FAIL이며 오프라인 결론 FAIL이다. 첫 회귀 filter는 0건/26 skipped이므로 NOTRUN이다. 실제 selected/read/applied/verified는 모두 NOTRUN, 실제 선택·hostReceipt는 null이다. 합성 mock decision/receipt는 호스트 증거가 아니다. 기존 3 finding 중 신규 원인 2개와 기존 host 상태 공급 공백 1개를 보존하며 현재 R17에도 같은 결함이 있다고 단정하지 않는다.

Claude CLI는 `/workspace/cloud-tools/claude/node_modules/.bin/claude`에서 `2.1.286 (Claude Code)`으로 재확인했다. --version/--help만 실행했고 인증·추론 호출은 하지 않았다. CLI가 PATH에 없어도 설치되어 있다. 영구 인증 설정, 권한 및 네트워크 정책을 변경하지 않았다. 로컬 지침 checkout은 `56fef8bd189377b80f4020f506e717ab292b260a`이며 관련 SKILL.md와 .agents/skills의 부재를 확인했다. 이는 R17 지침 로딩 완료를 뜻하지 않는다.

현재 후보는 부모가 보고한 R17 commit `fa1e250c1cbc4f8f446f2e2ddeb516f4e439edbb`, tree `43d2b4e49cdb6993c48d7adc792a3ef17426092e`다. 독립 SOURCE 판정과 고정 원격 후보가 아직 전달되지 않았다. 이전 main이나 c6a8019를 대신 시험하지 않았으며 과거 reproduce.sh도 실행하지 않았다.

재개하려면 부모의 검증된 후보·공통 모델/effort·기존 성공 API 인증 절차·선행 검사 결과가 필요하다. 후보 플러그인/설정 결속, 실제 호스트의 installed/enabled/supported 변형 공급과 hook/task attestation도 확인해야 한다. typo bootstrap 채점의 과거 R14 대기는 새 검증된 evaluator/manifest로만 해소하며 과거 21개 run을 재실행하지 않는다. 입력·호스트 관측·판정·원시 근거·비용 수집의 단계와 중단 조건은 `variant-plan.json`에 정리했다. Sol은 환경과 근거를 관리하고 Claude가 실제 호스트 작업을 수행한다.

`budget-ledger.json`은 유료 준비 호출·토큰·캐시·실패·재시도 비용까지 사례 US$2에 합산한다. 전체 39개 예약 US$78은 소비 목표가 아니다. 한도 접근 또는 비용 누락 시 다음 호출을 중단한다. JEV는 별도 배정 전이며 계속 미실행이다.

게시 범위는 기존 evidence 브랜치의 이 고유 SS15 run 경로에 한정한다. 제품 코드·생성물·다른 작업 파일·기존 결과를 수정하지 않는다. 원래 개인 채팅·비밀값·개인정보는 포함하지 않는다. SHA256SUMS는 이 디렉터리의 공개 파일 bytes만 검증하며 제품 PASS를 뜻하지 않는다.
