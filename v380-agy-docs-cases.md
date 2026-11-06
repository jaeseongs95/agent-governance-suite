# AGS3-D-0028·D-0029 검증 사례

기준: a281139387af096e696f8d50cc089ad09e9291fc. 작업본: codex/ags38-agy-docs.
목표는 현재 AGY 플러그인 계약으로 패키지 정체성을 전달하고, 기존 서버 키 전환의 실제 중복 원인을 구분하며, session-board의 잘못된 호출자 결속 설명을 고치는 것이다.

## 근거와 판단 경계

- 정본 D-0028은 옛 서버 키 agent-governance-suite와 새 ags 서버가 함께 보인 실제 관측을 담는다. 캐시/구프로세스 정리 코드 부재라는 root_cause는 정본 기록이다. 이것만으로 중복의 현재 원인을 확정하지 않는다.
- baseline mcp_config.json에는 ags 키 하나가 있고, antigravity host 선택도 맞다. root plugin.json과 .gemini-plugin/plugin.json은 같은 AGS 이름·버전을 담는다.
- 그러나 release/antigravity-package.json에는 .gemini-plugin만 들어 있고 현재 공식 manifest 경로 plugin.json이 빠진다. 기존 package 회귀도 .gemini-plugin만 기점으로 검사한다. 이것은 직접 확인한 패키지 계약 공백이다. 이 공백이 원 중복의 충분한 원인인지는 실제 호스트 확인 전 미확정이다.
- 공식 계약(2026-11-07 조회): https://antigravity.google/docs/build-plugins/ 의 manifest·plugin path·MCP servers 절과 https://antigravity.google/docs/plugins 의 CLI 관리 절. plugin.json 또는 .antigravity-plugin/plugin.json이 현재 manifest이고 이름은 MCP namespace의 일부다. 정식 uninstall은 등록부를 정리한다. 문서는 캐시 폴더 삭제나 실행중 구프로세스 종료 보장을 하지 않는다.
- D-0029는 caller-identity.ts RESERVED_CALLER_KEYS, server.ts의 예약필드 거부 및 callerIngress 호출, builtin-caller-ingress.ts의 호스트별 _meta/Claude admission 경로와 대조한다.
- PC 설치·프로세스 종료·캐시 삭제·전역 설정 수정·직접 SSH 변경은 이 작업에서 금지다. 실제 제품시험은 root TEST가 수행한다.

## 사전 사례

| Case | 요구·입력 | 전제 | 절차·진입점 | 기대 결과·판정 기준 | 실제 결과 |
|---|---|---|---|---|---|
| AGY28-01 | AGY package contract, root plugin.json | baseline과 test-only commit. Node24+기존 Vitest | tests/tooling/ags38-agy-package.test.mjs 실행 | 공식 manifest plugin.json이 패키지 선택에 포함. baseline에서 해당 assertion이 FAIL해야 하며 실행기 부재는 red가 아니다 | NOT_RUN: root CI/TEST 담당 |
| AGY28-02 | 한국어·영어 설치 ZIP, 실제 builder --ref HEAD | 각 red/green commit의 깨끗한 TEST checkout, Git/Node24. 제품설치 불필요 | node --test tests/tooling/ags38-agy-package.node-test.mjs. 실제 builder CLI 두 번 실행 후 ZIP 중앙목록/내용 확인 | 두 ZIP 루트에 plugin.json 존재, AGS name/version이 소스 정체성과 동일. old compatibility manifest도 보존. mcp_config에는 ags 하나·antigravity host 선택. root manifest 누락 baseline은 FAIL | NOT_RUN: root TEST 담당 |
| AGY28-03 | 실제 AGY 구키 설치→후보 갱신 | root가 허용된 TEST 호스트에 소유 fixture. 사용자/타세션 설치 불변. 앱/세션 사용중 여부 먼저 확인 | 정식 agy plugin list --help 및 --json으로 설치명/path/mcpServers 확인. 현행 패키지를 정식 CLI로 validate/install한 후 실제 tools namespace·개수·schema-null 여부 확인. 구키를 실제 재현할 때만 격리 fixture 사용 | 같은 플러그인에 ags namespace 하나. long old namespace 없음·정상 도구 schema/대표호출 확인. 남은 중복은 구성등록/프로세스/표시캐시로 따로 분류하고 실패 보존 | NOT_RUN: root realhost 관측 담당 |
| AGY28-04 | 무관 캐시/프로세스·이미 올바른 설치 | AGY28-03 fixture와 무관한 타등록 sentinel | 후보 패키지 갱신 전후 무관 등록·프로세스 유지 확인 | 패키지 변경만으로 무관 캐시 삭제·프로세스 종료·설정 재작성 없음. 광범위 kill/rm 도입 금지 | NOT_RUN: root realhost 관측 담당 |
| BOARD29-01 | session-board 문서 결속 설명 | baseline source 위 세 파일 읽기 | entry-details.md의 각 결속 문장을 호출자 수집·예약필드 거부·현황판 쓰기 소스와 수동 대조 | _sessionBinding 주입 경로라는 주장이 없고, host metadata/Claude admission·예약키 거부·관측불가 BINDING_REQUIRED·기록실패 MCP_UNAVAILABLE를 정확히 설명 | 정적 대조 PASS: server.ts:477,498,866-872·caller-identity.ts:46,59-65·builtin-caller-ingress.ts:45-123·session-board-hook.ts:handleSessionBoardHook와 diff 대조. 실행 검증을 뜻하지 않음 |

