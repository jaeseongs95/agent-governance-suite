# P5 — 기존 spool의 peer 배정 전달과 수락 판정

## 이번 구현 범위

기준 HEAD는 `56f3650fd89e7891e73aff51f421950a52c78d37`이다. 구현 계획 §5.1/§5.3/§6.1/§9.3 및 A10–A13/A18–A20의 **배정 전달, 수신 측 재검증, 수락 기록, 중복 방어**를 연결했다.

이번 단위는 작업을 전달하고 수신 측이 기존 로컬 작업에 연결해 수락할 수 있는지 판정하는 데서 끝난다. 실제 호스트의 worker 실행, 완료 관측, 결과의 최종 채택은 수행하지 않는다. 기존 `accepted` 예약을 `running`으로 바꾸거나 `dispatchedAt`을 만들어내지 않는다. 모든 외부 결과의 `executionAuthorized`, `trustedGateSatisfied`, `completed`는 false다. `executionStarted: false`는 이 전달·수락 경로가 실행을 시작하지 않았다는 의미이며, 이미 존재하는 다른 실행의 상태는 `not-observed`/`unknown`으로 구분한다.

버전은 2.4.0을 유지한다. v2.5.0 릴리스 완료나 실제 벤더 계정 검증을 뜻하지 않는다.

## 실제 연결

```text
기존 로컬 workflow/lease + 저장된 v2 decision
 → 명시적으로 활성화한 native peer CLI의 send
 → 공유 capability 및 양쪽 session/instance의 현재 상태 재확인
 → 서명된 delta proposal을 기존 broker send로 전달
 → 기존 spool/claim/wake 경로 그대로 사용
 → 기존 session-message hook이 peer provenance 기록
 → opt-in native 수신부가 해당 actor의 로컬 decision/task/lease/권한 재확인
 → 기존 ModelRoutingStore의 일회용 dispatch 예약을 accepted까지만 전이
 → 별도 서명된 수락/거절/불명 receipt를 기존 spool로 반환
 → 발신자 hook이 receipt를 대조하여 전송 기록 갱신
```

새 broker 명령, 중앙 오케스트레이터, 별도 실행 큐, 범용 shell 실행기, 모델 호출 도구는 추가하지 않는다. send/status/claim/ACK의 기존 wire 계약을 유지한다. 새 capability 명령은 앞선 구현의 협상된 공유 조회만 사용한다.

원래의 peer 메시지는 계속 **untrusted peer context**로 표시하고 기존 provenance와 ACK 안내도 유지한다. 수락 진단은 context 예산 안에 들어갈 때만 추가한다. 수신 처리는 기존 hook이 이미 claim한 메시지 한 개에 대해서만 실행하며, 다른 메시지를 추가 claim하거나 자동 ACK하지 않는다.

## 명시적 활성화와 설치 경로

기본은 비활성화다. 호스트/운영자가 해당 세션 프로세스 환경에 `AGENT_GOVERNANCE_PEER_ROUTING=1`을 명시한 경우에만 새 수신 처리를 수행한다. 플러그인이 전역 환경이나 사용자 설정을 수정하지 않는다. 비활성화된 상대는 기존 일반 메시지 경로를 유지한다. 상대의 online 또는 모델 capability만으로 새 수신 기능이 활성화됐다고 추정하지 않으며, 유효한 수락 receipt가 오기 전에는 accepted가 아니다.

배포 CLI:

```text
node <plugin-root>/mcp-server/dist/model-routing-peer-cli.mjs --host codex
node <claude-plugin-root>/mcp-server/dist/model-routing-peer-cli.mjs --host claude-code
```

모든 요청은 stdin JSON이다. argv에는 메시지 본문·인증값·실행 명령을 넣지 않는다. `nativeContext`는 실제 호스트/운영자가 관찰한 세션 문맥이어야 한다. 현재 instance가 제공되면 broker와 반드시 일치해야 한다. 이것은 로컬 adapter 인터페이스이지 모델이 MCP로 자신의 권한을 발급하는 인터페이스가 아니다.

send 입력 형태:

```json
{
  "operation": "send",
  "nativeContext": {
    "session_id": "<actual-session-id>",
    "instance_id": "<current-presence-instance>"
  },
  "payload": {
    "decisionDigest": "sha256:<existing-local-decision-digest>",
    "delta": "이미 승인된 목표와 파일 소유권을 유지하는 변경분",
    "inputReferences": []
  }
}
```

`decisionDigest`는 CLI가 새로 만들어주는 값이 아니라 기존 `resolve_model_assignment`의 저장된 결정이다. `inputReferences`는 최대 8개의 `{ "uri": "...", "digest": "sha256:..." }`이고, 수신부가 그 URI를 열거나 실행하지 않는다. 전체 목표·정책·카탈로그·비밀을 메시지에 복제하지 않는다.

status는 동일한 nativeContext와 `{"operation":"status","payload":{"packetId":"ags-peer-<hex>"}}` 형식이다. 실제 요청에는 위 예시처럼 operation/nativeContext/payload 세 필드가 모두 있어야 한다. 출력에서 `delivery.status.state`는 broker 전달/ACK 상태이고 `handoffState`는 별도의 수락 상태다.

receive는 기존 broker에서 claim한 `SessionMessage`를 `payload.message`로 받는다. 정상 설치에서는 opt-in session-message hook이 이를 자동 호출한다. 독립 CLI로 연결하는 호스트는 자기 세션이 이미 claim한 메시지를 전달해야 한다. CLI는 raw JSON에 포함된 임의 command/program/token을 실행하거나 권한으로 사용하지 않는다.

Claude는 항상 `CLAUDE_PLUGIN_DATA/workflows.sqlite3`를 사용한다. Codex의 DB 경로 환경변수가 함께 있어도 다른 호스트 DB를 열지 않는다. 호스트의 lifecycle/heartbeat/모델 설정은 변경하지 않는다. subagent는 기존 parent 세션의 message-binding 제한을 유지한다.

## 중요한 로컬 수락 전제

수신자는 메시지와 동일한 **저장된 v2 request/decision 및 현재 로컬 workflow binding**을 이미 가지고 있어야 한다. task/run/stage/revision, consumed lease, candidate가 일치하고 해당 actor가 그 로컬 lease의 기존 소유자여야 한다. 요구 tool/filesystem은 로컬 TaskEnvelope의 명시적 allowedActions 안에 있고 prohibitedActions에 없어야 한다. 고위험 task를 저위험 요청으로 낮출 수 없다. 독립 감사 배정은 기존 참여 이력 검사도 유지한다.

따라서 **분리된 수신 DB에 아직 대응하는 승인 작업이 없는 경우에는 거절한다.** 송신자 DB를 열거나 run/lease/root를 복사하거나, peer 메시지로 새로운 위임 승인을 생성하지 않는다. 이미 승인된 수신 작업을 준비·매핑하는 host 통합과 실제 실행기는 다음 단위다. 여기서 검증한 성공 경로는 미리 준비된 로컬 작업이 있는 세션 간 전달·수락이며, 임의의 다른 호스트에서 준비 없이 실행되는 경로가 아니다.

송신 전과 수신 수락 전에는 공유 capability의 전체 집합, 정확한 target transport mapping, 모델 선택 digest, 현재 catalog/policy 및 양쪽 presence를 읽는다. 최종 비동기 조회 후에는 로컬 workflow/lease/risk/권한을 동기적으로 한 번 더 확인한다. 이 판정은 실행 시점의 재검증이나 기존 trusted execution gate를 대신하지 않는다.

## 메시지와 저장 경계

`model-assignment-handoff.v1` 패킷은 기존 `model-routing.v2` proposal을 감싼다. HMAC은 broker credential에서 `ags:model-assignment-handoff:v1` 도메인으로 분리한 키를 사용한다. 서명은 송·수신 host/session/instance, issued/expires, proposal/receipt 본문에 걸린다. messageId는 완성된 패킷 바이트의 SHA-256으로 고정한다. recipient, sender, messageId, MAC 및 만료를 수신부에서 대조한다.

이것은 같은 OS 사용자 내부의 호스트 adapter 무결성 경계다. broker credential과 DB를 읽을 수 있는 같은 사용자의 임의 프로세스로부터 격리하는 기술이 아니며 인간 승인이나 모델 실제 실행의 증거도 아니다. 키를 peer 본문/context/log에 넣지 않는다.

