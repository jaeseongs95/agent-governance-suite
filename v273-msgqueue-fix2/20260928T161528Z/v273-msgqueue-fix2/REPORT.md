# AGS 2.7.3 Q 재감사 R1 처리 보고

- 지시: 총괄 ca8e3dc4.
- 기준: `claude/v273-msgqueue` = `74395bf698012a8b2e034e58e3b42d51f53b0b68`. fetch 뒤 local HEAD와 origin이 모두 이 값인 것을 확인했다.
- 입력: `claude/evidence-v273-msgqueue-reaudit-20260928T160657Z`의 `audit/REPORT.md` R1, `tests/reaudit-n5.test.ts` N5-b, `scripts/mutants.py`.
- 새 후보: commit `d99d768eab65878bab228ea73e5f5660ac98c616`, tree `bfa89453d591e03a3e9c66fe6df14a503e798bbc`. 메시지는 `fix: say when a capacity-rejected message ID can be retried`이다.
- push: fast-forward인지 `merge-base --is-ancestor`로 먼저 확인한 뒤 non-force로 `74395bf..d99d768`을 push했다. `ls-remote` 값이 새 후보와 같다.
- 바꾸지 않은 것: 제품 동작, `details` 형태, ErrorCode, store 코드. wake 브랜치도 합치지 않았다.

## 1. R1 처리: 권장 (a) 조건부 문구

세 곳의 뜻을 맞췄다. 뜻은 다음과 같다. 거절된 ID는 prepare가 돌려준 `expiresAt`까지 prepared로 남는다. `earliestReleaseAt`이 그보다 이르면 그 시각 뒤 같은 ID로 재시도하고, 아니면 새로 prepare한다. 둘 다 하지 않는다. 벤더 이름과 인증·principal 표현은 쓰지 않았다.

- `mcp-server/src/session-message-service.ts:74`(send 용량 거절, 확정 무효과 문장과 해제 시각 문장 사이):
  > The rejected messageId stays prepared until the expiresAt returned by prepare_session_message. If earliestReleaseAt is before that expiresAt, retry that same messageId after earliestReleaseAt; otherwise the draft expires first, so prepare again. Never do both.
- `mcp-server/src/server.ts:536`(`send_session_message` 설명의 끝):
  > …is definite: nothing was queued. The rejected messageId stays prepared until the expiresAt returned by prepare; if earliestReleaseAt is before that expiresAt, retry that same ID after earliestReleaseAt, otherwise prepare again. Never do both.
- `docs/session-message-lifecycle.md:35`(기존 N5 세 문장을 바꿈):
  > send에서 거절된 `messageId`는 prepare 응답의 `expiresAt`(준비 만료)까지 `prepared`로 남는다. `earliestReleaseAt`이 그 `expiresAt`보다 이르면 그 시각 뒤 같은 `messageId`로 재시도할 수 있다. 그렇지 않으면 draft가 먼저 만료되므로 새로 prepare한다. 둘 다 하지 않는다. 둘 다 하면 한 의도가 두 메시지로 전달될 수 있다. 용량 거절을 받은 뒤 그 ID로 다시 send하지 않았는데 draft가 만료돼 같은 ID의 send가 unknown(`Issued message ID is unavailable`)으로 거절될 수 있다. 이 경우 그 ID는 앞선 확정 거절로 전달되지 않았음이 이미 확인됐으므로, 저장한 거절 응답과 대조한 뒤 새로 prepare해도 된다. 확정 거절 기록이 없는 unknown ID는 기존처럼 저장한 영수증과 대조하고 무조건 다시 준비하지 않는다.

draft 만료 뒤 unknown이 되는 경우를 다룬 문장은 조건을 둘 붙였다.

- 거절 뒤 그 ID로 다시 send하지 않았을 것. 재시도했다가 응답을 잃었다면 실제로 전달됐을 수 있기 때문이다.
- 저장한 거절 응답과 대조할 것. 이렇게 해서 기존 불확실 안내 규칙(저장한 영수증과 대조)과 모순되지 않게 했다.

문장 위치는 감사 mutant의 service 앵커가 그대로 맞도록 정했다. 앵커는 M19의 `This definite rejection` 접두와 M16의 `${capacityRelease(details)}`, `{ ...details });` 접미다.

## 2. 테스트 (`tests/session-messaging/message-retention.test.ts`)

- `:16` `RETRY_GUIDANCE`: service 문장 전문을 담은 상수다.
- 기존 service 사례 `:256`: 옛 두 부분 일치 단언을 `toContain(RETRY_GUIDANCE)`(문장 전체 일치)로 바꿨다.
- 새 사례 `:353` "when earliestReleaseAt is after the draft expiry, the guidance leads to a new prepare that succeeds". N5-b 조건을 쓰고, 실제 broker와 service를 거친다.
  1. `earliestReleaseAt > prepare의 expiresAt`을 단언한다.
  2. 메시지가 `RETRY_GUIDANCE`와 "otherwise the draft expires first, so prepare again"을 포함하는지 단언한다.
  3. 테스트 DB에서 draft와 가장 이른 영수증을 만료시켜 시간이 지난 상태를 만든다.
  4. 같은 ID의 send가 `details: null`, `Issued message ID is unavailable`이고 큐 행이 0인지 단언한다. 문서가 적은 경우다.
  5. 안내대로 새로 prepare하고 send하면 `ok`, `duplicate: false`이고 해당 본문의 메시지가 정확히 1개인지 단언한다.
