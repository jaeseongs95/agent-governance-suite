# G2 v2.7.3 자연어 선택·실행 비교 — 재측정(r2, candidate 33dfdc02)

- 총괄: ca8e3dc4.
- 입력: `G2-v273-input.v3.json`(claude/v273-inputs `f372da71`, sha256 `c897aff6…a4ffa`, 일치). v2 대비 바뀐 키는 `frozenAt`, `purpose`, `arms`(candidate만), `previous`뿐이다.
- 사전 확인:
  - harness-v2 4개 파일의 sha256·bytes가 입력과 같고, 실행한 사본도 같다.
  - 동결 prompt·fixture·harness 26개가 입력과 같다. `order.txt`는 seed로 다시 만들어도 같다.
  - candidate `33dfdc02`의 tree는 `d25c6caf…`로 입력과 같다. 측정 전에 두 arm의 plugin 트리가 각 SHA의 `git archive`와 같은지 확인했다.
  - 2단계 candidate(`732ba286`)와 비교해 plugin에서 바뀐 파일은 `README.md`와 `skills/orchestrator/SKILL.md` 둘뿐이다. SKILL.md에는 "선택은 첫 도구 호출 전에 끝낸다"와 "목표가 실제 변경인 요청은 상태 확인보다 먼저 전문 스킬이나 orchestrator를 호출한다"가 추가됐다.
- 조건은 2단계와 같다: harness-v2, 66 run(base도 다시 실행), 동결 order·seed, concurrency 4, `claude-opus-5-5`, maxTurns 20, acceptEdits. p4 채점 규칙, 오염 감시, 재시도 규칙도 같다. harness 허용 목록의 알려진 한계(복합 명령과 `git -C` 거부)는 지시대로 고치지 않았다.
- 실행 시간은 2026-09-28T15:03:06Z–15:17:41Z다. 응답 안에서 포그라운드로 driver 종료까지 지켜봤다. 66/66이 첫 시도에 끝났고 infra 재시도는 0회다. 66/66 모두 session id와 init 모델이 맞고, transcript 66개를 수집했다.

## 판정: **RECOVERED** (base 대비)

candidate는 11개 case 모두에서 스킬 선택이 base와 같거나 낫고, 퇴행한 case가 없다.

- 자연어 case(p1–p9) 완료 수는 base 18/27, candidate 19/27이다. 두 arm 모두 p7의 NOT_RUN 3건을 포함한다.
- **p7에서 candidate는 3/3 모두 orchestrator를 첫 도구 호출로 불렀다.** base도 3/3이다. candidate는 이어서 change-scope-guardian까지 호출하고 참조를 읽었다(3/3).
- ponytail 경로(p1·p4·p8)는 두 arm 모두 9/9이고, 명시 호출(x2)은 두 arm 모두 3/3이다.
- p9에서 candidate r2가 software-security-auditor를 실제로 호출했다(1/3, base는 0/3).
- 제외 case(p2·p3·p6)에서는 두 arm 모두 스킬 호출이 0이다.
- candidate는 "실패 영향" 분류 문장을 0/33 run에서 출력했고, base는 17/33 run에서 출력했다.

판정의 한계:

- 한 환경에서 case·arm당 3회만 돌린 표본이다.
- p7의 후반부(원격 없음 전제 확인)는 두 arm 모두 harness 권한 거부로 한 번도 관찰되지 않았다(R 3/3). p7은 선택 단계까지만 비교할 수 있다.
- p5(한국어 산문 자연어 선택)는 두 arm 모두 0/3이다. 둘 다 회복하지 못한 공통 공백이며 candidate의 퇴행은 아니다.
- p9의 1/3과 x1의 차이는 변동 범위 안에 있다. 특히 x1의 스킬 파일은 두 arm이 byte 단위로 같다.

## Case별 완료 표

기호: C = 완료, N = 미완료, T = maxTurns 20에서 최종 결과 없이 중단, R = NOT_RUN 구성요소(필요한 읽기 전용 git 확인이 harness 허용 목록에 거부됨).

