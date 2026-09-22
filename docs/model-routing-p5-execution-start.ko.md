# P5-4b — 수락된 peer 작업의 원자적 실행 시작 claim

## 범위

기준은 `07e8794f3ff7d24cf21d2754e24009bf30ed9b5b` / tree
`548b66e34669f9223b36e448141059d4d88f8e50`(P5-4a)다.
이번 단위는 **한 accepted assignment의 시작권을 정확히 한 호출만 획득하는 primitive**다.
기존 `ags_model_dispatches_v2` row를 권위 상태로 사용하며, 새 queue·task·workflow lease를 만들지 않는다.
버전은 2.4.0을 유지한다. 실제 native worker, terminal evidence와 P6는 이번 범위가 아니다.

```text
accepted
  → 최신 capability / presence 조회
  → SQLite BEGIN IMMEDIATE
  → 같은 로컬 DB의 workflow / 권한 / journal / dispatch 최종 재검증
  → accepted + expectedRevision + dispatched_at IS NULL compare-and-set
  → running / revision + 1 / dispatched_at 최초 기록
  → COMMIT
```

## 명시적 호출

기존 opt-in `AGENT_GOVERNANCE_PEER_ROUTING=1`과 Codex/Claude native identity·DB 경계를 유지한다.
`model-routing-peer-cli.mjs --host codex|claude-code`의 stdin JSON:

```json
{
  "operation": "start",
  "nativeContext": {
    "session_id": "<actual-session-id>",
    "instance_id": "<current-instance>"
  },
  "payload": {
    "packetId": "ags-peer-<accepted-proposal-sha256>",
    "expectedRevision": 1
  }
}
```

`expectedRevision`은 workflow revision이 아니라 **로컬 routing dispatch의 revision**이다.
read-only `preflight` 응답의 `dispatchRevision`을 사용할 수 있지만, 그 응답은 허가나 재사용 토큰이 아니다.
`start`는 preflight를 이전에 호출했는지와 무관하게 동일한 전체 검사를 새로 수행한다.
정수·범위·정확한 revision을 확인하며, caller가 request/decision/approval/command를 추가하면 거부한다.
수신 native session은 자기 accepted inbound packet만 사용할 수 있다.

`start`는 조회용 명령이 아니다. 성공하면 write exclusion을 유지한 채 dispatch를 `running`으로 남긴다.
실행기가 아직 연결되지 않았으므로 사용자 작업을 시작하려고 이 명령만 호출하지 않는다.

## 원자성과 재검증

P5-4a의 비동기 관측과 마지막 동기 검사를 공용 내부 경계로 분리했다.
`preflight`는 여전히 read-only이며, `start`만 마지막 검사를 writer lock 안에서 호출한다.
네트워크 요청은 모두 `BEGIN IMMEDIATE` 전에 끝난다. 잠금 취득을 기다린 뒤 새 시각을 읽으므로
대기 중 발생한 proposal/presence/capability 만료나 workflow 권한 변경을 이전 관측으로 덮지 않는다.

native adapter는 routing connection과 workflow bridge를 동일한 로컬 DB 경로로 연다.
따라서 routing writer lock을 보유하는 동안 다른 connection/process가 해당 DB의 workflow,
journal, dispatch와 권한 상태를 변경할 수 없다. 최종 검사는 다음을 다시 확인한다.

- accepted proposal/receipt의 서명, packet·송수신 신원·native actor·digest·binding과 저장 bytes.
- 현재 run/stage/revision, consumed lease와 owner, outcome, risk, tools/filesystem, 감사 참여 이력.
- 현재 로컬 capability, 앞서 조회한 broker snapshot과 presence의 유효기간, 현재 catalog/policy의 재해석.
- 정확한 dispatch state/revision/decision과 최초 timestamp 부재, 기존 write exclusion.

`ModelRoutingStore.claimExecutionStart`의 callback은 내부 native adapter가 제공하는 **동기 read-only 검증 함수**다.
boolean·Promise·잘못된 timestamp를 반환하거나 dispatch를 수정하면 transaction을 rollback한다.
이 callback과 store API는 사람의 승인 증명이나 같은 OS 사용자에 대한 보안 격리 장치가 아니다.
peer packet이나 모델의 자기 주장으로 callback 또는 execution authority를 만들지 않는다.

