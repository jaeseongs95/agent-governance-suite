# 운영과 참고

[README](../README.md)에서 다루지 않는 용어, 상태 관리, 검사 범위와 저장소 구조를 정리합니다.

## 주요 용어

| 용어 | 의미 |
| --- | --- |
| 전문 스킬 | 작업 범위 확인, 위험 점검, 증거 검증처럼 한 가지 역할을 담당합니다. |
| 오케스트레이터 | 요청에 필요한 전문 스킬을 선택하고 실행 순서와 결과 전달을 관리합니다. |
| MCP 서버 | 계획과 각 단계의 결과가 정해진 계약을 따르는지 로컬에서 검사합니다. |
| 증거 | 테스트 결과, 파일 위치, `digest`처럼 완료 판단에 사용하는 기록입니다. |
| 완료 결과 | 모든 필수 단계와 게이트를 통과했음을 나타내는 구조화된 결과입니다. |

## 예: 위험도가 높은 배포 작업

1. 작업을 시작하기 전에 적용 지침과 저장소 관례를 확인하고, 허용 범위와 완료 조건을 정합니다.
2. 되돌리기 어려운 변경이라면 권한, 대상, 영향 범위, 복구 방법을 먼저 점검합니다.
3. 여러 에이전트가 함께 작업한다면 담당 영역을 나누고 구현자와 감사자를 분리합니다.
4. 변경이 끝나면 처음 정한 범위와 실제 변경을 비교하고 테스트 결과를 확인합니다.
5. 감사자와 구현자가 같거나, 감사 대상이 현재 결과와 다르거나, 해결되지 않은 문제가 남아 있으면 완료를 거절합니다.

이 흐름은 문서상의 권고에 머물지 않습니다. MCP 실행 계층이 각 조건의 충족 여부를 검사합니다.

## 상태 저장과 마이그레이션

MCP 서버는 workflow 실행 상태와 계획 서명 키를 `workflows.sqlite3`에 저장합니다. 선택적 task continuity는 같은 사용자 상태 디렉터리의 별도 `continuity.sqlite3`를 사용합니다. 세션 현황판과 TLS broker는 모든 호스트가 함께 보도록 OS와 관계없이 `~/.agent-governance-suite` 아래의 `session-board.sqlite3`와 `session-messaging/`을 사용하며, 호스트가 workflow DB 위치를 바꿔도 따라가지 않습니다. 공용 루트는 절대 경로인 `AGENT_GOVERNANCE_SHARED_STATE_DIR`로 바꿀 수 있고, 기능별 `AGENT_GOVERNANCE_SESSION_BOARD_DB_PATH`와 `AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR`가 있으면 이를 우선합니다. workflow와 continuity 위치는 각각 `AGENT_GOVERNANCE_DB_PATH`, `AGENT_GOVERNANCE_CONTINUITY_DB_PATH`로 지정합니다. 해당 디렉터리는 MCP 서버를 실행하는 사용자만 접근할 수 있도록 보호해야 합니다.

이전 기본 경로의 현황판과 message spool은 새 공용 루트로 자동 병합하지 않습니다. live SQLite WAL을 복사하면 서로 다른 상태가 섞일 수 있기 때문입니다. 3.0부터 broker 프로세스는 없고 각 프로세스가 같은 SQLite 파일을 직접 엽니다. 2.x가 남긴 `endpoint.json`·`broker.token`·`broker-key.pem`·`broker-cert.pem`·`broker.lock*`은 3.0이 읽지도 지우지도 않으며, 모든 2.x 프로세스를 끝낸 뒤 지워도 됩니다. 3.3.0은 host ID를 OS 기계 ID에서 도출하며 파일에 저장하지 않습니다. OS에 기계 ID가 없는 환경(`/etc/machine-id`가 없는 컨테이너 등)에서만 같은 디렉터리에 `host-id`를 만듭니다. 이 파일은 2.x 파일과 함께 지우지 않습니다. 지우면 새 ID가 생겨 기존 root가 다른 호스트의 것으로 판정됩니다. 기본 경로를 바꾸는 업데이트는 모든 호스트에 함께 적용하고 세션을 다시 시작합니다. 기존 경로는 그대로 남으며, 필요한 대기 메시지는 업데이트 전에 처리하거나 TTL 만료에 맡깁니다.

