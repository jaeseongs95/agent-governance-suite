## 실행

1. 요청 JSON을 `node scripts/resolve-instruction-files.mjs`의 stdin으로 전달한다.
2. 성공 응답의 `output.verdict`가 `ANALYSIS_REQUIRED`인지 확인하고, `instructionFileManifest`에 기록된 파일을 precedence 순서대로 모두 읽는다.
3. [resolution-model.md](references/resolution-model.md)에 따라 넓은 범위의 규칙부터 적용한다.
4. 자연어 규칙이 충돌하면 [conflict-classification.md](references/conflict-classification.md)에 따라 `activeRules`, `overriddenRules`, `unresolvedConflicts`를 채우고 `analysisStatus`를 `complete`로 바꾼다. 스크립트 결과만으로 의미 충돌을 해소했다고 주장하지 않는다.
5. 미해결 충돌이 작업 범위, 권한 또는 완료 조건을 바꾸면 `NEEDS_INPUT`으로 반환한다.

스크립트는 JSON만 stdout으로 출력한다. 직접 호출에서는 MCP 없이 구조화 결과와 짧은 사용자용 요약을 함께 제공한다.
