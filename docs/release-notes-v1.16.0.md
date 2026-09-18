# v1.16.0 — 한국어 산문 candidate-v2 정책

## 핵심 변경

- `korean-prose-editor`의 selection 정책에 2단계 결함 탐색을 추가했습니다. 보호 구간을 뺀 모든 prose unit에서 결함 유형을 빠짐없이 대조한 뒤, 발견한 구간마다 국소 수정의 안전성을 따로 확인합니다.
- editing 정책은 첫 수정안이 의미 불변량 대조에서 실패해도 곧바로 원문 유지로 끝내지 않습니다. issue range마다 최대 두 가지 국소 대안을 검토하고, 원문과 후보를 양방향으로 대조해 통과한 가장 작은 대안만 씁니다.
- verification 기준은 원문→후보와 후보→원문 두 방향의 판정이 다르면 `invariantDelta: "UNCERTAIN"`과 `retain`으로 처리합니다.
- 평가 도구에 `scripts/korean-prose-execution-provenance.ts`를 추가했습니다. 평가 preflight와 readiness는 실제 모델·provider·provider 버전이 비어 있거나 `unverified`인 실행을 새 평가 증거로 받지 않습니다. 이 문자열 검사는 provider attestation을 대신하지 않습니다.
- 2026년 9월 14일 `0.2.0-private-20260914-1` 평가의 terminal `failed` 기록을 로드맵에 추가했습니다.

## 품질 평가 상태

v1.15.x의 `0.3.0-gate-1` 품질 기준 통과는 candidate-v2 이전 정책과 평가 toolchain을 대상으로 한 결과입니다. 이번 릴리스의 정책과 평가 도구는 그 평가 대상과 다르므로, v1.16.0의 `korean-prose-editor`는 품질 미평가 상태입니다. 스킬은 v1.15.x와 같이 활성 상태로 배포하며, 이는 사용자의 명시적 릴리스 요청에 따른 결정입니다. 새 정책은 신규 frame과 private holdout으로 다시 평가해야 합니다.

## 호환성

- 스킬 구성, 용어집 데이터(1.2.1), SQLite schema와 MCP 서버 동작은 v1.15.1과 같습니다.
- `korean-prose-quality-adjudication-meta.v1` schema는 `actualModel`, `provider`, `providerVersion`에 `unverified`, `unknown`, `n/a`, `not-available` 값을 더 이상 허용하지 않습니다. 이런 값이 든 기존 심사 metadata는 새 schema 검증에 실패합니다.
- 평가 toolchain 파일이 바뀌었으므로 이전에 동결한 frame은 동결 당시 toolchain으로만 재검증할 수 있습니다.

## 알려진 제한

- 새 정책이 실제 편집 품질을 높이는지는 아직 측정하지 않았습니다.
- 실행 모델 정보는 host attestation adapter가 없으면 여전히 caller-asserted입니다.