상태 정리는 자동 실행되지 않습니다. `prepare_state_cleanup`으로 180일이 지난 terminal workflow 상태와 30일이 지난 비활성 continuity payload를 미리 본 뒤, 사용자가 확인한 같은 token을 `execute_state_cleanup`에 전달해야 합니다. 삭제 전 검증된 SQLite backup을 만들며 backup은 자동 삭제하지 않습니다. 자세한 정책과 복구 절차는 [SQLite 상태 보존과 정리](state-cleanup.md)를 참고하십시오.

```bash
AGENT_GOVERNANCE_DB_PATH=/absolute/path/workflows.sqlite3 pnpm dev
```

`v1.2.0`은 SQLite schema를 v2에서 v3으로 올려 convergence root, epoch, attempt, lease, review와 workflow 연결을 보존합니다. 이전 버전으로 돌아갈 가능성이 있다면 업그레이드 전에 MCP 서버를 중지하고 DB를 SQLite의 일관된 backup 방식으로 복사해야 합니다. v3 DB는 v2 서버에서 열 수 없으므로 플러그인만 다시 설치해서는 롤백되지 않습니다. 롤백할 때는 MCP를 중지한 상태에서 업그레이드 전 v2 backup을 복원해야 합니다.

## 플러그인 업데이트 확인

MCP 서버는 플러그인을 처음 사용할 때 공개 저장소의 안정 버전 tag를 확인합니다. 성공한 결과는 SQLite에 24시간 동안 보관하며, 확인에 실패하면 기존 workflow를 중단하지 않고 1시간 뒤 다시 시도합니다. 설치된 버전보다 높은 안정 버전이 확인되면 MCP 응답에 `plugin-update-notice`를 한 번 추가합니다.

```text
check_for_updates { "force": false }
```

`force: true`를 지정하면 저장된 확인 시각과 관계없이 다시 조회합니다. 이 기능은 새 버전의 존재만 안내합니다. 플러그인 파일, 설치 캐시와 마켓플레이스 설정은 변경하지 않으며 업데이트도 자동으로 설치하지 않습니다. 개별 전문 스킬을 MCP 없이 직접 호출한 경우에는 업데이트를 확인하지 않습니다.

## 스킬 시점 안내

`시점`은 각 스킬을 **어떤 작업 상황에서 검토하거나 호출하는지** 보여 주는 작업 생애주기 안내입니다. 표의 위에서 아래로 모든 스킬을 실행하라는 고정 순서가 아닙니다. 실제로는 요청의 위험도와 현재 상태에 맞는 스킬만 선택하고, 둘 이상을 연결할 때는 오케스트레이터가 필요한 실행 순서를 정합니다.

