---
name: evaluation-validity-auditor
description: 동결된 스킬·모델 평가의 입력, 판정 방법과 결과 집계가 공정하고 재현 가능한지 실행 전후에 감사한다. 평가 실행·채점·수정이나 일반 구현 검증에는 사용하지 않는다.
license: MIT
metadata:
  version: "1.0.0"
---

# Evaluation Validity Auditor

평가 결과를 품질 gate, 완료 주장 또는 릴리스 근거로 사용하기 전에 평가 자체의 유효성을 독립적으로 확인한다. 이 스킬은 평가를 실행하거나 fixture, rubric, oracle, threshold, 결과와 실패 기록을 수정하지 않는다.

<!-- optimization-navigation:start condition="the skill is activated for the request" reference="references/entry-details.md" do-not-load-otherwise="true" -->
- If the skill is activated for the request, read [entry details](references/entry-details.md) before producing any result or taking any action; otherwise do not read it.
<!-- optimization-navigation:end -->
## 판정

- `PASS`: 선택한 단계의 모든 필수 검사가 통과했다.
- `FAIL`: 현재 artifact가 잘못된 평가 설계, 오염, 불완전한 레코드 또는 잘못된 집계를 직접 증명한다.
- `BLOCKED`: 필수 artifact나 독립 provenance가 없거나 읽을 수 없어 판정할 수 없다.

잘못된 request schema, artifact-root 이탈과 외부 symlink/junction은 보고서가 아니라 `INVALID_INPUT`으로 반환한다. 새 evidence나 동결 frame이 들어오면 기존 보고서를 재사용하지 말고 새 요청 digest로 다시 감사한다.
