# P5-4a — 수락된 peer 작업의 실행 전 재검증

## 범위와 기준

기준은 `b746463b4425a56d8760136926a18890c2e296fc`(P5-3 정리 완료)다.
이번 단위는 **기존에 수락된 수신 작업에 대한 read-only preflight**를 native peer CLI에 연결한다.
P5-3의 전송/수락을 다시 구현하지 않는다. 기존 broker/spool/ACK와 workflow lease,
카탈로그/resolver, 참여 이력, write exclusion을 사용한다. 버전은 2.4.0을 유지한다.

## 호출

기존 opt-in `AGENT_GOVERNANCE_PEER_ROUTING=1`과 호스트별 DB 경계를 유지한다.
`model-routing-peer-cli.mjs --host codex|claude-code`의 stdin JSON:

```json
{
  "operation": "preflight",
  "nativeContext": { "session_id": "<actual-session-id>", "instance_id": "<current-instance>" },
  "payload": { "packetId": "ags-peer-<accepted-proposal-sha256>" }
}
```

수신 native session만 자기 inbound acceptance를 검사할 수 있다. caller가 request/decision,
승인값, 실행 명령이나 관측 증거를 payload로 덮어쓸 수 없다. send/receive/status는 그대로다.
새 MCP 도구, hook 자동 실행, 별도 executor는 추가하지 않는다.

## 검사

수신 journal의 accepted proposal과 서명된 acceptance receipt를 대조한다. packet ID,
송수신 신원, native actor, task/run/stage/revision/attempt, input/candidate digest,
저장된 request/decision과 dispatch payload가 같아야 한다. dispatch는 `accepted`이고
`dispatched_at`은 null이어야 하며, write 작업의 기존 stage 단위 exclusion key를 보존해야 한다.

현재 capability 전체 집합, target transport mapping, 양쪽 presence/instance를 다시 읽고
현재 policy/catalog 및 참여 이력으로 기존 resolver를 다시 호출한다. 마지막 비동기 조회 후에는
시각, 서명/lease 만료, journal/dispatch/request 변화, 로컬 workflow 상태와 권한을 다시 검사한다.
로컬 capability, catalog/policy 및 감사 이력도 마지막 비동기 조회 후에 다시 읽는다.
통신 중 다른 SQLite 연결이 `running` 또는 `unknown`으로 전이시켰으면 검사만 거부하고 그 전이를 보존한다.

기존 consumed workflow lease를 읽을 뿐 발급·갱신·재소비하지 않는다. task-specific approval
검증 adapter는 아직 연결하지 않았으므로 `authorization.approvalRequired`가 하나라도 있으면 차단한다.
호스트의 `approvals: enforced` capability나 peer 수락만으로 별도의 사용자 승인이 확인됐다고 하지 않는다.
독립 감사의 기존 참여 이력 제한도 유지한다.

proposal의 원래 서명 유효기간(최대 60초)을 연장하지 않는다. 과거 acceptance receipt는 서명과
binding 검사용 기록일 뿐 실행 허가가 아니다. 만료/통신 오류/상태 변경이 발생해도 accepted 또는
unknown write 예약을 해제하거나 `not-started`로 바꾸지 않는다. 회복과 재배정은 후속 단위다.

## 결과의 의미

성공 응답의 `preflightPassed: true`는 **그 조회 시점에 검사들이 통과했다는 진단**이다.
`checkedAt`, `decisionDigest`, `dispatchKey`, `dispatchRevision`을 반환한다.
`requiresAtomicStart: true`이며 `executionAuthorized`, `trustedGateSatisfied`, `executionStarted`,
`completed`는 모두 false다. 실행 상태는 `not-observed`다. 실패 시 기존 CLI 오류 envelope를 사용하고
입력·토큰·raw exception을 출력하지 않는다.

여러 호출이 같은 acceptance에 동시에 통과할 수 있다. **one-use claim, 슬롯 예약, 실행 토큰이 아니다.**
마지막 broker 조회 직후의 원격 상태 변경을 잠그지도 않는다. 후속 실행기는 이 응답을 저장해 재사용하지
말고 실제 시작 경계에서 다시 검사한 뒤 기존 dispatch revision의 원자적 claim과 호스트 실행을 연결해야 한다.
이번 코드는 worker를 실행하지 않으며 `running`/terminal 상태·모델 실행 증거를 생성하지 않는다.

## 검사와 남은 작업

`tests/mcp/model-peer-preflight.test.mjs`는 실제 SQLite/workflow와 명시적 broker fixture를 사용한다.
성공/반복 호출의 무변경, ACK와 수락의 차이, 상태/digest/서명/write-key 변조, 세션 교체,
마지막 await 이후 권한/시각/정책 변경, 두 DB 연결의 경합, 감사 참여 이력과 실패 시 예약 보존을 검사한다.
설치물 테스트는 한글/공백 경로와 `node_modules` 없는 Claude 생성물에서 실제 TLS broker 및
native hook → CLI preflight 경로를 실행한다. 벤더 모델 프로세스나 실제 계정 실행 테스트는 아니다.
실제 수행 결과와 환경 차이는 커밋 및 이번 작업의 검증 기록에 따로 남긴다.

P5-4b의 원자적 시작 claim은 [별도 계약](model-routing-p5-execution-start.ko.md)에 정의한다.
read-only preflight의 의미는 그대로이며, 승인된 native executor 연결은 P5-4c에 남는다.
수신 작업 준비/매핑, task-specific approval 검증, terminal evidence, unknown/cancel 복구,
P6/P7 및 A22 live 검증은 아직 남아 있다. main/tag/Release와 사용자 설치 캐시는 변경하지 않는다.
