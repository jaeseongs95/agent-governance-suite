## 절차

1. 대상 저장소와 적용 지침을 확인한다.
2. 첫 변경 전이면 `scripts/capture-workspace-baseline.mjs`로 `WorkspaceBaseline.v1`을 만들고 `manifestSha256`을 baseline artifact의 신뢰 경계에 동결한다. 작업 중 범위를 갱신해 task contract를 새로 만들 때는 현재 상태를 다시 캡처하지 않는다. 원래 baseline과 동결 digest를 capture 요청의 `baseline`·`baselineArtifactDigest`로 넘겨 새 task envelope에 다시 결속한다. 다시 캡처하면 이 작업의 변경이 `preexisting-untouched`로 흡수된다.
3. 검증 시에는 task envelope, baseline과 동결한 `baselineArtifactDigest`를 `scripts/compare-change-scope.mjs`에 전달한다.
4. `excluded`, `unplanned`, `preexisting-overlap`, `ownership-unknown`을 근거 경로와 함께 보고한다.
5. `PASS`, `NEEDS_REVIEW`, `BLOCKED`, `INCONCLUSIVE` 중 하나만 반환한다.

경로 판정 규칙은 [references/path-policy.md](path-policy.md), verdict 조건은 [references/verdict-rules.md](verdict-rules.md)를 읽는다.
