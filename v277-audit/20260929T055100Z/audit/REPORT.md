# AGS v2.7.7 독립 사전 감사: 세션 메시지 byte 단위 줄 reader

- 판정 대상: `claude/v277-utf8-framing` = `fd3f486a4ad976756532d1de0705e8a819f92778` (tree `1933de6506562af9dda1f4982fcbc24cc370952b`)
- 기준: main `9e76a07b81c8c8eba855acf48b7b25bf395e7548` (v2.7.6 + README PR #21). 후보는 기준의 fast-forward다.
- 커밋: `bd571c7c` fix, `cf09ff6a` docs, `fd3f486a` chore: release 2.7.7
- writer 근거 `evidence` `26ba523` : `v277-utf8/20260929T052434Z`는 대조에만 썼다(SHA256SUMS 41/41 일치). 판정은 아래 직접 재현으로만 했다.
- 읽기 전용. 제품 소스는 바꾸지 않았다. 시험 복사와 mutant는 버리는 worktree에서만 했고, 끝난 뒤 `git status`가 깨끗한 것을 확인했다.

## 판정: PASS_WITH_FINDINGS — 출시 차단 아님

reader 구현, 경계 기준, 반증, mutant, 호환 시험이 모두 요구대로다. finding은 문서 문장 하나(D-1, minor)다. 제품 동작은 이미 그 경우도 고친다.

## 1. 범위와 신선도 — PASS

- `9e76a07b..fd3f486a`: 30개 파일, +555/−105.
- 제품 소스 변경은 `session-message-protocol.ts`(reader 추가), `session-message-client.ts`, `session-message-broker.ts`와 `plugin-info.ts`(버전 문자열)뿐이다.
- 버전 파일 집합이 `git diff v2.7.5 v2.7.6` 때와 같다: `.agents/plugins/marketplace.json`, `.codex-plugin/plugin.json`, `README.md`, `README.en.md`, `claude-plugin/.claude-plugin/plugin.json`, `docs/roadmap.md`, `package.json`, `release/version.json` (+ `plugin-info.ts`).
- dist 6개(`server`, `session-board-hook`, `session-message-broker`, `-cli`, `-hook`, `-relay`)는 `mcp-server/dist`와 `claude-plugin/mcp-server/dist`가 byte 동일하다.
- `bundle:check` 0, `claude:drift`·`claude:check` fresh (logs/full-*.log).
- fixture 격리(logs/fixture-and-reader-scan.txt): `padded-claim`, `over-by-one`, `straddlingClaim`, `straddlingPing`, `utf8-layout`, `headBytes` 문자열이 `mcp-server/dist`, `claude-plugin`, `runtime`, `skills`, `.codex-plugin`, `.agents`, `hooks`에서 0건이다. `claude-plugin/tests/`도 없다.

## 2. reader 정확성 — PASS

`session-message-protocol.ts:20-31` `sessionMessageLineReader(limitBytes)`

- **한도 계산:** 줄바꿈이 있으면 `newline + 1`, 없으면 `pending.length`이고, `> limitBytes`면 던진다.
  - broker 쪽 기준과 한 byte까지 같다. `claimResponseBytes`(`session-message-store.ts:109-111`)는 `Buffer.byteLength(JSON.stringify({ ok: true, data: { messages } })) + 1`을 쓰고, claim 응답 data는 `{ messages }` 그대로다(`session-message-broker.ts:217-223`). list-presence(`:394`)도 `` `${JSON.stringify(...)}\n` `` byte 수를 `> 32768`로 판정한다.
  - 실제 broker와 TLS로 확인했다. 32768 byte 응답은 받고, 32769 byte 응답은 거절한다. 요청도 32768 byte는 받고, 32769 byte는 거절한다(시험 2a/2b, 반증 로그).
  - 줄바꿈이 없을 때 정확히 한도만큼이면 기다리고, 다음 조각에서 줄바꿈이 오면 32769가 되어 거절한다.
- **줄 뒤 byte:** 같은 조각으로 온 byte는 버린다(`pending = Buffer.alloc(0)`).
  - 옛 broker의 `buffer = ""`와 같다. 옛 client는 줄 하나에서 finish했으므로 결과가 같다.
  - 차이는 한 가지다. 옛 코드는 줄 뒤 byte까지 한도에 세었다. 연결마다 줄 하나를 주고받는 지금 사용에서는 영향이 없다(A6 참고).
- **client의 늦은 data:** `finish`가 `settled`로 한 번만 실행되고 `socket.destroy()`를 부른다(`session-message-client.ts:174-181`). 그래서 늦은 data는 결과를 바꿀 수 없다. reader가 던져도 `finish`로 가므로 두 번 결정되지 않는다.
- **broker에서 한도 초과 뒤 계속 data가 올 때** (logs/flood-probe.jsonl, 옛 broker와 새 broker 모두 source broker)

  | 경우 | 9e76a07b | fd3f486a |
  |---|---|---|
  | 64 MiB를 64 KiB씩 연속 전송 | 약 4.0 MB 쓴 뒤 8ms에 닫힘, 거절 1줄 | 약 3.6 MB 쓴 뒤 9ms에 닫힘, 거절 1줄 |
  | 40 KB 뒤 1 KiB를 20ms 간격으로 전송 | 1ms에 end, 2ms에 close | 2ms에 end·close |
  | broker RSS (전→후) | 77.1→78.2 MB | 76.9→78.4 MB |
  | 뒤이은 ping | ok | ok |

  - 초과 뒤 첫 조각에서 `socket.end(거절)`이 나간다.
  - 다음 조각의 `end`는 write-after-end 오류가 되고, 이 오류가 `socket.on("error", destroy)`로 socket을 닫는다.
  - 그래서 pending은 socket이 닫힐 때까지 한두 조각만 더 자라고, `end` 반복도 사실상 한 번이다. 옛 동작과 같고 나빠지지 않았다(I-3).
- **`Buffer.concat` 비용** (logs/reader-cost.txt, 32768 byte 한 줄의 CPU)

  | 조각 크기 | 새 reader | 옛 reader |
  |---|---|---|
  | 16384 | 0.07ms | 0.21ms |
  | 1024 | 0.35ms | 0.78ms |
  | 64 | 3.6ms | 4.2ms |
  | 1 | 179ms | 111ms |

  실제 TLS 조각(16384)에서는 더 빠르다. 1 byte 조각은 악의적인 로컬 peer만 만들 수 있는 병적인 경우이고, 옛 코드도 O(n²)이었다(I-2).
- **잘못된 UTF-8** (fuzz 20000건, 그중 잘못된 byte열 7617건, 조각은 항상 16384를 포함; logs/reader-fuzz.txt)
  - 새 reader: 한 번 decode한 원문과 다른 줄 0건, 한도 판정 오류 0건, 옛 reader보다 엄격해진 경우 0건.
  - 옛 reader: 거짓 한도 초과 4760건, 원문과 다른 줄 4285건.
  - 문자 경계에서 잘린 유효 UTF-8(줄 뒤 byte 없음) 1430건은 옛 reader와 결과가 모두 같았다.
  - 0x0A는 여러 byte 문자 안에 나오지 않으므로 byte 검색과 문자열 검색의 줄 경계가 같다.
- **벤더 중립:** reader 정의는 `session-message-protocol.ts` 하나이고 호스트 이름이 없다. 소스에 `chunk.toString`은 남아 있지 않다. dist마다 복사본이 있는 것은 번들러가 각 진입점에 넣은 것이다.

## 3. 반증과 mutant — PASS

- **9e76a07b 소스 + 후보 시험 파일 3개** (logs/refute-base-utf8-framing.log): 12/12 실패.
  - reader 단위 시험 6개: reader가 없음.
  - 응답 경계 2개: "The broker response exceeded its limit."
  - 요청 경계 2개: "Request exceeds the broker limit."
  - CLI 12묶음: 0–10 깨짐(11/12), U+FFFD 29개.
  - lease: returned 0, intact false.
  - 후보에서는 12/12 통과한다.
- **previous-broker 새 시험:** 9e76a07b client + v2.7.6 broker에서 응답 한도 초과로 실패하고, 후보 client에서는 통과한다(5절).
- **lease 경우 직접 재현** (별도 probe; logs/lease-probe.jsonl): 32767 byte 한글 응답이고, 16384에서 1|2로 나뉜다.

  | | 9e76a07b | fd3f486a |
  |---|---|---|
  | CLI 결과 | ok, messages 0개 | ok, 9개 원문 그대로 |
  | CLI 중 broker 연결 | 3개: claim(32767 byte, 조각 [16384, 16383]) → ping(147) → claim(35 byte, 빈 목록) | 1개: claim(조각 [16384, 16383]) |
  | 남은 행 | 9행, attempt 1, lease 120000ms | 9행, attempt 1, lease 120000ms(호출자가 보유) |
  | 곧바로 다시 claim | 0개 | 0개 |

  writer의 "확인" 판정이 맞다. 옛 client는 거절이 아닌 오류로 보고 broker를 확인한 뒤 다시 claim했고, 첫 claim의 lease 때문에 0개를 받았다.
- **실제 TLS 조각:** 응답은 [16384, 16383], 32768 byte 요청은 broker 쪽에서 [16384, 16384]로 받았다. 이는 broker preload로 기록했다. fixture의 16384 가정은 실제 전송 byte로 확인했다.
- **mutant** (logs/mutants-summary.tsv, logs/mutants/): 대상은 `tests/session-messaging/` 전체이고, BASELINE은 통과했다.

  | mutant | 결과 | utf8-framing 실패 수 |
  |---|---|---|
  | M1 조각마다 decode | KILLED | 12 |
  | M2a decode한 문자열로 한도 계산 | KILLED | 1 |
  | M2b 조각별 decode byte 합 | KILLED | 6 |
  | M3 `>` → `>=` | KILLED | 5 |
  | M4 줄바꿈을 한도에서 뺌 | KILLED | 5 |
  | M5 broker만 옛 reader | KILLED | 2 |
  | M6 client만 옛 reader | KILLED | 4 |
  | A1 줄 뒤 pending을 비우지 않음 | SURVIVED | 0 |
  | A2 줄바꿈을 찾은 뒤에만 한도 검사 | KILLED | 1 |
  | A3 줄을 조각별 `toString`으로 만듦(크기는 원시 byte) | KILLED | 10 |
  | A4 줄바꿈을 decode한 문자열에서 찾음 | SURVIVED | 0 |
  | A5 줄 뒤 byte를 다음 줄로 남김 | SURVIVED | 0 |
  | A6 줄 뒤 byte까지 한도에 셈 | SURVIVED | 0 |
  | A7 초과해도 거절하지 않음 | KILLED | 5 |
  | A8 한도 +1 | KILLED | 5 |
  | A9 broker가 거절 대신 destroy | KILLED | 2 |
  | A10 client 한도 초과를 거절로 분류 | KILLED | 2 |
  | A11 client 한도를 절반으로 | KILLED | 4 (+1) |

  - 살아남은 A1, A5, A6은 줄 뒤 byte만 다르게 다룬다. client는 요청 한 줄만 쓰고 broker는 응답 한 줄 뒤 `end`하므로, 지금 프로토콜에서는 결과가 같다.
  - A4는 유효 UTF-8에서 같다. broker와 client는 `JSON.stringify` 출력만 보내므로 항상 유효 UTF-8이고, 잘못된 byte는 악의적 peer만 보낸다.
  - 네 경우 모두 시험 공백이지만 출시 위험은 아니다(I-1).

## 4. 시험 품질 — PASS

- **결정성**
  - 벽시계 lease나 sleep이 없다. lease는 DB의 `claim_until − claimed_at`으로 본다.
  - byte 배치는 `fixtures/utf8-layout.ts`가 계산하고, 시험이 보낸 줄을 다시 직렬화해 길이와 16384 위치를 단언한다. 실제 TLS 조각 크기는 3절 probe로 따로 확인했다.
  - `straddlingClaim`은 앞 8개 본문을 같게 해 같은 ms 안의 순서가 분할 위치를 바꾸지 못하게 한다.
- **10회 반복** (logs/repeat10.tsv): 10/10, 매회 12/12, 2.8–4.4초. HOME과 XDG 디렉터리를 매회 새 디렉터리로 돌렸고, 거기에 쓴 것은 vitest token과 pnpm state뿐이었다(제품 상태 없음). 남은 `ags-utf8-framing-*` 임시 디렉터리와 broker process는 없었다.
- **Windows 호환성** (코드 검토만 함, 실행은 총괄이 따로 함)
  - 경로: `path.join`/`tmpdir`를 쓰고, preload는 `pathToFileURL(...).href`로 넘긴다.
  - 자식 종료: `child.kill()` 뒤 `once(child, "exit")`를 기다린다.
  - 정리: `rm(..., { maxRetries: 10 })`, `windowsHide: true`.
  - 위험: source broker를 tsx로 7번 띄우고 매번 5초 안에 준비되기를 기다린다. presence-retention과 같은 방식이므로 느린 Windows runner에서는 이 대기가 가장 약한 곳이다(I-5).
  - preload(`padded-claim.mjs`)가 `.ts` 모듈을 import해서 broker의 `./session-message-store.js`와 같은 인스턴스가 되는지는 tsx 해석에 기댄다. Linux에서는 over-by-one 시험이 통과하므로 같은 인스턴스다. Windows는 확인하지 못했다.
- **previous-broker.test.ts 변경**
  - 기존 4개 시험은 바뀌지 않았다. diff에는 import 추가와 새 시험 하나만 있다.
  - 새 시험의 요청 쪽 기대는 `previousAtLeast([2,7,7])`에 묶여 있다. 2.7.7 미만이면 거절(`BrokerRequestRejected("Request exceeds the broker limit.")`)을, 이상이면 수락을 기대한다. 버전이 없으면 실패한다.
  - 응답 쪽은 버전과 무관하게 온전해야 한다.

## 5. previous-broker — PASS (logs/previous-broker-summary.tsv, tag dist broker)

| 경우 | broker | 버전 입력 | 결과 |
|---|---|---|---|
| P1 | v2.7.6 | 2.7.6 | 5/5 |
| P2 | v2.7.5 | 2.7.5 | 5/5 |
| P3 | v2.7.3 | 2.7.3 | 5/5 |
| P4 | v2.7.6 | 없음 | 3/5, 버전 오류로 2개 실패(ended-birth, 새 시험) |
| P5 | v2.7.6 | 2.7.7 (거짓) | 4/5, 새 시험이 "Request exceeds the broker limit."로 실패 |
| P6 | v2.7.6, 9e76a07b client | 2.7.6 | 4/5, 새 시험이 "The broker response exceeded its limit."로 실패 |

- v2.7.6과 v2.7.5의 broker 번들은 byte가 같다(sha256 앞 16자리 `9f1efa9ef29a677d`). 그래서 P1은 P2와 같은 broker를 시험한다(I-4).

## 6. 문서 — PASS_WITH_FINDINGS

- 코드 설명은 코드와 맞는다: 공통 reader, byte 단위 줄바꿈, 한 번 decode, 줄바꿈 포함 32768 이하, 오류 문구와 분류, protocol 1.0.0.
- 측정도 재현과 맞는다: 11/12 깨짐, 32767 byte 응답에서 CLI 0개 반환과 9행 120초 lease, 새 client가 옛 broker의 32768 byte 한글 응답을 받음, 같은 크기 요청을 옛 broker가 거절함.
- 알려진 한계 세 가지(2.7.6 이하 client, 옛 broker 요청 reader, 이미 ACK된 깨진 메시지)는 정확하다.
- 공개된 v2.7.6 이하 notes 변경 0건. 새 링크는 `../README.md#설치`(README `:33` 존재)뿐이고, `architecture.md`의 링크 두 개는 전부터 있던 것이다. 외부 스킬 저장소 링크는 없다.
- **D-1(minor):** "hook 전달 경로는 한 번에 한 메시지(본문 4096 byte 이하)만 받으므로 응답이 16384 byte에 닿지 않아 영향이 없었습니다"는 일반 본문에만 맞다. 7절에 따로 적었다.

## 7. Findings

- **D-1 (minor, 문서, 비차단)**
  - 대상 문장: release notes의 "hook 전달 경로는 … 응답이 16384 byte에 닿지 않아 영향이 없었습니다".
  - 반례: 제어 문자는 JSON에서 `\u0001`처럼 6 byte로 늘어난다. 본문 4096 byte 한도 안에서 hook과 같은 한도(`maxMessages: 1`, `maxBodyChars: 4096`)로 claim해도 응답이 16384 byte를 넘을 수 있다.
  - 재현(logs/hook-shape-probe.jsonl): 본문은 제어 문자 2600개 + 한글 496자, 4088–4090 byte. 응답 조각은 [16384, 약 1060]이었다.
    - 9e76a07b: 3가지 배치 모두 본문 깨짐(U+FFFD 5, 3, 2개).
    - fd3f486a: 모두 온전.
  - "번들 client 요청은 … 16384 byte에 닿기 어렵습니다"도 같은 이유로 제어 문자가 많은 본문에서는 닿는다. 다만 "어렵다"로 이미 완화돼 있다.
  - 흔한 입력은 아니고, 이번 수정이 이 경우도 고친다.
  - 권장 문구: "일반 텍스트 본문으로는 닿지 않으며, 제어 문자가 많아 JSON escape로 크게 늘어나는 본문에서만 닿을 수 있다."

## 정보 (변경 요구 없음)

- **I-1:** 줄 뒤 byte 처리(A1, A5, A6)와 잘못된 UTF-8의 원시 byte 계산(A4)을 묶는 시험이 없다. 지금 사용에서는 동등하고 fuzz로 확인했다. 원하면 reader 단위 시험 두 개(줄 뒤 byte, 잘못된 byte)를 더할 수 있다.
- **I-2:** 조각마다 `Buffer.concat`이라 1 byte 조각에서 줄 하나에 179ms가 걸린다(옛 코드 111ms). 병적인 로컬 peer에서만 생긴다. 조각 배열과 누적 길이로 바꾸면 선형이 된다.
- **I-3:** 초과 뒤 연결을 닫는 것은 write-after-end 오류 → `destroy`라는 간접 경로에 기대며, 옛 코드와 같다. 명시적으로 `destroySoon`이나 첫 초과 뒤 data 무시를 두면 더 분명하다.
- **I-4:** v2.7.6과 v2.7.5 broker 번들이 같아서 v2.7.6 행은 추가 범위가 없다.
- **I-5:** 느린 Windows runner에서는 새 시험의 source broker 5초 준비 대기가 약한 곳이다(presence-retention과 같은 방식).
- **I-6 (기존, 범위 밖):**
  - `claimResponseBytes`는 `{ messages }` 기준인데, `claim-wake`/`claim-host-wake` 응답은 `recognized`, `managed` 필드를 더 담는다. 여러 메시지를 한도까지 채우면 수십 byte 넘칠 수 있다.
  - 번들 호출자는 hook(메시지 1개)뿐이다. 1개 응답은 최대 약 25 KB라 닿지 않는다.

## 8. 검증 — PASS (validate:official만 FAIL_UNRELATED)

fd3f486a 깨끗한 worktree, Node v24.21.0 (logs/full-summary.tsv):

| 단계 | 결과 |
|---|---|
| install --frozen-lockfile | 0 |
| bundle:check | 0 |
| claude:drift | 0 (fresh) |
| lint | 0 |
| build | 0 |
| test | 0 — 65 files passed, 1 skipped; 898 passed, 5 skipped |
| runtime:check | 0 |
| validate:all | 0 |
| validate:official | 1 — Codex validator 없음(ENOENT), FAIL_UNRELATED(환경) |
| claude:build / claude:check | 0 / 0 (fresh) |
| git diff --check (작업 트리 / 9e76a07b..fd3f486a) | 0 / 0 |
| source:check | 0 |
| 검증 뒤 작업 트리 변경 | 0 byte |

- utf8-framing 10회: 10/10.
- previous-broker v2.7.6, v2.7.5, v2.7.3(버전 입력 포함): 각 5/5.

## NOT_RUN

- Windows 실행(총괄 수동 관문), fd3f486a의 GitHub CI
- 실제 PC·설치 캐시·MCP 호출 흐름
- previous-broker v2.7.4, v2.7.2 이하
- source:verify
- 실제 hook(`claim-host-wake`) 경로로 D-1 반례를 보내는 것. 같은 한도의 `claim`으로 대신했다.

## 하네스 메모

- `/tmp/ags-presence-retention-wSOirv`(mtime 03:32Z)는 이전 v2.7.6 감사의 기준 실행이 남긴 것이라 지웠다(logs/cleanup.txt).
- previous-broker 행렬과 10회 반복 끝의 broker process 수(3, 1)는 동시에 돌던 mutant 실행의 것이다. 모든 실행이 끝난 뒤에는 0이었다.
- lease probe의 첫 실행에서는 요청 조각 기록이 close 시점에 빠졌다. 조각마다 바로 기록하도록 고쳐 다시 돌렸고, 로그는 두 번째 실행 결과다.
- flood probe의 첫 실행은 probe 자체의 `once(drain)` 예외(ECONNRESET)로 멈췄다. 예외를 잡도록 고쳐 다시 돌렸다.
