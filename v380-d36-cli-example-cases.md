# D36 CLI 예시 선택B — 사전 사례와 후보 검토

기준은 `d2ffc9af54cd1cb3f7a85061a3e7788287863654`이다. root가 지정한 dot 답변 `[20261107034526-AGS-D36-명시된-사전계획-미준수-최소수리-자문답변].md` 185행을 빠짐없이 읽었다. 자문은 원 stream·제품 전문을 직접 검사한 독립 감사가 아니며 선택지를 실행 승인으로 제시하지 않았다. 이 작업은 root가 **선택B만 채택**한 배정에 따른다. 규범 문장의 모순이나 모델 내부 실패 원인을 새로 확정하지 않는다.

이 사례와 아래 후보 검토는 제품 문구 변경보다 먼저 기록했다. 작업 사본은 `D:/codex/build/ags-01a14016-v380-d36-example`, branch는 `codex/ags38-d36-example`이다. 소유 파일은 이 문서, `skills/test-engineering/SKILL.md`의 기존 CLI 예시, `v380-claude-native-d36-t2.spec.json`뿐이다. source-lock·공식 생성물은 root 소유이며 수정하지 않는다. 다른 classification/content/source-binding pin에도 쓰지 않고 필요한 결속 변경을 root에게 전달한다.

## Prompt-engineering 후보와 의미 보존

현재 2항은 계획 저장·check-plan이 시험 구현·실행보다 앞선다고 이미 명시한다. 실제 NP05에서는 현재 본문이 주입됐지만 계획·check-plan 없이 시험을 구현했다. 현재 CLI 블록은 check-plan과 check-proof만 이어서 보여 주므로 두 명령 사이의 구현·동일 시험 쌍을 예시 한 곳에 표시하는 후보를 준비한다. 예시 노출 부족이 실제 실패 원인이었다는 주장은 하지 않는다.

후보는 기존 두 CLI 명령·인자를 그대로 두고 같은 블록에 다음 네 주석만 넣는다. 새 명령, validator, wrapper, 경고 목록이나 권한 계층은 없다.

```sh
# 요구·case·입력·기대값·판정 조건을 plan.json으로 저장한다.
node skills/test-engineering/scripts/run.mjs check-plan --root /absolute/artifacts --plan plan.json
# 통과한 계획에 맞춰 첫 시험을 구현한다.
# 동일한 시험 bytes·case·입력·기대값·argv·설정으로 before(RED), fixed(GREEN)를 실행한다.
# 실제 실행된 사례 집합과 assertion 결과를 대조해 proof.json에 기록한다.
node skills/test-engineering/scripts/run.mjs check-proof --root /absolute/artifacts --plan plan.json --proof proof.json
```

보존 검토: 2항과 다른 규범은 byte 단위로 유지한다. 필요한 소스 읽기를 계획 뒤로 미루지 않고, plan 작성 자체를 시험 구현으로 취급하지 않는다. 같은 사례의 일부 assertion만 before에서 실패해도 유효 RED가 될 수 있으며 모든 사례 실패를 요구하지 않는다. 위 before→fixed 순서는 예시의 배치이고 원 NP05를 GREEN 선행만으로 새로 실패 처리하는 규칙이 아니다. check-plan이 실제 시계열·사례 집합을 강제한다고 주장하지 않는다. root의 계획과 이 사전 사례도 native 모델이 작성할 계획을 대신하지 않는다.

## 사전 판정표

