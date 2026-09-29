# AGS 2.7.3 통합 1단계 보고 (wake + intake)

지시: 총괄 ca8e3dc4. main(v2.7.2) 위에 감사를 통과한 wake 후보와 intake 후보를 병합하고, Linux에서 전체 검증했다. Q(msgqueue)는 이번 단계에 넣지 않았다. 버전은 바꾸지 않았다.

## 판정: PASS (push 완료)

| 대상 | SHA |
| --- | --- |
| 기준 main (v2.7.2) | 8763cef2b11f2635d6c9af7861b5bffd496e2a30 (fetch 후 일치) |
| wake `claude/v273-wake-liveness` | 651f5ec94e120703b2685c6fbbe68cfebd1afbfd (일치) |
| intake `claude/v273-intake` | 33dfdc02508ff13d5a2763f0fa318cd81e2971a7 (일치) |
| 병합 1 `merge: v2.7.3 wake liveness` | d9498d69 |
| **통합 후보 `claude/v273-integration`** | **e71b121a5481a0a04302a7f1c12ec3f4522df606 (tree e708032fadaadec2210a68ed262f89a611c5a57a)** |

환경: Linux cloud 컨테이너, Node.js v24.21.0(`/opt/node24`), pnpm 11.19.0. push 전 원격에 `claude/v273-integration`이 없음을 확인했다.

## 병합 결과와 충돌 기록

`logs/merge/merge.log`에 있다.

- 두 후보 모두 main을 조상으로 둔다. `git merge --no-ff 651f5ec9`, 이어서 `git merge --no-ff 33dfdc02`를 실행했다.
- **텍스트 충돌: 0건.** `git merge-tree`로 다시 계산한 tree도 통합 tree와 같다.
- 두 후보가 함께 바꾼 파일은 세 개다. `mcp-server/src/server.ts`, `mcp-server/dist/server.mjs`, `claude-plugin/mcp-server/dist/server.mjs`. 셋 모두 git이 자동 병합했다.
  - 생성물 두 개는 손으로 합치지 않았다. 병합을 커밋하기 전에 `pnpm build`와 `pnpm claude:build`로 다시 만들었고, 자동 병합본과 byte 단위로 같았다(추가 diff 0). `bundle:check`와 `claude:check`도 통과했다.
- 의미 충돌 확인:
  - `server.ts`: wake는 `unknownPresence`/`SessionPresenceView`의 advisory `autoWake`와 `list_session_status`·`send_session_message`·`get_session_message_status` 도구 설명을 바꿨다. intake는 `SKILL_INTAKE_SERVER_INSTRUCTIONS`와 `serverInstructions()`만 바꿨다. 통합본에는 두 변경이 모두 남아 있다. wake는 `SESSION_MESSAGE_SERVER_INSTRUCTIONS`를 바꾸지 않았으므로 instructions 끝부분도 intake 단독과 같다(아래 init-smoke에서 sha 일치).
  - 문서: wake는 `docs/session-message-lifecycle.md`만, intake는 `README.md`, `README.en.md`, `claude-overlay/README.md`(생성물 포함)만 바꿨다. 겹치는 파일이 없다. lifecycle 문서에는 스킬 추천 hook 서술이 없고, 두 README의 wake 서술(`README.md:147`, `README.en.md:131-147`)은 wake 후보가 바꾸지 않은 main 문장 그대로다. 서로 모순되는 서술은 찾지 못했다.

## 전체 검증

명령별 stdout, stderr와 종료 코드는 `logs/full/NN-*`에 있다.

| # | 명령 | 종료 코드 | 결과 |
| --- | --- | --- | --- |
| 01 | `pnpm install --frozen-lockfile` | 0 | PASS |
| 02 | `pnpm bundle:check` | 0 | PASS |
| 03 | `pnpm claude:drift` | 0 | PASS (`claude-plugin: fresh`) |
| 04 | `pnpm lint` | 0 | PASS |
| 05 | `pnpm build` | 0 | PASS |
| 06 | `pnpm test` | 0 | PASS: 파일 60 통과·1 skip, 테스트 842 통과·2 skip. skip 2건은 `AGS_PREVIOUS_BROKER_PATH`가 없을 때 건너뛰는 previous-broker 테스트다(아래에서 따로 실행) |
| 07 | `pnpm runtime:check` | 0 | PASS |
| 08 | `pnpm validate:all` | 0 | PASS |
| 09 | `pnpm validate:official` | 1 | FAIL_UNRELATED(환경): Codex validator `validate_plugin.py`가 컨테이너에 없음(ENOENT) |
| 10 | `pnpm claude:build` | 0 | PASS |
| 11 | `pnpm claude:check` | 0 | PASS |
| 12 | `git diff --check` | 0 | PASS |
| 13 | `git status --porcelain` | 0 | 출력 0 byte(작업 트리 깨끗함) |

