# code-review

이 모듈이 필요한 작업에서만 읽는다. 기존 AGS 권한·역할·계약을 유지한다. 규칙 원본은 [catalog.json](catalog.json)이며 모델 행동 평가는 NOT_RUN이다.

## CR-001 — 후보와 검토 범위 고정

**담당:** code-review

**적용:** diff 또는 PR을 리뷰할 때

**행동:** base/head 또는 파일 digest와 요구·제외 범위를 먼저 고정한다. 모든 변경 파일을 읽었거나 미검토 이유를 적는다.

**근거:** request.changedFiles와 report.coverage가 정확히 일치해야 한다.

**피할 실패:** 일부 출력만 읽고 전체 검토 완료를 주장하지 않는다.

**예외:** 큰 diff에서는 위험 기반 깊이를 조정하되 파일 개수만으로 안전 여부를 결정하지 않는다.

출처: AW-REVIEW ([고정 커밋](sources.lock.json)).

## CR-002 — 도달 가능한 실패 경로

**담당:** code-review

**적용:** 결함을 보고할 때

**행동:** 관찰 위치, 위반 계약, 실제 호출 경로, 영향과 최소 수정 방향을 연결한다.

**근거:** finding에 file:line, contract, trace, impact, correction을 남긴다.

**피할 실패:** 가능할지도 모른다는 추측이나 취향만으로 blocking finding을 만들지 않는다.

**예외:** 불완전한 관측은 open question으로 남기고 증거가 강한 결론은 불필요하게 약화하지 않는다.

출처: AW-REVIEW ([고정 커밋](sources.lock.json)).

## CR-003 — 제거된 방어의 목적 확인

**담당:** code-review

**적용:** 검증·timeout·권한·제약 코드를 삭제할 때

**행동:** 관련 이력과 호출자를 읽고 삭제 후에도 원래 실패를 막는지 확인한다.

**근거:** 제거한 guard의 목적과 대체 보호 또는 더 이상 필요 없는 근거를 남긴다.

**피할 실패:** 짧아졌다는 이유로 기존 사고 방지 코드를 제거하지 않는다.

**예외:** 이력이 없으면 동기를 만들어내지 않고 현행 동작·계약으로 평가한다.

출처: AW-REVIEW ([고정 커밋](sources.lock.json)).

## CR-004 — 리뷰와 수정 책임 분리

**담당:** code-review

**적용:** 코드 리뷰 실행 중

**행동:** 기본은 읽기 전용으로 findings와 질문을 반환하고 수정은 구현 담당에게 넘긴다.

**근거:** 검토 대상 digest와 수정하지 않았다는 실행 범위를 기록한다.

**피할 실패:** 리뷰 도중 대규모 refactor를 시작하거나 스스로 독립 감사자라고 선언하지 않는다.

**예외:** 명시적 수정 요청이 있으면 별도 작업 범위·후보를 만들고 변경 후 재검토한다.

출처: AW-REVIEW ([고정 커밋](sources.lock.json)).

## CR-005 — 영향도와 증거 수준 분리

**담당:** code-review

**적용:** findings를 정렬할 때

**행동:** 심각도는 영향과 도달성으로, 확인 상태는 근거로 정한다. 동일 원인을 중복 집계하지 않는다.

**근거:** severity·confidence·category·blocking을 서로 다른 필드로 기록한다.

**피할 실패:** 리뷰어 여러 명이 같은 지적을 했다는 이유로 심각도를 올리지 않는다.

**예외:** 권고 사항은 non-blocking이며 프로젝트의 명시적 기준이 있으면 그 기준을 우선한다.

출처: AW-REVIEW ([고정 커밋](sources.lock.json)).

## CR-006 — 전문 감사에 넘길 경계

**담당:** code-review

**적용:** auth·의존성·DB·분산 상태·성능 변경

**행동:** 표면 결함을 위치와 함께 넘기고 깊은 보안은 software-security-auditor, CS 제약은 cs-engineering에 연결한다.

**근거:** handoffs에 대상 역할·대상 파일·사유를 남긴다.

**피할 실패:** code-review 하나가 security audit, CS 검토, acceptance와 release 승인을 모두 대신하지 않는다.

**예외:** 해당 전문 스킬이 없으면 미검토 범위를 적고 자동 설치나 새 권한을 만들지 않는다.

출처: AW-REVIEW ([고정 커밋](sources.lock.json)).