## runner·oracle·미실행 범위

- 기존 Vitest와 node:test runner를 사용한다. 새 의존성과 별도 runner를 만들지 않는다.
- AGY28-01은 배포 계약을 검사하는 정적 회귀이며 원 manifest 누락만 잡는다. AGY28-02는 실제 공개 package builder를 실행하는 process-boundary 시험이라 TEST 서버 범위다. ZIP reader는 테스트 안에서 Node stdlib만 사용한다.
- 이름·버전 oracle은 현재 공식 manifest 계약, AGS 고정 이름, package.json 버전이다. package paths 구현을 복사해 기대 manifest를 만드는 방식은 쓰지 않는다.
- D-0029는 문서 사실 교정이다. 새 동작시험을 발명하지 않고 현재 caller ingress·예약필드·session board 소스 대조와 기존 검증을 사용한다.
- test-only와 fix는 서로 다른 commit으로 즉시 push한다. 동일 test 파일·argv의 red/green은 root가 각 commit에서 실행한다. 원상태로 reset하지 않는다.
- 두 fixture ZIP은 실행별 os.tmpdir 아래 생성·시험 후 자기 임시 디렉터리만 정리한다. 고정 드라이브·실사용 home·인증파일을 쓰지 않는다.
- 이 소스 수정으로 기존 PC의 stale cache/process가 실제 정리되었다고 주장하지 않는다. 원 중복 관측의 원인·실호스트 수리는 AGY28-03 근거까지 필요하다.

## 소스 수정·통합 인계

- D-0028 소스 변경은 release/antigravity-package.json의 paths에 정식 plugin.json 한 항목을 넣는다. 기존 .gemini-plugin·MCP ags 키·builder·host 설정은 유지한다. 임의 installer·kill·캐시삭제 코드를 추가하지 않았다.
- D-0029 문서는 서버가 host-observed caller로 행 식별자를 정하고, Codex/AGY는 host-written MCP _meta, Claude는 tool-use ID에 결속된 hook admission을 사용한다고 바로잡았다. 예약 인자 _sessionBinding의 실제 결과는 INVALID_INPUT(reasonCode RESERVED_CALLER_FIELD)다.
- 문서 새 바이트 SHA256은 4c0571608a124e96da1b27510a8c42775b3c84396c46abb11a915f57f103a196. 기존 scripts/check-skill-context-optimization.mjs의 동결 source successor 갱신은 해당 파일 소유 root/D-0026 담당에게 요청했다. 이 branch는 배정 밖 고정값이나 생성물을 바꾸지 않는다.
- 문서의 기존 인코딩(UTF-8, BOM 없음)·LF 줄바꿈을 유지했다. git diff --check 종료0. 제품/회귀시험은 로컬에서 실행하지 않았다.
