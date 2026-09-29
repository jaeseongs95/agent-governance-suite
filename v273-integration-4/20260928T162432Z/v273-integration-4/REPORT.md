# AGS 2.7.3 통합 4단계 보고 (용량 거절 재시도 안내 반영)

지시: 총괄 ca8e3dc4. Q 재감사 minor R1에 대한 writer 수정(d99d768e)을 통합 브랜치에 병합하고, release notes의 해당 문장을 맞춘 뒤 Linux에서 전체 검증했다. d99d768e의 감사는 다른 세션에서 진행 중이다.

## 판정: PASS (fast-forward push 완료)

| 대상 | SHA |
| --- | --- |
| 기준 `claude/v273-integration` | b6deb37120e82c75ea0e3ba90a07324adf885969 (fetch 후 일치) |
| Q `claude/v273-msgqueue` | d99d768eab65878bab228ea73e5f5660ac98c616 (fetch 후 일치, 74395bf6 위 1 commit) |
| `merge: v2.7.3 capacity retry guidance` | 6b5af0842a1dfb83dce394d8fc8b52d2dfa2cb6e (부모 b6deb371, d99d768e) |
| **`docs: align v2.7.3 notes with capacity retry guidance` (새 HEAD)** | **6852c722514a1abfdf8ed08733c2041b1b4d4ce3 (tree 2e120ccd8b70e0da3e7283dbae60bcee77078315)** |

환경: Linux cloud 컨테이너, Node.js v24.21.0, pnpm 11.19.0.

## 병합과 충돌

d99d768e가 74395bf6 대비 바꾼 src·docs·tests 전체는 `logs/merge/q-d99d768e-src-docs-tests.diff`, 원래 충돌 diff는 `logs/merge/conflicts-raw.diff`에 있다.

| 파일 | 결과 | 해법 |
| --- | --- | --- |
| `mcp-server/src/server.ts:536` send 설명 | 충돌 | 통합본의 wake 문장 두 개(성공 의미, advisory autoWake)를 유지했다. Q의 옛 재시도 문장("stays prepared until its draft expires; after earliestReleaseAt either retry … not both")은 d99d768e의 새 문장으로 바꿨다("stays prepared until the expiresAt returned by prepare; if earliestReleaseAt is before that expiresAt, retry that same ID after earliestReleaseAt, otherwise prepare again. Never do both."). 해법 결과에서 wake 문장을 빼면 d99d768e 쪽과 같다는 것을 스크립트로 확인했다 |
| `mcp-server/dist/server.mjs`, `claude-plugin/mcp-server/dist/server.mjs` | 충돌(생성물) | 손으로 합치지 않았다. `pnpm build`와 `pnpm claude:build`로 다시 만들었다. 두 번들 모두 autoWake 문장과 새 재시도 안내를 담는다 |
| `mcp-server/src/session-message-service.ts` | 자동 병합 | send 용량 거절 메시지의 재시도 안내만 바뀐다 |
| `docs/session-message-lifecycle.md` | 자동 병합 | `:35` 문단의 재시도 안내만 바뀐다. wake 절과 겹치지 않는다 |
| `tests/session-messaging/message-retention.test.ts` | 자동 병합 | 새 테스트("when earliestReleaseAt is after the draft expiry …")는 `toMatchObject({ ok: true, data: { duplicate: false } })`만 쓰고 duplicate `toEqual`이 없다. 그래서 autoWake 기대값을 조정할 곳이 없었다 |

병합 뒤 `tests/session-messaging`는 280개 통과, 2개 skip이다.

## release notes (`logs/checks/release-notes.diff`)

`docs/release-notes-v2.7.3.md`의 Q 문단에서 한 문장을 새 문서 `:35`의 뜻에 맞게 바꿨다.

- 전: send에서 거절된 `messageId`는 준비 만료까지 prepared로 남으므로, 용량이 풀린 뒤 같은 ID 재시도와 새 prepare 가운데 하나만 합니다.
- 후: send에서 거절된 `messageId`는 prepare 응답의 `expiresAt`까지 prepared로 남습니다. `earliestReleaseAt`이 그 `expiresAt`보다 이르면 그 시각 뒤 같은 ID로 재시도하고, 그렇지 않으면 새로 prepare하며, 둘 다 하지 않습니다.

`TODO(총괄): Windows 로컬 검증 결과` 줄은 건드리지 않았다(1회 존재 확인). 링크 검사(`logs/checks/link-check.log`, 범위 b6deb371..HEAD)는 broken 0이다. release notes 링크 4개와 lifecycle 문서 링크 2개가 모두 OK다.

## 전체 검증

명령별 stdout, stderr와 종료 코드는 `logs/full/`에 있다.

