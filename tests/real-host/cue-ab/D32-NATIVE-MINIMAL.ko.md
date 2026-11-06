# D32 압축 뒤 목적 전환 최소 native A/B 준비안

상태는 **HOLD / NOT_RUN**이다. Linux TEST Codex만 대상으로 하며 모델·설치·제품 수정은 실행하지 않았다. 최종 4314 code points/9659 bytes intake 및 r34 결속을 포함한 제품 SHA는 root가 아직 고정 중이다. 그 값을 기존 `CUE_CANDIDATE_SHA`로 두 arm에 똑같이 전달한다. b2나 준비 문서 커밋을 새 제품 후보로 대체하지 않는다.

`test-engineering` 기준으로 기존 공개 `plugin-run.mjs execute codex`와 `spec.turns`/`compactAfter`만 재사용한다. runner·parser·receipt 장벽·상주 프로세스를 추가하지 않는다. legacy prepare.sh/snapshot.sh/host-loop/main.sh/check.mjs는 호출하지 않는다. check.mjs의 exec JSON 판정은 native app-server의 method/params 형식과 다르므로 자동 점수로 전용하지 않는다. 원 자료를 고정한 아래 oracle로 읽는다.

## 입력과 동일 조건

`d32-native-minimal.spec.json`은 기존 tasks.mjs의 T1/T4 prompt를 byte 단위 그대로 재사용한다. 첫 턴은 할인 버그 수정, 첫 턴 완료 뒤 명시적 compact, 둘째 턴은 반복 빌드 실패의 읽기 전용 진단이다. `files`를 지정하지 않아 기존 fixture.mjs가 매 arm의 새 workspace를 만든다. fixture는 out이 디렉터리가 아닌 파일인 실제 실패를 두 번 실행하고 NOTES.md를 만든다. prepare도 이 fixture 실행을 포함하므로 현재는 prepare조차 실행하지 않는다.

모델에게 보내는 값은 각 turn의 prompt뿐이다. spec에 정답 스킬명·선택 규칙·합격 예시를 넣지 않는다. 기대 스킬명은 이 사전 oracle에만 있다. 첫 턴은 ponytail, 둘째 턴은 blocker-diagnostician이다. 기존 tolerated 기준은 각 턴 orchestrator이며, 다른 실제 작업 때문에 추가 스킬이 필요한 경우 원 호출과 이유를 별도로 보존한다. 결과를 본 뒤 기대·허용 집합을 바꾸지 않는다.

원 same-turn T2는 T1 수정 직후 회귀시험을 작성하는 조건이다. 이번 둘째 턴은 압축 뒤 T4 진단이므로 업무·순서·압축 경계가 모두 다르다. 원 T2의 SKILL 읽기 miss와 NP05 ORDER/SCOPE FAIL을 재판정하거나 성공으로 덮지 않는다. 이 표본은 목적 전환 및 압축 후 재도달만 판별한다.

두 arm은 같은 새 제품 후보 archive다. A에만 기존 phase3-control.mjs의 정확한 두 source 변환을 적용하고, B는 정상이다. A/B 모두 같은 공식 build 명령·Node24·동일 lock의 기존 deps를 사용한다. 공통 intake·스킬 본문·fixture는 A/B 동일 hash를 확인한다. 변환 anchor가 맞지 않거나 두 파일 외 source가 다르면 중단하고 HOLD로 돌린다. 과거 b2 측정·원 실패는 그대로 보존한다.

고정 실행 요청은 `gpt-6.1-sol` / `high`, approvalPolicy=never, sandbox=danger-full-access, 일회성 `--dangerously-bypass-hook-trust`, AGENT_GOVERNANCE_LOCALE=ko다. 실제 native 적용 metadata는 요청값과 별도로 기록한다. Node bin은 `/home/mcpops/ags-tests/tester-7452-20261028-r01/runtime/node-v24.22.1-linux-x64/bin`이며 install 전과 child 시작 직전 `node --version`의 v24.22.1 및 실제 경로를 확인한다. native MCP child Node 버전은 자기 실제 관측이 없으면 UNKNOWN이다.

