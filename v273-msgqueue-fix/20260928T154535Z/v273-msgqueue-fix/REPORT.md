# AGS 2.7.3 Q 감사 finding 처리 보고

- 지시: 총괄 ca8e3dc4. Q writer 세션에서 이어서 처리.
- 기준: `claude/v273-msgqueue` = `cc5b1e9dc439647fff18ed8aaa58170fc9389369`. fetch 뒤 local HEAD와 origin이 모두 이 값인 것을 확인했다.
- 감사 입력: `claude/evidence-v273-msgqueue-audit-20260928T152951Z`의 `audit/REPORT.md`(판정 ACCEPT_WITH_FINDINGS)와 `scripts/mutants.py`, `scripts/run-mutants.sh`, `tests/audit-*.test.ts`.
- 새 후보: commit `74395bf698012a8b2e034e58e3b42d51f53b0b68`, tree `a4315674f6a18e058a05699fc9fafb227733cc2d`.
  - `544cd6e fix: say a capacity-rejected message ID stays prepared`
  - `74395bf test: pin receipt retention ordering, scope, byte and ACK atomicity`
- push: fast-forward인지 `git merge-base --is-ancestor`로 먼저 확인한 뒤 `cc5b1e9..74395bf`를 non-force로 push했고, `git ls-remote` 값이 새 후보와 같다.
- wake 브랜치는 합치지 않았다. store 코드(`session-message-store.ts`)는 이번에 바꾸지 않았다.
- 환경: Linux cloud 컨테이너, Node v24.21.0, pnpm 11.19.0. 상세는 `meta.json`.

## 1. finding별 처리

모든 테스트는 `tests/session-messaging/message-retention.test.ts`에 있다(줄은 새 후보 기준).

| ID | 처리 | 근거 |
|---|---|---|
| N1 (major) | 수정: store 테스트 `:275`와 service 테스트 `:236` 끝부분 추가 | store: sender 250이 찬 상태에서 이미 보낸 ID(첫 번째, 마지막)를 다시 보내면 `duplicate: true`이고 행 수가 불변이다. 이어서 전역 1000까지 채운 상태에서도 같다. service: 실제 broker로 sender와 전역이 모두 찬 상태에서 `send`가 `ok: true`, `error: null`, `duplicate: true`이고 행 수가 불변이다. M05 검출(두 사례 실패) |
| N2 (minor) | 수정: `:289` | 다른 sender 750개(1000 시각)를 먼저, 찬 sender 250개(3000 시각 이후)를 뒤에 넣어 전역의 가장 이른 만료와 sender의 가장 이른 만료가 다르게 했다. 찬 sender의 prepare와 send가 모두 `scope: "sender"`와 자기 영수증의 가장 이른 만료를 받는다. 다른 sender는 `scope: "global"`과 전역의 가장 이른 만료를 받는다. M03 검출 |
| N3 (minor) | 수정: `:308` | 큰 draft로 byte를 채운 뒤 남은 byte를 draft→영수증 증가분보다 작게 만든다(남은 byte < 100을 단언, 영수증 0개). send 거절이 정확한 문구, `details = { scope: "global", earliestReleaseAt: 가장 이른 draft 만료 }`, 행 0개인 것을 단언한다. 해제 1 ms 전에는 같은 details로 거절되고, 해제 시각에는 수락되어 행이 1개가 된다. 감사 L5를 참고했다. M20 검출 |
| N4 (minor) | 수정: `:337`. 제품 코드 변경 없음 | 테스트 DB에 `BEFORE UPDATE OF expires_at ON prepared_messages` trigger로 `RAISE(ABORT)`를 넣어, ACK 안의 영수증 갱신 문장만 실패시킨다. `acknowledge`가 오류를 던지고, `messages.acknowledged_at`이 NULL로 남으며, 영수증 만료와 status(`queued`, `acknowledgedAt: null`)가 그대로다. trigger를 지운 뒤 ACK하면 만료가 ACK+1h가 된다. trigger는 send 뒤에 만들어 `submitPrepared`의 갱신에는 영향이 없다. M11 검출 |
| N5 (minor) | 수정: `544cd6e` | 세 곳에 같은 뜻의 문장을 넣었다. 벤더 이름을 쓰지 않았고, 상한을 인증이나 principal로 표현하지 않았다 |

N5 문구:

