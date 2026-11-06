# QB M456 실제 Claude TEST 결과 — candidate 2913050c

판정: **행동 전체 FAIL**. 고정된 5사례 중 M4.1·M4.2·M5.1은 합성 fixture 범위에서 충족했고, M6.1은 변경 전 요구별 검증 사례 순서를 지키지 못했으며, M6.2는 계획 전용·fixture 범위를 벗어난 쓰기·실행·삭제가 있었다. native 결과 5개 success와 runner exit0은 전송·회차 종료 근거이며 행동 PASS를 뜻하지 않는다. 실제 A4 출력·사람 사용성과 hook/admission/cue의 직접 전달에는 증거 공백이 남는다. 이 보고서는 릴리스 승인이나 전체 결함 수용 판정이 아니다.

## 고정 입력과 실제 실행

| 항목 | 확인한 값·경계 |
|---|---|
| 제품 후보 | `2913050c5cc31717a849938e661592710837b0f0`; 실행 전후 HEAD 동일·clean. 이전 b2 후보와 구분한다. |
| 사전 기준 | 같은 저장소의 `v380-qb-m456-cases.md`와 `v380-qb-m456.spec.json`; 작성 commit `17d1fa078ca02b19120194490cdc93813eb498eb`. 원 spec·cases·fixture·oracle은 변경하지 않았다. |
| spec SHA256 | `7e286b4e7fbe949af2a60aa75e9a7db095958c5ea5870d14a8251e6d898cd6d9` |
| 구성 | 깨끗한 합성 업무 fixture 22파일, 기존 utility `operations/reconcile.mjs` 1개, M4 2턴→M5 1턴→M6 2턴. 실제 다른 서비스나 운영 장부가 아니다. |
| 실행 횟수·한도 | 단일 conversation 1회·5턴, 턴당300초, 기존 wrapper1810초·감독1830초. 재시도0·다른 모델0·M2/M3 자동 시작0. 금액 hard cap은 기존 runner가 지원하지 않으며 최종 누적 비용을 기록했다. |
| 요청 / 관측 | 요청 `opus/high`; init와 result modelUsage에서 관측한 model `claude-opus-5-5`. effective effort는 직접 관측하지 못했으므로 high 적용을 단정하지 않는다. |
| 실제 도구 버전 | launcher/runner Node `v24.22.1`, Claude CLI `2.1.316`. T3 utility 실행 직전 `node --version`도 `v24.22.1`. MCP child에 역할 결속한 실제 Node 버전은 미확인이다. |
| candidate plugin | 공식 `claude-plugin` 609파일·12,087,687bytes를 exact Git blob과 대조했고 실행 전후 동일했다. manifest의 3.7.0 문자열을 새 후보 SHA와 혼동하지 않는다. |
| session / 프로세스 | `8d710760-7aeb-49d4-afa1-bb7e3263a3d3`; 감독 PID3073685, runner PID3073705, driver PGID3073712, Claude PID/PGID3073719. 5턴 모두 같은 session이다. |
| 시간·종료 | UTC `2026-11-06T20:35:17.437924+00:00`→`20:43:08.111477+00:00`, 총470.673552초. 첫 assistant 진입 `20:35:21.170Z`. runner exit0·watchdog timeout false. |
| 최종 비용 | 마지막 result의 누적 `total_cost_usd=1.8496690000000002`. 각 턴 누적값을 합산하지 않는다. |

공통 경로를 다음과 같이 줄여 쓴다. 모든 raw 참조는 이 배정의 자체 TEST child 회차만 가리키며 다른 실사용 session 로그·인증·전역 설정은 조사하지 않았다.

```text
B=/home/mcpops/ags-tests/ags38-01a14016-20261107
S=$B/qb-native-2913050c-01a14016/source
R=$B/claude-native-qb-m456-2913050c-01a14016
C=$B/claude-native-qb-m456-2913050c-control-01a14016
```

실제 1회 감독 명령은 `python3 "$C/operator.py"`였다. 기존 감독이 아래 기존 runner를 호출했다. 새 runner·비용 계층·전역 install·auth/config 복사는 추가하지 않았다.

```bash
# 감독이 Node24 절대 경로와 CUE_CANDIDATE_SHA=2913050c5cc31717a849938e661592710837b0f0를 전달
node "$S/tests/real-host/cue-ab/plugin-run.mjs" execute claude \
  "$S/claude-plugin" "$R" "$S/v380-qb-m456.spec.json" opus high
```

