# SS15 — existing AGS 2.9.1 offline evidence

기존 SS15 산출물을 공개용으로 포장한 기록입니다. 이 게시 단계에서는 새 환경, 시험, 과거 run 재실행, JEV/vendor/Claude/Codex 추론 호출을 수행하지 않았습니다.

## 고정 대상과 기존 결과

- 후보 branch: `codex/skill-classification-2.9.1`
- commit: `c6a8019be30e4bf5ee9a36147ca45ae28b0f75b6`
- tree: `28f2f2ed8a864405320f6d20e7bc5004e8466ad3`
- fixture SHA256: `17ade7e27cc11ffee8cc0b7b2070785617861d4c3384448cf24fce75f40d87e9`
- oracle SHA256: `5db1d67cef8719c40b17b0ab07003f01f765746d34ced0b326e59fadb2efe055`
- 기존 회귀: 2 PASS, 24 skipped, exit 0. 최초 잘못된 filter는 실행 0건/26 skipped이므로 NOTRUN이며 exit 0을 PASS로 취급하지 않습니다.
- 최종 기존 격리 테스트: 17건, 12 PASS / 5 FAIL, exit 1. 최초 탐색 실행과 최종 재실행은 동일한 17개 assertion이며 별도 case로 중복 집계하지 않습니다.
- 오프라인 결론: FAIL. typo, disabled, unsupported 세 variant를 모두 검사했습니다. 전체 suite나 실제 호스트 PASS가 아닙니다.
- 실제 host selected/read/applied/verified: 모두 NOTRUN. 실제 선택과 hostReceipt는 null입니다. JEV/external vendor/Claude/native inference 호출 0입니다.
- 기존 plan helper는 READY이며 proof helper는 INCOMPLETE(exit 1)입니다. 제품 수정 후보/green이 없고 실제 호스트도 미실행이므로 sensitivity proof의 NOT_RUN을 보존합니다.

## 기존 관측

1. typo: 교정된 CS를 합성 SELECTED로 넣거나 unresolved를 유지한 채 PARTIAL로 넣으면 검증기에서 valid=true, runnable에 CS가 포함됩니다. 실제 AGENT가 이 오류를 범했다는 관측은 없습니다.
2. disabled/unsupported: selected=null인 NEEDS_INPUT에서 needed CS는 남지만 blockedItems의 DISABLED/HOST_UNSUPPORTED 사유가 빠집니다. 두 실패를 한 원인으로 묶습니다.
3. unsupported: 직접 loader에 호스트 지원 목록을 주면 false지만 gateway에는 그 공급 경로가 없습니다. 이미 알려진 host-active-state 공급 공백이며 새 결함으로 중복 집계하지 않습니다.

합성 decision/receipt는 테스트 입력입니다. 분류기는 지원이며 AGENT 최종 선택, 실행 승인, 본문 읽기, 적용, 검증 완료를 대신하지 않습니다. 정답을 임의로 추가하거나 운영 case에 정확도 점수를 만들지 않았습니다. SS15 bootstrap 오타 채점은 기존 기록대로 R14 새 후보 대기/NOTRUN입니다.

## 파일과 원본 결속

- `SS15.result.json`: 기존 결과의 공개 정제본. `push:false` 등은 원래 검사 시점의 상태이며 현재 게시 상태를 뜻하지 않습니다.
- `SS15.source.json`: 기존 fixture의 SS15 원문/embedded fields/oracle/variants. `TEST-SPEC.seq7.ko.md`는 원 저장소에 없어 embedded 원문만 사용했습니다.
- `SS15.witnesses.json`: 기존 variant별 전체 입력/기대/관측. null과 []를 그대로 보존했습니다.
- `inputs/*.prompt.txt`: 기존 결과에 기록된 정확한 prompt 문자열을 UTF-8/no-final-newline bytes로 저장한 파생본입니다.
- `logs/`: 이미 존재하던 JSON report/helper 출력과 help/version stdout의 공개본입니다. 전체 stdout/stderr가 아닌 report를 terminal log처럼 표시하지 않습니다.
- `repro/SS15.development.test.ts`: 기존 테스트의 portable 출력 경로 정제본. assertion/제품 코드 변경은 없습니다. 공개본은 실행하지 않았습니다.
- `repro/reproduce.sh`: 기존 명령을 옮긴 재현 안내로, 게시 중 실행하지 않았습니다. Node 24.19.0/pnpm 11.19.0과 고정 lockfile의 기존 의존성을 준비한 별도 후보 checkout에서 사용하십시오.
- `missing-originals.json`: 회수하지 못한 원본과 미생성 transport bytes를 구분합니다. 원래 patch는 없으며 새 patch를 만들지 않았습니다.
- `original-artifact-digests.json`: 기존 원본들의 과거 SHA256 목록. 제외한 원본의 bytes를 공개한 것으로 해석하지 않습니다.

개인 로컬 경로는 `<REPO_ROOT>`, `<ARTIFACT_ROOT>`, `<DEPENDENCY_ROOT>`, `<HOME>`, `<CODEX_EXECUTABLE>`로 정제했습니다. assertion 오류 문구와 제품 source 위치를 남기고 불필요한 framework stack frame은 제거했습니다. 자격정보/환경 변수 값/개인 대화는 게시하지 않습니다. 정제본의 bytes는 원본과 다를 수 있으며 모든 변경·원본 및 공개 bytes/SHA256를 manifest에 구분합니다. 기존 candidate/proof digest는 원본 대상의 digest로 유지되며 정제본을 원본 bytes로 검증했다고 주장하지 않습니다.

## checksum과 재현

`manifest.json`은 payload 파일별 bytes/SHA256 및 원본 provenance를 기록하고 자기 자신의 hash를 포함하지 않습니다. `SHA256SUMS`는 payload와 manifest를 포함하며 자기 자신은 제외합니다.

```bash
# Check downloaded public bytes only; this is not a new product test.
sha256sum -c SHA256SUMS
# Instructions only, not run during publication:
# bash PUBLIC_SS15_DIRECTORY/repro/reproduce.sh PUBLIC_SS15_DIRECTORY
```

게시 대상은 `evidence` 브랜치의 `evidence/ags-2.9.1/2026-10-09/cases/SS15/`로 한정합니다. 제품/main/tag/다른 사례 변경은 없습니다. 실제 호스트 시험에 필요한 승인된 profile/route/native allowance, 지원 상태 공급, 실제 attestation/task 관측 등은 기존 `host-readiness.json`에 보존했습니다.