- `mcp-server/src/session-message-service.ts:74`(send 용량 거절): "The rejected messageId stays prepared until its draft expires; after capacity is released, either retry that same messageId or prepare again, not both." 기존의 확정 무효과 문장 뒤, 해제 시각 문장 앞에 넣었다. 감사 mutant의 service 앵커(M16, M19, M21)가 그대로 맞도록 위치를 골랐다.
- `mcp-server/src/server.ts:536`(`send_session_message` 설명): "…is definite: nothing was queued. The rejected messageId stays prepared until its draft expires; after earliestReleaseAt either retry that same ID or prepare again, not both."
- `docs/session-message-lifecycle.md:35`: "send에서 거절된 `messageId`는 준비 만료까지 `prepared`로 남는다. 용량이 풀린 뒤에는 같은 ID 재시도와 새 prepare 가운데 하나만 한다. 둘 다 하면 한 의도가 두 메시지로 전달될 수 있다." `:33`의 "해당 draft는 준비 만료까지 남는다"와도 맞다.
- service 사례 `:255-256`이 새 문장을 단언한다.

## 2. mutant 결과 (새 후보)

방법:

- 새 후보 commit으로 detached worktree를 만들고 `pnpm install --frozen-lockfile`을 실행했다.
- 감사의 `scripts/mutants.py`를 수정 없이 썼다. 모든 앵커가 맞았다(apply 0).
- mutant마다 적용 → `node scripts/build.mjs` → `npx vitest run tests/session-messaging tests/session-board` → `git checkout -- .`를 반복했다.
- 러너는 감사의 `run-mutants.sh`에서 후보 테스트 열만 남긴 `scripts/run-mutants.sh`다. 감사 테스트 열은 돌리지 않았다.
- 로그: `logs/mutants/<id>.{apply,build,candidate}.log`, `.diff`, `mutants.tsv`.

기준선(BASELINE): 266 passed, 1 skipped. skip은 `AGS_PREVIOUS_BROKER_PATH`가 없는 previous-broker 사례다.

| mutant | 이전 후보(감사) | 새 후보 | 실패 수 |
|---|---|---|---|
| M01 sender 상한 251 | 검출 | 검출 | 6 |
| M02 sender 검사 제거 | 검출 | 검출 | 5 |
| **M03 전역 검사 먼저** | 생존 | **검출** | 1 (N2 사례) |
| M04 send 검사 제거 | 검출 | 검출 | 6 |
| **M05 용량 검사를 duplicate 앞으로** | 생존 | **검출** | 2 (N1 store, service 사례) |
| M06 검사를 transaction 밖으로 | 검출 | 검출 | 2 |
| M07 `changes` 검사 제거 | 검출 | 검출 | 3 |
| M08 `min()` 제거 | 검출 | 검출 | 1 |
| M09 영수증 갱신 제거 | 검출 | 검출 | 7 |
| M10 ACK+1h 대신 ACK | 검출 | 검출 | 7 |
| **M11 갱신을 COMMIT 뒤로** | 생존 | **검출** | 1 (N4 사례) |
| M12 prepare 입장 검사 제거 | 검출 | 검출 | 6 |
| M13 입장 검사를 prune 앞으로 | 검출 | 검출 | 2 |
| M14 broker details 누락 | 검출 | 검출 | 1 |
| M15 client details 무시 | 검출 | 검출 | 1 |
| M16 service details null | 검출 | 검출 | 1 |
| M17 earliest에 max | 검출 | 검출 | 3 |
| M18 scope 라벨 교체 | 검출 | 검출 | 3 |
| M19 용량 거절에 불확실 안내 | 검출 | 검출 | 1 |
| **M20 byte 거절 details 누락** | 생존 | **검출** | 1 (N3 사례) |
| M21 모든 거절을 확정으로 | 검출 | 검출 | 1 |
| M22 sender 개수 전체 계산 | 검출 | 검출 | 6 |

결과: 22개 모두 검출. 목표인 M03, M05, M20과 M11(N4)이 새로 검출됐고, 나머지 18개도 계속 검출된다.

## 3. 전체 검증 (새 후보)

`logs/summary.txt`, `logs/10`~`23`. 지시된 순서대로 실행했다.

