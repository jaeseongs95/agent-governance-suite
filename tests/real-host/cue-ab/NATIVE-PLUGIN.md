# 공식 TEST plugin으로 같은 세션의 행동 관측

이 경로는 `plugin-run.mjs` → 기존 Claude/Codex stream driver의 native-plugin 분기다. 설치·전역 설정·모델 실행은 root 담당이며 여기에는 installer가 없다. 기존 source-composition 경로(`isolated-run.mjs`, trial-preflight helper)와 legacy wrappers는 보존한다. 새 경로는 receipt 파일을 기다리지 않는다. 아직 실제 native/model/fake/prepare/execute는 전부 NOT_RUN이다.

Claude는 공식 `--plugin-dir <candidate/claude-plugin>`로 후보를 로드한다. 후보의 plugin namespace·hook matcher·MCP descriptor·skills bytes를 그대로 쓴다. 수동 MCP 이름, inline settings, strict MCP source composition, matcher 치환을 하지 않는다. Codex는 root가 공식 TEST 경로로 설치한 후보를 기존 로그인으로 로드한다. driver에는 hooks/MCP/plugins `-c` override가 없다. root는 설치 전 기존 plugin 목록·상태를 보존하고 기존 가이드의 정확한 설치·후보 cache 확인·원복 명령을 실행한다. PC 설치/전역 설정·인증파일 열람·복사·재로그인 요구는 하지 않는다.

## 핀과 명령

Codex 입력은 root가 생성한 clean 업무 산출물 `installed-pin.json`이다. 예:

```json
{
  "pluginId": "<공식 설치 결과와 native API의 exact plugin ID>",
  "pluginRoot": "/TEST/actual-installed-candidate-cache",
  "cacheSha256": "<root가 실제 cache bytes에서 산출한 64자리 hash>",
  "serverSha256": "<mcp-server/dist/server.mjs SHA256>",
  "hooksSha256": "<hooks/hooks.json SHA256>"
}
```

driver가 cache 전체를 재귀 탐색하지 않는다. root는 cacheSha256의 대상 파일 집합·산출 명령·후보 SHA와 공식 설치 ID의 결속을 외부 근거에 남긴다. wrapper는 pin 형식과 공개 server/hooks 파일의 실제 hash를 대조하고 공개 manifest hash도 기록한다. `cacheSha256`가 wrapper가 자체 재검증한 전체 cache hash라는 주장은 하지 않는다. pin의 pluginRoot는 설치된 **실제 cache**이며 source checkout 경로로 대체하지 않는다. 인증/config/session 자료를 pin에 넣지 않는다.

```sh
# 모두 Linux TEST에서 root가 실행. source SHA와 모델/effort는 root가 현재 후보로 고정.
CUE_CANDIDATE_SHA=<제품후보40자리SHA> \
node tests/real-host/cue-ab/plugin-run.mjs prepare codex \
  /TEST/installed-pin-B.json /TEST/native-B-prep cue MODEL EFFORT

# 한 대화 7턴 pilot: Codex는 root의 공식 설치/목록/cache 확인 뒤 실행
CUE_CANDIDATE_SHA=<제품후보40자리SHA> \
node tests/real-host/cue-ab/plugin-run.mjs execute codex \
  /TEST/installed-pin-B.json /TEST/native-B-pilot cue MODEL EFFORT

# Claude는 fresh source-copy에서 같은 후보를 빌드한 공식 plugin 디렉터리를 전달
CUE_CANDIDATE_SHA=<제품후보40자리SHA> \
node tests/real-host/cue-ab/plugin-run.mjs execute claude \
  /TEST/src-B/claude-plugin /TEST/native-claude-B-pilot cue MODEL EFFORT
```

spec은 기존 `{candidateSha,timeoutSec,turns:[{id,prompt,compactAfter?}],files?}` 형식이다. spec의 `files`가 없으면 기존 cue fixture를 만든다. cue는 기존 7턴이다. prepare도 fixture 파일을 만들지만 CLI/모델을 시작하지 않는다. fresh runDir만 허용한다. 현재 핀의 공개 manifest/hooks/server hash를 `native-plugin-pin.json`에 보존한다. 후보 hash·입력·tool/model/effort·workspace/OS/locale와 A/B 순서를 root가 고정하고 원 실패를 남긴다.

## 관측과 주장 범위

