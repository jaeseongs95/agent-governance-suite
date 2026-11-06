# AGS 3.7.0 릴리스 노트

3.7.0은 사람이 보고 쓰는 결과물의 UI/UX 설계·점검을 맡는 전문 스킬 `ui-ux-design`을 더하고, 한국어·영어 README를 설치·턴별 동작·한계 중심으로 다시 썼다. 사용자 원문은 「이 브랜치 봐보고 문제 없으면 메인에 반영해줘.」(브랜치 `codex/ui-ux-specialist-20261106`), 「UI/UX 설계 스킬 릴리즈해.」다.

호환성:

- 전문 스킬이 23개에서 24개가 됐다. `skills/registry.json`, `skills/source-lock.json`, `scripts/fixtures/registry-contract.3.0.json`에 `ui-ux-design` 0.1.0이 늘었다.
- MCP 서버·hook 실행 코드는 3.6.0과 같다. 바뀐 것은 판 번호 문자열뿐이다(`mcp-server/src/plugin-info.ts`).
- 이전 판의 3.7.0·3.8.0 계획(상주 서비스, PostgreSQL 저장소)은 3.8.0·3.9.0으로 옮긴다. 4.0.0 계획은 그대로다.

## 새 전문 스킬 `ui-ux-design`

- 사람이 보고 이해하고 행동하는 결과물(화면, 인쇄·광고, 영상, 공간·안내물, 제품, 서비스 절차, 문서·양식)의 사용자 흐름·정보 계층·행동 유도·접근성·예외 상황을 설계하거나 점검한다. 결과물이 대상 사용자에게 통하는지(첫인상·이해·행동·예외·접근성)를 먼저 확인하고, 컴포넌트·반응형·비동기 상태·대량 목록 같은 화면 전용 기준은 「화면일 때」 항목으로 둔다.
- 입력·출력 계약은 `ui-ux-design-request.v1`, `ui-ux-design-report.v1` schema다. 스킬 descriptor, classification, 참고 자료(설계 절차, 출력 계약, AGS 역할 경계)를 함께 둔다.
- Claude(한·영), Codex(한·영), agy 패키지에 같은 스킬이 들어간다.
- 스킬 문맥 최적화 검사(`scripts/check-skill-context-optimization.mjs`)는 고정된 26개 스킬 snapshot에 이 스킬을 넣지 않고 `POST_SNAPSHOT_SPECIALISTS`로 따로 둔다. snapshot 이후에 생긴 스킬이기 때문이다.

## 적용 범위 수정: 화면 밖 결과물 (AGS3-D-0037)

- 첫 후보의 description·본문·참고 자료·classification targets·descriptor preconditions가 대상을 웹·데스크톱·모바일 화면으로 한정해, 광고·영상·안내물·양식·제품·서비스 절차의 사용자 경험 설계·점검에는 선택되지 않았다. 사용자 원문: 「UI/UX가 꼭 컴퓨터 작업에만 쓰이겠냐? 광고는 그럼?」
- 위 다섯 곳을 매체 무관으로 고쳤다. 스킬 이름, capability, schema 이름과 필수 필드는 그대로다. request `surface`에 `print`·`video`·`physical-space`·`physical-product`·`service-process`·`document`·`multi-channel`을, report check `kind`에 `audience`를 더했다(기존 값은 그대로 유효).
- `tests/ui-ux-design`에 선택돼야 하는 요청 7건(쇼츠 구성, 신문 광고, 매장 안내판, 종이 신청서, 제품 조작부, 민원 절차, 웹 결제 화면)과 선택되면 안 되는 요청 3건(순수 백엔드, 일반 질의, 이미지 한 장 생성), 대상 사용자 확인 기준·계약 사례를 먼저 넣었다. 수정 전 후보에서 45건 중 11건 실패, 수정 후 45건 통과. 이 시험은 선택 문구와 계약의 결속을 확인하며, 실제 모델의 스킬 선택은 평가하지 않았다.

## README 개편

- `README.md`, `README.en.md`, `codex-plugin-en/README.md`를 설치, 턴마다 하는 일, 구성 요소, 전문 스킬 표(출처·버전·하는 일), 한계, 문제 해결 순서로 다시 썼다.

## 시험 도구 수정: 스킬 문맥 최적화 검사의 git 호출 축소 (AGS3-D-0033)

