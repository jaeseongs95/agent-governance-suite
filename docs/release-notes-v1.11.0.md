# Agent Governance Suite v1.11.0

`v1.11.0`은 관측 가능한 Codex 토큰 사용량을 보수적으로 요약하는 명시 호출 전용 분석기와, 동결된 평가 근거의 공정성·재현성을 독립적으로 검사하는 감사기를 추가하는 minor 릴리스다.

## 변경 사항

- `codex-token-usage-analyzer` 0.1.0을 추가해 사용자가 제공한 관측치만 집계하고 가용하지 않은 사용량·비용·품질은 추정하지 않는다.
- `evaluation-validity-auditor` 1.0.0과 JSON/JSONL 계약, digest·report 검증 CLI를 추가한다.
- 평가 감사 결과를 reference-only receipt로 저장하고 `PASS`, `FAIL`, `BLOCKED`를 workflow 상태와 고정 오류 코드로 연결한다.
- `pre-execution PASS`가 품질·릴리스 증거로 사용되지 않도록 감사 목적을 별도 `plan_workflow` 입력과 서명된 plan stage에 결속한다.
- 두 독립 저장소의 공개 tag, peeled commit과 checksum을 source lock에 고정한다.

## 호환성과 제한

- 기존 `TaskEnvelope.v1`과 비평가 `plan_workflow(TaskEnvelope)` 호출은 유지된다. 평가 감사 계획만 `{ schemaVersion, taskEnvelope, evaluationAuditPurpose }` 구조를 요구한다.
- workflow와 continuity SQLite schema는 `v1.10.0`과 같다.
- 토큰 분석 결과는 품질, 낭비 또는 구독 한도 차감의 증거가 아니다.
- 평가 감사기 v1은 JSON/JSONL과 SHA-256 기반 증거만 지원하며 임의 테스트 프레임워크 출력 parser를 포함하지 않는다.
- 문제가 생기면 marketplace ref와 설치 버전을 `v1.10.0`으로 복원한다.