- **시작 전**: 파일을 수정하거나 명령을 실행하기 전에 적용 지침과 저장소 관례를 확인하고, 목표·범위·완료 조건을 정할 때 사용합니다.
- **진행 중**: 작업을 독립 단위로 나눌 필요가 생기거나, 복잡하고 실패 비용이 큰 결정을 여러 관점에서 검토해야 할 때 사용합니다.
- **수렴 검토**: 반복 시도의 허용 횟수를 소진했거나 목표·평가 기준·입력이 달라질 가능성이 생겨, 새 시도 구간(`epoch`)을 열기 전에 기존 계약과 제안된 변경의 의미가 같은지 확인할 때 사용합니다.
- **변경 전후**: 변경 전에 Git 기준 상태를 기록하고, 변경 후 실제 diff를 그 기준과 비교해 요청 범위를 벗어난 파일이 없는지 확인할 때 사용합니다.
- **변경 전**: 삭제, 배포, 마이그레이션처럼 영향이 크거나 되돌리기 어려운 동작을 실행하기 직전에 대상·권한·복구 조건을 점검할 때 사용합니다.
- **완료 전**: 구현과 테스트가 끝난 뒤 완료를 선언하기 전에 수용 기준별 근거를 확인하고, 고위험 작업에는 독립 감사까지 통과했는지 확인할 때 사용합니다.
- **문제 발생 시**: 같은 실패가 반복되거나 원인이 불분명해 진행이 막혔을 때, 관측 사실과 원인 가설을 분리하고 다음 판별 검사를 정할 때 사용합니다.
- **복구 선택 시**: 원인이 확정된 실패에 대해 실행 가능한 복구안 2~3개를 비교하고, 새 작업 계약에 결속할 handoff를 만들 때 사용합니다.
- **평가 전후**: 평가 실행 전에 동결한 설계의 실행 가능성을 확인하거나, 실행 뒤 결과·판정·집계 근거의 유효성을 감사할 때 사용합니다.

## 작업 연속성

작업 연속성은 스킬이 아니라 MCP 도구와 lifecycle Hook으로 제공합니다. 예전 `context-continuity` 인프라 스킬은 모델이 스스로 고르지 않아 쓰이지 않았으므로 없앴고, 호출할 때와 목적을 각 도구 설명·hook cue에 적었습니다. `checkpoint_context`는 압축·재개 뒤 이어 갈 핵심 현재 상태를 유지합니다. 상황이 바뀌면 목표, 최신 결정·권한·제약, 미완료·다음 행동과 필요한 실패·근거를 자율적으로 갱신합니다. 현재 행동을 바꾸는 필요한 사용자 원문과 기존 유효 핵심은 보존하되 중복·폐기·불필요한 완료 내역은 정리하고, 대화·로그·workflow 원장을 쌓아 넣지 않습니다. 변화가 없으면 불필요하게 저장하지 않습니다. 저장하는 `JSON(status/core/evidenceRefs)` 전체는 UTF-8 2000 byte 이하여야 하며, 상한을 채우는 것이 목표가 아닙니다. 연속성 도구는 `skills/registry.json`과 위 전문 스킬 수에 포함되지 않습니다.

자기 current는 `load_context`에 `{"schemaVersion":"1.0.0"}`만 보내 읽습니다. 반환된 `stateToken`을 저장·삭제의 `expectedStateToken`에 그대로 넣으며, 상태가 바뀌어 충돌하면 최신 current를 다시 읽어 재구성합니다. 서명된 fork·workflow 후보는 제공받은 `candidateToken`으로 선택하지만 임의의 과거 버전·다른 세션·history를 조회하지는 못합니다. `clear`는 epoch를 회전하고 `suppress_context_restore`는 자동 복원을 억제합니다. 사용자 명시 삭제 요청에만 쓰는 `purge_direct_context`는 current만 지우고 hash tombstone을 남기며, 비공개 history와 workflow receipt·convergence root는 삭제하지 않습니다.

Resume과 direct compact에서는 기존 hook이 원자적 읽기 시점 L의 현재 메모리 본문을 주입합니다. Codex·Claude Code의 일반 사용자 입력에는 짧은 cue만 보내며 본문을 반복 주입하지 않습니다. AGY turn0는 native ephemeral current+cue를 사용해 그 주입문을 durable 대화 이력에 누적하지 않습니다. 본문이 없거나 토큰이 필요하면 `load_context`로 읽고 최신 사용자 요청과 대조합니다. Orchestrated workflow의 revision과 기존 `TaskEnvelope`, receipt·convergence root에서 투영한 bounded 구조 카드는 별도 계약을 유지합니다. 호스트 수락 ACK가 없는 상태에서 crash 이후까지 exactly-once 전달이나 모델 첫 행동까지의 최신성은 보장하지 않습니다. 실제 native 시험은 해당 호스트·후보·이벤트에서 관측한 범위로만 보고해야 합니다.

