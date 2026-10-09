# SS17 — AGS 2.9.1 기존 개발 증거

이 게시물은 기존 SS17 결과를 정제한 공개본이다. 게시 단계에서 새 시험, 과거 run 재실행, JEV/vendor/Claude/native Codex 호출은 모두 0회다. 전체 SS17 또는 실제 모델 정확도 PASS를 주장하지 않는다.

| 항목 | 기존 관측 |
| --- | --- |
| 원ID / 전체 fixture variant | SS17 / base 1개 |
| 기존 관련 scope 회귀 | PASS 6/6, exit 0 |
| 새로 작성했던 SS17 격리 검사 | PASS 21/21, exit 0 (이번 게시에서 실행하지 않음) |
| 알려진 결함 | host-active-state-supply-gap: REPRODUCED_OFFLINE, 새 원인 중복 집계 없음 |
| 실제 selected/read/applied/verified | 모두 NOTRUN; selected=null, hostReceipt=null |
| 실제 provider/model 호출 | 0; in-memory synthetic vendor stub 1회는 실제 호출 아님 |
| 제품 patch | NO_PATCH; 제품 소스 변경 없었음 |
| 원본 회수 누락 | 없음. 존재하지 않았던 제품 patch와 외부 TEST-SPEC 파일을 만들지 않음 |

고정 후보 commit `c6a8019be30e4bf5ee9a36147ca45ae28b0f75b6`, tree `28f2f2ed8a864405320f6d20e7bc5004e8466ad3`.
전체 fixture 원본 SHA256 `17ade7e27cc11ffee8cc0b7b2070785617861d4c3384448cf24fce75f40d87e9`.
동결 oracle SHA256 `5db1d67cef8719c40b17b0ab07003f01f765746d34ced0b326e59fadb2efe055`.
`TEST-SPEC.seq7.ko.md`는 고정 repo에 없으므로 embedded fields/originalPrompt/oracle/variants만 사용했다.

`input.originalPrompt.txt`는 fixture의 원문 UTF-8 bytes를 줄바꿈 추가 없이 추출했다. `request.public.json`에는 당시 원문과 전체 24개 skill inventory, null context가 있다. `fixture.SS17.json`은 해당 case만 추출했다. 기대 추천은 change-scope-guardian만이며 code-review/ponytail/비공식 ID를 금지한다. 실제 scope CLI는 제외 경로 1개와 기존 사용자 변경 겹침 1개를 보고했고 BLOCKED였다. baseline 부재는 INCONCLUSIVE/ownership-unknown, repository/task/digest 불일치는 exit 1과 비교 보류였다. 검사 대상 CLI에서 파일 및 .git bytes/mode의 전후 snapshot은 동일했고 읽기 전용 Git 호출 55회, mutation 호출 0회였다. fixture 초기화를 위한 add/commit/mv는 별도다.

`observations.public.json`에는 모든 기존 경계의 입력·기대·관측 22개(최종 API/readonly audit 포함)가 있다. 반복 inventory는 `request.public.json`로 연결했고 synthetic repository 절대경로를 역할 placeholder로 정제했다. 내부 baseline/report checksum은 기존 관측 digest를 보존했다. 정제된 객체의 재계산 digest로 원본 무결성을 주장하거나 이를 validator 입력으로 사용하면 안 된다. 원본 및 공개 파일의 bytes/SHA256와 변환 설명은 `manifest.json`에 있다. stdout/stderr 4개는 원본 bytes와 동일하다. 원본 report와 결과 생성 helper는 provenance digest만 공개하며 불필요한 전체 원문은 게시하지 않는다.

실제 호스트 확인에는 승인된 classification 설정/profile/provider route/예산, actual host 설치·활성·지원 inventory와 prompt/session/hook 관측, 실제 대상 repository/baseline/독립 baseline digest/task envelope가 여전히 필요하다. 테스트로 host receipt를 생성하지 않았다. 정답 synthetic advice는 AGENT의 실제 선택이 아니다. 알려진 호스트 공급 공백도 그대로 남아 있다. 상세 누락 입력과 지원 코드 경로는 public result의 hostSupportPath에 있다.

## 재현 안내 — 작성만 했으며 이번 게시에서 실행하지 않음

별도 승인된 개발 환경에서 위 고정 commit을 checkout하고 해당 lockfile의 기존 dependencies와 Node 24.19.0 / pnpm 11.19.0을 준비한다. repository root를 cwd로 하고 이 게시 폴더의 절대 경로를 사용한다.

```bash
node --import tsx --test <PUBLIC_SS17_DIRECTORY>/SS17.offline.node.mjs
node --test --test-name-pattern '^(blocks explicit excluded changes|preserves untouched preexisting changes and detects overlap|rejects a baseline from another repository|returns INCONCLUSIVE instead of guessing ownership without a baseline|requires an externally frozen baseline digest even when a forged checksum is self-consistent|rejects a baseline captured for a different frozen task envelope)$' tests/change-scope-guardian/change-scope.node.mjs
```

공개 재현 파일은 개인 경로 기본값과 synthetic 이메일을 portability 목적으로 정제했다. 공개 버전 실행 상태는 NOT_RUN이고 기존 원본 실행 상태만 PASS 21/21이다. 원본 fixture/후보를 다른 후보로 바꾸거나 과거 API 21-run을 실행하는 명령은 포함하지 않았다.

`manifest.json`은 payload 파일별 bytes/SHA256를 담고 자기 자신과 SHA256SUMS를 제외한다. `SHA256SUMS`는 payload와 manifest를 포함하고 자기 자신은 제외한다. 이를 통해 순환 hash를 피한다. Git push/remote 검증은 시험 실행 또는 실제 host 관측이 아니다.
