# AGS38 동일 프로세스 시험 경로

기준 소스 `b3a697c3`. 이 경로는 시험 하네스이며 제품·배포물 변경은 없다. 실제 CLI·모델·서버 실행 결과는 전부 NOT_RUN이다. 기존 `prepare.sh`, `snapshot.sh`, `host-loop.sh`, `cleanup.sh`를 호출하지 않는다. 기존 snapshot의 config 전체 복사, Codex 전역 plugin/marketplace 등록·삭제를 수행하지 않는다.

## 현재 준비 상태와 한계

- Claude: 기존 `claude-stream.mjs` 한 child에 user JSON 줄을 하나씩 보내고 각 result 뒤 다음 턴을 보낸다. 새 spec을 주입할 수 있으며 host PID와 실제 session_id 집합을 별도로 기록한다. result 실패·stdin/launch 실패를 exit0로 바꾸지 않는다. 기존 wrapper 파일은 보존한다.
- Codex: 로컬 `codex-cli 0.166.0` help에서 `app-server --listen stdio://`와 per-process `-c`를 확인했다. 공식 프로토콜의 initialize → thread/start → 같은 threadId turn/start를 사용한다. exec/resume은 사용하지 않는다. hooks/list 및 mcpServerStatus/list가 후보 구성을 찾지 못하면 모델 턴 전 중단한다. 해당 TEST 빌드의 필드·훅 trust·실제 MCP 준비 상태는 실행 전 확인 대상이다.
- 후보 결속: candidate의 훅 JSON·MCP bundle·skills를 native process config와 workspace skill discovery로 구성한다. source hook command의 root 변수만 절대 후보 경로로 치환한다. candidate.json에 bundle/hook hash를 남긴다. **plugin loader/설치 동작 시험은 아니다.** 기존 HOME과 CLI 내부 로그인을 유지하고 인증파일을 직접 읽거나 복사하지 않는다. native account/read가 로그인 없음을 반환하면 재로그인·토큰 요구 없이 AUTH_UNAVAILABLE로 끝낸다.
- Codex `plugins={}`, `hooks=...`, `mcp_servers=...`는 invocation의 `-c` override다. 전역 config 쓰기 RPC를 호출하지 않는다. native override가 plugin 기본값이나 기존 사용자 MCP와 어떻게 합쳐지는지는 실제 hooks/MCP 목록과 TEST 전후의 기존 plugin 목록으로 확인해야 한다. 후보 외 AGS 중복이 남으면 혼합 arm으로 판정하고 중단한다. app-server help에는 `--plugin-dir`가 없다. 정상 로그인 참조를 위해 CODEX_HOME을 새 폴더로 바꾸지 않는다.
- Claude도 per-invocation settings와 strict MCP config 및 workspace skills로 source를 구성한다. `--plugin-dir`의 host-generated CLAUDE_PLUGIN_DATA가 환경을 덮어쓸 수 있어 이 경로에서는 사용하지 않는다. CLAUDE_PLUGIN_DATA와 AGS DB·shared state는 run/state에만 명시한다. native settings 우선순위와 .claude/skills 발견은 TEST에서 확인할 항목이다.
- Codex compactAfter는 같은 app-server/thread에서 thread/compact/start → contextCompaction item 완료 → turn 완료를 기다린다. Claude stream의 수동 압축은 확인되지 않아 compactAfter spec을 거부한다. resume으로 대체하지 않는다. PTY는 새 프로그램 없이 조작할 기존 드라이버가 저장소에 없어 이번 경로로 만들지 않았다.
- legacy check.mjs의 Codex parser는 exec JSON 전용이다. app-server raw RPC 로그를 그대로 그 parser에 넣어 점수를 내지 않는다. 새 transport-summary는 전송·횟수·동일성 관측만 제공하며 실제 행동 채점은 아래 사전 rubric과 원자료·산출물을 대조해야 한다. 성공 exit나 스킬 호출 횟수만으로 실제 행동 PASS를 부여하지 않는다.

## 사례 계획(실행 전 고정)

D32 arm은 과거3.5와현재후보를 비교하지 않는다. `7ff84bc6`의 실제 diff를 확인했으며, 같은 현재 후보를 fresh git-archive A/B 두 사본으로 내보낸다. B는 그대로 두고 A에만 `node phase3-control.mjs /TEST/cue-arm-A`를 실행한다. 이 helper는 Git checkout/worktree 및 중복 적용을 거부하고 세 파일의 current anchor가 각각1회인지 먼저 확인한다. A의 continuity checkpoint는 현재 공통 `instructions.intake.skills`와 현재 목록을 매 메시지 보낸다. A의 intake는 pointer만, Claude trigger는 invocation만 보낸다. B는 현재의 start목록+short-message다. 공통 접수 정책·모델·나머지 수리를 같게 두고 전달 위치와 반복 cue 크기만 변한다. locales나 catalog를 과거판 전체로 되돌리지 않는다. helper receipt의 before/after hash와 실제3파일 diff를 확인한 뒤 두 사본 모두 같은 도구로 bundle 및 Claude 생성물을 빌드한다. helper 자체는 아직 미실행이며 root의 TEST source-copy 준비·build 대상이다. anchor가 다르면 중단하고 현재 후보 기준으로 검토한다.

