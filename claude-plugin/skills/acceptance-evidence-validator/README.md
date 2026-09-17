# acceptance-evidence-validator

고정된 구현 대상과 테스트·검사 결과를 수용 기준별로 연결해 `PASS`, `FAIL`, `BLOCKED`, `NEEDS_INPUT`을 판정하는 Codex 스킬입니다. 구현을 수정하거나 고위험 릴리스의 독립 감사를 대신하지 않습니다.

## 요구 사항

- Node.js 22 이상
- 개발과 잠금 파일 재현에는 pnpm 11 사용

## 직접 실행

JSON 파일이나 stdin을 사용할 수 있습니다.

```bash
node scripts/cli.mjs --input tests/fixtures/passing.json
node scripts/cli.mjs < tests/fixtures/passing.json
```

출력은 `AcceptanceEvidenceReport.v1` JSON입니다. 각 수용 기준은 `AC-001`부터 순서대로 ID를 받고, 현재 `target.digest`와 일치하는 검증된 evidence만 판정에 사용됩니다. verification command에는 고유 ID와 영향을 받는 기준 ID를 함께 기록하며, stale 결과와 0이 아닌 종료 코드를 각각 증거 부족과 반증으로 반영합니다.

`not-applicable`은 임의 문자열로 선언할 수 없습니다. 현재 대상에서 검증된 authority evidence가 해당 기준과 `TaskEnvelope`의 실제 제외 범위 또는 금지 행동을 함께 가리켜야 합니다. authority evidence digest는 locator의 값뿐 아니라 evidence ID, 기준 ID, 대상 digest, 방향과 관측 결과도 함께 고정합니다.

기존 보고서를 다시 검사할 때는 다음 명령을 사용합니다.

```bash
node scripts/validate-report.mjs --request tests/fixtures/passing.json --request-artifact request-artifact.json --report report.json
```

`request-artifact.json`에는 외부에서 동결한 요청 artifact의 ID, 입력 schema ID, locator와 canonical SHA-256을 기록합니다. stdin이나 `--input`을 쓸 때는 `{ schemaVersion, request, requestArtifact, report }` 전체를 전달해야 합니다. report만 제출하거나 request와 digest가 일치하지 않으면 검증이 실패합니다.

## 검증

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm validate
```

`contracts/upstream/task-envelope.v1.schema.json`은 Agent Governance Suite의 고정 snapshot입니다. `contracts/upstream/lock.json`의 버전, ref와 SHA-256이 일치해야 하며 런타임에는 suite 모듈을 불러오지 않습니다.

## 통합

`integration/skill-descriptor.json`은 선택 어댑터입니다. 이 파일을 제거해도 직접 호출 기능은 그대로 동작합니다. Agent Governance Suite는 clean tag를 편입할 때 descriptor와 schema checksum을 검증해야 합니다.