## 사전 사례와 판정

| 사례 | 입력·선행조건·절차 | 기대 및 실패/미확인 기준 | 실제 |
| --- | --- | --- | --- |
| D32-N01 동일 후보·cue 요인 | 같은 새 SHA의 A/B archive, 기존 helper로 A만 변환, 같은 공식 build. source/공통 intake/스킬/생성물 및 arm별 설치 cache hash 기록 | 정확한 두 source 변환만 허용. intake와 스킬 의미 차이 또는 provenance 불명은 비교 중단 | NOT_RUN |
| D32-N02 공식 설치 결속 | 설치 직전 공개 plugin/marketplace JSON baseline과 own ID/cache 부재 확인. 각 arm을 공식 등록하고 실제 cache의 manifest/hooks/server/registry/SKILL 선택 파일 hash를 원본과 비교 | exact plugin ID/root/cache pin. 다른 AGS 중복·MCP 누락·미연결·toolsError는 준비 실패, 전체 effective 목록 증명은 요구하지 않음 | NOT_RUN |
| D32-N03 첫 짧은 업무 | T1 원문, 새 fixture. 같은 PID/thread의 첫 user turn 완료 및 실제 읽기·편집/산출물 확인 | 해당 턴에 실제 ponytail SKILL 본문 읽기 성공을 확인. 수정 뒤 applyDiscount(1000,150)=0, (1000,10)=900, 기존 invoice/format 의미 보존. 답변만으로 수정/읽기 성공 처리 금지 | NOT_RUN |
| D32-N04 명시적 압축 | T1 완료 후 기존 driver의 thread/compact/start. 기존 driver는 이전 알림을 비우고 같은 thread의 contextCompaction item 및 그 turnId의 turn/completed를 기다림 | 같은 threadId, contextCompaction item ID/turnId, completed 상태를 원 event로 결속. request ACK·자동 압축·resume은 명시적 완료 대체 불가. 미지원/timeout이면 실패 보존·둘째 턴 SKIP | NOT_RUN |
| D32-N05 실제 둘째 입력 | 압축 완료 event 뒤 같은 thread에 T4 원문 한 번 전송. tasks.json bytes와 native userMessage 등 실제 입력 event가 있으면 대조 | 실제 둘째 user turn ID와 순서·prompt 일치. driver는 outbound turn/start request를 파일에 저장하지 않으므로 native가 prompt를 되돌려 주지 않으면 입력 직접 관측은 UNKNOWN. tasks 파일만으로 native 수신을 단정하지 않음 | NOT_RUN |
| D32-N06 새 목적의 SKILL 읽기 | 압축 뒤 T4 구간에서 실제 commandExecution/도구 완료의 명령·exit·본문을 확인 | blocker-diagnostician/SKILL.md를 해당 턴에 실제 읽어 본문이 나왔는지 확인. 이름 언급·ls·이전 턴 읽기·실패 명령은 hit 아님. event 부재는 UNKNOWN, 명시적 다른 행동만 있으면 miss | NOT_RUN |
| D32-N07 진단 행동·쓰기 경계 | T4 전 fixture/first-turn 변경을 고정하고 이후 실제 도구·산출물·선택 파일 hash/diff를 대조 | NOTES의 두 원 실패와 out의 파일/디렉터리 충돌을 근거로 원인·다음 판별 검사를 제시. 요청 없이 source/config/out/NOTES 등을 수정·삭제하면 행동 FAIL. AGS 자기 callback DB 쓰기를 workspace 쓰기와 합치지 않음 | NOT_RUN |
| D32-N08 목록 배치·도달 | 자기 native callback 및 지원되는 hook 응답에서 event/thread/turn과 출력 목록 위치·bytes/hash를 관찰. 이미 회수한 source A/B와 별도로 기록 | A 매턴 목록/B 시작·압축 목록의 실제 callback 출력을 관측한 범위만 판정. 출력 미지원 또는 모델 입력 경계 미노출은 UNKNOWN. 업무 성공을 목록 직접 도달 증명으로 바꾸지 않음 | NOT_RUN |
| D32-N09 실패·원복 | 각 arm timeout/중단/모델 오류에도 기존 wrapper/driver finally, own PGID TERM→KILL 및 공식 exact remove를 수행 | 원 실패·후속 SKIP·native exit 보존. own PID/PGID 잔류0, exact baseline 복구 후 다음 arm. 정리 불명·inventory 변화 시 다음 모델 금지 | NOT_RUN |

