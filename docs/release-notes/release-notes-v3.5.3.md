# AGS 3.5.3 릴리스 노트

3.5.3은 agy에서 대화가 압축되면 AGS 공통 접수 기준이 사라져 AGS를 쓰지 않던 결함을 고친다. 사용자 원문은 「agy (내 환경은 네이티브앱) 에서 압축되고난 이후 ags 호출이 안되는거같은데 확인해줄래?」이고, 발행은 「3.5.3 릴리즈로 발행해줘.」로 정했다.

호환성: 공개 도구 계약, 오류 code, DB schema 버전은 바뀌지 않는다. 메시지 key `instructions.intake.pointer` 하나가 늘었다. hook으로 전하던 접수 기준 전문은 짧은 안내로 바뀐다(아래).

## 압축 뒤 접수 기준 소실

### 원인

- agy는 MCP 서버 instructions를 모델에 주지 않는다(3.5.0에서 확인). 그래서 접수 기준은 SessionStart hook이 넣는 system message로만 들어갔다.
- agy hooks.json에는 압축 이벤트가 없다. 내장 문서 기준 이벤트는 SessionStart(새 대화에서 한 번)·PreToolUse·PostToolUse·PreInvocation·PostInvocation·Stop이다.
- agy 압축은 그 system message를 잃었다. AGS v3.5.2를 설치한 agy 대화에 `/compact` 뒤 접수 기준 첫 문장을 묻자 `NONE`이었다. 압축하지 않은 대조 대화는 그대로 인용했다.
- 처음 정한 방법(PreInvocation 입력의 `initialNumSteps`가 줄면 압축으로 판단)은 쓸 수 없었다. 이 값은 대화 전체 step 수라 압축 뒤에도 줄지 않았다(15→18).

다른 호스트는 같은 결함이 없었다.

- Claude Code: 접수 기준이 MCP instructions로 시스템 프롬프트에 있어 압축과 무관하다. 압축 뒤에도 그대로 인용했다.
- Codex: 압축 뒤 `SessionStart(source=compact)`가 불리고 AGS가 그때 접수 기준을 다시 넣는다(PreCompact·PostCompact·SessionStart 순서를 시험 hook으로 확인).

### 바뀐 점

- 공통 intake hook(`mcp-server/src/intake-hook.ts`)이 맥락이 시작될 때마다 접수 기준 전문 대신 짧은 안내를 낸다. 안내는 「이 대화에 AGS 공통 접수·선택 기준이 보이지 않으면 작업 전에 설치된 `skills/orchestrator/SKILL.md`(절대 경로)의 그 절을 읽고 따른다」이다(`mcp-server/src/skill-intake.ts`의 `skillIntakePointer`). 호스트 이름 분기는 없다.
- 무엇이 맥락 시작인지는 호스트 어댑터가 정한다.
  - Codex는 지금처럼 SessionStart(startup·resume·clear·compact·fork)에서 부른다.
  - agy는 압축 이벤트가 없으므로 각 턴의 첫 모델 호출(PreInvocation `invocationNum` 0)을 맥락 시작으로 본다(`antigravity-connector/hooks/antigravity-hook-runner.mjs`). 안내는 턴마다 들어가므로 ephemeral message로 넣어 대화에 쌓이지 않게 했다. SessionStart에서 넣던 전문은 뺐다.
  - Claude Code는 이 hook을 등록하지 않는다(바뀌지 않음).
- MCP 서버 instructions는 지금처럼 접수 기준 전문을 싣는다.

## 검증

대상 커밋은 `9b283e3e`(코드 변경 전체)다. 그 뒤 커밋은 릴리스 노트·README·로드맵 링크뿐이다.

- CI: run 41782833963(9b283e3e) Node 24 ubuntu-latest·windows-latest 모두 success.
- red→green(Linux 시험 서버, Node 24.22.1): `tests/mcp/intake-hook.test.ts`와 `antigravity-connector/hooks/antigravity-hook-runner.test.mjs`를 돌렸다.
  - 후보에서 12/12 통과.
  - `mcp-server/src/intake-hook.ts`와 agy runner만 26c4c1ce로 되돌리면 5개가 실패했다. 실패한 항목은 세 어댑터의 맥락 시작 안내 3개, agy 턴 첫 호출 ephemeral 안내 1개, agy runner 시나리오 1개다.
  - 되돌린 파일을 복원하면 다시 12/12 통과.
