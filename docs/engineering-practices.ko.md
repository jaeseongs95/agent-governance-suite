# 엔지니어링 실무 통합

AGS 2.8.1 후보는 소스 패키지 `ags-engineering-practices` 0.1.0에서 `test-engineering`과 `code-review` 두 스킬을 편입한다. 소스 패키지 버전 0.1.0은 두 스킬과 공통 지식의 버전이며 AGS 릴리스 버전 2.8.1과 같은 의미가 아니다.

## 책임 경계

| 구성 | 책임 | 대신하지 않는 것 |
| --- | --- | --- |
| `test-engineering` 0.1.0 | 요구사항과 실제 코드 경계에서 테스트 사례를 설계하고 red/green 또는 표적 mutation 근거가 결함을 탐지하는지 점검 | 원인 진단, 제품 구현 총괄, 최종 수용, 독립 감사, 릴리스 승인 |
| `code-review` 0.1.0 | 고정된 diff·patch·PR의 검토 범위와 실제 실패 경로를 확인하고 결함·권고·질문을 구분 | 수정 실행, 전체 아키텍처·보안 심층 감사, 최종 수용, 독립 감사, 릴리스 승인 |
| 기존 전문 스킬 | 디버깅, 최소 구현, 의존성 보안, 수용 근거, 흐름 연결과 독립 감사의 기존 책임 유지 | 새 두 스킬에 기존 권위를 넘기지 않음 |

`cs-engineering` 0.2.0은 CS 원리로 설계 제약과 검증 의무를 도출하고 선택된 후보·근거의 일관성을 검사한다. 엔지니어링 실무 통합은 이 범위, CS stage binding, draft 규칙의 상태와 알려진 한계를 바꾸지 않는다.

## 공통 지식과 계약

공통 지식은 8개 모듈, 48개 규칙으로 구성한다. 오케스트레이터나 담당 스킬은 현재 작업에 필요한 모듈만 읽는다.

| 모듈 | 규칙 수 | 담당 |
| --- | ---: | --- |
| `test-design` | 6 | `test-engineering` |
| `test-proof` | 6 | `test-engineering` |
| `code-review` | 6 | `code-review` |
| `debugging` | 6 | `blocker-diagnostician` |
| `implementation` | 6 | `ponytail` |
| `dependency` | 6 | `software-security-auditor` |
| `verification` | 6 | `acceptance-evidence-validator` |
| `agent-instructions` | 6 | `orchestrator`와 스킬 작성자 |

닫힌 `engineering-*.v1` JSON Schema 9개는 다음 입력과 결과를 표현한다.

- 테스트: `engineering-test-plan`, `engineering-test-proof`, `engineering-plan-result`, `engineering-test-result`
- 리뷰: `engineering-review-request`, `engineering-review-report`, `engineering-review-result`
- 공통 실행 근거: `engineering-snapshot`, `engineering-run-receipt`

스냅샷, digest와 실행 로그는 제출된 자료의 식별과 로컬 일관성 검사에 사용한다. raw proof가 존재하거나 결과가 `CONSISTENT`·`NO_BLOCKING_FINDINGS`라는 사실만으로 요구사항 충족, 실제 동작, 근거 진본성, 독립 감사 또는 릴리스 승인을 확정하지 않는다. `NOT_RUN`, 누락과 무결성 실패를 성공으로 바꾸지 않는다.

## 실행과 권한

두 스킬은 기존 registry와 orchestrator 선택 경계를 사용한다. 새 권한 source, 사용자 승인, hook, MCP handler, DB, PEER·세션 제어, signed plan·lease·resume·finalize binding을 추가하지 않는다. 선택 metadata는 런타임 의미를 자동으로 강제하지 않으며, 직접 호출과 registry 경로는 각각 실제 실행으로 확인해야 한다.

소스 패키지의 자체 CLI는 Node.js 22 이상으로 작성됐지만 AGS 프로젝트와 출하물의 지원 기준은 Node.js 24 이상과 `pnpm@11.19.0`을 유지한다. 새 npm 의존성은 추가하지 않는다. 생성되는 `mcp-server/dist/`와 `claude-plugin/`은 공용 원본이 고정된 뒤 기존 생성 절차로 만들며 직접 수정하지 않는다.

## 2.8.1 후보 상태

이 문서 작성 시점의 상태는 다음과 같다.

| 항목 | 상태 |
| --- | --- |
| 소스 패키지 0.1.0 입력 구조·두 스킬·8모듈·48규칙·9계약 확인 | 확인 |
| AGS source 편입, registry·source lock·orchestrator 연결 | 후보 작업 트리에 반영, 최종 pin·검증 대기 |
| AGS에서 직접 스킬 선택 | `NOT_RUN` |
| registry provider 실행 | `NOT_RUN` |
| 통합된 standalone validator | `NOT_RUN` |
| AGS 전체 lint·build·test·bundle·runtime·official validation | `NOT_RUN` |
| Codex·Claude 생성물과 실제 호스트 로딩 | `NOT_RUN` |
| 독립 감사와 공개 릴리스·설치 | `NOT_RUN` |

통합 대상 47개 payload 경로 중 42개는 입력 byte를 유지한다. 나머지 5개는 AGS lint와 content lock 정합성을 위해 `runtime/engineering-practices/core.mjs`, `io.mjs`, `CONTENT_LOCK.json`과 두 스킬의 `shared-dependencies.json`을 조정한 통합 delta다. 별도 installer·hook·npm 의존성은 제품에 넣지 않는다.

입력 패키지에 포함된 자체 검증 보고와 raw proof는 통합 입력의 출처 자료다. 이 writer는 이를 재실행하지 않았으며 AGS 후보의 수용 근거로 승격하지 않는다. 최종 후보는 source pin, 생성물과 registry 상태를 고정한 뒤 직접 호출, registry 경로, 실패 보존, 전체 회귀, 공식 validator와 실제 호스트 경계를 별도로 검증해야 한다.
