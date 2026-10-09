# SS13 준비 보고서 — inventory 안에 해당 전문 스킬이 없음

상태: **PREPARED / WAITING_PARENT_HANDOFF**. 실제 Claude Code 제품 시험은 **NOTRUN**이며 PASS 판정이 아니다. 준비 중 유료 호출 0회, 비용 US$0, 재시도 0회, JEV 호출 0회다.

## 고정 입력과 판정

- 원래 제목: **inventory 안에 해당 전문 스킬이 없음**. 단일 `base` 사례다.
- 원문 입력: “달걀을 쓰지 않는 파스타 레시피 하나 알려 줘.”
- 입력 근거: evidence commit `af579e2caa8c09b380bdf88b5e9c675b0b0b9c68`, `evidence/ags-2.9.1/2026-10-09/cases/SS13/source.fixture.SS13.json`의 embedded sourceSpec/oracle와 `input.prompt.txt`.
- 프롬프트: UTF-8 62바이트, 마지막 줄바꿈 없음, SHA256 `2242c7317cda9aac6a9574d583c377286d29448bb41c524a32dfda2d169f71e4`.
- 공개 fixture 파일 SHA256 `7a1bb1afba1ac3e54ea75e4f2b8bdbd8e913c0808c8cd8f6b4ebf53c9355c1d8`. 공개 manifest SHA256 `ce6b411ab9a995f199a786e1f5ab16a53efca3c1000bf72871e3fd8eda4bdd4e`.
- 공개 manifest 항목 18개와 SHA256SUMS 항목 17개가 모두 고정 원본 바이트와 일치한다. manifest 자체를 더한 공개 파일 19개의 근거를 읽었다.
- 과거 전체 inventory는 AGS 24개 후보이고 semantic inventoryDigest는 `sha256:b7aa250a96c14ebc7132d3a0c20895ef6a07ec023a85ec1cb6cc04e4eaa7dc82`다. 새 후보의 실제 inventory와 digest는 재개 시 다시 묶으며 과거 inventory로 대체하지 않는다.
- 전체 TEST-SPEC.seq7.ko.md는 기존 근거에도 없다. 공개된 원래 embedded sourceSpec/oracle만 보존하며 누락된 문서를 복원했다고 주장하지 않는다.

원래 통과 기준은 전체 후보에 대한 유효한 공통 RESP `SUCCESS`, 필요한 후보가 없다는 judgment, 그리고 호스트에서 실제 수락된 `agentSelectedSkillIds=[]`다. 선택 실패·미관측을 뜻하는 `null`은 빈 집합이 아니다. `R={}`, `A={}`이며 보류 조건은 없다. 가장 가까운 점수의 ponytail/cs-engineering/orchestrator 강제 선택이나 존재하지 않는 요리 스킬 생성은 금지다. 일반 AGS 선택·읽기·적용·검증 관측을 각각 보존하며 준비 작업의 SKILL 읽기를 파스타 요청의 host stage로 계산하지 않는다.

## 기존 결과를 유지

과거 `c6a8019be30e4bf5ee9a36147ca45ae28b0f75b6` / tree `28f2f2ed8a864405320f6d20e7bc5004e8466ad3`의 19개 오프라인 mock 경계 검사 결과는 **18 PASS, 1 FAIL, exit 1**이다. 실제 selected/read/applied/verified와 사례 live 완료는 **NOTRUN**, 실제 선택 IDs는 `null`이었다. 원래 engineering sensitivity 결과는 **INCOMPLETE**이며 paired green은 없다. 이번 준비에서 이 검사를 다시 실행하지 않았다.

알려진 단일 실패는 invalid RESP에서도 독립적으로 유효한 actual cost 0.1을 유지해야 한다는 요구다. 과거 mock 관측은 cost null, spent 0, unknown reservation 0.4였다. 기대값은 cost 0.1, spent 0.1, reservation 해제다. 과거 실패를 정답으로 바꾸거나 새 원인으로 중복 집계하지 않는다. mock에서 실제 과금은 없었다.

## 현재 환경과 준비