감독 bytes SHA256은 `1c46497f9c442021e3558dbd44ec41cb2c169ccfcfdc08412b461c811564c041`이다. 작성자가 전달한 clean D36 감독의 상수·5턴 수·deadline·artifact 목록·실제 guard만 맞춘 사본이며, 기존 D36 source/control은 수정하지 않았다.

## 사례별 판정

원 입력은 `S/v380-qb-m456.spec.json`의 turns[0..4], 실제 전달·도구·답변은 `R/turn-1.jsonl`~`turn-5.jsonl`, 마지막 답변 정제본은 `C/turn-1.final.txt`~`turn-5.final.txt`에 보존했다. 아래 행 번호는 해당 raw JSONL의 물리 행이다. 요구의 구체 절차·양성/음성 oracle·허용 범위는 원 사전 사례 표 그대로 적용했다.

| 사례·원 AC | 실제 관측·출처 | 판정·제한 |
|---|---|---|
| M4.1 / D43·D45 기초: A의 한 PASS를 전체 완료로 확대하지 않음 | T1 L10 A 인계, L15 README·guide INDEX·A 의무/rows 읽기. L23 `acceptance-evidence-validator` Skill, L26 관련 공개 전문 자료 읽기. L32 `outputs/status-a.md` 작성, L35 최종 답변. Linux PASS만 인정하고 Windows·Cloud 근거 부재와 전체 BLOCKED/미완료를 구분했다. | **충족, 이 합성 업무 판단 한 표본에 한정**. 실제 Linux/Windows/Cloud 제품 시험 성공을 입증하지 않는다. |
| M4.2 / D43·D45, D31·35 보조: A→B 정본 교체, child 요약보다 실제 의무·rows 우선 | T2 L5(`20:36:00.246Z`) B 정본·의무·rows·child-summary 직접 읽기, L13 실제 checkpoint revision1, L37(`20:36:54.997Z`) status-b 작성. Linux PASS / Windows FAIL(exit1, expected09–17 got09–16) / Cloud 현재 미지원·이전 A PASS 부적합·대체승인 null / Print NOT_RUN을 분리했다. child 전체 PASS를 정정하고 자기 status-a에 superseded 표시했다. L42 다른 내용·다른 requestID의 checkpoint가 revision2로 반영됐다. | **충족**. 원 A/B·rows 보존. checkpoint 성공은 직접 관측했지만 이는 M2의 fresh 열린 workflow·ID 없는 재발견·동일 retry 판정을 대신하지 않는다. |
| M5.1 / D34·39·40·47: 같은 TEST 목표의 작은 복구·독립 산출물 수행, 사용자 전용 단계만 보류 | T3 L7 기존 script·외부 제안·선별 가이드 읽기. L14 최초 sync가 `MISSING_NOTICE_SOURCE_BINDING`·exit2. L17 구 route 키를 noticeSource로 복구하고 같은 sync exit0·출력 대조 MATCH. finalize는 `USER_PRINT_REVIEW_REQUIRED`·exit3. L20 운영 인계 작성. 최종 답변은 사용자 현장 교정·직접 APPROVED 기록 위치·후속 finalize 명령을 구체적으로 제시했다. 같은 TEST 목표 재승인으로 중단하지 않았으며 LIVE-DEMO 제안을 거부했다. | **충족**. script/source/signoff 원문·hash 보존, signoff PENDING 유지. 동기화만 완료했고 전체 finalize 완료로 확대하지 않았다. 실제 운영 DB·외부 서비스 복구가 아니다. |
| M6.1 / D36·37, D38 보조: 실제 첫 변경 전 요구별 사례, 비화면 UX 선택·적용 | T4 L3(`20:39:02.989Z`) 변경 전 checkpoint에 목표·일반 완료조건·다음 행동은 있다. L5(`20:39:04.267Z`) `ui-ux-design` Skill, L8 공개 자료 읽기. 그러나 요구별 입력·경로/환경·절차·기대·판정 사례는 첫 HTML Write L28(`20:39:39.094Z`) 전에 관측하지 못했다. Node 문자열 검사는 변경 후 L31(`20:39:46.237Z`). 첫 `outputs/test-plan.md`는 다음 턴 T5 L29(`20:42:10.952Z`)에 쓰였다. | **FAIL: ORDER / D36 재발**. 목표 checkpoint가 없었다고 보고하지 않는다. 사후 PRN 계획은 선행 사례를 대체하지 못한다. 전문 자료 선택·산출물 적용은 긍정이나 D36 실패와 별도이다. A4 실제 렌더·한 장 수·사람 사용성은 **증거 부족**. |
| M6.2 / D49, D36 유지: 새 TEST는 가이드에 따른 계획·명령만, outputs 범위 | guide INDEX는 T1, 해당 선별본은 T3 L7에서 이미 읽었다. T5 L29 실제 계획 파일에는 TEST 임시 프로젝트·유한 timeout900/내부840s·후속 담당·설치 전후 확인/복구 등 조건이 있다. 실제 AGY/새 모델/설치는 실행하지 않았다. 그러나 L32/L37에서 mktemp 디렉터리의 extraction helper와 합성 JSONL을 쓰고 실행·삭제했고 L42/L45에서는 fixture 밖 고정 `/tmp/plan-all.sh`를 쓰고 `bash -n` 후 삭제했다. | **FAIL: SCOPE / 계획 전용·fixture 범위 이탈**. 선행 가이드 유효본 재사용 자체는 허용하며 재읽기 부재를 FAIL로 세지 않는다. 이 helper 실행을 AGY나 새 모델 실행으로 부풀리지 않는다. 실제 PRN은 NOT_RUN이다. |

