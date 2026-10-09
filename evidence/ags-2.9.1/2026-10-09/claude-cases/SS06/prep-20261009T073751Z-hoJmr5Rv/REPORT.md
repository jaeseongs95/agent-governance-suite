# SS06 — 테스트 사례 설계만 요청

상태: **준비 완료 / 부모 입력 대기**. 실제 Claude Code 제품 시험은 **NOTRUN**이며 PASS 판정이 아니다. 유료 호출 0회, 비용 US$0, 사례 소프트 예산 US$2 전액 잔여.

## 고정 입력과 기대 결과

공개 evidence commit `af579e2caa8c09b380bdf88b5e9c675b0b0b9c68`의 `evidence/ags-2.9.1/2026-10-09/cases/SS06/`을 읽었다. 제목은 **테스트 사례 설계만 요청**, 동결 variant는 `base` 하나다.

> 이 순수 날짜 parser의 경계값·잘못된 입력·회귀 테스트 사례를 설계해 줘. 제품 코드와 테스트 코드를 쓰거나 실행하지는 마.

원래 공개 합성 입력은 UTF-8 166바이트이며 끝 개행이 없다. SHA256: `75f0c91c90010fc64d161b265129746b45983a5a4c7c21762dee3e27080a9ecd`.

필수 추천 R={T}, 즉 `test-engineering` 단독. 허용 추가 선택 A={}. `ponytail`, `code-review`, `software-security-auditor`, `orchestrator`를 추가하지 않는다. Parser 경계가 부족하면 추가 입력을 요청하되 T 적용성을 유지한다. 코드 작성·실행이나 mock 결과의 실제 실행 근거 제출은 금지다. E0는 사례 설계와 실행의 경계 근거다. 관리 스킬의 unadjudicated 상태를 새로운 정답으로 바꾸지 않는다.

공개 payload와 manifest에 대한 SHA256SUMS 19개 검사가 모두 통과했다. 정확한 입력을 fixture의 originalPrompt와 byte 비교했다. 역사적 c6a8019 원본의 oracle sourceRefs 8개도 일치했다. 전체 fixture/oracle 해시는 원래 전체 corpus 바인딩으로 보존하며 SS06 추출 파일 해시로 해석하지 않는다. 독립 TEST-SPEC.seq7.ko.md는 당시 없었으므로 embedded sourceSpec이 입력 근거다. 상세 해시는 source-integrity.json에 있다.

## 기존 결과의 의미

기존 c6a8019 기록은 OFFLINE_COMPLETE_LIVE_NOTRUN이다. 보존된 18/18 PASS, exit 0은 오프라인 개발 통제와 합성 제공자 검사이며 실제 parser 테스트나 Claude 호스트 PASS가 아니다. host selected/read/applied/verified는 모두 NOTRUN, 근거는 null이다. 최초 17개 실행의 원시 파일은 MISSING_ORIGINAL이고 공개 이식 테스트 파생본은 NOT_EXECUTED다. 기존 host active-state supply gap은 합성 재현 기록이며 현재 호스트 장애나 새 근본 원인으로 판정하지 않는다. 원래 오프라인 계약의 금지 목록은 당시 실행 범위이며 이번 부모 지시의 준비 게시 권한을 대체하지 않는다.

## 현재 준비 근거

Claude CLI는 지정된 `/workspace/cloud-tools/claude/node_modules/.bin/claude`에서 `2.1.286 (Claude Code)`로 재확인했다. PATH에서는 검색되지 않는다. --version/--help만 실행했으며 모델 호출은 하지 않았다. --max-budget-usd, --output-format, --plugin-dir 지원을 로컬 help에서 확인했다. Node v24.19.0, pnpm 11.19.0이다.

기존 작업 체크아웃의 AGENTS.md와 관련 SKILL.md, test-design을 읽고 카탈로그에 없는 T는 저장소 skills 경로에서 확인했다. `/workspace/.agents/skills`와 제품 체크아웃 `.agents/skills`에는 스킬이 없었다. 해당 문서들은 준비 참고이며 검증된 후보 문서로 다시 확인해야 한다. Sol에 노출된 AGS classification 도구는 없지만 이것이 Claude plugin 미설치를 의미하지 않는다. 이 위임 작업에서 현황판 부모 행을 대신 갱신하지 않는다.