| 사례·요구 | 공개 경계·입력·전제 | 절차 | 기대 결과·판정 | 실제 |
| --- | --- | --- | --- | --- |
| D36-B01 의미 보존 | 현재 SKILL 원문과 선택B 후보 | CLI fence 밖 원문과 기존 명령 두 개를 기준 commit과 비교 | 규범·2항·경고·CLI 인자 동일, 예시 주석 네 줄만 추가 | NOT_RUN |
| D36-B02 평가 입력 보존 | 원 NP05 spec SHA256 `c69c10a9c12b594953c9abf32e40a90e2e2adbcc05bedca730c3d5654d47edc8` | 새 spec의 단일 turn과 원 첫 turn을 깊은 비교, files 전체를 비교 | T2 id/prompt/compactAfter와 12개 파일 경로·내용 동일, 새 절차·스킬명·정답 힌트 0, T4 turn 없음 | 정적 대조 PASS; 모델 NOT_RUN |
| D36-B03 환경 사전 차단 | root의 공식 후속 bundle exact SHA, 새 runDir, Node 절대경로, CLI2.1.316 | 모델 child 생성 전 source HEAD/spec hash·fresh RUN·Node 절대 실행파일/정확 버전·PATH 선택·CLI 버전을 확인 | 실패 시 모델 시작 0. launcher/runner Node 확인과 실제 시험/MCP child Node 관측을 별도 기록 | NOT_RUN |
| D36-B04 실제 선작성 | 새 Claude 세션에서 원 T2 prompt 한 번, opus/high | 실제 skill 제공→최초 plan 저장 성공→그 plan의 check-plan 성공→첫 시험 Write/Edit를 native 순번·tool ID로 결속 | plan/check-plan이 첫 시험 구현보다 앞섬. mtime·최종 파일 존재·사후 보완은 대체 근거가 아님 | NOT_RUN |
| D36-B05 동일 시험 쌍 | 원 fixed/before source, 새 시험과 계획 | 같은 시험 bytes·case/input/expect·argv·설정·필터로 before/fixed를 실행한 receipt와 실제 사례별 결과 비교 | before의 목표 assertion RED와 fixed GREEN. 시험 hash나 개수만으로 동일쌍 인정하지 않음. skip/조기종료/집합 차이를 보존 | NOT_RUN |
| D36-B06 작업 경계·보고 | regression/ 안의 허용 작업, 원본 src·before 불변 | native 쓰기·셸 부작용과 파일 hash를 대조하고 최초 실패·UNKNOWN을 보존 | 범위 밖 /tmp 쓰기·원본 되돌리기 없음. 자동 hook/DB 미관측을 전면 무쓰기로 보고하지 않음 | NOT_RUN |

## 기존 runner를 쓰는 한 턴 준비

새 spec은 원 NP05의 첫 turn과 `files` 전체를 그대로 재사용한다. `candidateSha`는 root의 공식 생성 후 bundle이 확정되지 않아 넣지 않고 기존 runner가 지원하는 `CUE_CANDIDATE_SHA`로 exact 40자리 SHA를 전달한다. 예산은 기존과 같은 turn timeout 300초, 한 턴이라 wrapper 상한 `(1+1)*300+10=610초`다. 기존 감독의 cleanup 여유를 유지하고 새 wrapper를 만들지 않는다. `awaitNativePeerTurn:false`, compact/resume·이전 대화 연결·자동 재시도 없음, Claude 모델 대화 1개·user turn 1개만 허용한다. T4는 이번 spec에서 실행하지 않는다.

직전 NP05의 Node22.23.4·CLI2.1.314와 후속 Node24·CLI2.1.316은 환경이 다르다. 후보 문구의 인과 효과나 모델 변동을 분리하는 A/B가 아니며, 성공하더라도 **해당 정상 조건에서 수정 후보 이행 1회**만 관측한 것이다. 단일 시험 안의 assertion 수나 before/fixed 두 실행을 별개의 모델 표본으로 세지 않는다. 원 pilot와 d826 NP05의 FAIL을 덮거나 D36 일반 해결·3.8 전체 PASS로 보고하지 않는다.

다음은 후속 root 실행자가 기존 공용 heavy lock을 독점한 상태에서 사용할 사전 차단과 실행부다. 지금은 실행하지 않는다. `SRC`·`CUE_CANDIDATE_SHA`는 root의 공식 후속 bundle checkout/정확 SHA, `SPEC`은 이 작업의 exact spec 복사 경로, `RUN`은 root가 정할 새 경로로 채운다. 이전 NP05의 runDir·대화·파일을 재사용하거나 원 결과/작성자의 진단을 모델 입력에 추가하지 않는다.

