---
name: software-security-auditor
description: 소스·설정과 허용된 로컬 재현으로 웹·API 및 CLI·MCP의 공격 경로와 방어 통제를 감사하고 취약점·근거·검사 공백을 보고한다. 자동 수정, 운영 서비스 능동 검사나 릴리스 승인에는 사용하지 않는다.
license: MIT
metadata:
  version: "0.1.0"
---

# Software Security Auditor

보안 분석을 요청했거나 수용 기준이 요구할 때 사용한다. 보안 관련 파일이 있다는 이유만으로 일반 작업에 추가하지 않는다. 조사 완료와 소프트웨어 안전 판정은 다르다. 수정·승인·배포 권한을 만들지 않는다.

<!-- optimization-navigation:start condition="the skill is activated for the request" reference="references/entry-details.md" do-not-load-otherwise="true" -->
- If the skill is activated for the request, read [entry details](references/entry-details.md) before producing any result or taking any action; otherwise do not read it.
<!-- optimization-navigation:end -->
## 기존 게이트와 연결

단독 보안 조사는 독립 완료 감사가 아니다. 기존 `independent-audit-gate`의 감사자로 참여하면 해당 실행 안전·독립성 규칙을 먼저 따른다. 감사자는 새 재현 코드를 작성·실행하지 않고 fixture 명세를 구현자에게 반환한다. 구현자가 만든 테스트를 고정된 후보에서 확인한다.

capability `software-security-audit`는 phase 65에서 보고서를 만든다. 유효한 `complete`와 `partial`의 workflow `passed`는 조사 산출물 생성 성공만 뜻한다. `blocked`는 `MISSING_EVIDENCE`로 전달한다. 수용 검증이 선택됐다면 보고서와 검사 공백을 기존 verification evidence에 전달하고 최종 완료·릴리스 판정은 기존 게이트에 맡긴다. 자동 수정이나 새 전역 심각도 차단 정책을 추가하지 않는다.
