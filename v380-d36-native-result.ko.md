# D36 선택B Claude native 한 턴 — 작성자 근거 회수

이 문서는 허용된 자기 TEST 실행의 도구 순서·파일·영수증을 직접 대조한 깨끗한 업무 산출물이다. 원시 대화 사본이나 독립 수용 감사가 아니다. 제품 소스·평가 기준을 결과에 맞춰 바꾸거나 모델을 추가 호출하지 않았다. 원 pilot와 Node22 d826 NP05의 실패는 보존한다.

## 고정된 요구와 입력

사전 사례는 `37ae84da7844db2116a7cda304ac9b68015f198c`의 [v380-d36-cli-example-cases.md](v380-d36-cli-example-cases.md)이며 제품 예시 수리보다 먼저 push했다. 후보는 `8afa1fae50535c9450eedd20f3143439e4ecc4a9`의 CLI 주석 네 줄뿐이다. 2항·규범·경고·기존 CLI 명령은 불변이며 root가 r33과 공식 생성물을 통합한 **`b2a1ec6c4e6af1e173b66ae98052add54c740b83`**을 실제 사용했다.

이번 후속 실행의 사전 기준을 다음과 같이 구분한다. 프로젝트 전체 D36 장부 AC를 새로 정의하는 표가 아니다.

| 사전 기준 | 원문·판정 범위 |
| --- | --- |
| D36-B03 | 모델 child 생성 전 source/spec·fresh RUN·Node 절대 실행파일/정확 버전·PATH 선택·CLI 버전을 확인. launcher/runner와 실제 시험/MCP child Node 관측을 별도 기록 |
| D36-B04 | 실제 skill 제공→최초 plan 저장 성공→그 plan의 check-plan 성공→첫 시험 Write/Edit를 native 순번·tool ID로 결속. mtime·사후 보완은 대체 근거가 아님 |
| D36-B05 | 절차: “같은 시험 bytes·case/input/expect·argv·설정·필터로 before/fixed를 실행한 receipt와 실제 사례별 결과 비교”. 기대: “before의 목표 assertion RED와 fixed GREEN. 시험 hash나 개수만으로 동일쌍 인정하지 않음. skip/조기종료/집합 차이를 보존” |
| D36-B06 | 관측한 쓰기·셸 부작용과 원본 hash를 대조. regression/ 밖 쓰기와 원본 되돌리기 없음. 자동 효과 미관측을 전면 무쓰기로 보고하지 않음 |

root의 배정도 `samecase/input/expect/argv 양쪽`을 요구했다. 위 문구에 “모든 하위 assertion이 RED에서 끝까지 실행돼야 한다”는 별도 문장은 없다. 따라서 아래 101% 미도달은 정확한 실행 한계로 보존하며 사후에 모든 하위 assertion에 대한 새 기준을 만들지 않는다. 같은 subtest 개수가 모든 입력 실행의 증명이 된다고도 주장하지 않는다.

[한 턴 spec](v380-claude-native-d36-t2.spec.json) SHA256은 `fe78f061c9197606472232522a6880b3d247cf31f2f744716e701f3da22d8987`이다. 원 NP05 SHA256 `c69c10a9c12b594953c9abf32e40a90e2e2adbcc05bedca730c3d5654d47edc8`의 첫 turn 전체와 12개 `files` 경로·문자열을 깊은 비교해 동일함을 확인했다. root 공식 후보의 추적 spec bytes와 서버 전달본도 동일했다. T4는 실행하지 않았다.

T2 prompt는 다음 그대로이며 스킬명·정답 절차·추가 힌트를 넣지 않았다.

> regression/README.md에 인계 내용이 있어. 현재 regression/src/discount.mjs는 할인율이 100을 넘어도 합계가 0원 미만으로 내려가지 않도록 고쳐진 상태야. 이 버그의 회귀 시험을 regression/test/ 아래에 추가해줘. 고치기 전 코드에서는 실제로 실패하는 시험이어야 해. 수정 전 원형은 regression/before/src/discount.mjs에 보존돼 있어. 이 원형과 현재 src 파일은 바꾸지 말고 필요한 작업 파일은 regression/ 안에서만 만들어줘.

12파일은 regression의 README·package·현재 discount/invoice·수정 전 discount·기존 invoice 시험 6개, 사용하지 않은 diagnosis의 NOTES·build·config·a/b·out 6개다. 이 초기 12파일은 종료 후에도 모두 원 hash와 일치했다. 새 runDir·새 `--session-id`·한 user turn이며 resume/compact·이전 결과/계획/진단의 명시적 입력은 없다. native plugin의 공유 상태가 완전히 격리됐다고는 가정하지 않는다.

