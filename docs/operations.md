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

MCP 서버는 workflow 실행 상태와 계획 서명 키를 `workflows.sqlite3`에 저장합니다. 선택적 task continuity는 같은 사용자 상태 디렉터리의 별도 `continuity.sqlite3`를, 세션 현황판은 `session-board.sqlite3`를 사용합니다. 저장 위치를 직접 관리하려면 각각 `AGENT_GOVERNANCE_DB_PATH`, `AGENT_GOVERNANCE_CONTINUITY_DB_PATH`, `AGENT_GOVERNANCE_SESSION_BOARD_DB_PATH`에 절대 경로나 MCP 작업 디렉터리 기준 상대 경로를 지정합니다. 해당 디렉터리는 MCP 서버를 실행하는 사용자만 접근할 수 있도록 보호해야 합니다.

상태 정리는 자동 실행되지 않습니다. `prepare_state_cleanup`으로 180일이 지난 terminal workflow 상태와 30일이 지난 비활성 continuity payload를 미리 본 뒤, 사용자가 확인한 같은 15분 token을 `execute_state_cleanup`에 전달해야 합니다. 삭제 전 검증된 SQLite backup을 만들며 backup은 자동 삭제하지 않습니다. 자세한 정책과 복구 절차는 [SQLite 상태 보존과 정리](state-cleanup.md)를 참고하십시오.

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

## 공통 인프라 스킬

[`context-continuity`](../skills/context-continuity/)는 전문 판단 provider가 아니라 로컬 lifecycle 인프라입니다. 긴 direct task에서 잃으면 범위·권한·분기·검증 판단이 달라질 상태만 선별해 replacement checkpoint를 작성합니다. Resume과 direct compact에서는 본문을 자동 주입하지 않고 metadata와 restore token만 제공하며, 본문은 `load_context`를 명시적으로 호출할 때만 반환합니다. Orchestrated workflow의 compact 복원은 기존 `TaskEnvelope`, receipt와 convergence root에서 투영한 bounded 구조 카드만 자동 주입합니다. 이 스킬은 `skills/registry.json`과 위 전문 스킬 수에 포함되지 않습니다.

Lifecycle Hook은 raw transcript를 읽거나 저장하지 않으며 raw session·turn·request 식별자 대신 설치별 HMAC correlation을 기록합니다. `clear`는 epoch를 회전해 이전 snapshot 복원을 억제하지만 payload를 자동 삭제하지 않습니다. `suppress_context_restore`는 후보 제공만 멈추고, 명시적인 `purge_direct_context`만 direct payload를 지우고 hash tombstone을 남깁니다. Continuity DB 오류는 workflow나 compaction을 막지 않습니다.

Continuity snapshot의 `core`와 `evidenceRefs`는 로컬 `continuity.sqlite3`에 평문 JSON으로 저장되며 자동 만료되지 않습니다. 비밀값, 개인정보, 원시 로그·코드나 chain-of-thought를 checkpoint에 넣지 말고, DB 파일의 접근 권한과 보존 기간을 직접 관리해야 합니다.

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

공개 MCP 도구의 응답 옵션을 생략하면 기존과 같은 전체 결과와 convergence 이력을 반환합니다. 오케스트레이터의 정상 경로는 `responseMode: "compact"`와 `detail: "compact"`를 사용해 plan, 누적 `stageResults`, provider output, task/frame 원문과 전체 이력을 제외한 고정 크기 요약만 받습니다. 오류 원인, 과거 결과 또는 감사 자료가 필요할 때만 해당 상태를 `full`로 다시 조회합니다. compact attempt claim은 root에 저장된 task envelope와 frame을 복원하고, plan을 생략한 guarded start는 일회용 lease에 결속된 proposal plan을 사용합니다. 저장되는 전체 `WorkflowReceipt`와 SQLite schema v5의 run·convergence·trusted observation claim 상태는 이 전송 방식과 무관하게 유지됩니다.

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