| 구분 | 하네스 기록 | root의 실제 판정 근거 |
| --- | --- | --- |
| Codex 같은 프로세스/세션 | app-server PID 1개, thread/start 1회, 같은 threadId의 turn/start와 응답 turn ID 결속 | session.json과 각 native turn 완료·실제 callback event의 thread/session 결속 |
| Claude 같은 프로세스/세션 | stream child 1개, 새 session UUID, 각 result의 같은 session_id assert | 실제 SessionStart·연속 UserPromptSubmit 횟수. exec/resume을 대조로 대체하지 않음 |
| 후보 선언 결속 | Codex hooks/list에서 입력 pluginId의 선택 metadata와 같은 pluginId MCP 연결/tool 이름 기록. Claude init이 plugins/MCP/model을 주면 해당 자체 event를 기록 | root 설치 ID/cache 근거, 자기 callback의 실제 candidate 경로/hash. 선언 목록이 callback 실행 증거는 아님 |
| 실제 governance | 자기 native hook event는 native-callbacks.jsonl와 원 turn stream에 보존. 해당 event가 없는 CLI면 횟수는 UNKNOWN | 실제 AGS tool 이름·같은 호출의 governance PreToolUse/admission 생성·MCP admission 소비 및 성공/거부 결과. 성공 query wrapper만으로 제품 PASS 금지 |
| native 데이터 경로 | DB/XDG/shared/plugin-data 환경을 임의 run/state로 바꾸지 않음. native-plugin-pin의 stateIsolation은 NOT_ASSUMED | Claude가 생성한 자기 callback의 실제 CLAUDE_PLUGIN_DATA/DB 경로와 실제 자기 MCP가 쓰는 DB가 동일한지 선택 관측. 생성 source descriptor나 trial 경로 추정으로 대체하지 않음 |
| D32 cue | own hook response/native completion과 모델 turn stream 보존 | source output 생성, callback 실행, 모델 context 도달, 필요한 문서 읽기, 행동·산출물을 별도로 판정 |
| 의미 판정 | transport-summary semanticResult=NOT_EVALUATED, callback 횟수 기본값 null | ISOLATED.md의 B1~B9/code/noncode/negative-control 사전 rubric과 실제 산출물 |

Codex의 선택된 plugin 선언/MCP가 없거나 준비되지 않았으면 native binding 실패로 중단한다. 전체 effective hook/skill/config 목록·완전 격리·다른 plugin 부재는 주장하지 않는다. Claude init에 metadata가 없다고 존재하지 않는 API나 root receipt를 기다리지 않는다. 자기 callback·실제 admission·cue/model 행동이 관측되지 않으면 해당 요구는 미확인/실패다. 원 raw stream은 이 run의 자기 child 출력만 수집하며 account/auth/login notification 및 control 응답 전체는 저장하지 않는다.

기존 TEST 사용자·native plugin 이름의 DB/shared state를 공유할 수 있다. root는 실제 공유 범위·기존 plugin 전후 목록·자기 DB 경로 관측을 기록해야 한다. fresh workspace/session은 DB 전체가 새롭다는 뜻이 아니다. 공유 state가 남은 비교를 cold-start·arm별 완전격리·plugin loader 전체 검증이라고 보고하지 않는다. 동시 모델 대화는 1개로 제한한다. 원복은 root가 설치 전 목록과 정확한 TEST 후보 ID를 기준으로 하고, 하네스가 기존 설치를 삭제하거나 전체 config를 복원하지 않는다.

## 실행기 판별 사례(실행 전, 모두 NOT_RUN)

| 입력·절차 | 기대·FAIL 기준 |
| --- | --- |
| pin의 ID/cache hash 형식 누락, 실제 공개 server/hooks hash 각각 불일치 | native/model 시작 전 거절. root cache 산출 근거 자체는 외부 검증 |
| Codex 같은 ID의 후보 선언/MCP 누락·미연결 | native-plugin-discovered에 선택 근거와 실패 보존. 전체 목록의 완전성 판정으로 확대하지 않음 |
| Claude 공식 --plugin-dir 로딩 후 AGS 정상/거부 도구 호출 | native plugin prefix에 candidate matcher 도달, 같은 호출의 실제 admission 생성/소비. 수동 prefix 치환 없이 확인 |
| 자기 callback과 MCP의 실제 DB 경로 불일치·경로 미관측 | 동일 DB 요구 FAIL/UNKNOWN. run/state로 추정하거나 환경을 강제 덮어써 성공시키지 않음 |
| 같은 session 2턴·Codex compactAfter | 한 PID/thread/session·각 turn 완료·압축 turn ID 결속. Claude compact 요청은 미지원 거절 |
| 첫 턴 timeout·TERM 무시 같은 PGID 자손·wrapper/driver 각각 SIGTERM/SIGINT | 원 실패1/후속 SKIP·summary 실패, TERM1.5s→KILL1.5s, 소유 그룹 잔존0. root tree는 별도 관측 |
| CLI 없음·invalid JSON·native RPC/control/result error | 실패 보존, 후속 실행 금지, 다른 run 프로세스 종료0 |
| Windows·잘못된 timeout/compact type·기존 runDir | 쓰기/child 시작 전 거절 |

Linux 소유 PGID 정리·retire는 9fb 경로와 같은 helper를 쓴다. setsid로 탈출한 자손·SIGKILL/머신 중단은 root 감독이 별도 확인한다. 새 상주 감독이나 framework는 없다. 실제 native TEST 전에는 정리 성공을 주장하지 않는다. 7턴 pilot의 기존600s 상한은 startup 포함 약80분+정리, full112턴은 약21시간20분+정리이며 실제 RSS/토큰/지연은 UNKNOWN이다. native 공유 상태와 plugin 설치/원복 시간은 이 상한에 포함되지 않는다.
