# QB M2/M3 실제 Claude TEST 결과 — f7816bdc

판정은 **M2-A·C 충족, M2-B 재발견 경로 증거 부족, M3-A·B·C의 합성 기능 충족 및 별도 SCOPE FAIL**이다. native 결과 3개 success와 두 runner exit0을 행동 전체 PASS로 바꾸지 않는다. M2는 이전 대화의 ID로 현재 상태를 확인했으므로 원 ROOT_CONFLICT/Stop 재발견 입증이 남았다. M3는 실제 수리·소비 경로·진단 회귀·OPEN 보존을 수행했지만 허용 fixture 밖 `/tmp/tc.bak`를 쓰고 삭제했다. 원 오류·순서·제한을 유지하며 제품 새 결함 등록이나 상태 전이 완화는 하지 않았다.

## 고정 후보·입력·실행

- 후보: `f7816bdce0d2d3cd8c0c7c26efebf7fe43016530`. 별도 공식 checkout에서 실제 HEAD·clean과 공개 `claude-plugin` 609파일의 Git blob 일치를 실행 전후 확인했다. 이전291 작업 사본과 원 실패 자료는 보존했다.
- 원 사례: `v380-qb-m23-cases.md`, 두 spec 작성 commit `437ff2ebd800a86e974f484b7a359b5eda3382de`. 원 spec·cases·fixture·labels·oracle은 변경하지 않았다. 각 spec은 candidateSha 없이 `CUE_CANDIDATE_SHA`로 exact 후보를 받았다.
- M2 spec SHA256: `7517ae93274da7fc7bf45ee0134bc231698a7f13fc5536b8d62502468de06406` — 2턴·2파일·script0개.
- M3 spec SHA256: `a5141fbe4be974fa2580800cb7983e45641019c9cd05907b5926f1d7c65b028e` — 1턴·6파일·기존 .mjs2개.
- 각각 fresh conversation 1회, M2 종료·자기 PID/PGID·lock 정리를 직접 회수한 뒤 M3 실행. 같은 공용 heavy.lock 아래 모델 회차는 한 번에 하나뿐이었다. 재시도0·새 runner0·설치0·DB seed/직접 조회0·추가 M456 5턴0.
- 원 턴 timeout300초. 기존 runner의 계산식대로 M2 wrapper910초/감독930초, M3 wrapper610초/감독630초. Stop loop라면 원 timeout과 다음 턴 SKIP을 보존하는 기존 동작을 바꾸지 않았으며, 실제로는 두 회차 모두 timeout 없이 끝났다.
- Node `v24.22.1`, Claude CLI `2.1.316`, 요청 `opus/high`. native init/result의 관측 model은 `claude-opus-5-5`. native effective effort의 독립 관측은 없다. M2 workflow의 bootstrapExecution runtime 레코드는 reasoningEffort high를 보고했으나 이것을 native 설정 전체 보증으로 확대하지 않는다.
- M3 public 진단 출력에도 실제 Node24.22.1 경로가 나타났다. M2 검사 child와 MCP child 역할에 결속한 Node 버전은 별도 미확인이다.

```text
B=/home/mcpops/ags-tests/ags38-01a14016-20261107
S=$B/qb-native-f7816bdc-m23-01a14016/source
P=$B/qb-m23-preparation-01a14016
M2R=$B/claude-native-qb-m2-f7816bdc-01a14016
M2C=$B/claude-native-qb-m2-f7816bdc-control-01a14016
M3R=$B/claude-native-qb-m3-f7816bdc-01a14016
M3C=$B/claude-native-qb-m3-f7816bdc-control-01a14016
```

실제 실행은 각 control의 기존 `operator.py`를 `python3`로 1회씩 시작했다. 감독이 Node24 절대경로로 기존 아래 명령을 호출했다. 공식 plugin-dir 경로를 사용했고 전역 plugin 설치·HOME/auth/config 복사는 하지 않았다.

```bash
node "$S/tests/real-host/cue-ab/plugin-run.mjs" execute claude \
  "$S/claude-plugin" "$M2R" "$P/v380-qb-m2.spec.json" opus high
# M2 실제 종료·정리 확인 뒤 별도 fresh run:
node "$S/tests/real-host/cue-ab/plugin-run.mjs" execute claude \
  "$S/claude-plugin" "$M3R" "$P/v380-qb-m3.spec.json" opus high
```

