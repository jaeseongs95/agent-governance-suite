# AGS 3.8.0 릴리스 노트

2026년 11월 7일 공개한 AGS 3.8.0은 압축·재개 후 작업을 이어 가는 현재 메모리를 개편하고, 스킬 선택·위임·검증 안내와 기존 결함을 개선한 버전입니다.

릴리스 소스는 [`a32badf30c3890ecb9cd1f82a15efa051a1e261b`](https://github.com/jaeseongs95/agent-governance-suite/tree/a32badf30c3890ecb9cd1f82a15efa051a1e261b)입니다. 이 문서는 해당 버전의 안내를 정정한 것으로, 배포 파일이나 태그를 교체하지 않습니다.

## 업그레이드 전 확인

이번 버전은 데이터와 공개 API 계약을 변경합니다. 설치 전에 [3.8.0 데이터 이관 가이드](https://github.com/jaeseongs95/agent-governance-suite/blob/v3.8.0/docs/migrate-to-v3.8.0.md)를 읽고, AGS 데이터를 쓰는 MCP 서버·hook·relay를 중지한 뒤 백업과 이관을 진행하세요. 호스트별 설치 방법은 [설치 안내](https://github.com/jaeseongs95/agent-governance-suite/blob/v3.8.0/README.md#설치)를 따릅니다.

- continuity SQLite 스키마는 `4`입니다. 기존 current가 새 제한을 넘으면, 의미를 보존해 줄인 내용을 담은 mapping이 필요합니다. 원문을 자동으로 자르거나 비워서 이관하지 않습니다.
- 백업은 WAL의 변경까지 포함해야 합니다. 이관에 실패하면 원인을 해결한 뒤 다시 진행하고, 구버전으로 돌아갈 때는 이전 버전과 그 버전에 맞는 백업을 함께 복구하세요.
- `checkpoint_context`와 `purge_direct_context`의 `expectedRevision`은 `expectedStateToken`으로 바뀝니다. 기존 API 연동도 수정해야 합니다. `load_context`가 반환한 `stateToken`을 그대로 사용하세요. workflow의 revision 계약은 이 변경과 별개입니다.

## 현재 메모리 개편

현재 메모리는 대화 기록을 모으는 공간이 아니라, 압축·재개 뒤 작업을 이어 갈 핵심 상태입니다. 에이전트는 목표·제약·진행 상황이 바뀔 때 내용을 갱신하며, 완료 이력과 중복 정보를 계속 쌓지 않습니다.

- `status`, `core`, `evidenceRefs`를 합친 JSON의 UTF-8 크기 상한은 **2000 byte**입니다. 상한을 채우는 것이 목표는 아닙니다.
- 현재 내용과 이전 내용을 `continuity_current_memory`, `continuity_memory_history`로 나눕니다. 갱신 시 이전 내용의 보관과 현재 내용의 교체는 하나의 트랜잭션으로 처리합니다.
- 이전 내용은 AGS 도구·hook·복원 경로에 노출하지 않습니다. 같은 OS 사용자가 파일을 직접 읽는 권한까지 격리한 것은 아닙니다.
- 기존 hook은 압축·재개 시 현재 메모리를 주입하고, 사용자 교정이나 작업 상황 변경 시 갱신을 안내합니다. hook 출력만으로 모델이 내용을 따랐다고 판정하지 않습니다.

## 스킬과 협업 안내

- 독립적으로 맡길 수 있는 일을 구분하고, 위임 여부를 검토하도록 공통 안내를 보완했습니다. 위임 시 목표·범위·금지 구역·쓰기 소유·검증 기준을 전달하도록 안내합니다.
- 하위 에이전트의 결과·기록·잘못은 생성한 부모가 확인하고 정정할 책임이 있음을 명시했습니다.
- 세션 현황판에 선택 필드 `role`을 추가했습니다. 사용자가 맡긴 역할을 기록하고, 역할 밖 요청은 담당 세션에 전달하도록 안내합니다. 역할 표시는 권한이나 잠금이 아닙니다.
- 단계 확인 알림에 `runId`와 `rootId`를 포함해, 진행 중인 workflow를 다시 찾을 수 있게 했습니다.
- 작업 전에 검증 사례를 정하고, 사용자의 실제 진입점에서 확인하며, 막힌 단계와 계속할 수 있는 일을 구분하도록 안내를 보완했습니다.
- 범용 스킬의 표현이 특정 분야에 불필요하게 묶이지 않도록 문구와 검사를 개선했습니다.
- 포함 스킬은 **25개**입니다. `codex-token-usage-analyzer`를 제거했습니다. `model-effort-advisor`는 하위 에이전트를 호출하기 전에 모델·추론 수준을 선택하는 역할로 바뀌었으며, 현재 메인 모델을 관측하는 기능을 전제로 하지 않습니다.

## Windows 범위 검사 성능

변경 범위 검사에서 파일마다 Git 프로세스를 실행하던 경로를 일괄 조회로 바꿨습니다. 파일 내용 해시와 기존 자원 상한을 유지하면서 프로세스 생성 비용을 줄입니다.

TEST의 동일 사례에서 파일 수가 8개에서 80개로 늘 때 Git 프로세스 수가 기존 13→85개에서 7→7개로 바뀌었습니다. Windows 80파일 사례의 관측 시간은 약 7.1초에서 0.7초로 줄었습니다. 이 시간은 해당 시험 환경의 관측값이며 모든 환경의 성능을 보장하지 않습니다.

## 호스트별 범위와 알려진 한계

- Codex와 Claude Code는 `SubagentStart`를 통한 시작 안내를 지원합니다. Antigravity 네이티브 앱에는 해당 이벤트가 없어 이 시작 안내를 지원하지 않습니다. 이를 Antigravity의 모든 AGS 기능이 미지원이라는 뜻으로 해석하지 않습니다.
- hook이 읽은 현재 메모리를 전달하더라도, 이후 상태 변경이나 호스트 중단까지 포함해 정확히 한 번 전달되거나 첫 행동 시점까지 최신이라고 보장하지 않습니다.
- 과거 native 시험의 실패와 Antigravity의 직접 관측 한계는 남아 있습니다. 안내 출력·정적 검사·일부 시험의 통과를 모든 호스트의 실제 행동 성공으로 확대하지 않습니다.
- 내부 wake 표식의 UI 노출·반복 회차 개선은 이번 버전에 포함하지 않았습니다. 남아 있는 모든 결함을 해결한 버전이라고 선언하지 않습니다.

## 검증 근거

- 릴리스 소스 `a32badf30c3890ecb9cd1f82a15efa051a1e261b`의 [CI 42352810552](https://github.com/jaeseongs95/agent-governance-suite/actions/runs/42352810552)는 Linux·Windows에서 성공했습니다.
- main 반영 후 같은 소스의 [CI 42353422373](https://github.com/jaeseongs95/agent-governance-suite/actions/runs/42353422373)와 [패키지 생성 42353421247](https://github.com/jaeseongs95/agent-governance-suite/actions/runs/42353421247)도 성공했습니다.
- TEST와 실제 Codex·Claude Code·Antigravity 시험 및 변경분 독립 감사 결과를 릴리스 판단에 사용했습니다. 이전 후보의 결과는 그 후보의 근거로 보존하며, 최종 소스에서 모든 시험 파일을 한 번에 통과했다는 뜻은 아닙니다.

변경 파일과 개별 커밋은 [3.7.0에서 3.8.0까지의 비교](https://github.com/jaeseongs95/agent-governance-suite/compare/v3.7.0...v3.8.0)에서 확인할 수 있습니다.
