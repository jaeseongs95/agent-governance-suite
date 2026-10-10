## 실행

1. 요청 JSON을 `node scripts/resolve-instruction-files.mjs`의 stdin으로 전달한다.
2. 응답은 `schemaVersion`·`ok`·`output`·`error`를 담은 실행 봉투다. `InstructionScopeResolution.v1`은 봉투가 아니라 `output` 객체이며, 결과를 내기 전에 [그 schema](../contracts/instruction-scope-resolution.v1.schema.json)를 읽는다.
3. 성공 응답의 `output.verdict`가 `ANALYSIS_REQUIRED`인지 확인하고, `instructionFileManifest`에 기록된 파일을 precedence 순서대로 모두 읽는다.
4. [resolution-model.md](resolution-model.md)에 따라 넓은 범위의 규칙부터 적용한다.
5. [conflict-classification.md](conflict-classification.md)에 따라 대상마다 `targets[].activeRules`, `overriddenRules`, `unresolvedConflicts`를 schema의 객체 형태로 채운다. 스크립트 결과만으로 의미 충돌을 해소했다고 주장하지 않는다.
6. 최종 `verdict`를 정한다. 미해결 충돌이 작업 범위, 권한 또는 완료 조건을 바꾸면 `NEEDS_INPUT`으로 반환한다. `analysisStatus`는 최종 `verdict`가 `ANALYSIS_REQUIRED`이면 `required`, 그 밖이면 `complete`다. 의미 분석을 일부 마쳤어도 확인하지 못한 지침 위치 때문에 `ANALYSIS_REQUIRED`를 유지하면 `analysisStatus`는 `required`로 두고, 마친 범위와 확인하지 못한 위치를 `findings`에 적는다.
7. `output` 객체를 기반으로 최종 결과를 조립한다. `schemaVersion`, `workspaceRoot`, `instructionFileManifest`와 각 대상의 `requestedPath`·`resolvedPath`·`exists`·`instructionChain`은 바꾸지 않는다. 의미 판정은 5단계의 배열에, 관찰과 확인 한계는 `findings`에 더하고 `analysisStatus`와 `verdict`만 갱신한다. schema에 없는 필드를 추가하지 않는다.
8. 내보내기 전에 조립한 결과를 schema의 필수 필드, enum, 객체 형태와 `verdict`·`analysisStatus` 조건에 다시 대조하고, 맞지 않으면 고친 뒤 내보낸다.

스크립트는 JSON만 stdout으로 출력한다. 직접 호출에서는 MCP 없이 조립한 `InstructionScopeResolution.v1` 객체 하나를 JSON 코드 블록으로 제공하고, 짧은 사용자용 요약은 그 밖에 따로 쓴다. 요약이나 일부 필드만 고른 객체를 구조화 결과로 표시하지 않는다.