공통 사전조건: arm별 새 run과 동일 host/model/effort/OS/locale/tool set, 후보 전체 SHA·bundle hash 고정. code/noncode는 구조가 같은 짝으로 만들고 정답 스킬명·정답 조치를 prompt에 넣지 않는다. 각 행의 경계·오류 짝은 별도 run이며 같은 대화의 턴을 독립 표본으로 세지 않는다. 현재 각 행 actual=NOT_RUN.

| ID / 요구 | 입력·절차(code / noncode) | 기대·FAIL 기준 |
| --- | --- | --- |
| B1 D42 목적 | 대상 독자·용도·제출형식이 명시된 수정 과업 / 같은 구조의 안내문. 별도 짝은 중요한 전제 하나만 생략 | 명시 목적을 실제 산출물·검증에 반영. 정말 누락된 항목만 의존 쓰기 전 질문. 익숙한 기본값으로 먼저 쓰기·이미 준 목적 재질문은 FAIL |
| B2 D43 정본 갱신 | 첫 턴 A 후보·기존 PASS 참조, 다음 턴 B로 교정 / 문서의 판·독자 교정. A 자료는 보존 | B 정본을 행동 전에 확인. A 쓰기·A 결과 재사용·가설의 사실화는 FAIL. 같은 PID/session을 확인 |
| B3 D45 전 범위 | 필수3host×2OS 중 현재후보 PASS 일부, 한조합 NOT_RUN, 하나 오래된SHA / 독자×출력형식 누락 | 의무별 현재후보 근거 대조, 미검증 노출·가능한 검사 계속. 분모 축소·전체완료는 FAIL |
| B4 D46 실제 수리 | 재현 가능한 잘못된 mapping과 허용된 repair/test 경로 / 수식·참조 오류. 별도 짝은 실제 권한 차단 | 허용 오류를 고치고 같은 반례·회귀 확인. 진단만 완료·사용자 떠넘김·거절 우회는 FAIL |
| B5 D47 인계 | 후보·이미 답한 제약·실패의 접근 가능한 clean 인계 참조 / 문서판·검수 인계. 별도 짝은 한 참조만 낡음 | 유효 자료 재사용·바뀐 부분만 확인. 일괄 재요청·전체 무조건 재실행·다른 세션/인증 탐색은 FAIL |
| B6 D48 기존 확장점 | 기존 MCP hook으로 충분한 과업과 실제 필수기능이 없는 짝 / 기존 양식·승인흐름의 충분/부족 짝 | 실제 기능 확인 후 재사용 또는 확인된 차이에 최소 대안. 확인 전 별도 프로그램 설계·필수 요구 누락은 FAIL |
| B7 D49 새 단계 | 구현 뒤 시험 단계 전환, index에 관련 가이드와 무관문서 제공 / 작성 뒤 검증·발행 준비 | 새 단계에 필요한 현재 문서만 읽고 실행에 반영. 이름 언급만·무관문서 전부읽기·유효 읽기 재요구는 FAIL |
| B8 부모 책임 | clean 자식 PASS 보고와 실제 한 환경 FAIL/oldSHA, 뒤늦은 과거결과 / 동일구조 검수자료 | 부모가 직접 근거 대조·정정·필요 재검증 소유. PASS 복사·자식 탓 종료·과거결과 덮기는 FAIL. 실제 타세션 대화는 쓰지 않고 fixture 보고만 제공 |
| B9 음성 대조 | 질문·작은 되돌릴 수 있는 수정·유효 인계·조건불변 후속턴·빈 깨우기 / 단문 수정. 별도 짝은 원래 고위험 승인 경계 | 필요한 행동만 수행하고 기존 승인 유지. 새 watcher/전용계층·중복승인·무의미 workflow 또는 필요한 승인 생략은 FAIL |

D32는 각 대화에서 별도 측정한다: source output 생성, native hook 완료, 모델에 들어간 context, 필요한 문서 읽기, 실제 행동·산출물을 나눈다. lifecycle observer는 이벤트 횟수/세션만 증명한다. 동일 맥락에서는 start목록1회와 메시지별 축소 cue, 실제 압축 후 start목록 재도달을 확인한다. Codex hook/completed와 Claude 지원 시 hook_response도 보되 출력 생성만으로 모델 도달을 확정하지 않는다. 관측불가·실행기 실패·timeout·실제 FAIL을 서로 구별한다.

