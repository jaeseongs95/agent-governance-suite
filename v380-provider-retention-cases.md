# Provider observation retention CI 원인·수리 사례

- 기준: `9f6fe1e85a414a51cb78e8c0baf9ddd27b897fb0`; 작업 branch `codex/ags38-provider-retention`.
- 관측: CI `42250756095`의 Ubuntu·Windows에서 모두 `ORACLE_SOURCE_MISMATCH`, `bootstrap.prepare:268`이 발생했다. 로그는 `D:/codex/build/ags-01a14016-release-resume/ci-9843-failed.log`다. fetch/응답보존 검사 전에 선행 준비가 거부됐으므로 OS 또는 provider 보존 결함의 근거가 아니다.
- 정적 대조: 기존 frozen corpus와 r30까지의 successor로 결속된 60경로 중 3개가 현재 root와 다르다. acceptance classification은 D6 문서 source digest 재결속, board classification·entry-details는 D29 호출자 문서 정정에서 바뀌었다. r30·그 이전 bytes와 frozen oracle은 유지한다.
- 수리 범위: 정확히 이 3개 경로의 원본→현재 hash를 r31 successor로 결속한다. 본문 비교의 이전 기준은 `a281139387af096e696f8d50cc089ad09e9291fc`, 허용된 현재 원문은 root `9f6fe1e85a414a51cb78e8c0baf9ddd27b897fb0`다. context 21 pin 계약과 합치지 않는다.

| 사례 | 공개 진입점·입력·전제 | 절차 | 기대·판정 | 실제 결과 |
|---|---|---|---|---|
| PR-01 | `loadCurrentSourceBindings`; 현재 공개 source tree·frozen corpus | 원본 sourceSkills와 현재 binding의 실제 bytes를 정확 hash 대조 | 미허용 차이 0개. 수리 전에는 3개 차이로 실패 | NOT_RUN |
| PR-02 | `prepare`→retention public helper; 기존 13개 합성 provider 시나리오 | 기존 helper·raw/usage/omission/no resend assertion을 그대로 실행 | 13개 식별자가 모두 기존 순서·내용으로 통과; API 호출 0 | NOT_RUN |
| PR-03 | r31 public manifest | r30 부모 bytes·hash, 원본 3개 hash와 현재 3개 hash 대조 | 승인된 경로 3개만 정확 결속, 임의·stale digest 거부 | NOT_RUN |
| PR-04 | `loadCurrentSourceBindings`; 격리 복사한 JSON manifest만 변조 | r31 파일에 다른 bytes 추가 후 공개 loader 호출 | CURRENT_SOURCE_BINDING_MANIFEST_MISMATCH, frozen 원본은 수정 없음 | NOT_RUN |

TEST: `pnpm exec vitest run tests/skill-classification/live-bootstrap/provider-observation-retention.test.ts tests/skill-classification/source-binding-successor.test.ts tests/skill-classification/live-bootstrap/bootstrap-fixture-reuse.test.ts tests/skill-classification/parent-accountability.test.ts`. 로컬 제품 시험은 금지되어 실행하지 않는다. 보존 조건·source 검사를 완화하지 않는다.

정적 확인(제품 시험 아님):

- Node 표준 라이브러리로 manifest JSON과 원문 bytes를 읽어 대조했다. 60경로 중 r30 상태의 불일치는 위 3개이며 r31 적용 후 0개다. 기존 tracked frozen manifest 변경은 0개다.
- r31은 2,107 bytes, `sha256:0dd7fdf3baa5b12a9cd6d533145acfe8b2b9770453188a327c8b6f2aa5918499`다. r30 부모는 10,378 bytes, `sha256:13ccf86f29b547cc17491df7d4edeb8c464b153cf8be45f22de5bc02b8639aad`로 유지했다.
- 이전 descriptor와 참조 원문 6개는 `a281139387af096e696f8d50cc089ad09e9291fc`의 exact hash로 확인했다. 현재와 selected clause를 비교하면 acceptance는 모두 동일하고 `session-board:exclusions[3]`만 D29의 실제 caller 계약 문구로 바뀌었다. 과거 회귀는 당시 bytes를, PR-03은 현재 bytes와 inventory를 각각 검증한다.
- 최신 통합 `34959b0654fe0f81e72331afcfbca100ae90d31e`와 입력 기준 `9f6fe1e85a414a51cb78e8c0baf9ddd27b897fb0` 사이에서 이 60경로의 Git blob 변경은 0개다.
- `node --check`로 변경 TypeScript 구문을 검사하고 `git diff --check`를 실행했다. runtime provider 구현·기존 retention helper는 변경하지 않았다. PR-01~04 실제 제품 실행은 모두 NOT_RUN이며 원격 TEST가 필요하다.
- Claude builder의 `SHARED_ROOTS`와 English builder의 `CODEX_PATHS`는 `tests/`를 포함하지 않는다. 이번 successor와 평가 추적부는 발행물 생성 경로에 추가하지 않았다.