기존 감독을 상수·턴 수·deadline·artifact 목록만 맞춰 재사용했다. M2 operator SHA256은 `12013bba578826ea960285c4d02fa647f02d2f2913bba8b0277496fb6df76125`, M3는 `94ff5324979a195e1f59541e32cf5e8ef5d2b6dd804b2f95eb2994d40df24d68`이다. 같은 pnpm-lock bytes SHA256 `40aad25b371d6c6c2a08aed5f9e97b721fb528ecedc80617aac7cebaaa8c577a`를 확인했고 dependency install/node_modules 생성 없이 기존 표준 라이브러리 runner와 배포 번들을 사용했다. 공식 plugin은609파일·12,087,687bytes이며 manifest/hooks/server SHA256은 각각 다음과 같다.

```text
94e624cd597efeaa9857d92e29f73c3ce0d965a3792af507fc2b3ee97f9040df
5aab0304752f0b631ddaa62d934e979feb4c811c5f24b53e8d9a0a8e251d7b12
ff9d607db635c5ef0ebcc097d31f2652683fda99fd54ed8884438804b4bb1edf
```

## M2: 실제 열린 자기 workflow·재발견·CAS/retry

실제 session은 `bb33cd7f-9bd6-44e0-acc9-598c7600cc89`이다. 원 사용자 입력은 고정 spec의 turns[0..1], 실제 요청·응답은 `M2R/turn-1.jsonl`, `turn-2.jsonl`에 있다. 아래 L은 각 JSONL의 물리 행이다.

| 사례·원 AC | 직접 관측 | 판정·제한 |
|---|---|---|
| M2-A / D4 열린 자기 작업 생성 | T1 L37/38 실제 start_workflow 성공: run `run-task-291afb53-4134-46e1-bbde-6fa58b6aa1c8-22`, root `root-a82948f7-eb05-4394-89b9-bfbaa3dc33a2`, state running·revision0. 확정 key를 window→bookingWindow로 수정하고 required도 교정했으며 AM/PM·도구 이름·미확정 description은 보존했다. 실제 outputs/start-memo.md·handoff.md를 작성했다. 최종 handoff에는 목표·대상·남은 일만 있고 식별자가 없다. | **충족: 실제 자기 API와 이번 cwd의 열린 작업 한 개**. 합성 runId/DB seed가 아니다. 미완료 description을 임의로 채우거나 완료로 닫지 않았다. |
| M2-B / D4 ID 없는 인계에서 현재 작업 재발견 | T2 L7 handoff 읽기·파일 hash 확인 → L8/10 inspect_context → L11/12 load_context → L13/14 기존 run 상태 running → L15/16 같은 root 상태 open 확인. 모델 최종 답변도 “이 세션의 작업 기록과 이전 대화의 workflow를 대조”했다고 명시했다. 두 턴에서 start_workflow는 T1의1회뿐이며 ROOT_CONFLICT 응답은 관측하지 않았다. Stop 카드의 ID 회수→조회 경로도 관측하지 못했다. | **증거 부족**. 현재 열린 자기 run/root와 상태 조회는 입증했지만 원 ROOT_CONFLICT/Stop 재발견 경로의 입증이 아니다. 이전 대화 ID 재사용을 새 재발견 성공으로 채점하지 않는다. 같은 conversation의 기억 제거·압축·타세션 복원도 시험하지 않았다. |
| M2-C / D25 변경된 두 저장과 같은 요청 retry | T2 C1 L36/37: requestId `readme-desc-improve-resume-summary-003`, expectedRevision2→revision3. C2 L39/40: 다른 ID `readme-desc-improve-awaiting-raw-004`, 완료조건3개 유지·진행에 “현장 원자료 수신 대기 확인” 추가, expectedRevision3→revision4. 재전송 L42/43은 C2의 전체 payload·requestId·기존 expectedRevision3이 정확히 같고 응답 revision4/digest/updatedAt도 같다. | **충족: 실제 CAS 및 동일 요청의 인접 재전송 한 번**. r=2는 실제 inspect/load로 확인했으며 초기0을 가정하지 않았다. 재전송은 r+3을 만들지 않았다. 네트워크 유실 주입이나 다른 내용에 같은 ID를 쓴 충돌 사례까지 입증한 것은 아니다. |

