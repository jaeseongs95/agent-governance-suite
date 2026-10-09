# SS33 — 비밀값 보호와 분리된 예산

상태: **준비 완료 / 부모 설정 대기 / 실제 Claude 시험 NOTRUN**. 새 제품 시험, 유료 호출, JEV 호출은 모두 0회이며 이 run의 비용·토큰·캐시·재시도·실패 호출은 모두 0이다. 기존 사용량의 공통 장부는 아직 전달되지 않았다.

고정 evidence commit: `af579e2caa8c09b380bdf88b5e9c675b0b0b9c68`. 원래 제목은 입력과 결과에서 동일하게 확인했다. `SHA256SUMS` 25개 항목과 manifest의 공개 bytes/SHA256가 일치했다. 원 fixture SHA256는 `17ade7e27cc11ffee8cc0b7b2070785617861d4c3384448cf24fce75f40d87e9`, 동결 oracle 파일 SHA256는 `5db1d67cef8719c40b17b0ab07003f01f765746d34ced0b326e59fadb2efe055`이며 분류 `oracle` 값과 `originalPrompt`는 `null`이다. 원본 SHA는 provenance 기록이며 읽을 수 없는 private 원본을 재확인했다는 뜻이 아니다. 공개 입력·테스트는 경로 및 합성 표식을 치환한 대체본이다. 원문 외부 `TEST-SPEC.seq7.ko.md`가 없어 embedded SS33 fields를 기준으로 유지한다. 파일별 실제 검증과 원본/공개 대응은 source-integrity.json에 기록했다.

후보 R17 `fa1e250c1cbc4f8f446f2e2ddeb516f4e439edbb` / tree `43d2b4e49cdb6993c48d7adc792a3ef17426092e`는 위임문에 지정된 대기 대상이다. 독립 SOURCE 판정, 원격 게시 확인, 부모의 확정 후보/공통 실행 설정을 아직 받지 못했고 제품 후보를 시험하지 않았다. 과거 후보 `c6a8019be30e4bf5ee9a36147ca45ae28b0f75b6`와 기존 main은 시험 대상으로 사용하지 않는다.

기존 결과는 secret-sentinel/jev-budget/vendor-unapproved FAIL, vendor-unknown-budget/inflight-reservation 경계 검사 PASS, 실제 호스트 모두 NOTRUN이다. 최종 격리 검사 13 PASS/3 FAIL과 기존 회귀 9 PASS/36 SKIPPED는 과거 mock 관측이다. 최초 14개와 최종 16개는 테스트 바이트가 달라 동일 red/green 증거가 아니다. 기존 결함을 정답으로 바꾸거나 mock PASS를 전체 사례 PASS로 승격하지 않는다.

원래 기대 결과:

- secret-sentinel: 허용된 입력 fixture 밖 로그·응답·업로드에서 합성 표식 0회, 비승인 내용 전송 0회. 원문/키는 보존하지 않고 구조화 오류·digest·사용량만 남긴다.
- jev-budget: 기존 사용량을 포함한 원 명세 USD5 한도와 진행 중 예약을 검사한다. invalid RESP에서도 독립적으로 유효한 실제 비용을 보존하고 상한 초과 시 다음 호출을 보류한다. 이는 mock 요구이며 JEV 지출 승인이 아니다.
- vendor-unapproved: 별도 유료 권한·known budget 없는 전송 0회. credential await 도중 승인 철회도 실제 전송 직전에 반영한다.
- vendor-unknown-budget: 한도·이전 사용량·호출 상한이 불명하면 null을 보존하고 호출을 보류한다.
- inflight-reservation: 동시 요청·dispatch 뒤 비용 불명·timeout/late completion에서 보수적 예약을 유지해 다음 distinct operation의 초과를 막는다. 추가 충전은 0회다.

재개 후 실제 Claude Code가 수행할 단계:

1. 부모가 보낸 확정 후보/독립 SOURCE/원격 고정 파일과 공통 선행 검사 근거를 읽고 commit/tree·공개 입력/runner digest를 다시 확인한다. 후보 변경 시 해당 근거를 재검토한다.
2. 부모가 전달한 검증된 API 인증 절차와 공통 모델/effort를 임시 프로세스 범위에 적용한다. CLI 로컬 경로는 `/workspace/cloud-tools/claude/node_modules/.bin/claude`, 버전 `2.1.286 (Claude Code)`이다. PATH 조회는 실패했으나 지정 경로에서 version/help 성공했다. 인증·연결 성공은 아직 미확인이다. 로컬 Node v24.19.0/pnpm 11.19.0을 확인했다. 영구 인증, 권한, 네트워크 정책은 바꾸지 않는다.
3. SS33는 originalPrompt null인 운영 사례이므로 부모가 승인한 공개 합성 host task/full-payload digest가 있어야 launch한다. 아래 host-task.draft.md는 제안 wrapper이며 원래 prompt 또는 동결 oracle을 대체하지 않는다.
4. 승인된 후보의 격리 scratch와 활성 AGS plugin/MCP에서 Claude가 지침·관련 스킬을 읽고 원래 mock runner를 Bash 도구로 실행한다. Sol은 fixture/근거/장부만 관리한다. 원래 진단 코드는 scratch에만 놓고 제품 코드·생성물을 수정하지 않는다. fixture 값은 Claude 응답·로그에 출력하지 않고 runner가 로컬 파일로 읽게 한다. 실패 응답 원문 대신 표식 개수·오류 코드·digest만 기록한다.
5. SS33 mock 다섯 변형, invocation exit/실제 도구 호출·Claude usage·실제 모델을 관측한다. `node scripts/run-tests.mjs tests/skill-classification/ss33-isolated.test.ts`와 원 SS33 name-filter 회귀는 후보와 runner 호환성이 부모 선행 검사에서 확인된 뒤 Claude가 실행한다. 과거 reproduce.md의 c6a8019 시험 지시는 이번 위임의 확정 후보 규칙보다 우선하지 않는다.
6. 분류가 필요한 승인된 host 입력일 때만 get_skill_inventory → classify_skills(advice) → Claude의 독립 선택 → 실제 SKILL.md 읽기/적용/출력 검증 및 허용된 record_skill_selection·호스트 관측을 분리해 수집한다. 기대 스킬 집합이 없으므로 임의 정확도 점수를 만들지 않는다. E0/E1 정의와 signed observation이 없으면 해당 증거를 BLOCKED/NOTRUN으로 유지한다.
7. 모델 호출 전에 준비 호출 포함 USD2 잔여·보수적 상한·불명/진행 중 예약을 확인하고 호출 뒤 모든 비용·토큰·캐시·재시도·실패를 usage-ledger에 누적한다. 한도 접근 또는 비용 불명이면 다음 호출을 멈춘다. JEV 개별 배정 전 live JEV는 0회 유지한다.
8. 정제한 결과와 hashes만 같은 사례 아래 새 고유 run에 추가하고 비-force 게시 후 고정 원격 commit의 파일을 다시 읽어 bytes/SHA256를 검증한다. 준비와 PASS를 별도로 판정한다.

읽은 지침은 기존 local checkout의 AGENTS.md와 test-engineering, evaluation-validity-auditor, acceptance-evidence-validator, session-board, mutation-risk-preflight SKILL.md이다. test-design과 mutation 관련 상세 지침을 읽었다. 해당 지침 checkout은 기존 main `56fef8bd189377b80f4020f506e717ab292b260a`이며 후보 실행 근거가 아니다. .agents/skills는 workspace/repo 모두 존재하지 않았고 repo .agents에는 marketplace 파일만 있었다. 이번 준비에서는 test-engineering 계획과 게시 preflight만 사용한다. 독립 평가·수용·릴리스 감사나 실제 피시험 에이전트 선택을 주장하지 않는다.

남은 조건: 검증된 확정 후보/공통 Claude 모델·API 인증·선행 검사, SS33 공개 합성 host task digest 승인, 활성 plugin/MCP/profile 구성, 현재 공통 비용 장부, E0/E1 및 실제 호스트 관측 정의. 부모가 이를 전달하면 재개한다.