| 명령 | 결과 | 로그 |
|---|---|---|
| `pnpm install --frozen-lockfile` | PASS | `10-install---frozen-lockfile.log` |
| `pnpm bundle:check` | PASS | `11-bundle-check.log` |
| `pnpm claude:drift` | PASS (`claude-plugin: fresh`) | `12-claude-drift.log` |
| `pnpm lint` | PASS | `13-lint.log` |
| `pnpm build` | PASS | `14-build.log` |
| `pnpm test` | PASS: 파일 60개 통과·1개 skip, 테스트 826개 통과·1개 skip | `15-test.log` |
| `pnpm runtime:check` | PASS | `16-runtime-check.log` |
| `pnpm validate:all` | PASS | `17-validate-all.log` |
| `pnpm validate:official` | FAIL_UNRELATED(환경): `/root/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py` ENOENT | `18-validate-official.log` |
| `pnpm claude:build` | PASS | `19-claude-build.log` |
| `pnpm claude:check` | PASS | `20-claude-check.log` |
| `git diff --check` | PASS | `21-git-diff-check.log` |
| `git status --porcelain`(마지막) | 빈 출력 | `22-git-status-final.txt` |

- 테스트 수는 이전 후보 822개에서 826개로 늘었다. 새 사례 4개를 추가했고, service 사례에는 단언을 더했다.
- 한 번 실패했다가 재실행으로 통과한 명령은 없다.

## 4. previous-broker

`git show <tag>:mcp-server/dist/session-message-broker.mjs`로 꺼낸 파일을 `AGS_PREVIOUS_BROKER_PATH`로 주고 `tests/session-messaging/previous-broker.test.ts`를 실행했다. 파일은 태그 내용과 `cmp`로 일치를 확인했다.

| 태그 | sha256 | 결과 |
|---|---|---|
| v2.7.2 | `fbb808e0fd8d52df17db7e7a8eeac84ed675f83a3abca9039f79740f2536f682` | PASS (1 passed) |
| v2.7.1 | `d4b667d417c6c8a8beaf749a2209ab1a8d1548a26d1f819dfcc6238a6711ab80` | PASS (1 passed) |
| v2.2.6 | `14f9345d3b18611fe0d5799ae56d65e3e80708ee288bbd771aafa5611a1a1cc3` | PASS (1 passed) |

## 5. 관찰 가능한 변화

- send 용량 거절 메시지와 `send_session_message` 설명에 한 문장이 추가됐다. 코드 동작, details 형태, ErrorCode, wire 필드는 바뀌지 않았다.
- 나머지 변경은 테스트뿐이다.

## 6. 통합 참고

- `session-message-service.ts:74`와 `server.ts:536`의 문구 변경은 wake 브랜치와 겹친다. `server.ts:536`은 감사 11절에서 이미 충돌로 확인된 send 설명 줄이라 충돌이 더 커질 수 있다.
- 새 store 테스트 가운데 `toEqual({ ...sent[i], duplicate: true })` 형태가 세 곳(`:279`, `:280`, `:285`)이다. 이들도 감사 11절의 `:113`과 같은 이유로 wake 통합 때 `autoWake` 기대값을 맞춰야 한다. 새 service 사례의 `toMatchObject`는 영향이 없다.

## 7. NOT_RUN

| 항목 | 이유 |
|---|---|
| `pnpm validate:official` | FAIL_UNRELATED(환경): Codex 공식 validator가 컨테이너에 없다 |
| 감사 테스트 열(`tests/audit-*.test.ts`)의 mutant 재실행 | 지시가 후보 테스트의 검출을 요구했다. 러너에서 감사 열은 뺐다 |
| Windows, 실제 호스트 MCP, 설치 캐시 | 범위 밖. 컨테이너에 없다 |
| 프로세스 강제 종료를 주입하는 원자성 시험 | 하네스가 없다. N4는 trigger로 문장 실패를 주입해 같은 transaction임을 관측했다 |

## 8. 가린 값

- 로그 6개 파일(`15-test.log`, `17-validate-all.log`, `18-validate-official.log`, `30-previous-broker-*.log` 3개)에서 컨테이너 홈 경로(`/home/<계정>`)의 계정 이름 부분을 `[REDACTED]`로 바꿨다.
- `/root/.codex/...`는 시스템 계정 경로라 그대로 두었다.
- 다음 패턴은 발견되지 않았다: `ghp_`, `gho_`, `github_pat_`, `sk-ant-`, `AKIA`, private key 줄, `Authorization: Bearer`, 이메일 주소, IPv4 주소.
- env·printenv 출력은 남기지 않았다. 가린 뒤 SHA256SUMS를 만들었다.