| # | 명령 | 종료 코드 | 결과 |
| --- | --- | --- | --- |
| 01 | `pnpm install --frozen-lockfile` | 0 | PASS |
| 02 | `pnpm bundle:check` | 0 | PASS |
| 03 | `pnpm claude:drift` | 0 | PASS (`claude-plugin: fresh`) |
| 04 | `pnpm lint` | 0 | PASS |
| 05 | `pnpm build` | 0 | PASS |
| 06 | `pnpm test` | 0 | PASS: 파일 61 통과·1 skip, 테스트 858 통과·2 skip(previous-broker, env 없을 때 skip) |
| 07 | `pnpm runtime:check` | 0 | PASS |
| 08 | `pnpm validate:all` | 0 | PASS |
| 09 | `pnpm validate:official` | 1 | FAIL_UNRELATED(환경): 이 컨테이너에 Codex validator `validate_plugin.py` 없음(ENOENT). 총괄의 Windows 검증에서는 b6deb371 기준 통과했다고 전달받았다 |
| 10 | `pnpm claude:build` | 0 | PASS |
| 11 | `pnpm claude:check` | 0 | PASS |
| 12 | `git diff --check` | 0 | PASS |
| 13 | `pnpm source:check` | 0 | PASS |
| 14 | `pnpm source:verify` | 1 | NOT_VERIFIABLE: 오류는 삭제된 `ponytail` 원격 저장소 clone 인증 실패 1건뿐이다 |
| 15 | `git status --porcelain` | 0 | 출력 0 byte |

## Q 감사 mutant (`logs/mutants/`)

실행 대상은 후보 테스트(`tests/session-messaging` + `tests/session-board`)뿐이다. mutant마다 `node scripts/build.mjs` 뒤 실행하고 `git checkout`으로 되돌렸다. 끝난 뒤 작업 트리 변경은 0이다.

- 스크립트:
  - `mutants.py`: 감사 원본
  - `mutants-integration.py`: 통합용. M16, M19, M21을 추가했다
- 앵커:
  - M03, M16, M19, M20, M21: 감사 원본 앵커가 그대로 맞았다.
  - M05, M11: 2단계와 같이 wake 추가분(duplicate의 autoWake, ACK 뒤 `recordActivity`)을 포함한 앵커로 옮겼다.

| mutant | 결과 | 잡은 후보 테스트 |
| --- | --- | --- |
| BASELINE | 295 통과, 2 skip | — |
| M03 전역 검사 먼저 | **검출**(1) | sender·전역이 모두 찼을 때 sender scope 보고 |
| M05 용량 검사를 duplicate 앞으로 | **검출**(2) | service 용량 거절, 전 용량 duplicate 재전송 |
| M11 영수증 갱신을 COMMIT 뒤로 | **검출**(1) | 영수증 갱신 실패 시 ACK 전체 rollback |
| M16 service details null | **검출**(2) | service 용량 거절, 새 "earliestReleaseAt이 draft 만료보다 늦음" 사례 |
| M19 send가 불확실 안내 사용 | **검출**(2) | 위 두 사례 |
| M20 byte 거절 details 누락 | **검출**(1) | byte 한도 send 거절 details |
| M21 모든 거절을 확정으로 | **검출**(2) | 위 두 사례 |

## intake init-smoke (`logs/checks/init-smoke.log`)

9경우(배치 3 × profile 3) 모두 결과가 같다. 1~3단계와 같은 값이다.

- instructions sha256 `474cdcdb93a26a3bed0c58cc03313b3b47e7c19c654702476cb202efc43a0b75`, 3548 byte
- intake 1회, 도구 28개, 제품명 없음

## NOT_RUN

- `validate:official`의 실제 검사(이 컨테이너): Codex validator가 없다.
- `source:verify`의 `ponytail` 원격 확인: 저장소가 삭제됐다(NOT_VERIFIABLE).
- previous-broker, Q·wake 감사 테스트, 나머지 Q mutant 15개: 이번 지시 목록에 없다.
- Windows × Node.js 24, 실제 host wake 주입·관측, 설치 캐시: 총괄의 로컬 검증 범위다.
- d99d768e 자체의 독립 감사: 다른 세션에서 진행 중이다.
- tag, GitHub Release, main 반영: 금지 범위다.

## 가린 값

토큰 패턴(`ghp_`, `gho_`, `github_pat_`, `sk-ant-`, `AKIA`, PRIVATE KEY 줄, Authorization Bearer), 이메일 주소와 IPv4 주소는 발견되지 않았다. `env`·`printenv` 출력과 Python 캐시는 남기지 않았다. 다음을 바꾼 뒤 `SHA256SUMS`를 만들었다.

| 대상 | 치환 | 파일 수 | 횟수 |
| --- | --- | --- | --- |
| 사용자 이름이 들어간 컨테이너 홈 경로 | `[REDACTED-HOME]` | 11 | 11 |
| root 계정 홈 경로 | `[REDACTED-HOME]` | 1 | 2 |
| GitHub 계정 이름(URL 소유자) | `[REDACTED-ACCOUNT]` | 2 | 3 |