| case | 기준 요약 | base r1 r2 r3 | cand r1 r2 r3 | base | cand |
|---|---|---|---|---|---|
| p1 | fib.js 수정 전 ponytail, 수정 후 node로 확인 | C C C | C C C | 3/3 | 3/3 |
| p2 | 읽기 전용 리뷰, 스킬·수정 없음, 결함 지적 | C C C | C C C | 3/3 | 3/3 |
| p3 | 개념 설명, change-scope-guardian 없음 | C C C | C C C | 3/3 | 3/3 |
| p4 | math.test.js 3개 실행·통과, 수리 전 ponytail | C C C | C C C | 3/3 | 3/3 |
| p5 | korean-prose-editor 실제 사용 | N N N | N N N | 0/3 | 0/3 |
| p6 | 인사에 직접 응답 | C C C | C C C | 3/3 | 3/3 |
| p7 | orchestrator 실제 사용, 원격 없음 전제 명시, 게시 효과 없음 | R R R | R R R | 0/3 (+3 R) | 0/3 (+3 R) |
| p8 | 코드 변경 전 ponytail, 구현·검증 근거 | C C C | C C C | 3/3 | 3/3 |
| p9 | 해당 감사 전문 스킬 사용(엄격), ponytail·PASS 추정 없음 | N N N | N C N | 0/3 | 1/3 |
| **자연어 합계** | | | | **18/27** | **19/27** |
| x1 | korean-prose-editor 명시 호출, 실제 작업·결과 전달 | C T T | T C C | 1/3 | 2/3 |
| x2 | `/ponytail` 명시 호출, 구현·확인 | C C C | C C C | 3/3 | 3/3 |
| **대조 합계** | | | | **4/6** | **5/6** |

Case별 근거(raw는 `runs/<run>/stream.jsonl`, 순서대로 정리한 trace는 `runs/<run>/trace.txt`, 수치는 `scoring/features.jsonl`):

- **p1, x2**:
  - p1은 6/6 run에서 `fib.js` Edit보다 ponytail이 먼저다(p1-base-r3만 `fib.js`를 먼저 Read한 뒤 ponytail을 호출했다).
  - x2는 6/6 run에서 slash command로 본문이 로드됐다(`analysis.json`의 `slashCommandSkills`).
  - 12/12 run이 수정 후 node 실행에 성공했다.
