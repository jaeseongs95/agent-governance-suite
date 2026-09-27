# peer 결과 대기 판정

2.6.0은 메시지 전송, 호출 전 제한, 턴을 끝낸 뒤의 복귀를 별도 기능으로 다룬다. 메시지나 ACK가 존재한다는 사실은 업무 완료나 승인을 뜻하지 않는다.

## 실행 경계

| 경로 | 관측과 실제 효과 |
| --- | --- |
| 지원 Codex hook | `PreToolUse`의 정확한 `mcp__codex_app__wait_threads` 이름과 `targets[].threadId`, 로컬 `hostId`, `timeoutMs`를 읽는다. main actor가 관측되고 아래 조건이 충족되면 호출 전에 `permissionDecision: deny`를 반환한다. |
| hook 없는 기존 CLI | stdin의 `wait` 작업이 같은 브로커 판정을 받은 뒤 실제 delay 실행 여부를 결정한다. 거절 시 추가 조회·delay가 없고, 복귀 미확인이면 최대 1000ms 대기 후 한 번만 갱신한다. |
| 그 밖의 native 호출 | AGS가 실행 경계를 소유하지 않는다. 안내만 가능하며 MCP 서버가 호출을 가로막는다고 주장하지 않는다. |

강제 제한에는 다음 관측이 모두 필요하다.

1. 모든 대상에 현재 hook 결속 sender와 주고받은 만료 전 peer 메시지 메타데이터가 있다. 서로 다른 채팅이나 관계가 미확인인 대상이 섞이면 제한하지 않는다.
2. sender presence가 online이며 최신 instance의 lease가 유효하다.
3. 브로커가 기존 relay acquire/heartbeat에서 같은 instance를 결속했고 relay lease·relay ID와 현재 relay/parent 프로세스 생존이 일치한다. 구 relay가 instance를 제공하지 않으면 미확인이다.
4. 같은 instance와 relay에서 예약된 nonce가 실제 host wake hook의 `claim-wake`에서 유효하게 소비되었으며 그 관측이 30초 이내이다. 기능 선언·브랜드·ACK·caller JSON만으로 이 증거를 만들지 않는다.
5. presence에 `peer-wake` 주입과 `idleWake`가 선언되어 있으며 wake visibility와 일치한다. `none`은 복귀 가능한 상태로 취급하지 않는다.

복귀가 확인된 peer 대기의 positive timeout은 거절한다. `timeoutMs: 0`은 첫 조회를 허용한다. 같은 대상·peer 상태·관측 cursor의 반복 조회만 30초 동안 억제하며, 거절된 반복은 만료 시각을 연장하지 않는다. peer 메타데이터나 cursor 변화, 새 사용자 입력 또는 기록 만료는 첫 조회를 다시 허용한다. `get_session_message_status`, 일반 sleep·셀 대기·프로세스·테스트 대기는 이 native 제한 대상이 아니다. 명시적인 사용자 대기 의도를 임의 regex나 `approved` 필드로 추정하지 않는다.

복귀가 없거나 불명확한 상태에서는 대기를 일괄 금지하거나 세션 종료를 강제하지 않는다. 제한된 조회·대기를 사용하고 다음 사용자 턴에 이어가라는 안내를 반환한다. 최초 wake, nonce 예약 때의 generation을 확인할 수 없는 과거 wake, 관측 만료, 브로커 재시작 직후에는 복귀를 미확인으로 둔다. 따라서 이 변경은 모든 첫 대기를 차단하는 기능이 아니다.

## 공개 CLI

```json
{"operation":"wait","payload":{"sender":{"host":"spark","sessionId":"owner"},"targets":[{"host":"grok","sessionId":"worker"}],"timeoutMs":60000}}
```

이 JSON을 `node mcp-server/dist/session-message-cli.mjs`의 stdin으로 전달한다. 출력의 `data.decision`은 실행 전 판정, `data.snapshot`은 현재 peer 메타데이터 digest, `data.waitedMs`는 수행한 대기 시간, `data.next`는 이어갈 방법이다. CLI는 범용 호스트용 기존 동일 사용자 협업 경로이며, 입력 identity를 보호 principal이나 별도 사용자 승인으로 승격하지 않는다. 새로운 전송·자동화·poller를 만들지 않는다.

## 상태와 실패

새 DB schema나 daemon은 없다. 브로커의 메모리에는 relay 결속·nonce generation 결속·최근 wake 관측과 snapshot 억제만 둔다. 각 map은 최대 1000개이며 요청 시 만료 항목을 제거한다. 자체 idle 타이머는 없다. presence/relay의 기존 20초/15초 lease와 wake 관측 30초를 모두 검사한다. 브로커 재시작은 메모리 증거를 버리고 기존 메시지를 보존한다.

구 브로커나 오류에서 hook은 강제 제한을 만들지 않고 미확인 안내를 제공한다. CLI는 해당 작업을 지원하지 못하면 명시적인 오류로 종료한다. 본문·token·nonce 원문을 새 로그에 기록하지 않는다. nonce 결속은 digest로 보관한다. 기존 동일 사용자 협업 모델의 신뢰 경계는 그대로이며, 공격적인 동일 사용자 process의 broker 호출이나 파일 조작을 보안 격리로 막는 기능은 아니다.

## 검증 구분

집중 검사에는 broker 판정, stale/unknown/다른 generation/과거 nonce/미관측 wake, state·cursor 변화와 새 사용자 턴, 실제 배포 hook subprocess의 deny/allow, 공개 CLI의 요청 계수와 delay, 브로커 재시작을 포함한다. 설치 형태의 검사에서는 `node_modules` 없는 별도 트리의 배포 진입점을 실행한다.

subprocess fixture의 PASS는 설치된 Codex가 실제 native `PreToolUse` payload를 보내고 거절을 이행했다는 증거가 아니다. 실제 설치와 native host 행사 여부는 인계서에서 별도로 기록한다. 지원되지 않는 tool 이름이나 중첩 실행 코드까지 통제하는 보장은 없다.

이전 릴리스 브로커와의 하위 호환 구현·검사는 사용자 지시로 이번 수용 범위에서 제외한다. 현재 브로커의 재시작·generation·nonce·lease와 실패 처리는 범위에 남는다. 제외한 검사를 PASS로 보고하지 않는다.

2.6.0 업그레이드에서는 기존 AGS MCP·relay·broker 프로세스를 종료한 뒤 플러그인을 업데이트하고 재연결한다. 새/구 버전 process가 섞인 상태를 지원한다고 주장하지 않는다.