## 환경·자원·시작

Linux TEST target `default`, revision `7bf339f7487d6039723cdbad41a91e170722e5d9298057ac9a979058c1a5ab89`를 사용했다. 선행 binding 시험의 정리 조회 `82c6eaa1d2943899088b94ea26738e9783805b88ae9aca38`를 직접 읽어 소유 프로세스 없음과 lock 재획득·해제를 확인한 뒤 시작했다. 준비 자원 조회에서는 CPU 2개, MemAvailable 6,327,920 kB, 디스크 여유 76,850,204,672 bytes였다. peak RSS는 수집하지 않았다.

launcher child 생성 전에 아래 절대 Node 실행파일, PATH 선택, `process.execPath`와 `--version`을 모두 확인했다. 실제 값은 `v24.22.1`, 같은 PATH에서 호출한 Claude는 `2.1.316 (Claude Code)`였다.

```text
/home/mcpops/ags-tests/tester-7452-20261028-r01/runtime/node-v24.22.1-linux-x64/bin/node
```

요청은 `opus/high`, 실제 init/modelUsage는 `claude-opus-5-5`다. `per_turn_effort_active`와 effective effort 값 자체는 구분하며 high의 실효 값은 미확인이다. 감독이 관측한 자기 Node 실행파일 표본 55개는 위 Node24 경로였다. 각 PID를 MCP·시험 child 역할에 결속하지 않았으므로 **실제 MCP child의 Node 버전은 UNKNOWN**이다. 실행 receipt의 `nodeVersion:24.22.1`도 `runner.mjs`가 `process.versions.node`로 기록한 캡처 프로세스 값이며 child attestation으로 확대하지 않는다. 따라서 ‘전체 프로세스 Node24’라고 보고하지 않는다.

기존 공용 `/home/mcpops/ags-tests/.heavy.lock`을 독점했고 모델 conversation 1개·turn 1개만 실행했다. turn timeout 300초, 기존 wrapper 상한 610초, 같은 감독의 outer deadline은 cleanup 여유를 포함해 630초였다. 실제 turn은 111.356초, runner/transport exit0으로 끝났다. 모델 추가 요청·재시도·T4·설치·전역 설정 변경은 없다.

## 실제 시간순서와 계획 전 명령

아래 L번호는 작성자가 읽을 권한을 받은 자기 회차에서 계산한 순번이다. 검토자는 원시 stream을 열 필요 없이 이 업무 요약과 아래 plan/receipt/test 산출물을 대조할 수 있다.

| 순번 | 직접 대조한 행동·결과 |
| --- | --- |
| L12·14 | test-engineering 호출과 현재 SKILL 본문 전체 주입. 후보 주석 네 줄도 포함. 주입 본문 SHA256 `433c9f7c73914b53f1baf7975f5fb9e22d3195c6be1e6c5939f056bf3768edfb` |
| L18·20 | regression 안에서 find/cat/ls로 fixture·기존 시험·source 읽기, `node --version`은 v24.22.1 반환 |
| L31·33 | 후보 `claude-plugin`의 스킬 파일 목록·wc, test-design/test-proof/공통 CLI 문서 cat |
| L54 | 기존 스킬 CLI `--help 2>&1 | head`와 runtime 목록 조회. `--help`는 INVALID_INPUT을 반환했으며 회귀 RED로 세지 않음 |
| L56·58 | 후보 product subtree의 wc/grep/예시·plan 참조 검색, plan schema와 engineering core 읽기 |
| L77·82 | runner/CLI·proof schema·readArtifact 구현을 cat/grep/sed로 읽기 |
| L89 | 첫 관측된 작업 파일 쓰기: regression/.evidence/task.md와 plan.json 저장. 같은 순차 Bash에서 그 plan의 check-plan 실행 |
| L90 | check-plan READY, sealed planDigest `sha256:c93f38669249a806c5c63b11ff01ac92e73adf967889b48c393db9cbebd26120` |
| L92·93 | 새 test/discount-over-100.test.mjs 첫 Write와 저장 성공. L89~90보다 뒤 |
| L98·99 | 격리 before 사본과 현재 fixed에 같은 argv로 실행. assertion RED exit1, GREEN exit0 |
| L126·127 | proof 작성과 check-proof CONSISTENT. 원본 hash 확인, 추가 기존 시험 포함 npm test와 기본 discovery는 각각 4 PASS. 자기 임시 red-copy만 이때 삭제 |