Current와 history는 로컬 `continuity.sqlite3` schema v4의 `continuity_current_memory`·`continuity_memory_history`에 평문 JSON으로 저장하며, 현재 내용 교체와 이전 내용의 history 보관은 원자적으로 처리합니다. History는 에이전트 API에 노출하지 않으며, 같은 OS 사용자의 직접 파일 접근을 막는 별도 권한 격리는 없습니다. 비밀값, 개인정보, 원시 로그·코드나 chain-of-thought를 checkpoint에 넣지 말고 DB 파일 접근 권한과 보존 기간을 관리해야 합니다. Lifecycle Hook은 transcript 본문을 checkpoint에 저장하지 않고 raw session·turn·request 식별자 대신 설치별 HMAC correlation을 기록합니다. Continuity 초기화·lifecycle 실패는 workflow나 compaction을 막지 않으며, bounded diagnostic에 단계와 원인을 구분해 남깁니다.

## 전역·담당·상황 컨텍스트(3.9.0)

AGS는 세 가지 컨텍스트를 둡니다. 프로젝트 단위 컨텍스트는 없습니다.

| 컨텍스트 | 누가 받는가 | 상한(UTF-8 본문) | 누가 바꾸는가 | 저장 위치 |
| --- | --- | --- | --- | --- |
| 전역 | 이 컴퓨터에서 AGS에 붙은 모든 세션과 그 서브에이전트 | 2000 byte | 사용자가 로컬 관리 페이지에서 패스키로 서명한 기록만 | 공유 상태 폴더의 `context-layers.sqlite3` |
| 담당 | 그 역할(role)에 결속된 세션들과 그 서브에이전트 | 1000 byte | 그 역할에 결속된 세션(에이전트가 씀, 서명 대상 아님) | 같은 파일 |
| 상황 | 그 세션과 그 서브에이전트 | 2000 byte(현재 메모리, 기존 그대로) | 그 세션 | 호스트별 `continuity.sqlite3` |