- Windows 시험 서버 `pnpm test:server`(9b283e3e): `TEST_SERVER_EXIT=0`.
  - vitest: 파일 277개 통과·2개 skip, 시험 4112개 통과·28개 skip·8개 todo.
  - node:test: 499개 중 498개 통과·1개 skip, 실패 0.
- Linux 시험 서버(9b283e3e, Node 24.22.1): `node scripts/build.mjs && node scripts/run-tests.mjs && node scripts/check-runtime.mjs`, `TEST_SERVER_EXIT=0`.
  - vitest: 파일 278개 통과·1개 skip, 시험 4125개 통과·15개 skip·8개 todo.
  - node:test: 499개 모두 통과, 실패 0.

### 실호스트 A/B(Linux 시험 서버, 2026-11-04)

A는 3.5.2(26c4c1ce), B는 이 후보(9b283e3e)다. 호스트는 Claude Code 2.1.316, Codex 0.166.0(ChatGPT 구독 로그인), agy 1.5.0이다. 호스트·판·조건(새 대화, 읽기 전용 질문 → 압축 → 작업)마다 2회씩 돌렸다. 판정은 각 실행의 기록에서 AGS 사용, 첫 파일 수정 전 workflow 시작, 설치된 `orchestrator/SKILL.md` 읽기를 셌다. 작업 완료는 `node index.js mul 3 4`가 12를 내고 `node test.js`가 통과하는지로 봤다.

세 파일 작업(calc.js·index.js·test.js를 함께 고치는 작업, 3.5.0에서 접수 기준 유무가 갈렸던 형태):

| 호스트 | 판 | workflow 먼저 시작 | 접수 기준 문서 읽음 | 작업 완료 |
| --- | --- | --- | --- | --- |
| Claude Code | A | 4/4 | 0/4 | 4/4 |
| Claude Code | B | 4/4 | 0/4 | 4/4 |
| agy | A | 3/4(압축 뒤 1/2) | 3/4 | 4/4 |
| agy | B | 3/4(압축 뒤 2/2) | 4/4 | 4/4 |
| Codex | A | 4/4 | 2/4(압축 뒤 0/2) | 4/4 |
| Codex | B | 4/4 | 4/4 | 4/4 |

- Claude Code는 접수 기준이 MCP instructions로 시스템 프롬프트에 있어 문서를 따로 읽지 않는다. 두 판의 행동이 같았다.
- 두 파일 작업(1차 시험)에서는 Claude·agy가 두 판 모두 workflow 없이 끝냈다. Codex는 A 2/4, B 1/4로 workflow를 시작했다. 이 작업은 workflow가 필요한 크기가 아니어서 판정에 쓰지 않았다. 접수 기준 문서는 agy A 1/4·B 4/4, Codex A 1/4·B 4/4로 읽었다. 16회 모두 작업을 끝냈다.
- B가 어느 호스트에서도 A보다 나쁘지 않아, 호스트별 전문 주입으로 되돌리지 않았다.

시험 하네스 결함 두 가지를 고친 뒤 Codex를 다시 돌렸다. 처음 결과는 버렸다.

- 다른 시험이 남긴 AGS 3.0.0-rc.1 플러그인을 끄는 `-c` 인자에 TOML 따옴표를 넣어 무시됐다. 그 플러그인의 hook이 시험 대상의 MCP 호출을 막았다.
- 실행별 `XDG_STATE_HOME` 격리는 Codex가 MCP 서버에 넘기지 않아, hook과 서버가 다른 상태 DB를 봤다.

### 이번에 고치지 않은 것

- Codex에서 첫 `start_workflow`가 「workspace가 필요하다. 호스트가 이 세션의 작업 폴더를 알리지 않았다」로 실패하는 일이 있다. 세 파일 작업 B 4/4, 두 파일 작업 A 1회에서 나왔다. 모델이 `workspace`를 넣어 다시 불러 모두 이어 갔다. 3.5.2에도 있던 동작이며, 원인 조사는 다음 작업으로 남긴다.
- agy 실행 1회(B 새 대화)는 `record_stage_result` 뒤 약 7분 동안 모델 응답이 없다가 끝났다. 그동안 AGS hook 프로세스는 돌지 않았다.
