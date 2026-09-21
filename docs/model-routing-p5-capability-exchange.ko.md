# P5 — 기존 broker를 통한 capability 공유와 조회

## 범위와 연결

기준 HEAD: `cef975cbf32fc72496daee037b10a424ccaad4b6`.
계획 §4.3, §8.1, §9.3과 P5의 presence capability 연결을 구현한다. P3의 호스트별 관측과 앞선 P5의 workflow/audit 검증 위에 추가한 기능이다. 전체 v2.5.0 릴리스 완료가 아니며 플러그인 버전은 2.4.0을 유지한다.

```
Codex/Claude native hook
 → 기존 호스트 workflow DB에 검증된 snapshot 저장
 → 기존 TLS broker와 model-capabilities.v1 기능 협상
 → 서명된 snapshot 발행
 → 기존 session-messaging DB의 별도 테이블
 → MCP resolve_model_assignment가 요청마다 완전한 snapshot 집합 조회
 → 기존 ModelRoutingServiceCore의 동일 resolver
```

다른 호스트의 workflow DB나 서명키를 열지 않는다. consumer workflow DB에는 외부 capability 캐시를 만들지 않으며, 선택 증거로 사용된 snapshot은 기존 decision의 environment에 보존한다. source/record/decision/gate를 복제한 제2의 라우터나 새 작업 큐를 추가하지 않는다.

## 메시지·신원·권한 경계

새 broker 명령은 `publish-model-capability`, `list-model-capabilities` 두 개다. `ping`에서 `model-capabilities.v1`을 확인한 뒤에만 호출한다. 일반 모델이 호출할 수 있는 MCP publication 도구는 만들지 않는다. 기존 메시지·spool·ACK·깨우기·승인 처리는 바꾸지 않는다.

호스트 adapter는 `broker.token`에서 고정 도메인 `ags:session-model-capabilities:v1`으로 분리해 도출한 HMAC 키로 발행 receipt를 서명한다. 키나 transport token을 publication payload, 모델 context, 로그에 넣지 않는다. broker는 TLS 인증 후에도 receipt 서명, schema, snapshot digest 및 transport host/session/instance와 snapshot session/instance를 대조한다. transport host와 routing host는 별개 식별자이며 일반 계층에서 벤더명을 매핑하거나 원산지를 추정하지 않는다.

이는 **동일 OS 사용자 내부의 호스트 adapter 무결성 경계**다. 그 사용자의 파일·broker token을 읽을 수 있는 프로세스로부터의 격리가 아니며 직접 인간 승인도 아니다. configuration 출처를 host-observation/live-probe로 승격하지 않고, 알 수 없는 모델·추론·모드·실행 경계를 채워 넣지 않는다. 최종 모델 원산지·역할·고위험 하한은 기존 resolver/gate가 계속 검사한다.

## 저장과 수명

기존 `session-messages.sqlite3`에 별도의 additive 테이블 세 개를 둔다.

- `ags_session_model_capabilities_v1`: slot, 관측 시각, 만료, snapshot digest와 signed receipt.
- `ags_session_model_capability_nonces_v1`: 재전송 식별과 nonce 충돌 검사.
- `ags_session_model_capability_revision_v1`: publication 집합의 단조 revision.

기존 메시지·presence·workflow/root/receipt 및 `user_version`을 재작성하지 않는다. 발행은 SQLite `BEGIN IMMEDIATE`에서 현재 presence와 observation 단조성을 함께 검사한다. 동일 receipt/동일 snapshot의 재전송은 idempotent이며 관측 시각·만료·revision을 새로 늘리지 않는다. 같은 시각의 다른 snapshot, 더 오래된 snapshot, 이미 대체된 receipt 또는 동일 nonce의 다른 payload는 거부한다.

공유 publication은 16 KiB, active/retained slot은 256개, 유효 nonce는 4096개로 제한한다. receipt와 snapshot의 공유 유효기간은 최대 5분이며 실제 P3 hook snapshot은 기존 60초를 유지한다. 다음 발행에서 만료 레코드를 정리한다. presence heartbeat와 모델 관측의 수명은 독립적이다. 조회는 현재 세션이 종료·만료됐거나 instance가 교체되면 즉시 제외하고, heartbeat로 모델 관측 수명을 연장하지 않는다.