- 첫 후보 `4849bdd4`의 Windows 시험 서버(논리 CPU 2개) `pnpm test:server`에서 `tests/tooling/skill-context-optimization.test.mjs` > 'does not read executable script history'가 30초 한도를 넘었다(34,631ms). 검사 한 번이 git 프로세스를 278개(show 199, diff 55, ls-files 23, ls-tree 1) 띄워 부하에 따라 한도를 넘는 시험이었다. 한도는 올리지 않았다.
- `scripts/check-skill-context-optimization.mjs`가 고정 커밋의 과거 파일을 리비전마다 `git ls-tree -r -z` 한 번과 `git cat-file --batch` 한 번으로 읽고, 커밋 쌍마다 `git diff --name-only --no-renames -z` 결과 하나를 재사용한다. 목록에 없는 경로(그 리비전에 없는 파일, 실행 스크립트)는 예전처럼 `git show`로 읽어 git 원래 오류를 낸다.
- 검사 한 번의 git 프로세스: 278 → 83. 검사 JSON 출력은 변경 전후 sha256이 같다(`925e9d0e…7fb4`).
- 'does not read executable script history' 시험이 `cat-file` 배치 입력의 실행 스크립트 경로도 센다. 실행 스크립트 제외를 망가뜨린 사본에서는 Linux·Windows CI 모두 이 시험만 실패했다(run 42158351426), 수정본은 통과했다(run 42158355448). 정규 CI(`AGS_TEST_SCOPE=ci`)는 이 시험 파일을 실행하지 않아 확인용 브랜치에서 따로 돌렸다.

## 검증

후보 커밋은 `1cd5f20b`(판 번호·릴리스 노트 초안 `4849bdd4` + AGS3-D-0033 수정 `efffea18` + AGS3-D-0037 검증 사례 `b134025e`·수정 `1cd5f20b`)이다. 3.6.0(`c6f76414`)부터 이 후보까지 `mcp-server/src`, `mcp-server/dist`의 서버 코드, `hooks`는 판 번호 문자열 말고 바뀌지 않았다.

- CI(run 42166484117, head `1cd5f20b`): Node 24 / ubuntu-latest, Node 24 / windows-latest 모두 success. 직전 후보 `efffea18`은 run 42157205064 success.
- Linux 시험 서버 `pnpm test:server`(Node v24.22.1, `1cd5f20b`): vitest 시험 파일 288 passed·1 skipped(289), 시험 4199 passed·15 skipped·8 todo(4222). node:test 546/546 pass. runtime ready(스킬 CLI 34개). 종료 코드 0. 'does not read executable script history' 1,041ms.
- Windows 시험 서버 `pnpm test:server`(Node v24.22.2, 논리 CPU 2개, `1cd5f20b`, r03): vitest 시험 파일 287 passed·2 skipped(289), 시험 4186 passed·28 skipped·8 todo(4222). node:test 545 pass·1 skipped(546)·fail 0. 설치 준비·빌드·시험·runtime 검사의 종료 코드 모두 0. 직전 후보 `efffea18`의 'does not read executable script history'는 5,612ms(첫 후보 34,631ms).
- 로컬: `node scripts/sync-release-metadata.mjs` 일치, `node scripts/build-en-packages.mjs --check` fresh, `node scripts/check-skill-context-optimization.mjs` 종료 코드 0.

### 이번에 고치지 않은 것

- 열린 결함은 운영 장부 프로젝트 `AGS3`에 있다. 이번 판 작업 중 새로 등록한 것은 AGS3-D-0029(session-board 참고 문서가 없앤 `_sessionBinding` 훅 방식을 설명함), AGS3-D-0030(세션이 자기 역할을 인지하고 담당 세션에 맡기도록 이끄는 장치가 없음), AGS3-D-0031(대상을 닫거나 없애기 전에 그 목적이 이미 이뤄졌는지 확인하도록 이끄는 장치가 없음), AGS3-D-0032(공통 접수 기준이 길고 중복돼 문맥을 낭비함), AGS3-D-0033(위 시험 시간 초과, 이번 판에서 수정), AGS3-D-0034(외부 원인으로 한 단계가 막히면 작업 전체를 멈춤), AGS3-D-0035(바꾼 동작을 실제 사용 경로·대상 환경에서 확인하지 않음), AGS3-D-0036(작업 전에 검증 사례를 먼저 정하는 단계가 없음)이다. 같은 원인·수정 위치인 D-0003·D-0030은 D-0002로, D-0034·D-0035는 D-0031로 합쳤다.
- `ui-ux-design`의 실제 설계 품질과 실제 모델의 선택 여부(화면 밖 매체 포함)는 평가하지 않았다. 계약·등록·schema·선택 문구 결속 시험만 있다.