## 추가 확인

`logs/checks/`에 있다.

### previous-broker

각 태그 트리를 `git archive`로 풀고, 그 `mcp-server/dist/session-message-broker.mjs` 경로를 `AGS_PREVIOUS_BROKER_PATH`로 주어 `tests/session-messaging/previous-broker.test.ts`를 실행했다. 끝난 뒤 풀어 둔 트리는 지웠다.

| 태그 | 결과 | 로그 |
| --- | --- | --- |
| v2.7.2 | 2/2 통과 | `previous-broker-v2.7.2.log` |
| v2.7.1 | 2/2 통과 | `previous-broker-v2.7.1.log` |
| v2.2.6 | 2/2 통과 | `previous-broker-v2.2.6.log` |

### intake init-smoke

intake 감사 스크립트(`init-smoke.mjs`)로 서버 배치 3가지(Codex 루트, 저장소 안 claude-plugin, 떼어 낸 claude-plugin 사본)와 profile 3가지(default, anthropic, 미설정)를 곱한 9경우를 초기화했다.

- 결과: 9/9 모두 instructions sha256 `474cdcdb93a26a3bed0c58cc03313b3b47e7c19c654702476cb202efc43a0b75`, 3548 byte, intake 1회, 도구 28개, 제품명 없음. 판정은 PASS다.
- 33dfdc02 단독의 값과 같다. wake는 도구 수와 instructions를 바꾸지 않았다.

### wake 재감사 테스트

`claude/evidence-v273-wake-reaudit-20260928T151802Z`의 `audit/tests/` 5개 파일을 임시로 `tests/audit/`에 복사해 통합 트리에서 실행했다. 파일 hash는 `wake-audit-tests.sha256`에 있다. 실행 뒤 복사본을 지웠고, `git status` 변경은 0이었다.

| 시험 | 결과 | 로그 |
| --- | --- | --- |
| `reaudit-f1-store.test.mjs` + `reaudit-f1-hook.test.ts` | 10/10 통과 | `wake-reaudit-f1.log` |
| `audit-retire.test.mjs` | 17/18 통과. 실패 1건은 2b 원본 probe로, 예상된 실패다 | `wake-audit-retire.log` |
| `audit-race.test.mjs` (`AUDIT_RACE_ROUNDS=10`) | 3/3 통과 | `wake-audit-race-10rounds.log` |

2b probe 출력은 재감사 기록과 같다. `recognized:true`, messages 1건(현재 본문), `w2late:null`, pending 0이다.

## NOT_RUN

- `validate:official`의 실제 검사: 컨테이너에 Codex validator가 없다.
- `source:check`와 `source:verify`: 이번 지시의 검증 목록에 없어 실행하지 않았다.
- Windows × Node.js 24: Linux 한 환경만 실행했다.
- race 40회 반복과 mutant 재실행: 지시 범위(10회)만 실행했다.
- Q(`claude/v273-msgqueue`) 병합: 2단계 범위다.
- 설치 캐시·marketplace·실제 호스트 동작과 G2 재측정: 범위 밖이다.

## 가린 값

토큰 패턴(`ghp_`, `gho_`, `github_pat_`, `sk-ant-`, `AKIA`, PRIVATE KEY 줄, Authorization Bearer), 이메일 주소, IPv4 주소와 GitHub 계정 이름은 발견되지 않았다. `env`·`printenv` 출력은 남기지 않았다. 다음을 바꾼 뒤 `SHA256SUMS`를 만들었다.

| 대상 | 치환 | 파일 수 | 횟수 |
| --- | --- | --- | --- |
| 사용자 이름이 들어간 컨테이너 홈 경로 | `[REDACTED-HOME]` | 9 | 9 |
| root 계정 홈 경로 | `[REDACTED-HOME]` | 1 | 2 |