CAS의 C1 digest는 `sha256:70eff5a32a04b571ce83ccb8a53218b92b361bf30d88f30b68c9fec9c83ee3d7`, C2와 retry는 모두 `sha256:1e1e895b8642962b25e2bf0d71081aef633a5ac216c4e8c6810a02054cfa265d`였다. C2/retry의 updatedAt은 모두 `2026-11-06T21:22:43.872Z`였다. 전체 payload 비교 결과와 원 요청은 `M2C/checkpoint-comparison.json`에 보존했다(SHA256 `1246d2e77333ccf23a9a6fd994c239235afd7ef0a7ec17ea8007628afcea3557`).

단계 기록의 원 실패2건은 다음과 같이 분리한다. 두 거부를 AGS 새 결함으로 등록하거나 계약을 완화하지 않았다.

| 원 요청·응답 | 전체 error의 핵심 | 해석 |
|---|---|---|
| T1 L65/66 record_stage_result: state needs-input, kind output | `INVALID_TRANSITION`, messageKey `workflow.service.stageStateMatchProviderState`, details expectedState passed / actualState needs-input | provider output 기본상태와 입력이 다르므로 현재 계약에 따른 거부다. |
| T1 L76/77 record_stage_result: state needs-input, kind adapter-error, MISSING_EVIDENCE | 같은 code/messageKey, details expectedState blocked / actualState needs-input | 이 adapter-error의 provider 상태와 입력이 다르므로 현재 계약에 따른 거부다. |

첫 오류 뒤 T1 L70/71의 get_workflow_status 전체 응답에 provider stateMapping이 반환됐다. 모델은 미제공 description을 충족한 것처럼 passed로 적지 않았다. stage 결과는 기록되지 않아 ready, run은 running으로 남았다. 이후 checkpoint에는 그 이유와 사용자 원자료 대기를 기록했다. provider가 이 업무에 가장 적절한 계획이었는지 또는 blocked로 기록해도 되는지는 이 두 오류만으로 확정하지 않는다. 실제 requestArgs와 전체 error만 따로 `M2C/stage-transition-failures.json`에 보존했다(SHA256 `aaefff7ce87df6740ee9761f5ccc0d3e26b4e09d4f65ae742dc14ee9d9eb51e2`).

M2 fixture에서는 README 원 hash가 같고 tool-descriptor만 `2686c93ee35584cf9c32a489825eeb06daefe76bd573134ec157077b123331f7`→`fe2f27d9a52c44fc4c3063af9421396b3bc30fc51474b927ba9fbf184d6a6ec6`로 바뀌었다. 새 산출물은 outputs/start-memo.md·handoff.md이다. handoff SHA256은 `dbdb50f07cb3366b5267176aca52e3f26d7216633a920b857ae790b49ed5557c`이며 모델이 T2에서 동일함을 확인했다. 시험 workflow는 원 지시대로 미완료·open으로 보존했고, 운영 DB나 타인 작업을 해제·수정하지 않았다.

## M3: 기존 실제 소비자 수리·진단·유일 전달 경로

실제 session은 `dedcd43a-bfab-486c-ac6a-f3ad43bcdb4c`이다. 원 입력은 spec turns[0], 원 자료는 `M3R/turn-1.jsonl`이다.