계획 전 Bash는 9회다. 실제 명령의 쓰기·범위를 별도로 대조한 조회는 `542d50862755f4106fa22fc98a9e557f6499e5c1160e7eb2`다. 이 9회에는 mkdir/cp/Write/Edit/rm 또는 이름 있는 작업 파일을 대상으로 하는 출력 redirection이 없다. `2>&1`은 stdout 연결이고 `2>/dev/null`은 stderr 버림이다. Node 버전·기존 CLI 탐색 실행 외에는 fixture 또는 후보 제품 파일 읽기였다. 모든 자동 hook·캐시·DB 효과까지 무쓰기라고 단정하지 않는다. 최종 hash 동일성만으로 중간 덮어쓰기·복원 부재를 증명하지도 않는다.

위 순서에서 **plan 저장 성공→동일 plan의 check-plan READY→첫 시험 구현**은 관측됐다. 사후 파일 존재나 검토자의 사전 계획으로 이 조건을 대신하지 않았다.

## 동일 시험 쌍과 101% 입력의 정확한 한계

plan의 C1은 할인율 **101%, 150%, 200%**를 scenario에 적었다. 숫자는 assertion의 개수나 순번이 아니다. 생성한 시험은 932 bytes, SHA256 `cb55ef5ac0f36e3d9b74aaa0d0288007e736b64e460c3d8ee3b38a3c4e5903e5`이며 RED/GREEN snapshot의 test digest·size가 같다. invoice source digest도 같고 예정된 차이는 discount source 하나다. 양 receipt argv는 정확히 `['node','--test','test/discount-over-100.test.mjs']`, timeout 30000ms, platform linux, `NODE_TEST_CONTEXT` 제거 정책도 동일하다.

| 동일하게 등록·실행된 subtest | RED | GREEN | 입력 도달 해석 |
| --- | --- | --- | --- |
| invoice total is clamped to 0 when the discount exceeds 100% | FAIL, -1250≠0 | PASS | 첫 assertion의 `invoiceTotal(lines,150)`에서 RED가 throw. 그 뒤 `invoiceTotal(lines,101)`은 RED에서 미도달, GREEN에서는 통과 |
| applyDiscount never returns a negative total | FAIL, -1000≠0 | PASS | `applyDiscount(1000,200)`의 기대값 0은 양쪽 실행 경계에 있음 |
| discounts up to 100% are unchanged by the clamp | PASS | PASS | `invoiceTotal(lines,100)===0`, `invoiceTotal(lines,99)===25` 보존 경계 |

따라서 **같은 3 subtest 집합**, RED 2 FAIL·1 PASS와 GREEN 3 PASS, 유효한 할인 버그 assertion 실패는 확인했다. 다른 npm/default-discovery 4 PASS는 이 동일쌍의 분모로 섞지 않는다. 다만 계획에 적힌 모든 입력이 양쪽에서 실제 실행됐다고는 말할 수 없다. 101%의 RED 미도달은 시험 본문과 첫 AssertionError 위치에 따른 제어 흐름 해석이며 별도 입력 추적 instrumentation을 추가하지 않았다. 전체 input 실행 보장 여부는 위 사전 문구와 이 한계를 가지고 독립 담당자가 판정해야 한다. CONSISTENT나 동일 hash·개수만으로 그 의미 판정을 대신하지 않는다.

로더·환경 오류가 아니라 `ERR_ASSERTION`으로 실패했고 stderr는 양쪽 빈 문자열이었다. L54의 --help INVALID_INPUT은 이 RED와 별개다. native 모델은 check-proof 뒤 자기 임시 `.evidence/red-copy`를 지웠으므로 현재 사본 bytes를 다시 읽어 비교할 수는 없다. 당시 snapshot·receipt·전체 assertion 출력, 원 before source와 새 시험은 남아 있으며 원본 source/초기 fixture는 바뀌지 않았다. 이 삭제도 감추지 않는다.

## 경계·남은 미확인·정리

전체 도구 호출은 Skill 1회, Bash 12회, Write 1회다. MCP 도구 호출은 0이다. 관측한 작업 파일 쓰기·임시 사본·삭제는 regression/ 아래였고 이번 회차에는 /tmp 등 경계 밖 작업 파일 명령이 없다. 자동 호스트 효과와 공유 DB 상태 변경까지 0으로 확대하지 않는다.

