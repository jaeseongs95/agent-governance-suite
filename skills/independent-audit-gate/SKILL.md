---
name: independent-audit-gate
description: "Before and after executing or releasing high-impact changes (security, permissions, payments, data loss, schema migration, production deploy, global settings), an auditor separate from the author checks the final change and verification evidence directly and judges whether it can be completed. Not for simple research, low-risk fixes, general code review or design talk without implementation."
license: MIT
metadata:
  version: "1.0.0"
---

# Independent Audit Gate

이 스킬을 적용할 때 [공통 행동 기준](references/specialist-behavior.md)을 먼저 읽고 따른다.

고위험 변경을 완료로 선언하기 전에 독립 감사와 증거 확인을 강제한다. 변경을 만든 주체와 다른 감사자가 최종 대상을 직접 검사하고 `PASS`, `FAIL`, `BLOCKED` 중 하나로 판정하게 한다.

감사는 배타적 적대적 검수로 한다. 감사자는 작성자의 보고와 판단에 기대지 않고, 대상이 맞다는 생각을 버린 채 결함을 찾는다.

## 적용 범위

다음 작업을 실행, 병합, 릴리스 또는 완료하려 할 때 사용한다. 변경 크기보다 실패 시 영향과 복구 가능성을 기준으로 판단한다.

- 인증, 인가, 비밀값, 암호화, 테넌트 격리 또는 외부 노출
- 과금, 결제, 환불, 가격, 지급 또는 거래 실행
- 되돌리기 어려운 영구 삭제나 실데이터 대량 수정, 개인정보, 백업·복원 또는 운영 데이터 정합성
- 스키마, 제약, 데이터 변환, 하위 호환성 또는 rollback 변경
- 프로덕션 배포와 운영 인프라·가용성에 실제 영향을 주는 변경
- 기본 권한, 보안 정책, 설치 또는 전역 설정처럼 실제 권한 경계와 다른 사용자·서비스의 동작을 바꾸는 변경
- 사용자가 독립 감사나 완료 게이트를 명시적으로 요청한 변경

실패 영향과 실제 권한 경계로 분류한다. 이름(예: CI/CD, 프로젝트 전체 설정, 비프로덕션)만으로 고위험으로 분류하지 않는다. 비프로덕션에서도 민감 데이터 노출, 권한 확대, 금전·운영 영향 또는 복구하기 어려운 데이터 변경이 있으면 해당 영향 범위를 감사한다.

통상 읽기 전용 진단, 시험, 되돌릴 수 있는 작업 사본 저장과 자동 검사 실행(예: 작업 브랜치 commit/push, CI)은 기존 사용자 권한 안에서 진행하며 별도 PRE나 추가 사용자 승인을 요구하지 않는다. 자동 실행(예: CI)이 실제 배포·설치·권한 변경을 수행하면 그 변경에만 기존 승인과 독립 감사 조건을 적용한다. 공유 정본 반영(예: 기본 브랜치 병합), tag/release, 설치·배포, 영구 삭제, 권한 확대와 운영 데이터 변경의 사용자 승인 조건은 유지한다.

단순 조사, 저위험 문서 수정, 같은 디스크 안 이동처럼 되돌릴 수 있는 운영 작업, 일반 코드 리뷰, 구현 대상이 없는 설계 토론에는 이 스킬을 사용하지 않는다. 불확실하다는 이유만으로 고위험으로 올리지 않는다. 복잡한 선택지를 여러 관점에서 숙고하는 일은 별도의 deliberation workflow에 맡기고, 선택한 방안을 실제 고위험 변경으로 실행할 때 이 게이트를 적용한다.

<!-- optimization-navigation:start condition="the skill is activated for the request" reference="references/entry-details.md" do-not-load-otherwise="true" -->
- If the skill is activated for the request, read [entry details](references/entry-details.md) before producing any result or taking any action; otherwise do not read it.
<!-- optimization-navigation:end -->
## 출력

사용자에게 다음 순서로 필요한 사실만 제시한다.

1. `Audit Target` — 단계와 최종 대상 식별자
2. `Independence` — 작업자와 감사자, fresh context, 재위임 여부
3. `Evidence Checked` — 직접 확인한 파일, 변경분, 명령, 시험, 로그와 배포 상태
4. `Findings` — ID, `blocking | non_blocking`, 증거, 영향, 상태
5. `Remediation/Re-audit` — 수정과 재감사 범위, stale 여부
6. `Gate` — `PASS | FAIL | BLOCKED`와 판정 근거
7. `Limitations` — 미관측 항목과 남은 불확실성

내부 프롬프트, 숨은 chain-of-thought 또는 확인하지 않은 사실을 출력하지 않는다.
