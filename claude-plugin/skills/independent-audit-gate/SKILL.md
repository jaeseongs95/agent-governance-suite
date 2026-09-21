---
name: independent-audit-gate
description: 보안·권한·결제·데이터 손실·스키마 마이그레이션·프로덕션 배포·전역 설정처럼 잘못되면 실패 영향이 큰 변경을 실행하거나 릴리스하기 전후에 쓴다. 목록에 없는 변경도 되돌리기 어렵거나 다른 사람·공개 상태에 영향을 주면 해당한다. 구현자와 분리된 감사자가 최종 변경과 검증 근거를 직접 확인해 완료 가능 여부를 판정한다. 단순 조사, 저위험 수정, 일반 코드 리뷰, 구현 없는 설계 토론에는 쓰지 않는다.
license: MIT
metadata:
  version: "1.0.0"
---

# Independent Audit Gate

고위험 변경을 완료로 선언하기 전에 독립 감사와 증거 확인을 강제한다. 변경을 만든 주체와 다른 감사자가 최종 대상을 직접 검사하고 `PASS`, `FAIL`, `BLOCKED` 중 하나로 판정하게 한다.

## 적용 범위

다음 작업을 실행, 병합, 릴리스 또는 완료하려 할 때 사용한다. diff 크기보다 실패 시 영향과 복구 가능성을 기준으로 판단한다.

- 인증, 인가, 비밀값, 암호화, 테넌트 격리 또는 외부 노출
- 과금, 결제, 환불, 가격, 지급 또는 거래 실행
- 영구 삭제, 대량 수정, 개인정보, 백업·복원 또는 데이터 정합성
- 스키마, 제약, 데이터 변환, 하위 호환성 또는 rollback 변경
- 프로덕션 배포, 인프라, CI/CD, 장애 대응 또는 서비스 가용성
- 조직이나 프로젝트 전체에 적용되는 기본 권한, 정책, 런타임 또는 네트워크 설정
- 사용자가 독립 감사나 완료 게이트를 명시적으로 요청한 변경

비프로덕션 환경도 실데이터·민감 데이터·공유 자원·외부 연동에 영향을 주거나 복구 가능성이 검증되지 않았다면 고위험으로 본다. 격리된 로컬 환경에서 합성 데이터만 사용하고 즉시 복구할 수 있는 작업은 위험 분류 근거를 남긴 뒤 제외할 수 있다.

단순 조사, 저위험 문서 수정, 일반 코드 리뷰, 구현 대상이 없는 설계 토론에는 이 스킬을 사용하지 않는다. 복잡한 선택지를 여러 관점에서 숙고하는 일은 별도의 deliberation workflow에 맡기고, 선택한 방안을 실제 고위험 변경으로 실행할 때 이 게이트를 적용한다.

<!-- optimization-navigation:start condition="the skill is activated for the request" reference="references/entry-details.md" do-not-load-otherwise="true" -->
- If the skill is activated for the request, read [entry details](references/entry-details.md) before producing any result or taking any action; otherwise do not read it.
<!-- optimization-navigation:end -->
## 출력

사용자에게 다음 순서로 필요한 사실만 제시한다.

1. `Audit Target` — 단계와 최종 대상 식별자
2. `Independence` — 구현자와 감사자, fresh context, 재위임 여부
3. `Evidence Checked` — 직접 확인한 파일, diff, 명령, 테스트, 로그와 배포 상태
4. `Findings` — ID, `blocking | non_blocking`, 증거, 영향, 상태
5. `Remediation/Re-audit` — 수정과 재감사 범위, stale 여부
6. `Gate` — `PASS | FAIL | BLOCKED`와 판정 근거
7. `Limitations` — 미관측 항목과 남은 불확실성

내부 프롬프트, 숨은 chain-of-thought 또는 확인하지 않은 사실을 출력하지 않는다.
