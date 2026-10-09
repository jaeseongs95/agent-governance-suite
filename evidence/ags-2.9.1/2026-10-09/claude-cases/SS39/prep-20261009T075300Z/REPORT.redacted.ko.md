SS39 — 중앙 vendor profile과 모델 추론 설정

상태: 준비 완료 / 부모 입력 대기. 실제 Claude 제품 시험 NOTRUN이며 PASS가 아니다. Claude API·JEV·다른 vendor·실제 native 호출 0회, 사용 비용 US$0, 토큰·캐시·재시도·실패 API 호출 모두 0이다.

입력은 evidence commit af579e2caa8c09b380bdf88b5e9c675b0b0b9c68의 cases/SS39에서 고정했다. SHA256SUMS의 모든 49개 파일을 실제 bytes로 검증했고 source.json의 SS39 및 SS03 재사용 내용이 pinned fixture와 일치했다. fixture SHA256은 17ade7e27cc11ffee8cc0b7b2070785617861d4c3384448cf24fce75f40d87e9이다. 동결 oracle digest 5db1d67cef8719c40b17b0ab07003f01f765746d34ced0b326e59fadb2efe055는 hash 검증한 fixture와 기존 source.json의 계산 기록이 일치한다. 이 준비에서 oracle 알고리즘을 독립 재계산하지 않았다. 세부 원문과 해시는 source-input.json 및 source-hashes.json에 보존했다.

원래 입력은 단일 합성 중앙 ProviderProfileRegistry의 Vendor-A→model-a/low 및 Vendor-B→model-b/null, supportedOptions·qualificationRevision·approved route·profile revision이다. 모델 이름은 합성값이고 실제 Claude 모델 지원 사실이 아니다. 기본 prompt는 공개 SS03의 session-handoff 요청을 재사용한다. SS39 originalPrompt와 oracle은 null이다. 12개 counterexample의 개별 입력·기대값 및 TEST-SPEC.seq7.ko.md는 공개 자료에 없으므로 원래 variant 검증은 BLOCKED, 각 variant는 NOTRUN을 유지한다. 새로운 반례를 발명하거나 기존 보강 시험을 원래 12개에 대응시키지 않았다.

기대 결과는 고정 modelId·effort·지원 옵션·route·revision과 실제 전송의 일치, runtime catalog/가격 탐색 0회, 승인 없는 모델·벤더 대체 없음이다. profile 없음·모델 미가용/미검증·미지원 effort/옵션·route/예산 부족·egress 차단에서는 보류한다. profile 갱신은 새 revision과 qualification·지원 옵션 검증 뒤 다음 유효 요청에 적용한다. profile 조회나 추천만으로 AGENT 선택·읽기·적용·검증 완료를 주장하지 않는다. E0·E1·E3·E4 및 중앙 registry digest/revision, 정제된 실제 wire, qualification·비용 근거, 실제 model/effort와 호스트 관측을 수집해야 한다. Vendor-B/null을 native adapter에 맞추려고 다른 effort로 바꾸면 안 된다.

기존 결과는 c6a8019be30e4bf5ee9a36147ca45ae28b0f75b6의 오프라인 FAIL이다. 제한된 기존 회귀 9 PASS, 보강 19 PASS/3 FAIL, 원래 12개 NOTRUN/BLOCKED, 실제 호스트 단계 NOTRUN이다. 실패는 qualification 만료 뒤 전송, credential 대기 중 revision 변경 뒤 전송, invalid response의 유효 US$0.6 비용 유실이다. 두 원인 그룹으로 기록된 과거 관측을 현재 R17 결과나 기대값으로 승격하지 않았다. 이번 준비에서 이 시험을 재실행하지 않았다.

로컬 Claude CLI는 지정 경로 /workspace/cloud-tools/claude/node_modules/.bin/claude에서 --version exit0, 2.1.286 (Claude Code)로 확인했다. PATH lookup은 찾지 못했지만 지정 경로는 정상이다. Node v24.19.0이며 CLAUDE_API_KEY 존재 여부만 확인했다. API 인증은 실행하지 않았고 키 값·placeholder·영구 인증 설정·권한·네트워크 정책은 읽어 게시하거나 변경하지 않았다. 실제 인증 절차는 부모 전달을 기다린다. 환경과 읽은 지침의 hash는 environment.json에 있다.

현재 전달받은 후보 R17 commit fa1e250c1cbc4f8f446f2e2ddeb516f4e439edbb / tree 43d2b4e49cdb6993c48d7adc792a3ef17426092e는 식별자만 기록했다. 독립 SOURCE 판정·원격 게시·공통 모델 설정·선행 검사 결과를 아직 받지 않았다. 로컬 작업 폴더 HEAD 56fef8bd189377b80f4020f506e717ab292b260a는 후보가 아니며 시험하지 않았다. 이전 main이나 c6a8019를 대체 후보로 사용하지 않는다. 로컬 AGENTS와 test-engineering·evaluation-validity-auditor·orchestrator, 게시 관련 scope/preflight 지침을 읽었고 .agents/skills 부재를 확인했다. 준비 기록은 평가 유효성 독립 감사나 제품 수용 판정이 아니다.

재개 때 부모의 검증된 후보·공통 Claude model/effort/API 인증·선행 검사 결과를 먼저 고정하고, 후보 AGENTS 및 설치된 스킬·registry/runtime/adapter/hook의 bytes를 새로 확인해야 한다. 실제 호스트 작업은 Claude가 수행하며 Sol은 환경과 근거를 관리한다. 승인된 격리 scratch 대상·native allowance·기존 소비/unknown 예약, 실제 qualification/고정가격 최소비용 근거와 host hook 관측이 필요하다. 원래 12개 variant 전체 판정에는 누락된 권위 있는 정의가 추가로 필요하다. 상세 단계와 보류 조건은 test-plan.json에 있다.

제품 소스·생성 배포물 수정은 NONE이다. 게시 대상은 claude-cases/SS39의 이 고유 run 아래 준비 보고서·정제 근거·해시 목록뿐이다. 기존 자료·다른 작업 파일을 덮어쓰지 않으며 force push하지 않는다. 원격 게시와 고정 commit 파일 재읽기 검증은 게시 뒤 별도로 보고한다.