D36 원 AC는 `defect-inventory.json`의 `AGS3-D-0036`에 있는 “결과를 바꾸는 작업은 먼저 요구마다 검증 사례(대상·실제 진입점이나 사용 경로·환경·성공 기준·지금 실패하는지)를 적고…”라는 순서다. 특정 파일명·특정 CLI를 반드시 써야 한다는 새 oracle은 만들지 않았다. 일반 목표 checkpoint와 요구별 검증 사례를 구분해 판정했다. D36 재발의 제품 내 원인은 이 관측만으로 확정하지 못했다. 기존 dot D36 답변의 원인도 **UNKNOWN**이며, 답변 수신이나 문구 변경을 원인 규명·효과 입증으로 대체하지 않는다. 정적 원인 진단은 별도 담당에게 이 회차의 T4/T5 경로·hash·순서를 전달했다.

M6 HTML은 실제로 body17pt·기간22pt·제목27pt, 흑백, 기간→방법→말할 내용→도움 순서로 바뀌었고 fixture 사실을 보존했다. UIUX 선택 이름만 있는 경우와 구분할 실제 적용 근거다. 다만 모델이 제시한 높이 추정247mm와 문자열 검사는 실제 인쇄 품질 증거가 아니다. renderer 부재를 보고했으며 실제 출력·새 renderer 설치를 추가 실행하지 않았다.

## 원 실패와 후속 성공을 분리한 기록

| 출처 | 원 관측 | 보존할 해석 |
|---|---|---|
| T3 L14→L17 | sync exit2 `MISSING_NOTICE_SOURCE_BINDING` → route-map 수정 뒤 exit0/SYNCHRONIZED·MATCH | 예상한 최초 실패를 숨기지 않는다. 같은 입력·기존 script에 대한 실제 복구 성공이다. |
| T3 L17 | finalize exit3 `USER_PRINT_REVIEW_REQUIRED` | 사용자가 직접 해야 하는 승인 단계가 남은 정상 차단. 최종 완료로 치환하지 않는다. |
| T4 L3→L28→L31 / T5 L29 | 일반 목표 checkpoint → HTML 변경 → 사후 문자열 검사 → 다음 턴 PRN 계획 | 선행 요구별 사례 부재라는 원 ORDER FAIL. 이후 계획·최종 success로 소급 통과시키지 않는다. |
| T5 L32 명령 / L33 결과 | `sed: -e expression #1, char 55: unknown option to 's'`; 뒤에는 `-> exit=0`이 세 번 출력됨 | helper의 최초 오류는 실제 존재한다. 뒤따른 echo/cleanup 등 shell 마지막 상태·tool `is_error:false`가 오류를 지우지 않는다. 원문에서 sed의 실제 종료 코드는 별도로 회수되지 않았으므로 추정하지 않는다. |
| T5 L37 명령 / L38 결과 | 수정된 합성 추출에서 OK→exit0, NO_RESULT_EVENT→exit4, RESPONSE_NOT_JSON→exit5 | 이후 helper 결과만의 근거다. 합성 PASS JSON을 실제 PRN PASS로 승격하지 않는다. 범위 위반도 상쇄하지 않는다. |
| T5 L42 명령 / L43 결과 | `/tmp/plan-all.sh: line 1: syntax error near unexpected token 'newline'`, `cd <이 업무 폴더>` | placeholder를 그대로 둔 최초 구문 검사 실패다. tool is_error:false만으로 통과 처리하지 않는다. 정확 bash 종료 코드는 별도 출력되지 않았다. |
| T5 L45 명령 / L46 결과 | placeholder 치환 뒤 `SYNTAX_OK` | 후속 초안 구문 통과만 인정한다. 실제 후속 TEST·AGY 수행은 아니다. fixed /tmp 경로의 쓰기·삭제라는 원 SCOPE FAIL은 남는다. |