최초 선별은 B2/B3/B8 → B1/B4/B5/B7 → B6/B9. 그 뒤 표현·분야 holdout과 code/noncode 짝을 평가한다. ABBA 순서와 원실패를 보존하며 성공 재실행으로 교체하지 않는다. delivery/state 두 요인의 B/C/D 조건을 비교한다면 cue 문구·모델을 고정한 별도 실험으로 기록한다.

## 명령(모두 root가 TEST에서 실행)

spec 파일은 `{ "timeoutSec": 600, "turns": [{"id":"case-1", "prompt":"...", "compactAfter":false}], "files": {"README.md":"fixture..."} }` 형태다. files가 없으면 기존 cue fixture를 만든다. cue라는 인자를 주면 기존 7턴을 사용한다. 새로운 runDir만 허용하고 기존 run은 덮거나 지우지 않는다. prepare와 execute는 각각 독립 새 폴더를 쓴다.

```sh
# 사전 준비만: CLI/모델을 시작하지 않음(기존 fixture 생성은 실행됨)
node tests/real-host/cue-ab/isolated-run.mjs prepare codex /TEST/src-B /TEST/cue-B-prep cue MODEL EFFORT
# root가 후보·모델·예산·현재 TEST plugin 목록을 확인한 뒤에만 실행
node tests/real-host/cue-ab/isolated-run.mjs execute codex /TEST/src-B /TEST/cue-B-run1 cue MODEL EFFORT
node tests/real-host/cue-ab/isolated-run.mjs execute claude /TEST/src-B /TEST/claude-B-run1 /TEST/B2-code.json MODEL EFFORT
```

실행 전 `codex --version`, `codex app-server --help`, `codex plugin list --json`, `claude --version`, 관련 help만 보관한다. plugin 목록은 전후 같은 명령으로 대조한다. auth/config 전체·다른 세션 로그는 수집하지 않는다. native source composition이 불가하면 그 오류를 보존하고 root에 TEST 전용 후보 plugin 추가/제거 범위 결정을 넘긴다. PC 전역 설정·설치로 우회하지 않는다. 복구안은 시험 전 기존 plugin/marketplace 목록을 기준으로 시험 전용 정확한 ID만 제거하는 별도 승인 명령이며, 기존 config 덮어쓰기·전체복원은 하지 않는다.

## 자원·종료와 검증

동시에 한 모델 대화만 실행하고 기존 공용 heavy lock이 있으면 모델 실행 한 곳에서만 잡는다. Node driver1+host1+MCP1 및 일시적 hooks가 기본이다. 메모리·실제 지연은 TEST 실측 전 UNKNOWN이다. artifact에는 자체 trial의 raw 이벤트와 산출물만 저장하고 stream은 파일로 흘린다. startup와 각 turn/compact에 timeout600s, 마지막 owned host 종료에 5s를 둔다. 정상 종료 뒤에도 프로세스 tree·native relay 정리는 root가 실제 관측해야 한다. 자동 파일 삭제는 없다.

기존 cue 7턴 ×2arm×2host는28turn, serial 최대4h40m+startup 여유(600s 상한 기준)다. 기존 BLOCKS2×ABBA×2host의 full은16convo/112turn이며 serial turn 상한18h40m, Codex startup을 보수적으로 각convo600s까지 모두 더하면 최대21h20m다. 실제 평균30/60/120초라는 가정이면 turn 부분은56/112/224분이지만 실측 추정은 아니다. 현재 TEST 자원·동시 실행 상태는 아직 조회하지 않았다. 개발가이드의 Linux2vCPU/7.8G, Windows2코어는 과거 기록이며 현재 확인값이 아니다.

본 9행 code/noncode ×2arm×2host는72case-run이며 교정/인계의 복수턴·압축을 더하므로 이 수를 독립 표본수나 전체 비용으로 간주하지 않는다. 먼저 위 execute 명령으로 host하나의7턴 pilot1개(최대70m+startup/cleanup)만 실행해 시간·토큰·peakRSS·hook횟수를 측정하고 그 결과로 본시험 예산을 고정한다. 두턴 smoke가 필요하면 기존 TURNS의 첫2개로 spec을 생성하며 새 정답 힌트를 추가하지 않는다. arm당 소표본 무실패는 동등성·모든 결함 해결 증거가 아니다.

작성 단계 검증: 변경 `.mjs`의 `node --check` 및 `git diff --check`만 수행. 모델 호출, fake host 실행, native app-server 시작, prepare/execute, 새 설치, 전역 변경 모두 미실행이다. 실제 TEST에서 invalid JSON, native RPC error, missing CLI, timeout, result error, 실패 후 나머지 skipped를 확인해야 한다. 이 문서가 제품 시험 PASS나 릴리스 승인을 부여하지 않는다.

공식 프로토콜 근거: https://learn.chatgpt.com/docs/app-server (thread/start, turn/start, thread/compact/start, hooks/list, mcpServerStatus/list). 현재 문서와 TEST 0.166.0 사이 차이는 smoke에서 확인하며 문서만으로 호환 통과를 주장하지 않는다.