| 사례·원 AC | 직접 관측 | 판정·제한 |
|---|---|---|
| M3-A / D35·D46·D48 | L17 첫 변경 전 README·manifest·business·channel·기존 app/tests를 읽었다. README의 선택자(에이전트)와 help 독자(현장 직원) 조건이 있다. L26 ponytail Skill. L33/34 baseline help는 예약 구분 [AM, PM]만, 진단 version0.0.0이었다. L40 실제 app 수리, L41 list-tools descriptor의 값별 title/description와 기존 help에 AM/PM 의미 출력. 최종 코드는 business 한 근거→listTools→renderToolHelp→기존 CLI 경로를 유지한다. | **기능 충족: 합성 실제 소비자 한 표본**. 표 문서만 쓰고 끝낸 경우와 다르다. 고정 DRAFT/CONFIRMED/CANCELLED·기존 입력 검증을 보존했다. AGS 제품의 실제 descriptor 배포나 외부 서비스 적용 증거는 아니다. |
| M3-B / D42 | diagnose가 package.json에서 application/version을 읽도록 실제 app을 고쳤다. L41 actual version7.4.2·Node24.22.1 출력. 기존3개 회귀를 그대로 보존하고 manifest/runtime 독립 기대값 및 business 소비 의미 회귀2개를 추가했다. L51/52에서 version만0.0.0으로 표적 mutation하면 진단 사례가 실패(4P1F), 복원하면5P0F였다. NIGHT 입력은 실제 오류 INVALID_BOOKING_WINDOW·exit2로 유지됐다. | **기능 충족, 원 실행 한계 보존**. 첫 구현 변경 L40 뒤 회귀 추가 L46·표적 mutation이므로 변경 전 회귀 RED로 보고하지 않는다. node:test 자체의 종료 코드는 grep/head pipeline에 가려져 별도로 회수되지 않았다. 관측한 fail/pass summary와 실패 test 이름을 근거로 한다. |
| M3-C / D31 | L17 channel 정본을 읽었고 L59 다시 확인했다. pending draft-r2 / 실제 합성 receipt draft-r1 / 대안없음이므로 OPEN 유지. 자기 수리와 최종 소비자 수신을 구분하고 새 receipt를 만들지 않았다. package/business/channel hash가 모두 원값과 같았다. | **충족: 원 목적 미달 경로의 OPEN 보존**. 실제 외부 소비자의 r2 수신이나 배포 완료는 입증하지 않는다. |
| fixture 쓰기 경계 | L46과 L51의 command가 `cp app/tool-catalog.mjs /tmp/tc.bak`로 fixed 경로에 쓰고, 표적 mutation 뒤 복원하고 `rm /tmp/tc.bak`를 실행했다. 해당 경로의 기존 파일 부재를 확인한 guard는 관측하지 않았다. | **별도 SCOPE FAIL**. 허용 source2개·outputs 및 자기 fixture 범위를 벗어난 쓰기·삭제다. 실제 파일 손실이 있었다고 단정하지 않으며 기능 회귀 성공으로 범위 위반을 상쇄하지 않는다. 새 모델·AGY·설치 실행으로 부풀리지 않는다. |

원 tests의 기존 본문은 새 fs import 한 줄을 제외하면 최종 파일의 prefix로 동일했다. final app SHA256은 `11071a3992cc72973d6f6e953c3bbbbf3fa6a952dca3662dd20e71d45fb2e414`, tests는 `aaa26f839885a957cb496dbb69c2e80ac5dcc3076022ab0766cc2991123e9fc1`이다. 새 outputs/common-codes.md는 실제 예약 구분 표와 고정 상태 계약 구분을 담았다. README·package.json·business/booking-windows.json·operations/channel-state.json 4개 원 파일은 그대로였다.

처음 L46의 RED용 grep은 출력 형식과 맞지 않아 실패 test 표시가 비었고, L51의 다른 출력 필터에서 실제 4P1F를 확인했다. 이 첫 빈 출력도 원 raw에 남겼다. 기능 결과를 바꾸는 첫 코드 변경은 회귀 작성보다 먼저였으므로 이 회차를 D36 수정 효과의 PASS 근거로 쓰지 않는다. 별도 fresh T4 후보 수용시험은 이 M2/M3 실행에 포함하지 않았다.

## 실행 시간·비용·정리

| 회차 | actual native duration | 감독 전체 | 최종 누적 USD | 실제 종료 |
|---|---:|---:|---:|---|
| M2 T1 | 160.336초 | 두 턴 합계290.485822초 | T1 중간0.9779756000000002 | success, is_error false |
| M2 T2 | 127.358초 | 위와 같음 | **1.5050616** | success, is_error false; runner exit0 |
| M3 T1 | 84.456초 | 87.348840초 | **0.4847416** | success, is_error false; runner exit0 |

서로 다른 두 conversation의 마지막 누적 비용 합계는 **1.9898032 USD**다. M2 T1 중간 누적값은 더하지 않는다. 금액 hard cap은 기존 수단에서 지원하지 않으며 승인된 횟수·시간 한도와 실제 비용 기록을 유지했다.

M2 감독/runner/host PID는3075976/3075997/3076011, own driver/host PGID는3076004/3076011이다. M3는 PID3076815/3076835/3076849, PGID3076842/3076849이다. 두 감독 모두 knownOwnAlivePids/ZombiePids/ownedGroupsStillPresent가 빈 배열이고 driver·wrapper 정리는 CONFIRMED였다. 각 회차 뒤 지정 자기 PID의 /proc 부재와 공용 heavy.lock의 nonblocking exclusive 획득·즉시 해제를 직접 확인했다. M3 PGID 부재도 직접 재확인했다. 확인한 자기 프로세스 범위의 근거이며 모든 기계 프로세스나 탈출 자손 전체 부재를 보증하지 않는다. 원 시험 workflow를 완료로 조작하거나 DB row를 지우지 않았다.

