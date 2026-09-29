# G2 v2.7.3 자연어 선택·실행 비교 — 2단계 측정 결과

- 총괄: ca8e3dc4. 입력은 `G2-v273-input.v2.json`(claude/v273-inputs `b92fede6`, sha256 `b1db1174…406d`, 일치)이다.
- harness는 승인된 harness-v2(`a4c0353a`의 `g2/harness-v2/`)다. 4개 파일의 sha256과 bytes가 입력과 같고, 실행한 사본도 같다. 동결 prompt·fixture·harness 26개도 입력과 같다. `order.txt`는 seed 20260928로 다시 만들어도 같다. 두 arm의 plugin 트리는 각 SHA의 `git archive`와 같다(측정 전 확인).
- 설계는 바꾸지 않았다. 66 run, 동결 order, concurrency 4, `claude-opus-5-5`, maxTurns 20, acceptEdits. 실행은 2026-09-28T14:26:39Z–14:40:03Z에 했다.
- 66 run이 모두 첫 시도에 끝났다. infra 재시도는 0회이고, 결과를 이유로 다시 돌린 run은 없다. 66/66 모두 요청한 session id와 init 모델이 맞고, transcript 66개를 수집했다.

## 판정: **NOT_RECOVERED**

candidate는 자연어 선택·실행에서 base보다 나아지지 않았다.

- 자연어 case(p1–p9) 완료 수는 base 19/27, candidate 18/27이다.
- 자연어 run 중 실제로 plugin 스킬을 쓴 run은 base 12/27(ponytail 9, orchestrator 3), candidate 9/27(ponytail 9)이다.
- ponytail 경로(p1·p4·p8)는 두 arm 모두 9/9로 같다.
- **p7에서 candidate는 orchestrator를 한 번도 호출하지 않았다(0/3). base는 3/3 호출했다.** candidate는 첫 동작이 git Bash 호출이었으므로, 이 선택 누락은 harness의 거부보다 먼저 일어났다.
- p5(한국어 산문)는 두 arm 모두 0/3이다. 이 case에서는 어느 쪽도 회복하지 못했다.
- 좋아진 점도 있다. candidate는 불필요한 "실패 영향" 분류 문장을 한 번도 출력하지 않았다(base 18/33 run).

한계: 한 환경(이 cloud 컨테이너, Claude Code 2.1.283, Node v24.21.0)에서 arm당 case별 3회만 표본으로 삼았다. 차이가 3/3 대 0/3으로 일관된 p7도 통계적 유의성을 주장할 수 없다. 이전 G의 수치(base 11/27, candidate2b 0/27)는 권한 조건이 달라 이번 결과와 직접 비교할 수 없다.

## Case별 완료 표

기호: C = 완료, N = 미완료, T = maxTurns 20에서 최종 결과 없이 중단, R = NOT_RUN 구성요소(harness 허용 목록이 필요한 읽기 전용 git 확인을 거부함. 스킬 실패나 PASS가 아니다).

| case | 기준 요약 | base r1 r2 r3 | cand r1 r2 r3 | base | cand |
|---|---|---|---|---|---|
| p1 | fib.js 수정 전 ponytail, 수정 후 node로 결과 확인 | C C C | C C C | 3/3 | 3/3 |
| p2 | 읽기 전용 리뷰, 스킬·수정 없음, SQL injection과 `<=` 결함 지적 | C C C | C C C | 3/3 | 3/3 |
| p3 | 개념 설명, change-scope-guardian 없음 | C C C | C C C | 3/3 | 3/3 |
| p4 | math.test.js 3개 실행·통과, 수리 전 ponytail(decisions.p4Fixture) | C C C | C C C | 3/3 | 3/3 |
| p5 | korean-prose-editor 실제 사용과 참조·최종화 경로 | N N N | N N N | 0/3 | 0/3 |
| p6 | 인사에 직접 응답, 스킬·registry·workflow 없음 | C C C | C C C | 3/3 | 3/3 |
| p7 | orchestrator 실제 사용, 원격 없음 전제 명시, 게시 효과 없음 | R C R | N N N | 1/3 (+2 R) | 0/3 |
| p8 | 코드 변경 전 ponytail, 구현·검증 근거, 인위적 workflow 없음 | C C C | C C C | 3/3 | 3/3 |
| p9 | 해당 감사 전문 스킬 사용(엄격), ponytail 없음, PASS 추정 없음 | N N N | N N N | 0/3 | 0/3 |
| **자연어 합계** | | | | **19/27** | **18/27** |
| x1 | korean-prose-editor 명시 호출과 실제 작업·결과 전달 | T C C | T T T | 2/3 | 0/3 |
| x2 | `/ponytail` 명시 호출과 구현·확인 | C C C | C C C | 3/3 | 3/3 |
| **대조 합계** | | | | **5/6** | **3/6** |