- 공유 파일은 `AGENT_GOVERNANCE_SHARED_STATE_DIR`(없으면 `~/.agent-governance-suite`) 아래에 있고 `AGENT_GOVERNANCE_CONTEXT_LAYER_DB_PATH`로 따로 지정할 수 있습니다. hook은 이 파일을 만들지 않습니다. 저장한 적이 없으면 파일도 주입도 없습니다.
- 사람이 정하는 항목(전역 컨텍스트, 역할 등록표, 세션↔역할 결속, 패스키 목록)의 정본은 패스키 서명 기록(`admin_log`, 추가만 함) 하나입니다. 읽는 쪽(hook·MCP·페이지)은 매번 서명과 대상별 사슬을 검증하고, 검증에 실패한 기록은 적용하지 않습니다. 자세한 내용은 [로컬 관리 페이지](admin-page.md)를 봅니다.
- 에이전트는 바꾸지 못하고 요청만 남깁니다. `checkpoint_global_context`와 `bind_session_role`은 요청(proposal)을 저장하고 `pending`·`proposalId`·`adminUrl`을 돌려줍니다. 사용자가 페이지에서 차이를 보고 패스키로 승인해야 적용됩니다. 결속은 역할 등록표에 있는 역할에만 요청할 수 있습니다(없으면 `ROLE_NOT_REGISTERED`).
- 담당 컨텍스트에 누가 접근하는지는 서명된 결속으로만 정합니다. 세션 현황판의 role(`update_session_status`)은 세션이 스스로 적는 표시용 문구이며 접근 키가 아닙니다. 역할은 불변 ID와 이름(NFC 정규화·앞뒤 공백 제거, 대소문자 무시 고유)을 가지며 결속과 담당 컨텍스트는 ID를 참조합니다. 결속은 root 세션 단위이고 서브에이전트는 root 세션의 결속을 이어받습니다. 같은 세션을 재개하면 유지되고, 마지막 사용 뒤 30일이 지나면 없어집니다.
- 담당 컨텍스트 저장은 항상 본문 전체를 다시 구성해 `expectedStateToken`과 함께 보냅니다. 읽은 뒤 같은 역할의 다른 세션이 저장했으면 `STALE_REVISION`이며 아무것도 쓰지 않습니다. 담당 컨텍스트 이력은 역할마다 최근 50개를 남기고, 전역 컨텍스트 이력은 서명 기록 그 자체입니다.
- 주입: 세션 시작·재개·압축(`SessionStart` startup/resume/compact/clear/fork)과 서브에이전트 시작(`SubagentStart`) 때 비어 있지 않은 전역·담당 컨텍스트를 넣습니다. 서브에이전트 시작에는 부모 세션의 상황 컨텍스트도 넣습니다. 세션 도중 전역·담당 컨텍스트가 바뀌면, 그 실행 주체(`hostActorId`)가 아직 받지 않은 판을 다음 사용자 입력이나 AGS 진행 도구(`start_workflow` 등) 직후에 한 번 넣습니다. 압축 이벤트가 없는 호스트에서 어댑터가 턴 시작을 문맥 시작으로 표시하면(agy) 턴마다 전부 넣습니다.
- 서명 검증에 실패한 대상이 있으면 hook은 그 대상만 마지막 유효 판(없으면 기본값)으로 두고 「검증 실패 · rN 적용 중 · 사용자에게 알릴 것 · 에이전트가 고칠 수 없음」 한 줄을 넣습니다. 전역·담당 컨텍스트는 따로 읽으므로 하나를 읽지 못해도 다른 하나는 넣습니다.
- 도구: `load_shared_context`(읽기), `checkpoint_global_context`(요청), `bind_session_role`(요청), `checkpoint_role_context`(결속된 세션의 저장).

## 검사 범위와 한계

MCP 서버는 `SkillDescriptor.v2`의 `capability`, 실행 단계, `artifact` 의존성을 읽어 계획을 만듭니다. 계획에는 스키마 체크섬과 HMAC 서명이 포함되며, 서버는 다음 항목을 검사합니다.

- 계획을 시작한 뒤 내용이 바뀌지 않았는지
- 각 단계가 정해진 순서와 `revision`에 맞게 제출됐는지
- 각 provider의 결과가 선언된 스키마와 상태 매핑을 따르는지
- 다음 단계에 필요한 산출물과 검증 근거가 준비됐는지
- 독립 숙고와 필수 감사의 대상이 현재 결과와 일치하고 정해진 조건을 충족하는지
- 해결되지 않은 차단 사유가 남아 있지 않은지
- 새 orchestrated 실행이 root에 결속된 일회용 lease를 사용하고 epoch당 3회 예산과 frame 불변조건을 지켰는지

Convergence root, epoch, attempt, lease, review와 workflow 연결도 같은 SQLite DB에 append-only 이력으로 저장되므로 MCP 프로세스가 다시 시작돼도 예산과 활성 attempt를 유지합니다. `.mcp.json`의 stdio 서버가 필요할 때 자동 실행되며 별도 포트, 계정이나 상시 데몬은 필요하지 않습니다.

오케스트레이터는 설치 시 노출된 스킬 설명에서 필요한 capability 후보를 고른 뒤 `skills/orchestrator/scripts/query-registry.mjs`로 활성 provider의 실행 메타데이터만 조회합니다. 후보를 정하지 못한 경우에만 `--all` compact catalog를 사용하며, 전체 `skills/registry.json`을 모델 입력으로 전달하지 않습니다.