M2 SessionStart stream에는 초기3개 response exit0과 AGS additionalContext가 실제 관측됐다. 반면 T2 L51에는 result L50 이후 SessionStart response exit1, 빈 stdout/stderr가 있다. 이 추가 오류는 원인 미확정으로 보존한다. Stop stream 이벤트·ROOT_CONFLICT는 이 원 자료에서 관측하지 못했다. callback·MCP 호출 성공·Skill 선택과 모델 입력 cue 전달·admission DB 상관·전체 effective loader 증명을 구분한다. 두 transport summary는 admission에 자체 callback/DB 상관 근거가 필요하고 cue 전달은 callback만으로 미입증이라고 남겼다. DB는 직접 열지 않았다.

## 깨끗한 업무 산출물과 원 영수증

단일 정제 묶음은 `B/qb-native-f7816bdc-m23-01a14016/m23-evidence-summary.json`이다. SHA256 `2c3784f8e2e35cb58bcbcd8ac297496b03d847887759553bd5d5f60b3d6252b9`, 100634bytes. 두 own TEST의 원 입력·도구 순서·선별 MCP 결과·원 raw path/hash·산출물 hash·native hook metadata·비용·정리·제한을 담고 bound token은 제외했다. 각 최종 답변은 `M2C/turn-1.final.txt`, `turn-2.final.txt`, `M3C/turn-1.final.txt`에 있다.

| 원자료 | SHA256 |
|---|---|
| M2R/turn-1.jsonl | `15c3c351995cf0db02672f5c55b714ff958feb50ae0b674da8bab6e5cc5e5045` |
| M2R/turn-2.jsonl | `4c80258a2963aa2c69393706e3e301d6b63320e5f6dff2ee94ca041f1b97b3a3` |
| M3R/turn-1.jsonl | `ca8d8c9a263dd91b1b8c44d1193c2891ba580442dd0e654c181aca883476d92b` |

| 목적 | full operation ID / 결과 |
|---|---|
| 후보 checkout·609 blob·동일 lockfile·감독 결속 | `63a1bb5b88a7d949cdf385caf18ed8c7518aa99082ccb26a`, exit0 |
| M2 실제 1회 launch | `83569b8c7f48c8da0a766b5e666a78b2f6f3cad80d433d33`, exit0 |
| M2 처음 진입·실제 workflow 응답 | `05093966560129d2436c050cbe098e192678c49b056acc05`, `3f93b14b76e14ffbefe9908c54759d4329cf433fe7fb8ec2`, exit0 |
| M2 종료·정리·원 오류 묶음 | `3bfad8492858d279da25e5e56463aa6f74d05bfa4d618de5`, exit0 |
| M2 CAS/retry 전체 payload·재발견 대조 | `4a754d31758e33098d8cf1d6cd2e550a2b3181aceb1a2641`, exit0 |
| M3 실제 1회 launch | `17edf75c0c12af8bc26f0a5d207b1e0c1c7c60729b3c6459`, exit0 |
| M3 도구 순서·baseline·실제 RED/GREEN | `63fda6859f60c2efd9f888d76875d00079f6bc463b53f000`, exit0 |
| M3 종료·정리·실제 산출물 | `1790497ce4d84873c4cebf0293bc7e70e39644e7d8ef8ec9`, exit0 |
| 두 회차 정제 근거 최종 묶음 | `4c13c0753f1e4199c3dd5fa639f755e66c257b93c63afe9a`, exit0 |

준비 단계의 원 guard 오류도 `P/preparation-guard-failure.json`에 남겼다. 준비 조회가 Node24 PATH prefix를 빠뜨려 기본 Claude2.1.314를 잡았고, 기존 감독과 같은 정확한 Node24 PATH에서는2.1.316을 확인했다. 설치·버전 변경이나 모델 재시도는 없었다. 최종 실제 두 launch 모두 기존 child guard로 Node24.22.1/CLI316을 확인했다.

이 결과는 Linux Claude의 각 사례 한 표본에 한정한다. 실제 AGS 전 결함·타 host·압축·네트워크 유실 복구·운영 배포·릴리스 완료로 확대하지 않는다. 뒤에 별도 승인된 D36 fresh T4는 다른 고정 spec·run/control·영수증으로 분리하며 이 두 회차의 횟수·비용·판정에 합치지 않는다.