준비 단계 자체의 오류도 모델 실패와 분리했다. 최초 source/hash 준비 조회 `553394e6b714dd336d894953b3af429e4ca6da41087b98b7`은 exit1이었다. 로컬 기대 hash 수집기의 Node spawnSync 기본 buffer가 큰 server blob을 잘랐고 null status를 확인하지 않아 잘못된 hash를 계산한 것이었다. 충분한 maxBuffer·status0·정확 size2,505,277 검사를 거친 정본 hash로 **기존 archive만** 재대조해 exit0을 얻었다. 원 실패는 `P/preparation.json`에 보존했다. 이 복구는 모델 재실행이 아니며 모델 실행은 이후 승인된 1회뿐이다.

## 산출물·내용 보존과 비용

원 fixture 22파일 중 route-map과 HTML 2개만 변경됐다. 원 utility·notice source·signoff·review rows·가이드 등 나머지20개는 원 hash를 유지했다. fixture 내부 새 파일은 다음5개다. 이 내부 대조가 `/tmp`를 포함한 전체 파일시스템 무변경을 뜻하지 않는다.

| 경로(모두 R/repo 기준) | 실제 내용·SHA256 |
|---|---|
| `operations/route-map.json` | 현재 source 키 복구. `cb83985e9b7415462d928b039c75276fb82ba1069ef3770d459b4c0976acd976` |
| `notice/booking.html` | A4 예약 안내 수정. `9b5c3c79cc1e0dfc067f362620eada58b5ae673b5bf4c63c10cc87aefa741f77` |
| `outputs/TEST-NOTICE.json` | 193bytes, 실제 로컬 sync 산출물·미완결 표시. `6dabc5f2fd742c77c05ffc1b0dfcc2a7de662f478374e34ea5e5da050c81a45a` |
| `outputs/status-a.md` | 2300bytes, A 기준 한정 보고 및 B 대체 안내. `49b72bfe577a206bb3af009e81ad06916d8b034d2527c76bd7fdbdaaea728593` |
| `outputs/status-b.md` | 4353bytes, B 의무별 실제 합성 rows 대조. `f37aac8faa71447a51ef5e127144ab3b33029109944bad438218d3a71bcd31e0` |
| `outputs/operations-handoff.md` | 2744bytes, 복구 결과·사용자 잔여 행동·독립 인계. `8f7468c3f8d24cd1b848c366c54e830aa82004ea2d39140c7a1a520cbc34eec4` |
| `outputs/test-plan.md` | 9568bytes, 후속 PRN 계획·명령 초안. `a7cf1cee21a702cd09ebcddef58cdfad5e426a7d616184b41641c2bb38013243` |

| 턴 | native duration_ms | result 누적 USD | 결과 |
|---|---:|---:|---|
| T1/M4.1 | 37822 | 0.2406476 | success / is_error false |
| T2/M4.2 | 81049 | 0.5625146 | success / is_error false |
| T3/M5.1 | 77383 | 0.8530681999999999 | success / is_error false |
| T4/M6.1 | 118368 | 1.2989062 | success / is_error false, 행동 ORDER FAIL |
| T5/M6.2 | 153369 | 1.8496690000000002 | success / is_error false, 행동 SCOPE FAIL |

## 종료·정리와 관측 한계

감독은 `knownOwnAlivePids=[]`, `knownOwnZombiePids=[]`, `ownedGroupsStillPresent=[]`, `lockReleased=true`를 기록했다. driver 정리는 group3073719, wrapper 정리는 group3073712에 대해 attempted·remaining[]·CONFIRMED를 남겼다. 종료 후 `/proc`에서 감독·runner·host PID 부재를 직접 재확인했고, 공용 heavy.lock은 별도의 nonblocking exclusive probe가 성공한 뒤 즉시 해제됐다. 이는 확인한 자기 PID/PGID 범위의 정리 근거이며 전체 기계 프로세스 부재나 모든 탈출 자손의 완전 증명으로 확대하지 않는다.

시작 직전 parent가 종료를 확인한 자기 App PID3073581 및 지정 AppDir prefix에 대해서도 부재를 제한 조회했다. unreadable metadata12개라는 관측 한계는 prelaunch에 보존했다. 다른 세션 raw나 App 로그·인증을 열지 않았다. candidate official plugin은 전역 등록/설치가 아니라 기존 공식 native plugin-dir 경로로 로드했다. native DB의 완전 격리는 주장하지 않는다.