현재 주석을 포함한 실제 skill 주입, 선작성 이행과 위 회귀 검출은 관측했지만 **문구 수리의 인과 효과·재현성·D36 전체 수용·AGS 3.8 출시 PASS는 판정하지 않는다.** 원 NP05와 Node/CLI 조건이 바뀌었고 모델 이행 표본은 한 번뿐이다. startup hook 3건 success(exit0)와 1건 cancelled(exit1)를 보존한다. 한 init의 MCP pending은 connected 증거가 아니며 정확 취소 hook 매핑·MCP 준비/소비·cue 실제 입력 도달·effective high·자동 DB 효과는 미확인이다.

최종 조회에서 knownOwnAlivePids·knownOwnZombiePids·ownedGroupsStillPresent는 모두 빈 배열, operator `/proc` 항목 없음, driver/wrapper group cleanup CONFIRMED, 공용 lock free를 직접 확인했다. source HEAD/clean과 plugin 609파일 Git blob bytes도 전후 일치했다. group 밖 탈출 자손은 NOT_OBSERVED라 호스트 전체 잔류 없음으로 확대하지 않는다. QB/Q32 담당자와 root에게 완료·정리 ID를 전달했다. 이 작성자는 fixture·receipt·stream을 삭제하지 않았다.

## 깨끗한 근거 경로·지문

`B=/home/mcpops/ags-tests/ags38-01a14016-20261107`, `RUN=$B/claude-native-d36-b2a1ec6c-01a14016`, `E=$RUN/repo/regression/.evidence`다. source는 `$B/d36-native-b2a1ec6c-01a14016/source`, 감독 결과는 `$B/claude-native-d36-b2a1ec6c-control-01a14016/result.json`이다. 아래 JSON/test는 업무 산출물이며 원시 대화가 아니다.

| 산출물 | raw 파일 SHA256 |
| --- | --- |
| E/plan.json | 108f53bc52dba95b64f6c47433f58fc4ab845ed6aa1d641ec678d3a6bbb859e0 |
| E/red-receipt.json | e5842dc4a5178ca67a451122aacda17c1eb715583f116124afd4cbe16effbc2b |
| E/green-receipt.json | 8bc0c22b19a2f32c961b467d3b089ec0b71ba6678046ba87646c8a3e3349f209 |
| E/proof.json | 3f1d97f2ab6b69e2c2d3842e1c4557ec2753f85cb6f12e88c72f062cd678bc65 |
| E/result.json | 373ab7506493e6c7fd6b9038316974ff2c91c4718d22f6d346742d9ec37c4729 |
| regression/test/discount-over-100.test.mjs | cb55ef5ac0f36e3d9b74aaa0d0288007e736b64e460c3d8ee3b38a3c4e5903e5 |
| control/result.json | ba1066ea2838d05fb4b3f1ca997e0d0e3190c7bacbc9bedc5f0ef868706e551d |

위 raw SHA와 planDigest/receipt 내부 digest는 서로 구분한다. sealed planDigest는 check-plan이 반환한 값이고 raw SHA는 저장 파일 bytes의 hash다.

직접 회수한 조회 ID는 모두 exit0이지만 의미 PASS를 뜻하지 않는다.

- Node24/CLI 읽기 확인: `702d5fe7073a54bd8ddd227b57107fe2f15cb5a1a90cb46a`.
- 시작: `7b6ac7c024f635b64ce8d2ae85f10f9b60d7cd103c6d0c96`; actual start/pin: `daf3f31b5a3d67ef45c8b809252d60aa0be8eee114615ef0`.
- 순서·결과: `6c9310d7514af86d36ce72cb6a8e9c9ecafe14b9f5b60098`.
- cleanup·실제 주입·plan/receipt/test: `acb53feecd657cf186ece19eaf59287d38a980283dffc5fa`.
- 계획 전 command 범위: `542d50862755f4106fa22fc98a9e557f6499e5c1160e7eb2`.

원문 stream은 RUN 아래 보존했고 SHA256은 `85dc5e6ec8db40e8fb19a03df57bcd6ff68a068d29350e779b9aaea5d40f7776`이다. 이 보고서 작성자는 허용된 자기 원문만 읽었다. 독립 검토자에게 원시 대화 열람을 요청하지 않는다.