공개 MCP 도구의 응답 옵션을 생략하면 기존과 같은 전체 결과와 convergence 이력을 반환합니다. 오케스트레이터의 정상 경로는 `responseMode: "compact"`와 `detail: "compact"`를 사용해 plan, 누적 `stageResults`, provider output, task/frame 원문과 전체 이력을 제외한 고정 크기 요약만 받습니다. 오류 원인, 과거 결과 또는 감사 자료가 필요할 때만 해당 상태를 `full`로 다시 조회합니다. compact attempt claim은 root에 저장된 task envelope와 frame을 복원하고, plan을 생략한 guarded start는 일회용 lease에 결속된 proposal plan을 사용합니다. 저장되는 전체 `WorkflowReceipt`와 SQLite schema v6의 run·convergence·trusted observation claim 상태는 이 전송 방식과 무관하게 유지됩니다.

이 서버는 적대적인 호출자를 인증하는 보안 경계가 아닙니다. 전문 스킬과 호출자가 `verified` 값, 증거 위치, 작업자 식별자를 확인했다고 전제합니다. 서버는 값의 형식과 단계 사이의 일관성을 검사하지만, 실제 작업자의 신원이나 증거 원문의 진위를 인증하지는 않습니다.

실행 중인 run, 현재 `revision`, run ID sequence, 계획 서명 키와 플러그인 업데이트 확인 상태는 SQLite에 저장되므로 MCP 서버를 다시 시작해도 이어서 처리할 수 있습니다. 업데이트 상태에는 버전·tag·commit, ETag, 확인 시각, 다음 확인 시각, 마지막 안내 버전과 오류 코드만 들어갑니다. SQLite에는 전체 `WorkflowReceipt`가 평문 JSON으로 들어가며, 여기에는 각 `StageResult`의 provider output, evidence note, findings, blockers와 error가 포함됩니다. 일반 provider는 호출자가 민감한 원문을 넣지 않아야 합니다. descriptor에 `receiptPolicy.mode: reference-only`를 선언한 provider는 저장 전에 닫힌 output schema, digest·artifact reference·고정 토큰만 허용하며 note, locator, findings, blockers와 error의 자유 텍스트도 거부합니다. `actorIdPointer`와 `uniqueness: run`을 함께 선언하면 canonical lowercase UUID actor ID의 run 내 재사용도 서버 재시작 후까지 거부합니다. 자동 만료·삭제 정책은 제공하지 않으므로 DB 파일과 디렉터리의 접근 권한과 보존 기간은 직접 관리해야 합니다. 기본 생성자를 사용한 `WorkflowService`는 테스트와 임베딩 호환성을 위해 메모리 저장 방식을 유지합니다. 이 정책은 원문 비저장을 위한 구조적 저장 경계일 뿐 신원을 인증하지 않습니다. 인증된 신원, 암호화된 장기 보존이나 적대적 환경에서도 보장되는 증거 무결성이 필요하다면 별도의 신원·증거 저장소를 연결해야 합니다.

## 프로젝트 구조

```text
.codex-plugin/plugin.json  플러그인 메타데이터
.claude-plugin/            Claude Code 마켓플레이스
claude-plugin/             생성된 Claude Code 플러그인(직접 수정 금지)
claude-overlay/            Claude 전용 파일과 문구 보정
.mcp.json                  로컬 STDIO MCP 서버 설정
skills/                    오케스트레이터와 전문 스킬
mcp-server/                MCP 서버 구현
contracts/                 스킬 간 JSON Schema 계약
scripts/                   검증·빌드·스킬 편입 도구
tests/                     회귀·통합 테스트
```

`skills/orchestrator/`는 요청 분류, 실행 순서 결정, 입출력 전달, 결과 통합만 담당합니다. 전문 판단과 감사 결론은 각 전문 스킬이 맡습니다. MCP 서버는 스킬 이름으로 분기하지 않고 `skills/registry.json`에 선언된 provider의 `capability`와 계약을 사용합니다.