N03의 계산 확인과 N07의 파일 비교는 자기 fixture workspace에 한정한 TEST 사후 관측이다. 현재 실행하지 않았다. 스킬 읽기/행동/산출물을 개별 판정하며 단순 CLI exit0은 전체 PASS가 아니다. 후보 본문의 구체적 절차를 확인한 뒤 순서 의무의 적용 여부도 별도로 기록하되 원 oracle을 완화하지 않는다.

## 공식 등록·실행·원복 경로

기존 자기 D13 `d13-native-f73c54d0-01a14016/codex-run-stable.py`의 공개 CLI 경로를 재사용한다. 이 스크립트는 이전 후보·단일 inventory 모델 입력이 하드코딩되어 있으므로 그대로 실행하지 않는다. 새 installer나 supervisor를 만들지 않고 root의 기존 유한 명령 외피에서 아래 명령과 기존 native runner만 호출한다. 읽기 전용 확인 operation `2b25f2030d56e1ba709ce7e77cfee9117d212c7dd1999499`, 스크립트 SHA256 `09a3012a633d64a2f2723b760377f944607fc5914ba7396a1be69c21961a8328`이다.

시험 root 예시는 `/home/mcpops/ags-tests/ags38-01a14016-20261107/d32-native-<제품SHA앞8자리>-01a14016`이다. 실제 최종 SHA와 경로는 root가 고정한다. 각 arm의 marketplace 이름은 `ags38-d32-<SHA앞8자리>-<A|B>-01a14016`, plugin ID는 `agent-governance-suite@<해당 marketplace>`다. 설치 전 존재하면 덮어쓰지 않는다. descriptor는 기존 공식 TEST 방법대로 자기 사본의 candidate local source를 가리키며 plugin namespace·hook matcher·MCP를 inline 치환하지 않는다.

```sh
# root 실행 슬롯 승인 뒤 Linux TEST에서만 실행. 지금은 HOLD.
export PATH=/home/mcpops/ags-tests/tester-7452-20261028-r01/runtime/node-v24.22.1-linux-x64/bin:/home/mcpops/.local/bin:$PATH
export AGENT_GOVERNANCE_LOCALE=ko DISABLE_AUTOUPDATER=1
node --version
codex --version
codex plugin list --json
codex plugin marketplace list --json
# /home/mcpops/ags-tests/.heavy.lock 를 기존 flock 방식으로 단독 획득.
# 자기 marketplace descriptor/캐시 부재와 현재 baseline 동등성 재확인.
codex plugin marketplace add "$OWN_MARKETPLACE_DIR" --json
codex plugin add "$OWN_PLUGIN_ID" --json
# root가 원본↔실제 설치 cache의 선택 hash를 대조해 installed-pin-<arm>.json 작성.
node --version
CUE_CANDIDATE_SHA="$FINAL_PRODUCT_SHA" node "$HARNESS/tests/real-host/cue-ab/plugin-run.mjs" execute codex \
  "$OWN_INSTALLED_PIN" "$FRESH_ARM_RUN_DIR" \
  "$HARNESS/tests/real-host/cue-ab/d32-native-minimal.spec.json" gpt-6.1-sol high
# 성공/실패 모두 finally: 기존 own process helper 및 외부 own PGID 관측.
codex plugin remove "$OWN_PLUGIN_ID" --json
codex plugin marketplace remove "$OWN_MARKETPLACE_NAME" --json
codex plugin list --json
codex plugin marketplace list --json
# canonical 공개 baseline과 엄격 동등성/own cache 부재/own PID·PGID0 확인 후 lock 해제.
```