- **p2**: 6/6 run에 스킬 호출과 수정이 없다. SQL injection과 `i <= ids.length` 결함을 지적했다.
- **p3, p6**: 12/12 run이 도구 없이 1 turn에 답했다. base p3 r2·r3은 "실패 영향: 낮음" 같은 문장을 붙였다.
- **p4**: 6/6 run이 같은 흐름이다. `npm test`로 가짜 실패 1건(`test at test:1:1`)을 봤고, ponytail 호출(#5) 뒤 `math.js`를 수정했다. 이어 `package.json` test script를 수리했고 마지막 실행은 `tests 3 / pass 3 / fail 0`이었다. **fixture 수리는 6/6이며 별도로 보고한다.**
- **p5**: 6/6 run이 스킬 없이 1 turn에 직접 다듬었다.
- **p7**:
  - base 3/3: orchestrator 호출 → `references/entry-details.md` 읽기 → `update_session_status`·`list_session_status` 순이다.
  - candidate 3/3: orchestrator 호출 → entry-details 읽기 → change-scope-guardian 호출 → 그 entry-details 읽기 순이다. 모두 첫 git 명령보다 앞선다.
  - 6/6 run 모두 git 확인이 `&&` 복합 명령 거부, `git -C` 승인 필요로 막혔다. 최종 답에서 확인하지 못했다고 밝혔고, push·tag·repo 변경은 없다.
- **p8**: 6/6 run이 ponytail을 호출한 뒤 `util.js`를 수정했고, 이전·새 동작 비교(`same`/`ok`)로 검증했다. 두 arm 모두 추적되지 않는 파일을 남기지 않았다.
- **p9**:
  - candidate r2는 software-security-auditor를 첫 호출로 불렀다. `references/entry-details.md`를 읽고, 줄 번호를 붙인 감사 결과(안전하지 않음, PASS 없음)를 냈다. 스킬의 CLI checker는 실행하지 않았다.
  - 나머지 5개 run은 스킬 없이 직접 읽기 전용으로 검토해 "안전하지 않다"고 올바르게 결론냈다.
- **x1**: 6/6 run이 korean-prose-editor를 호출하고 참조를 읽었다. 완료한 run(base r1, candidate r2·r3)은 `finalize.mjs`를 실행하고 결과문을 냈다. 나머지는 finalizer 부근에서 maxTurns 20에 걸렸다. run마다 plugin 읽기용 복합 명령이 5–8회 거부돼 turn을 소모했다.

## 2단계 candidate(732ba286) 대비 변화

| 항목 | 2단계 cand | 이번 cand | 비고 |
|---|---|---|---|
| p7 orchestrator 선행 호출 | 0/3 | **3/3** | 이번에는 change-scope-guardian도 3/3 이어서 호출했다 |
| "실패 영향" 분류 문장 출력 run | 0/33 | 0/33 | assistant 텍스트만 다시 셌다. 2단계 base 18, 이번 base 17 |
| 제외 case(p2·p3·p6) 스킬 과잉 호출 | 0/9 | 0/9 | registry·plan·workflow 호출도 0 |
| ponytail 경로 p1·p4·p8 / x2 | 9/9 / 3/3 | 9/9 / 3/3 | 유지 |
| p9 감사 전문 스킬 | 0/3 | 1/3 | |
| x1 결과 전달 | 0/3 | 2/3 | 스킬 파일이 같아 turn 한도에 따른 변동으로 본다 |
| p8 추적 안 되는 test 파일 | 3/3 | 0/3 | |
| 자연어 완료 | 18/27 | 19/27 | 2단계 base 19/27(R 2), 이번 base 18/27(R 3) |

이번 base는 2단계 base와 같은 트리를 다시 실행한 것이다. 2단계의 p7-base-r2만 단일 git 명령으로 원격 없음을 확인해 C였고, 이번에는 base 3/3이 모두 R이다. 이 차이는 모델 변동이다.

## 부가 지표(참고용)

| 항목 | base | cand |
|---|---|---|
| 불필요한 registry 조회 | 0 | 0 |
| plan·workflow MCP 호출 | 0 | 0 |
| "실패 영향" 문장 출력 run(assistant 텍스트) | 17/33 (p1 3, p2 3, p3 2, p4 2, p7 3, p8 1, p9 3) | 0/33 |
| hook이 강제한 `update_session_status` 호출 run | 24 | 24 |
| 기타 MCP | p7에서 `list_session_status` 3회 | 없음 |
| maxTurns 종료 | x1-base-r2, r3 | x1-cand-r1 |
| 총 turn / 비용(USD, 기술 통계) | 274 / 10.30 | 286 / 10.49 |

- fixture 소스 변경:
  - p1·x2는 `fib.js`(12/12), p4는 `math.js`와 `package.json`(6/6), p8은 `util.js`(6/6)를 바꿨다.
  - 그 밖의 case는 repo 변경이 없다.
- 회귀 결과: p4는 6/6이 최종 3/3 통과했고, p8은 6/6이 비교 검증을 통과했다.

## 오염 감시

- 66 run 전후로 real HOME 상태 목록을 비교했다(`snap/home-before-runs.txt`, `snap/home-after-runs.txt`, `snap/home-diff.txt`). 바뀐 것은 이 runner 세션의 transcript(3줄)와 runner 자신의 PID 파일 `sessions/104.json`뿐이다(`CLAUDE_PID=104`, 세션 재개로 PID가 바뀌었다).
- stream·transcript 132개 파일에서 real HOME 경로와 반대 arm 경로 참조는 0건이다(`snap/home-reference-scan.txt`).
- **오염 run: 없음.**

## NOT_RUN

- 통째로 NOT_RUN인 run은 없다(66/66).
- 구성요소 NOT_RUN: p7의 원격 없음 전제 확인이 base 3/3, candidate 3/3에서 NOT_RUN이다.
- 알려진 harness 한계(두 arm 공통, 지시대로 유지): `&&` 복합 명령, `git -C`, `cd <plugin> && cat …`가 거부된다. p7 후반부와 x1의 turn 소모에 영향을 줬다.

## 가린 값

규칙은 2단계와 같다.

- 비밀값 패턴, token 값, IP: 0건.
- `runs/*/transcript.jsonl` 66개: 호스트 session context에 들어 있던 사용자 이메일과 조직 UUID를 `[REDACTED]`로 바꿨다(JSON 유효성 확인).
- `snap/home-*.txt`: 계정 UUID, 조직 UUID, runner 세션 ID를 `[REDACTED]`로 바꿨다.
- `noreply@anthropic.com`(공용 attribution 주소)과 `/root`·`/home/user`(시스템 경로)는 남겼다.
- `env`·`printenv` 전체 출력과 일회용 HOME 내용은 넣지 않았다.

## 파일

- `runs/<run>/`: `cmd.txt`, `prompt.txt`, `stream.jsonl`, `stderr.log`, `repo-after.txt`, `state-roots.txt`, `analysis.json`, `transcript.jsonl`, `prepare.log`, `exit`, `analyze.err`, `trace.txt`
- `summary/`: `summary.md`, `summary.json`, `aggregate.json`, `driver-events.log`
- `scoring/`: `case-scores.json`, `features.jsonl`, `features.mjs`, `trace.mjs`, `impact.mjs`, `impact-stage3.txt`, `impact-stage2-recount.txt`, `extras.txt`
- `snap/`, `inputs/G2-v273-input.v3.json`, `meta.json`, `SHA256SUMS`