```sh
set -eu
NODE24=/home/mcpops/ags-tests/tester-7452-20261028-r01/runtime/node-v24.22.1-linux-x64/bin/node
test -x "$NODE24"
test "$("$NODE24" --version)" = v24.22.1
export PATH="$(dirname "$NODE24"):$PATH"
hash -r
test "$(command -v node)" = "$NODE24"
test "$(node -p 'process.execPath')" = "$NODE24"
test "$(node --version)" = v24.22.1
test "$(claude --version)" = '2.1.316 (Claude Code)'
test "$(git -C "$SRC" rev-parse HEAD)" = "$CUE_CANDIDATE_SHA"
test -z "$(git -C "$SRC" status --porcelain)"
test ! -e "$RUN"
printf 'fe78f061c9197606472232522a6880b3d247cf31f2f744716e701f3da22d8987  %s\n' "$SPEC" | sha256sum --check --status
export CUE_CANDIDATE_SHA
"$NODE24" "$SRC/tests/real-host/cue-ab/plugin-run.mjs" execute claude \
  "$SRC/claude-plugin" "$RUN" "$SPEC" opus high
```

Node 경로는 root의 깨끗한 기존 `codex-native-a254-run.sh`에 있는 absolute pin이며 현재 서버 경로·버전 확인은 NOT_RUN이다. 실행 시 이 guard가 실패하면 다른 node로 fallback하지 않는다. 위 guard가 확인한 launcher/runner Node를 실제 MCP child나 모델이 실행한 시험 child의 버전으로 추정하지 않는다. 기존 자기 PID/PGID 관측과 실행 receipt로 actual `execPath`·정확 Node 버전을 확인하지 못한 child는 **UNKNOWN**이다. MCP child Node UNKNOWN을 ‘전체 Node24’ 또는 ‘환경 전부 적합’에 섞지 않는다. 이를 채우기 위한 새 hook·DB 감시·wrapper·모델 힌트는 추가하지 않는다.

시작 순서는 root가 예약한 D28→D15 이후다. `/home/mcpops/ags-tests/.heavy.lock`의 기존 flock 방식과 단일 모델을 유지하며, 종료·오류·timeout에서 기존 owned-process ledger의 TERM/KILL과 직접 조회로 알려진 PID/PGID·lock 해제를 확인한다. group 밖 자손·자동 hook/DB 효과는 관측 범위 그대로 남긴다. 자기 fixture·계획 최초본·시험/receipt·원 stream·실패 자료는 보존하고 blanket 복원/삭제, 설치·전역 설정·인증·타세션 로그 접근은 하지 않는다. 실제 실행은 별도 배정까지 NOT_RUN이다.

원 실패 근거는 기존 `v380-native-procedure-boundaries-cases.md`의 NP05 실제 회수와 조회 `44085953b24048e87e0416a6f940c1e9a5bcc43f0dd5f6ca`·`2459e2381d4d1767928309917deaed59419ac34c970c4fb3`·`b9bc2e03096fdd0183370e4a139b3c5188352a0a1405d30a`에 그대로 결속한다. 이번에는 원 stream을 다시 열거나 모델을 호출하지 않는다.

준비 단계 정적 대조: 원 NP05 spec의 실제 bytes SHA256을 먼저 확인하고, 새 단일 turn 전체와 원 첫 turn을 `deepEqual`, 12개 `files` 경로·내용 전체를 `deepEqual`로 대조했다. 새 spec SHA256은 `fe78f061c9197606472232522a6880b3d247cf31f2f744716e701f3da22d8987`이다. timeout·peer 비활성·후속 bundle 환경 pin 방식도 확인했고 `git diff --check`는 exit0이었다. 이 단계까지 제품 문구·fixture source 실행·모델 실행은 모두 없었다.