패킷 전체는 기존 4096 UTF-8 byte 한도, delta는 2048 byte 한도, 참조는 8개를 유지한다. outer signature/identity가 추가되므로 최대 길이의 delta와 참조가 모두 함께 들어가지는 않을 수 있으며 초과는 거부한다. 서명 유효기간은 최대 60초다. broker spool TTL과 서명 TTL은 별도로 확인한다.

workflow DB에 additive 전송 저널 `ags_model_peer_transfers_v1`을 추가했다. 같은 DB를 사용하는 두 세션을 위해 inbound/outbound는 같은 packetId라도 분리한다. 이는 재전송할 정확한 바이트와 수락 결과를 고정하는 **전송 기록**이며, 실행할 task를 순회/배정하는 새 큐가 아니다. 최대 256개 기록으로 제한한다. 만료됐다는 이유만으로 진행 중·수락·불명 쓰기 예약을 삭제하지 않는다. 기존 root/frame/receipt/user_version을 재작성하지 않는다.

송신 journal은 같은 task/run/stage의 미해결 write handoff와 경쟁하는 다른 결정을 막는다. 수신자는 기존 routing dispatch의 single-writer 예약을 사용한다. 이미 수락한 작업과 불명확한 작업은 기존 계약대로 새 모델/시도/revision으로 교체해 재실행하지 않는다.

수신 처리의 atomic claim은 한 프로세스만 담당하게 한다. 다른 프로세스가 처리 중이면 두 번째 수신자는 unknown을 반환하고 거절 receipt를 먼저 확정하지 않는다. 중간에 프로세스가 종료된 processing 상태 역시 자동 재수락하지 않는다. 재시도와 응답 유실에서는 기존 signed packet/receipt만 재사용하며 유효기간을 갱신하지 않는다. 완료 판정·중단 확인과 저널 정리는 후속 실행 수명주기 통합 대상이다. 여러 DB/호스트 간 exactly-once를 보장한다고 하지 않는다.

## 기존 helper 수정

기존 `acceptPeerAssignment`의 외부 authorization callback이 예외를 던진 경우, 명시적인 false와 구분하여 `unknown`을 남기도록 수정했다. callback이 이미 권한을 소비했을 가능성이 있는 실패를 `not-started`로 단정해 write exclusion을 풀지 않는다. 최종 비동기 조회 뒤 호출하는 선택적 동기 권한 재검사도 추가했다. 기존 v1 라우터나 실행 gate는 바꾸지 않았다.

## 검증 범위

명시적 fixture로 서명·만료·변조·송수신 instance·정확한 request/decision binding, 전송 응답 유실·재전송, ACK/수락 분리, 두 SQLite 연결의 수신 경합, 기존 lease 소유권과 revision 재확인, 미해결 write 유지, 수신 DB 미준비, opt-out을 검사한다.

설치물 검사는 한글·공백 경로의 `node_modules` 없는 실제 번들, TLS broker, SQLite, CLI 및 Claude native session-message hook을 실행한다. CLI send → 실제 수신 hook의 수락 → 기존 spool receipt → 송신 hook의 상태 반영을 확인한다. 기존 일반 메시지·ACK·peer provenance도 유지되는지 검사한다. 실제 Claude/Codex 모델 프로세스를 실행하거나 유료 계정에 연결한 검사가 아니다.

실제 명령·테스트 수·전체 회귀·환경 차이는 전달 검증 로그에 기록한다. 독립 감사 및 실제 계정(A22) 검증을 수행했다고 표시하지 않는다. 현재 Windows/Node 24에서 실행했다는 주장도 하지 않는다.

## 다음 구현

현재 accepted에서 멈추는 예약을 실제 호스트 실행기와 연결하고, 수신 작업의 사전 준비/매핑, 실행 직전 lease/모델 재검증, running/terminal 관측, 상태 불명·취소 복구, 완료 후 저널 정리를 구현해야 한다. 이어 P6 telemetry/evaluation 및 P7 릴리스 후보 검증·독립 감사·설치 검증이 남는다.