- `message-retention.test.ts`: 16/16 통과.

## 3. mutant (새 후보)

재감사의 `scripts/mutants.py`를 수정 없이 썼고, 모든 앵커가 맞았다(apply 0). 러너는 `scripts/run-mutants.sh`이며 후보 테스트 `tests/session-messaging`과 `tests/session-board`를 돌린다. 로그는 `logs/mutants/`에 있다.

| mutant | 결과 | 실패 수 |
|---|---|---|
| BASELINE | 267 passed, 1 skipped | 0 |
| M03 전역 검사 먼저 | 검출 | 1 |
| M05 용량 검사를 duplicate 앞으로 | 검출 | 2 |
| M11 갱신을 COMMIT 뒤로 | 검출 | 1 |
| M16 service details null | 검출 | 2 |
| M19 용량 거절에 불확실 안내 | 검출 | 2 |
| M20 byte 거절 details 누락 | 검출 | 1 |
| M21 모든 거절을 확정으로 | 검출 | 2 |

지시받은 7개가 모두 검출됐다. M16, M19, M21은 새 사례에서도 잡혀 실패 수가 1에서 2로 늘었다. 나머지 15개 mutant는 이번에 다시 돌리지 않았다. store 코드가 바뀌지 않았으므로, 재감사 결과(22개 검출)를 그대로 참고한다.

## 4. 전체 검증 (새 후보)

`logs/summary.txt`와 `logs/10`~`22`에 있다.

| 명령 | 결과 |
|---|---|
| `pnpm install --frozen-lockfile` | PASS |
| `pnpm bundle:check` | PASS |
| `pnpm claude:drift` | PASS (`claude-plugin: fresh`) |
| `pnpm lint` | PASS |
| `pnpm build` | PASS |
| `pnpm test` | PASS: 파일 60개 통과·1개 skip, 테스트 827개 통과·1개 skip(skip은 `AGS_PREVIOUS_BROKER_PATH`가 없는 previous-broker) |
| `pnpm runtime:check` | PASS |
| `pnpm validate:all` | PASS |
| `pnpm validate:official` | FAIL_UNRELATED(환경): `/root/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py` ENOENT |
| `pnpm claude:build` | PASS |
| `pnpm claude:check` | PASS |
| `git diff --check` | PASS |
| 마지막 `git status --porcelain` | 빈 출력 |

한 번 실패했다가 재실행으로 통과한 명령은 없다.

previous-broker는 태그에서 꺼낸 파일이 태그 내용과 같은지 `cmp`로 확인한 뒤 실행했다.

| 태그 | 결과 |
|---|---|
| v2.7.2 | PASS (1 passed) |
| v2.7.1 | PASS (1 passed) |
| v2.2.6 | PASS (1 passed) |

## 5. 통합 참고

`server.ts:536`과 `session-message-service.ts:74`는 wake 브랜치와 겹치는 줄이다. 이번 변경은 문장 내용만 바꿨다.

## 6. NOT_RUN

| 항목 | 이유 |
|---|---|
| `pnpm validate:official` | FAIL_UNRELATED(환경): Codex validator가 없다 |
| mutant 15개(M03, M05, M11, M16, M19, M20, M21 외) | 지시 범위 밖이고 store 코드는 바뀌지 않았다. 재감사 결과를 참고한다 |
| 감사 테스트(`tests/audit-*`, `tests/reaudit-*`) | 후보 테스트로 검증했다. `reaudit-n5` N5-b는 이제 옛 문구를 단언하므로 새 후보에서는 실패할 것으로 예상하지만, 실행하지 않았다 |
| Windows, 실제 호스트 MCP, 설치 캐시 | 범위 밖. 컨테이너에 없다 |

## 7. 가린 값

- 로그 6개 파일(`15-test.log`, `17-validate-all.log`, `18-validate-official.log`, `30-previous-broker-*.log` 3개)에서 컨테이너 홈 경로(`/home/<계정>`)의 계정 이름 부분을 `[REDACTED]`로 바꿨다.
- `/root/...`는 시스템 계정 경로라 그대로 두었다.
- 다음 패턴은 발견되지 않았다: `ghp_`, `gho_`, `github_pat_`, `sk-ant-`, `AKIA`, private key 줄, `Authorization: Bearer`, 이메일 주소, IPv4 주소.
- env·printenv 출력은 남기지 않았다. 가린 뒤 SHA256SUMS를 만들었다.