지정 경로 `/workspace/cloud-tools/claude/node_modules/.bin/claude`에서 버전 **2.1.286 (Claude Code)**를 재확인했다. PATH에는 없지만 실행 파일이 존재한다. Node는 `v24.19.0`다. 로컬 `--version`, `--help`만 실행했으며 API 인증·연결·모델 동작은 확인하지 않았다. CLAUDE_API_KEY는 비어 있지 않은지 여부만 확인했으며 값·placeholder를 출력, 파일 저장 또는 게시하지 않았다. 영구 인증, 권한과 네트워크 정책은 변경하지 않았다.

기존 로컬 제품 AGENTS.md와 과거 고정 소스의 AGENTS.md, 관련 SKILL.md, 분류 계약과 테스트 설계/증명 지침을 읽었다. 카탈로그에 없는 AGS 스킬의 대안으로 `.agents/skills`도 확인했지만 workspace와 과거 저장소에 없다. 역사적 SKILL sourceRefs 7개는 원래 digest와 일치한다. 이 읽기는 준비용 원본 대조이며 현재 후보의 지침 로딩, 독립 감사 또는 formal skill CLI PASS가 아니다.

실제 호출용 원문·공개 fixture·request·inventory의 고정 바이트를 SS13 전용 로컬 입력 경로에 준비했다. 게시물은 보고서, 정제된 근거와 해시 목록뿐이다. 제품 코드·생성 배포물이나 다른 사례 파일을 수정하지 않았다. 원래 public reproduction.sh는 c6a8019를 강제하고 이전 fixture 바인딩을 갖고 있어 현재 후보 시험 명령으로 사용할 수 없다.

## 재개 조건과 실제 Claude 작업

현재 전달된 후보 R17 `fa1e250c1cbc4f8f446f2e2ddeb516f4e439edbb` / tree `43d2b4e49cdb6993c48d7adc792a3ef17426092e`는 참고 식별자다. 부모 설명상 로컬 고정 보고만 있으며 독립 SOURCE 판정·원격 게시가 미확인이다. 이 준비에서는 후보를 시험하거나 검증됐다고 주장하지 않았다. 부모가 검증된 최종 commit/tree, 독립 SOURCE 및 원격 고정 근거, 공통 Claude 모델·revision·effort, 성공한 API 인증 절차와 선행 검사 결과를 전달할 때까지 대기한다. 이전 main 또는 c6a8019를 최종 후보로 시험하지 않는다.

재개 후 Sol은 검증된 후보와 격리 환경·입력·예산·근거를 관리한다. 실제 Claude Code가 전체 inventory 확인, 분류, 최종 빈 선택 전달과 원래 사용자 요청을 수행한다. 승인된 classification config, 최신 inventory/taxonomy에 결속된 유효 profile·route, vendor identity, budget/reservation 근거, 작동하는 MCP 도구와 호스트 서명 관측이 필요하다. 분류 `SUCCESS`만으로 선택을 수락했다고 간주하지 않으며 unattested `[]`나 provider failure는 PASS가 아니다. 구체적인 단계와 고정 기준은 `expected-and-procedure.json`에 담았다.

`--max-budget-usd` 옵션 존재를 로컬 help에서 확인했지만 모델·인증·권한 설정은 아직 정하지 않았다. 옵션은 Claude 프로세스 비용만 제한하므로 classification/vendor의 별도 비용을 합산한다. 훅을 끄는 `--bare`를 임의 적용하지 않는다. 사례별 US$2는 준비 유료 호출도 포함하는 소프트 상한이며 소비 목표가 아니다. 토큰·cache·실패·retry·불명 예약을 전부 기록하고 한도에 접근하면 다음 호출 전에 중단한다. 39개 US$78 예약의 다른 사례 비용이나 JEV를 임의 배정하지 않는다.

## 게시 범위

이 run은 `evidence/ags-2.9.1/2026-10-09/claude-cases/SS13/prep-20261009T074549Z-7d8189ac`에 새 파일만 추가한다. 기존 evidence 브랜치에 일반 fast-forward push를 사용하고 원격이 움직이면 기존 파일을 유지한 채 다시 결합한다. force push, product/main/tag 변경, 비밀·개인정보·원본 채팅 게시를 하지 않는다. 고정 원격 commit의 게시 파일을 새로 읽어 SHA256과 대조한 후 부모에게 commit·링크·검증 결과를 전달한다.