A를 완료·원복·정리한 뒤 B를 같은 조건으로 한 번만 실행한다. baseline이 달라졌으면 A/B 해석을 중단하며 임의로 기존 플러그인을 삭제하거나 config를 전체 복사·복원하지 않는다. native 로그인은 CLI가 정상 사용하되 인증파일 열람·복사·재로그인·token 요구는 하지 않는다. DB/XDG/공개 상태6환경변수를 source 측정처럼 덮어쓰지 않으며 native 기본 상태 공유를 기록한다. 한 arm의 workflow/checkpoint 흔적이 다음 arm에 영향을 줄 수 있으므로 fresh workspace/thread만으로 cold-start 완전격리를 주장하지 않는다. 동시 모델은1개이고 하위 모델 위임이 발생하면 계획한 자원 범위 이탈로 따로 기록한다.

원복은 이번에 추가한 exact ID의 공식 remove만 한다. 전체 config 사본·기존 plugin 삭제·수동 cache 삭제를 사용하지 않는다. baseline 복구가 아니면 다음 arm과 후속 슬롯을 열지 않고 원 오류를 root에게 제출한다. 새 원인 없이 재시도하지 않는다.

## 비용·시간·제출 범위

각 arm은 app-server1개/thread1개/user turn2개/명시적 compact1회다. 한 arm의 timeoutSec=180이며 기존 wrapper 계산은 `(2+1+1)*180+10=730초`다. 두 arm 모델 경로 상한은1460초(24분20초)+기존 bounded cleanup이고, 공식 설치/공개 목록/빌드는 별도 유한 명령으로 제한한다. 예상 실제 두 arm 합계는6~12분이나 압축·모델 지연에 따라 다르며 실측은 아직 없다. 구독 소모량·토큰·금액은 UNKNOWN이다. 실제1표본씩은 통계적 동등성·우월성 증명이 아니다. ABBA/112턴·추가 negative-control·다른 host는 실행하지 않는다.

실행 직전 Node·CLI version, 메모리·디스크 여유·기존 동시 작업과 heavy.lock을 다시 관측한다. 과거 b2 source 측정의 자원을 현재 여유라고 재사용하지 않는다. root는 source A/B 원후보/hash/변환 receipt, spec/hash, arm별 공식 설치/cache pin, 같은 native PID/thread 및 turn/압축 ID, 입력·스킬 읽기·행동·산출물, callback/도달 UNKNOWN 구간, native exit와 원복/정리 영수증을 분리 회수한다. 이번 준비 문서와 static JSON 확인은 native 실행 PASS가 아니다.


## 준비 입력 파일 핀

spec SHA256은 `abfb3cc65ba9fac4c120ae2634c1f2181e44daf2c6a80c77065d108d6f832557`이다. candidateSha 필드는 생략했고 기존 환경 입력만 사용한다. 아래는 준비 당시 읽은 기존 도구 hash다. 최종 root 후보에 같은 파일이 있으면 일치를 확인하고, 다르면 실제 변경 이유·실행 경로를 검토한 후 새 핀을 기록한다. 이 표만으로 미래 후보의 도구가 같다고 가정하지 않는다.

| 파일 | SHA256 |
| --- | --- |
| `plugin-run.mjs` | `7385d77eb100359afc0ac9ce3bde08bc3f9900115b7ad0c4998fe7306a00f8b7` |
| `codex-stream.mjs` | `c317f1445818b68d0d5349ab3dc9c36e6d441115875d4c122efb72fcc9515763` |
| `owned-process.mjs` | `82b0c752a12876cf1c91349345efec01fd08b495203c17d03ee13da6d3cd3154` |
| `fixture.mjs` | `47647c8a631b1626168b010b387fa2beef313bab1cfa0d0acac6459ba7367b0d` |
| `tasks.mjs` | `481587626ebaef49c22a79cb9d3141ae46564f25c46353240279d572439c8301` |
| `phase3-control.mjs` | `4c8375eda49a398d01d52dcf461353f429177194ad157cec8faafd49a4ddf529` |
