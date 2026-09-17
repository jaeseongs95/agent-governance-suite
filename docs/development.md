# 개발 참고

[README](../README.md)의 기본 검증 명령 외에, 동결 평가와 스킬 편입 절차를 정리합니다.

## 한국어 산문 평가

동결된 한국어 산문 평가에서는 각 모델 단계 직전에 공통 사전 검사를 실행합니다. `<evaluation-root>`에는 `evals/runs`와 평가에 사용한 `skills/korean-prose-editor`가 있어야 합니다.

```bash
pnpm eval:preflight -- selection 1 <evaluation-root>
pnpm eval:preflight -- editing 1 <evaluation-root>
pnpm eval:preflight -- verification 1 <evaluation-root>
pnpm eval:preflight -- record 1 <evaluation-root>
```

검사는 승인된 실행 횟수, 기존 출력, 입력·후보·루브릭 digest, ID 순서, 빈 후보, 역할 결속과 블라인드 검증 입력을 확인합니다. 실패하면 해당 모델 단계를 실행하지 않습니다. `record` 검사는 `pnpm eval:receipt`에도 자동으로 적용됩니다.

새 구조화 cycle은 경로를 명시하고, 모델 호출 전에 동결 frame과 독립 corpus 타당성 보고서를 검사합니다. 품질 결과를 릴리스 근거로 사용할 때는 `--require-quality`를 붙입니다.

```bash
pnpm eval:readiness -- <cycle-directory> --expected-frame-digest <sha256:digest> --expected-validity-report-digest <sha256:digest> --evaluation-root <evaluation-root>
pnpm eval:preflight -- selection 1 <evaluation-root> --cycle-dir <cycle-directory> --expected-frame-digest <sha256:digest> --expected-validity-report-digest <sha256:digest>
pnpm eval:readiness -- <cycle-directory> --expected-frame-digest <sha256:digest> --expected-validity-report-digest <sha256:digest> --expected-quality-report-digest <sha256:digest> --evaluation-root <evaluation-root> --require-quality
```

`READY_TO_EVALUATE`는 새 평가를 시작할 수 있다는 뜻이고, `EVALUATION_EVIDENCE_PASSED`는 receipt·SQLite·최종 case와 독립 심사 결과에서 다시 집계한 모든 실행이 동결 기준을 통과했다는 뜻입니다. 어느 상태도 provider 활성화나 릴리스 승인을 뜻하지 않습니다. frame·타당성 보고서·품질 보고서의 digest를 cycle 밖에 먼저 보관한 뒤 각각 전달해야 합니다. selection 사전 검사는 모델 실행 전에 start claim을 원자적으로 만들고 이후 단계 metadata가 그 digest를 참조합니다. 언어 모델과 독립 심사자 입력에는 정답 label을 넣지 않으며, 심사가 봉인된 뒤 별도 동결 label 파일을 결합해 점수만 집계합니다. 기존 `invalid-corpus`와 `failed-recovery` cycle은 재해석하지 않으며, 새 frame은 현재 suite revision, 실제 통합 skill과 동일한 평가 사본의 checksum, 평가 toolchain의 checksum, corpus strata·rubric·threshold의 digest, 실행 횟수, 독립 역할을 함께 결속해야 합니다.

동결 threshold 값은 source lock의 upstream commit `c5df63749e2edfc8aa424f9935ee3cd4697d3c49`에 있는 `evals/cycles/0.1.0-rc2/thresholds.json`을 그대로 보존합니다.

## 스킬 추가와 편입

새 전문 스킬의 기본 구조와 정상·경계·실패 사례용 `fixture`를 만들려면 다음 명령을 사용합니다.

```bash
pnpm new:skill --name evidence-normalizer --phase validation --capability evidence-normalization
```

별도 저장소에서 개발한 스킬은 태그나 커밋으로 버전을 고정한 뒤 편입합니다. `integration/skill-descriptor.json`이 있으면 `provider` 선언을 그대로 사용합니다. 기존 형식의 스킬에는 `--phase`와 `--capability`를 지정해 단일 `provider`를 보완할 수 있습니다.

```bash
pnpm import:skill --source <path-or-url> --ref <tag-or-sha> --skill-path <path> --phase <phase> --capability <capability>
pnpm import:skill --source <path-or-url> --ref <new-tag-or-sha> --skill-path <path> --replace true
pnpm validate:skill --name <skill-name>
```

편입 명령은 임시 checkout에서 지정한 Git `ref`의 파일만 가져옵니다. `.git`, `__pycache__`, `evals/results`, 일반적인 빌드 산출물은 제외하며, 원본 경로, tag 또는 commit, peeled full SHA와 원본/통합 `checksum`을 `skills/source-lock.json`에 기록합니다. 편입 PR에서는 자동 생성된 `fixture`를 실제 동작 사례로 교체해야 합니다.

공개 계약은 `contracts/`에 JSON Schema 2020-12로 정의되어 있습니다. 기존 버전과 호환되는 스킬 추가는 `minor`, 동작 수정은 `patch`, 계약·권한·식별자의 호환성을 깨는 변경은 `major` 버전으로 관리합니다.
