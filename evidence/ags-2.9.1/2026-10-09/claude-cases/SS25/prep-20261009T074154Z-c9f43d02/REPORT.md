SS25 — 작업 내용 변경과 stale 결과

준비 상태: READY_TO_WAIT. 실제 Claude 제품 시험: NOTRUN. 준비 완료는 시험 PASS가 아니다. 유료 호출 0, 실패 호출 0, 재시도 0, 토큰/캐시/비용 0, SS25 잔여 소프트 예산 US$2. JEV는 배정되지 않았으며 호출하지 않았다.

고정 입력 근거는 evidence commit af579e2caa8c09b380bdf88b5e9c675b0b0b9c68, evidence/ags-2.9.1/2026-10-09/cases/SS25/이다. 원래 SS25 originalPrompt=null, oracle=null이며 누락된 TEST-SPEC.seq7.ko.md를 만들지 않았다. 정확한 원제는 “작업 내용 변경과 stale 결과”이고 공개 sourceSpec.fields만 요구 근거로 사용한다. A/B는 SS03/SS09의 공개 합성 입력이며 별도 사례 실행이 아니다. 입력 원문과 oracle는 original-inputs.public.json에 기존 engineering/source.json 바이트 그대로 보존했다.

입력: request A는 SS03, taskRevision=1. B는 SS09, taskRevision=2다. A 응답을 B 완료 뒤 도착시키고 requestDigest가 다른 cache 항목도 제공한다.

A: session-handoff를 구현해 줘. 수신 전 종료, ACK 뒤 crash, 같은 메시지 재수신에서 인계가 유실되거나 중복 완료되지 않아야 해. 최소 구현과 회귀 테스트를 함께 설계해 줘.

B: SQLite WAL이 무엇인지 초보자에게 두 문장으로 설명해 줘. 설계·구현·감사는 요청하지 않아.

기대 결과: A 결과가 B의 raw·combined·상태를 덮지 않는다. revision이 바뀌면 옛 baseline도 재사용하지 않는다. 현재 작업이 유효하면 현행 revision으로 vendor 정책을 다시 적용하고, 취소·목적 변경이면 이전 선택을 중단한다. 실제 선택은 각 요청의 유효한 판단 경로에만 연결된다. B는 별도로 목적 정답을 만족해야 한다.

보류 조건: taskRevision·digest가 없거나 충돌하면 해당 결과 채택 보류.
금지: A의 구현 추천을 B에 재사용; requestId만 같다는 이유로 다른 digest를 수용.
B는 SUCCESS인 no-skill 판정이어야 하며 provider 실패와 혼동하면 안 된다. 실제 미관측 selected=null을 mock 합성 []로 바꾸지 않는다. SS25 자체 oracle=null에 임의 의미 정확도 점수를 만들지 않는다.

고정 파일 해시 검증: SHA256SUMS 24개 항목과 manifest payload 23개 전부 일치. fixture SHA256=17ade7e27cc11ffee8cc0b7b2070785617861d4c3384448cf24fce75f40d87e9. 공개 engineering/source.json SHA256=7d905a5b7a65f79384ce20631f0f91110956bee1657be54a98ab28c2d937e752. fixture/result/manifest의 frozen oracle 선언 sha256:5db1d67cef8719c40b17b0ab07003f01f765746d34ced0b326e59fadb2efe055는 일치한다. 이번 준비에서는 historical oracleDigest 함수를 실행하지 않았으므로 oracle 재계산 완료라고 주장하지 않는다. 각 원본/공개 변환 해시와 계산 결과는 source-integrity.json에 기록했다.

기존 결과는 구후보 c6a8019be30e4bf5ee9a36147ca45ae28b0f75b6의 offline-mock FAIL이다. 표적 회귀 7 PASS, 격리 17개 중 11 PASS/6 FAIL. 세 변형 모두 검사됐으며 초기 task binding 검증 누락과 accept await 뒤 쓰기 직전 재검사 공백이 기록돼 있다. 당시 selected/read/applied/verified는 전부 NOTRUN이다. 기존 FAIL·fixture NOT_RUN·합성 receipt를 새 후보의 정답·실행·성공으로 승격하지 않는다. 기존 exit=1은 재현 설명이고 새 후보 성공 조건이 아니다.

현재 부모가 전달한 R17 fa1e250c1cbc4f8f446f2e2ddeb516f4e439edbb / tree 43d2b4e49cdb6993c48d7adc792a3ef17426092e는 로컬 보고뿐이다. 독립 SOURCE 판정과 원격 게시 확인을 기다린다. main 또는 c6a8019를 최종 후보 대신 실행하지 않았다. 제품 코드·생성 배포물은 수정하지 않았다.

Claude CLI는 /workspace/cloud-tools/claude/node_modules/.bin/claude에서 2.1.286 (Claude Code)으로 로컬 재확인했다. PATH lookup 부재로 미설치라고 결론내리지 않았다. --help에서 print/json/stream-json, plugin-dir, max-budget-usd 등의 지원을 확인했지만 제품 세션·doctor·auth·모델 요청은 실행하지 않았다. CLAUDE_API_KEY 환경 항목 존재만 boolean으로 확인했으며 값은 출력·복사·게시하지 않았다. 실제 인증 성공 여부는 아직 미검증이고 영구 인증·권한·네트워크 정책은 바꾸지 않았다.

재개 후 실제 Claude 작업은 planned-host-checks.json의 G0–C7에 고정했다. 먼저 부모의 후보·공통 Claude 모델/effort·기존 성공 API 인증 절차·선행 검사 결과를 받고, 후보 commit/tree와 지침을 다시 읽는다. 별도 격리 사본에서 Claude가 공개 경계를 검사하고 기존 SS25 harness와 frozen 입력으로 역순 응답/digest cache/취소 및 17개 assertion을 실행한다. Sol은 환경·예산·근거를 관리한다. mock provider/observeTask/receipt를 쓰는 harness는 실제 Claude가 실행해도 mock 경계를 유지한다. 실제 AGENT selected/read/applied/verified 주장에는 별도의 genuine MCP/hook 관측, 독립 host-owned revision/digest/cancellation, 실제 read/apply/검증 receipt가 필요하다. bare/safe 모드로 훅을 끄거나 권한을 우회하는 실행 설정을 임의로 선택하지 않는다. JEV/추가 vendor 호출은 별도 배정 전 시작하지 않는다.

재개 조건: 검증된 후보와 SOURCE·원격 게시 근거, 공통 Claude API 인증·고정 모델/effort 설정, 선행 검사와 승인된 host/MCP/hook 경로를 부모가 제공할 것. 첫 호출 전 누적 비용 ledger와 잔여 상한을 대조하고 한도 접근 또는 비용 미확정이면 다음 호출을 중단한다. 이 준비 run은 정제된 보고·공개 입력 근거·해시 목록만 기존 evidence 브랜치의 고유 경로 evidence/ags-2.9.1/2026-10-09/claude-cases/SS25/prep-20261009T074154Z-c9f43d02/에 추가한다. 원격 고정 commit 재읽기 결과와 주소는 완료 응답에 명시한다.
