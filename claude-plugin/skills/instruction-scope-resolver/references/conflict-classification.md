# 규칙 충돌 분류

파일 발견 결과는 규칙의 의미를 대신하지 않는다. 각 규칙을 원문 위치와 연결한 뒤 다음 네 가지로 구분한다.

- `additional-constraint`: 상위 규칙과 양립하며 조건을 추가한다.
- `narrower-exception`: 더 가까운 지침이 특정 경로 또는 작업에 한정된 예외를 명시한다.
- `direct-conflict`: 같은 상황에서 동시에 지킬 수 없는 지시다. 더 가까운 저장소 지침이 충돌 부분을 덮어쓰되, 시스템·개발자·사용자 지침보다 우선한다고 해석하지 않는다.
- `ambiguous`: 적용 대상이나 조건이 불명확해 우선순위만으로 결론을 낼 수 없다.

`activeRules`에는 요약, 원본 파일과 line locator를 기록한다. 덮어쓴 규칙은 양쪽 source를 `overriddenRules`에 남긴다. 작업 범위, 권한, 파괴적 행동이나 완료 조건에 영향을 주는 `ambiguous` 항목은 `unresolvedConflicts`로 보고하고 사용자 입력을 기다린다.