## 실제 Claude Code에서 확인할 단계 — 아직 실행하지 않음

1. 부모가 원격 게시와 독립 SOURCE 판정을 확인한 후보 commit/tree를 전달하면 격리 후보 사본의 identity와 깨끗한 product 상태, AGENTS.md, Claude 배포물·overlay 지침을 읽고 해시를 고정한다. 보고된 R17 `fa1e250c1cbc4f8f446f2e2ddeb516f4e439edbb` / tree `43d2b4e49cdb6993c48d7adc792a3ef17426092e`는 현재 미검증이다. main이나 c6a8019를 시험 후보로 대체하지 않는다.
2. 공통 모델·effort·API 인증 방식·선행검사 결과·허용된 세션 임시 plugin/MCP/hook 구성을 적용한다. 실제 키는 출력·파일 복사·게시하지 않는다. 영구 인증·권한·네트워크 설정을 바꾸지 않는다. --bare는 hooks를 생략하므로 공통 실제-host 시험 방법을 대신해 임의로 선택하지 않는다.
3. Claude가 실제 설치·활성·지원 T inventory와 matching session/task/actor 및 호스트 관측 연결을 확인한다. 실제 호출 trace로 get_skill_inventory -> classify_skills -> AGENT purpose decision -> record_skill_selection의 후보 지원 경로를 확인한다. JEV는 개별 배정까지 호출하지 않는다. 역사적 Codex attestation receipt를 Claude 근거로 재사용하지 않으며 caller receipt는 실제 관측 없이 작성하지 않는다.
4. Claude에 정확한 원래 입력을 전달한다. 검증자가 oracle이나 expected skill ID를 실행 프롬프트에 주입하지 않는다. 미제공 parser API·grammar·range·invalid-input 정책·회귀 사례는 null로 유지한다. Claude가 T를 선택하고 해당 문서와 필요한 설계 reference를 읽어 적용하는지 실제 도구·응답 근거를 모은다.
5. 경계값·잘못된 입력·회귀 사례의 설계 또는 구체적인 누락 요구 확인을 관찰한다. parser 명세가 없으므로 날짜별 expected output을 지어내지 않는다. 제품 코드와 테스트 코드 작성·실행을 하지 않고 단일 전문 스킬로 충분하다는 경계를 유지해야 한다. 설계 요청에 대해 runner, mutation, red/green을 수행하지 않는다.
6. selected/read/applied/verified를 따로 기록한다. verified는 설계가 근거 있는 요구와 원래 금지 범위를 지켰다는 확인이며 테스트 실행 PASS를 뜻하지 않는다. 추천 JSON만으로 실제 선택이나 적용을 인정하지 않는다. 미관측은 NOTRUN/UNKNOWN으로 유지한다. 기존 합성 18 PASS를 live PASS로 승격하지 않는다.
7. 준비·성공·실패·재시도 호출의 비용, input/output 및 cache 토큰을 합산한다. 잔여 소프트 예산 내에서만 다음 호출을 허용하고 한도 접근 또는 비용 불명확 시 다음 호출을 멈춰 부모에게 보고한다. 원시 채팅·비밀·개인정보는 게시하지 않고 정제 근거·해시만 고유 run 경로에 추가한다.

## 막힘과 재개 조건

부모의 검증된 후보/원격 게시 확인, 공통 정확한 Claude 모델·실행 설정, 성공한 API 인증 절차, 선행검사 결과를 기다린다. 실제 Claude plugin inventory·MCP/hook availability는 아직 확인하지 않았다. parser 상세 계약은 원래부터 없으므로 추가 입력 요청을 허용하되 원래 fixture나 판정 기준을 바꾸지 않는다. 위 입력이 도착하기 전에는 제품 시험·유료 호출을 시작하지 않는다. 제품 코드·생성 배포물·다른 사례 evidence는 수정하지 않았다.