## 조회·페이지 일관성

기존 32 KiB broker 응답 한도를 유지하고 페이지를 나눈다. cursor는 publication `revision`, 현재 session 상태의 `presenceDigest`, 마지막 slot을 묶는다. 페이지를 읽는 중 snapshot이 갱신되거나 앞 페이지의 세션이 종료·교체·만료되면 부분 집합을 버린다. consumer도 schema/digest/중복/순서/페이지 크기와 최종 시점의 만료를 다시 확인한다. 전체 paging은 256개와 총 시간 제한 안에서만 수행한다.

동시 MCP 요청은 각각 독립적인 snapshot 배열을 동일 resolver에 넘긴다. 전역 provider를 임시 교체하거나 공유 캐시를 덮어쓰지 않는다. 독립 감사 후보에서는 전달된 snapshot이 명시하는 actor/session 관계도 기존 참여 이력의 제외 조건에 반영한다.

조회 결과는 **선택안**이며 실행 예약이나 permission 승인이 아니다. 최종 조회 이후의 상태 변화는 실제 dispatch 계층에서 다시 검사해야 한다. 이번 변경은 그 계층을 구현하지 않으며 외부 snapshot의 `invocationSurface`를 임의로 peer 실행 가능으로 바꾸지도 않는다.

## 장애·구버전·rollback

구버전 broker에는 ping 이외의 신규 명령을 보내지 않는다. endpoint가 없거나 응답이 잘못됐거나 기능 협상이 안 되면 새 broker를 강제로 시작·재시작하지 않는다. 공유 capability 조회는 비가용/미지원으로 구분하고 외부 후보를 사용하지 않는다. 이전 native-hook snapshot을 로컬에서 되살려 liveness 확인을 우회하지 않는다. 기존 다른 로컬 adapter snapshot과 v1 라우터·일반 workflow·메시징은 유지한다.

일부 페이지가 실패하면 기존에 읽은 앞 페이지를 성공한 전체 집합처럼 반환하지 않는다. optional exchange 저장소 초기화가 실패하면 broker는 이 기능을 광고하지 않고 기존 통신을 계속 제공한다. 기존 broker를 같은 DB에 다시 연결해도 새 테이블은 무시되며 구버전 메시징이 유지된다. 키/DB를 지우는 rollback은 수행하지 않는다.

## 검증

신규 검사는 signed publication/재전송/위조/TTL/nonce/DB 재열기/용량/페이지 순서와 revision·presence 변경, caller capability 거부, 감사 actor/session 배제, 동시 resolver 격리를 포함한다.

설치 경로 검사는 Linux에서 실제 TLS broker·SQLite·자식 프로세스를 사용한다. `node_modules` 없는 한글·공백 경로에서 Codex/Claude hook을 각각 실행하고, 분리된 두 workflow DB의 capability를 세 번째 MCP 서버가 조회해 선택하는 연결을 검사한다. 구버전 broker 바이너리의 실제 실행, 기존 메시지 claim/ACK 유지 및 동시 재전송도 검사한다.

호스트 입력·transcript·운영자 capability 파일은 명시적 fixture다. 실제 벤더 계정 실행(A22), 실제 task 전체의 mode/terminal 판정, 독립 감사나 Windows/Node 24의 로컬 실행을 주장하지 않는다. 테스트 수와 실제 명령 결과는 전달 검증 로그로 별도 보고한다.

## 남은 구현

이번 작업은 자동 peer assignment 송수신·수락·실행과 dispatch-time lease/권한 재검증을 구현하지 않는다. 그 연결, P6의 실측 telemetry/evaluation 수집과 P7의 최종 릴리스·독립 감사·설치 캐시 검증은 다음 범위다. P3에서 미관측으로 남긴 effort/runtime/작업 전체 종료 결과도 여전히 미관측이다.