최종 CAS는 `dispatch_key`, `revision`, `state='accepted'`, `dispatched_at IS NULL`,
`decision_digest`가 모두 같을 때만 성공한다. 성공한 호출만 `startClaimAcquired: true`를 받는다.
잠금 경합, 오래된 revision, 검증 실패에는 재시도·예약 해제·terminal 변환을 하지 않는다.

remote broker 상태나 filesystem의 catalog를 분산 transaction으로 잠그는 기능은 아니다.
원격 관측은 마지막 조회 이후 다시 바뀔 수 있다. 후속 executor도 실제 host 실행 경계와 관측을
연결해야 하며, 이 로컬 claim만으로 분산 시스템의 exactly-once side effect를 주장하지 않는다.

## 성공 응답의 의미

```json
{
  "ok": true,
  "data": {
    "packetId": "ags-peer-<accepted-proposal-sha256>",
    "decisionDigest": "sha256:<decision-digest>",
    "dispatchKey": "sha256:<dispatch-key>",
    "dispatchRevision": 2,
    "dispatchState": "running",
    "dispatchedAt": "<claim-time-ISO-8601>",
    "startClaimAcquired": true,
    "requiresNativeExecutor": true,
    "executionStarted": false,
    "executionState": "not-observed",
    "completed": false,
    "executionAuthorized": false,
    "trustedGateSatisfied": false
  }
}
```

`running`은 시작권을 소비한 dispatch 상태이며 **실제 worker 실행을 관측했다는 뜻이 아니다**.
`dispatchedAt`은 read-only preflight 시각이 아니라 writer lock 안에서 재검증한 claim 시각이다.
실행 토큰·새 lease·사용자 승인·모델 관측·결과 artifact는 발급하지 않는다.
기존 CLI 오류 envelope는 그대로 사용하며 입력 원문·비밀·raw exception을 출력하지 않는다.

## 경합과 유실

두 process가 모두 preflight PASS를 받아도 같은 revision의 `start`는 하나만 성공한다.
`running`, `unknown`, `succeeded`, `failed`, `cancelled`, `not-started`에서는 새 claim을 주지 않는다.
이미 `dispatched_at`이 있는 row도 재사용하지 않는다. 기존 stage 단위 write exclusion은 유지한다.

commit 뒤 응답이 유실되거나 claim을 받은 process가 종료돼도 `running`을 되돌리지 않는다.
후속 호출은 이전 성공을 재사용 가능한 claim으로 돌려받지 못한다. 현재 단계는 이 상황을 자동
`unknown`/`failed`/`not-started`로 변환하지 않으며, terminal evidence 기반 복구는 P5-4c 이후 범위다.
`unknown` 상태를 실행되지 않았다는 근거로 해석해 새 write worker를 시작하지 않는다.

## 승인 경계와 검증

`authorization.approvalRequired`가 비어 있지 않으면 계속 fail-closed한다.
`approvals: enforced` capability나 signed peer acceptance는 task-specific approval evidence를 대신하지 않는다.
workflow lease 발급·갱신·재소비, foreign DB import, receiver task preparation은 하지 않는다.
기존 v1 routing/trusted gate/ACK/SessionPresence의 의미를 바꾸지 않는다.

테스트는 기존 preflight 부정 사례를 start에도 적용하고, 실제 SQLite의 CAS/rollback/write exclusion,
두 connection의 최종 검증 잠금, 잠금 취득 뒤 만료·승인 변화, 세 차례의 독립 process 경합,
성공 응답 유실과 재생 거부를 검사한다. 설치물 테스트는 `node_modules` 없는 Claude 생성물에서
실제 TLS broker/hook을 거쳐 두 CLI process의 preflight 및 동시 start를 수행한다.
실제 vendor account/worker 실행이나 독립 감사는 이 테스트가 아니다.

다음 단위는 **P5-4c — 승인된 native executor와 host observation/terminal evidence 연결**이다.
claim 성공을 재사용 가능한 토큰으로 저장하는 대신 그 실행 경계에서 이어 받아야 한다.
main/tag/Release와 사용자 설치 캐시는 이번 단위에서 변경하지 않는다.