Case별 근거(raw 경로는 `runs/<run>/stream.jsonl`, 순서대로 정리한 trace는 `runs/<run>/trace.txt`):

- **p1, x2**: 6/6 run에서 ponytail이 첫 호출이었다(x2는 slash command로 본문 로드, `analysis.json`의 `slashCommandSkills`). 이어 `fib.js`를 Edit했고, 수정 뒤 `node fib.js 90` 같은 실행이 성공했다(예: `p1-cand-r1` #7→#8).
- **p2**: 6/6 run에서 스킬 호출과 수정이 없었고, 최종 답에서 SQL injection과 `i <= ids.length` 결함을 지적했다. run마다 권한 거부가 1건씩 있었지만(`cat change.diff && … && ls` 류 복합 명령), 이후 명령이나 Read(cand-r1)로 diff를 읽고 리뷰를 마쳤다.
- **p3, p6**: 12/12 run이 도구 없이 1 turn에 직접 답했다.
- **p4**: 6/6 run이 같은 흐름이었다. `npm test`를 실행해 가짜 실패 1건(`test at test:1:1`)을 봤고, ponytail을 호출한 뒤(#5) `math.js`를 수정했다. 이어 `package.json` test script를 고쳤고, 마지막 실행은 `tests 3 / pass 3 / fail 0`이었다(`scoring/features.jsonl`의 `testRuns`). **6/6 모두 fixture를 수리했다**(test script 변경, 별도 보고).
- **p5**: 6/6 run이 스킬 없이 1 turn에 직접 다듬은 문단을 냈다. 결과문은 있지만 전문 스킬 경로는 없었다.
- **p7**:
  - base 3/3은 먼저 `agent-governance-suite:orchestrator`를 호출하고 `references/entry-details.md`를 읽은 뒤, `update_session_status`와 `list_session_status`를 호출했다. r2만 `git remote -v`를 따로 실행해 "원격이 없어 push할 곳이 없다"고 밝혔다. r1과 r3은 `git status -sb && echo … && git branch -a -vv …` 복합 명령과 `git -C <repo> status -sb`가 거부돼 전제를 확인하지 못했다(R).
  - candidate 3/3은 스킬 호출 없이 git 확인부터 시도했고, 같은 방식으로 거부됐다. 최종 답에서는 확인하지 못했다고 밝혔다.
  - 6/6 모두 push·tag·repo 변경이 없다(`repo-after.txt`).
- **p8**: 6/6 run이 ponytail을 호출한 뒤 `util.js`를 수정하고 검증했다. base는 이전·새 동작을 비교하는 스크립트를 세션 scratchpad에서 실행해 `same`/`ok`를 얻었다. candidate는 `util.test.js`를 추가하고 `node --test`로 2/2 통과했으며, r2는 `node util.test.js`로 `ok`를 얻었다. **candidate 3/3은 fixture에 추적되지 않는 `util.test.js`를 남겼다.**
- **p9**: 6/6 run이 스킬 없이 직접 읽기 전용으로 검토했다. `rm -rf $BUILD_DIR/*`, `curl | bash`, `chmod -R 777`을 지적하고 "안전하지 않다"고 결론냈으며, ponytail·수정·PASS 추정은 없었다. 이 부가 기준으로는 두 arm 모두 3/3이다. 엄격 기준(software-security-auditor 호출)으로는 두 arm 모두 0/3이다.
- **x1**: 6/6 run이 korean-prose-editor를 호출했고 참조·contract를 읽었으며, selection·editing·verification 산출물을 만들었다.
  - base r2는 `finalize.mjs`를 실제로 실행해 결과문을 냈고, r3도 결과문을 냈다.
  - base r1과 candidate r1–r3은 finalizer 직전이나 실행 중에 maxTurns 20에 걸려 최종 결과가 없다.
  - **korean-prose-editor 디렉터리는 두 arm에서 byte 단위로 같다.** 그래서 이 차이를 candidate 변경의 효과로 볼 수 없다. run마다 plugin 읽기용 `cd … && cat …` 복합 명령이 5–7회 거부돼 두 arm 모두 turn을 소모했다.

## 부가 지표(참고용)

| 항목 | base | cand |
|---|---|---|
| 불필요한 registry 조회(`query-registry`, registry.json) | 0 | 0 |
| plan·workflow MCP 호출 | 0 | 0 |
| "실패 영향 …" 분류 문장 출력 run | 18/33 (p1 3, p2 3, p3 1, p4 3, p7 3, p9 3, x2 2) | 0/33 |
| session-board hook이 강제한 `update_session_status` 호출 run | 24 | 23 |
| 기타 MCP | p7에서 `list_session_status` 3회 | 없음 |
| maxTurns 종료 | x1-base-r1 | x1-cand-r1, r2, r3 |
| 총 turn / 비용(USD, 기술 통계) | 281 / 10.25 | 249 / 10.09 |

- intake 경로가 다르다(기술 통계). base는 UserPromptSubmit hook이 키워드에 맞는 스킬을 안내한다(예: p7에서 change-scope-guardian). candidate는 SessionStart에서 공통 접수·선택 기준을 주입하고, 프롬프트별 안내는 없다(`analysis.json`의 `skillTriggerContexts`, `otherHookContexts`).
- fixture 소스 변경:
  - p1과 x2는 `fib.js`(12/12), p4는 `math.js`와 `package.json`(6/6), p8은 `util.js`(6/6)를 바꿨다. candidate의 p8은 추적되지 않는 `util.test.js`도 추가했다.
  - p2, p3, p5, p6, p7, p9, x1에서는 repo 변경이 없다.
  - 회귀 결과: p4는 6/6이 최종 3/3 통과했다. p8의 검증은 위와 같다.

## 오염 감시(decisions.residualRisk)

- 66 run 전후로 real HOME 상태 목록(`snap/home-before-runs.txt`, `snap/home-after-runs.txt`, `snap/home-diff.txt`)을 비교했다. 바뀐 것은 이 runner 세션 자신의 transcript(3줄)와 `sessions/210.json`(runner PID 210)뿐이다. `/root/.agent-governance-suite`, `/root/.claude/plugins/data`, `/root/.claude.json`은 바뀌지 않았다.
- stream·transcript 132개 파일에서 `/root/`, `/root"`, `/home/user`, `/mnt/user-data`, `.agent-governance-suite/(session|trust|board)`, 반대 arm 경로(`/tmp/cand/`↔`/tmp/base/`)를 검사했고 **모두 0건**이다(`snap/home-reference-scan.txt`).
- **오염 run: 없음.**
- 관찰: nested 세션의 transcript에는 호스트가 넣은 session context(사용자 이메일, 조직 UUID)가 들어 있었다. 부모 환경변수를 물려받아 생긴 것이며, 두 arm에 똑같이 적용되고 real HOME 상태 접근은 아니다. 아래에서 가렸다.

## NOT_RUN

- 통째로 NOT_RUN인 run은 없다(66/66 실행).
- 구성요소 NOT_RUN은 p7-base-r1과 p7-base-r3의 "원격 없음 전제 확인"이다. harness-v2 허용 목록이 복합 git 명령과 `git -C`를 막았다. candidate p7의 git 확인도 같은 이유로 막혔지만, 스킬 선택 실패가 먼저여서 판정은 N이다.
- harness 한계(두 arm 공통): 허용 목록이 `&&`로 이은 복합 명령, `git -C …`, `git tag -l`, `git branch -a`, `cd <plugin> && cat …`를 허용하지 않았다. preflight probe는 단일 명령만 검사해서 이 한계를 잡지 못했다. p7과 x1의 결과에 영향을 줬다.

## 가린 값

- 비밀값 패턴(`ghp_`, `gho_`, `github_pat_`, `sk-ant-`, `AKIA`, `BEGIN … PRIVATE KEY`, `Authorization: Bearer`)은 검출 0건이다. GitHub·messaging·ingress·cloud token 값도 전체 파일과 대조했으며 0건이다. IP는 0건이다.
- `runs/*/transcript.jsonl` 66개: 사용자 이메일과 조직 UUID를 `[REDACTED]`로 바꿨다(132곳, JSON 유효성 확인).
- `snap/home-*.txt`: 계정 UUID, 조직 UUID, runner 세션 ID를 `[REDACTED]`로 바꿨다(경로 이름).
- `noreply@anthropic.com`(공용 attribution 주소)은 개인정보가 아니어서 남겼다. `/root`와 `/home/user`는 시스템 일반 경로이고 오염 판정의 근거라 남겼다.
- `env`·`printenv` 전체 출력은 저장하지 않았다. 일회용 HOME(`.claude.json`, broker key·token)은 넣지 않았고, `state-roots.txt`에 파일 이름과 크기만 있다.

## 파일

- `runs/<run>/`: `cmd.txt`, `prompt.txt`, `stream.jsonl`, `stderr.log`, `repo-after.txt`, `state-roots.txt`, `analysis.json`, `transcript.jsonl`, `prepare.log`, `exit`, `analyze.err`, `trace.txt`
- `summary/`: `summary.md`, `summary.json`, `aggregate.json`(동결 `summarize.mjs`), `driver-events.log`
- `scoring/`: `case-scores.json`, `features.jsonl`, `features.mjs`, `trace.mjs`, `extras.txt`
- `snap/`: 전후 목록, diff, 참조 검사, `snap.sh`
- `inputs/G2-v273-input.v2.json`, `meta.json`, `SHA256SUMS`