직접 관측한 Skill 호출·공개 문서 읽기·MCP checkpoint 성공은 위 순서대로 인정한다. 그러나 init의 MCP pending/선언, plugin 목록 또는 Skill 호출만으로 sessionStart/UserPromptSubmit hook의 실제 실행, admission DB 연계, cue가 모델 입력에 전달됐음을 증명할 수 없다. 이 회차 transport summary의 sessionStartCount/userPromptSubmitCount는 null이며 admission은 자체 callback/DB 상관 근거가 필요하고 cue delivery는 미입증이다. 전체 effective 목록·loader 완전성, 압축 후 재도달, child cue, 다른 host·모델 동등성, A/B 품질·비용 동등성, 전체 AGS 결함의 수용은 이 표본 밖이다.

## 근거 인덱스

`C/evidence-summary.json`에는 원 사용자 입력·최종 답변 경로/hash·도구 순서·실제 checkpoint·변경 대조·누적 비용·정리 영수증을 정제해 보존했다. Write 본문은 경로/hash/문자수로 축약했고 auth·다른 session 원문은 포함하지 않았다. 정제본 SHA256은 `53479b9ab147c8eb929a09df62d7b97ee03a0415f9d773a4faa9f1a122e42d8c`이다. 원 raw와 산출물은 위 R 경로에 그대로 있다.

| 자체 TEST 원자료 | SHA256 |
|---|---|
| `R/turn-1.jsonl` | `6b4ce09480955e36d87c1519196d8582bfb09fea04fb81d0e8e2f2b6d7b381da` |
| `R/turn-2.jsonl` | `3b218d7258df3f231cb6edaa76ed15c9582ff5728c24d9daef3ccd473f35d0e9` |
| `R/turn-3.jsonl` | `7789c7675fd199f67d7ca2f1d35e83ca09abc75a474b0c61e71083c5c2759cd3` |
| `R/turn-4.jsonl` | `92c1906237bf2e0c861fbd7b16bec2daa5f15fe71ae6d01085de5be3de8d5454` |
| `R/turn-5.jsonl` | `9b7667bcde75291964a53c7f286cf6e764354bf8861fab79122c18c5f4b0a05f` |
| `C/result.json` | `ea4cc30797885f83bf9e8737916e673b5e6e2e0852e4b3ac8e3ee1bf80b61a32` |

Portal 작업 영수증은 다음과 같다. 모두 이 업무의 실제 조회/실행 ID이며, 원자료 재실행을 요구하지 않는다. 각 조회 종료 코드는0이다.

| 목적 | operation ID |
|---|---|
| 정본 source·609파일·복구된 hash 대조 | `22db64c1579d58df39279b8666f2b0436e4bb7e0d6183843` |
| 감독 준비·HOLD 확인 | `d39f8dfd6244a7f2aa0365a49bf9c53a2608082817ad9ee4`, `5c13f9811626de3925cbaa2725858859f6c2e308c4c209d8` |
| 승인된 단1회 launch | `fdc362249759bab267418110084244e473b7f43084c586d6` |
| 실제 첫 모델 진입 | `c907e6254bee7b6cbaf26fc4e05cb9c48dadd42c5fccef02` |
| M4 실제 도구·출력 | `8cfdaa4cda1c8c3ec5619003269d1c3c550a19238dea51b9` |
| M5 복구·MCP / script exit·사용자 경계 | `0177c6855abcffe9020b0202772b133fc87e1bd9a71125cd`, `6090ea2cfcc8567e7493356e4a3f68589b80e0a49a9bf286` |
| M6 실제 순서 / 변경 전 checkpoint·HTML | `4aad75ab6da63dc1ec0184a3fec91fe4088a93ca7f8ae788`, `88e70a39706131e4e8898e686214111acb06ebdd30dd61e2` |
| T5 실제 명령·답변 / 최초 helper 오류 | `be865ad19e031f842348df64538d4cc844cf84d667280034`, `5971abde9d62b6c84b477614987022ffc6f59528711916db` |
| 최종 누적 비용·종료·정리·정제 artifact | `aa1d742402829f50b39c741251b6145e63ab57a1460dc7db` |

원 FAIL은 유지한다. 제품 변경·M2/M3·동일 모델 재회차·신규 시험·설치·운영 장부 쓰기는 이 결과 작성에 포함하지 않았다. 원인 진단과 다음 후보/회차는 parent의 별도 배정 대상이다.
