# AGS 2.8.1 Linux 생성 실행 로그

GitHub Actions run `37439468273`, attempt `1`의 API metadata와 제공된 full run 로그 10개, artifact text 21개를 회수 원자료에서 민감정보만 제거해 보존했다. source 담당이 동일 private ZIP을 안전 추출했고, 이 packet writer의 중복 다운로드·API poll·제품 실행·원자료 변경은 모두 0이다.

run은 `2026-10-06T08:56:08Z` 시작, `08:56:39Z` 갱신 기준 `completed/success`다. source HEAD `1f70b95f34c2e48b239e3595328e449862e0fcef`, tree `3e41fef3b2056d89fd9860b27f40b7d665a456d8`은 environment before/after 관측이다. 시작 상태는 clean이었다. 실행기는 GitHub Actions의 Linux `ubuntu-latest` job이며 실제 출력은 Node `v24.21.0`, pnpm `11.19.0`이다. label과 실제 출력의 증명 범위를 구분한다. VM 신규성·실제 AI model/effort 관측은 제공되지 않았다.

| 명령 | exit | 의미 |
|---|---|---|
| corepack enable / pnpm pin | 0 / 0 | pnpm 11.19.0 설정 |
| pnpm install --frozen-lockfile | 0 | frozen install 완료 |
| pnpm bundle:check | 1 | 생성 전 stale bundle 실패 보존 |
| pnpm claude:drift | 0 | 47개 생성물 차이 경고 보존 |
| pnpm skills:context-check | 0 | context 검사 통과 |
| pnpm build | 0 | runtime 생성 |
| pnpm claude:build | 0 | Claude 생성물 생성 |
| pnpm claude:check | 0 | 생성된 Claude 출력 검사 |

9개 명령의 순서·종료는 `artifact/commands.tsv`와 step 원로그에서 대조됐다. STATUS는 `GENERATED_BYTES_READY_NOT_FULL_QA`다. generation job은 성공했고 정상 verification job은 skipped다. 따라서 이 결과는 생성 단계 완료이며 full QA, official supplier, 실제 설치·사용자 경로의 통과를 증명하지 않는다. 요청 input `generate=true`는 API에 노출되지 않아 job 선택으로부터의 추론으로만 기록한다.

artifact ZIP `11400008624`는 1,333,532 B, SHA-256 `7ec13d96158aa1601240e9ba1ee75d94c642cdc081de8edcf4a73df08ea6dc0a`다. 원 run-logs ZIP은 24,461 B, SHA-256 `bb12caf87cf3dc8fee3378749e7b5011e9ffe9d6a6e876646d330bed48cb4916`다. 생성 tar는 private에 보존하며 공개 packet에 복제하지 않았다. `ARTIFACT-CONTENTS.json`에 원 artifact 파일별 크기·hash와 tar 정보를, `artifact/generated-files.sha256`에 생성 파일 527개의 원 inventory를 남겼다. 제품 tree로 import하거나 source에 적용한 작업은 없다.

원 artifact SHA256SUMS는 21개 대상을 검증하며 `full.log`는 원 producer SUMS 대상에 없었다. 이 packet은 `full.log`를 독립적으로 hash하고 original SUMS를 `SHA256SUMS.original.txt`로 표시한다. 새 공개 bytes의 hash는 최상위 SHA256SUMS이며, 원→공개 파일 mapping·크기·hash·줄별 제거 기준은 MANIFEST에 있다.

metadata는 account·opaque ID 맥락을 제외한 명시적 projection이다. 누락을 값의 부재로 해석하지 않는다. 원 run 로그의 GitHub 마스킹도 보존한다. 공개 Git repository/run/source 식별자는 provenance를 위해 유지하고, 실행기 home/checkout/temp/toolcache 경로·hostname·임시 UUID를 제거했다. 키·서명·민감 query·비loopback IP·encoded payload 검사도 수행하되, 파일명이나 진행 표시는 민감정보로 취급하지 않는다.

제공된 ZIP과 text 로그는 모두 회수됐지만 이 자료가 전체 원격 filesystem을 뜻하지는 않는다. 이전 Work Cloud의 offline·registry 차단·pnpm fallback 불일치·context UNKNOWN episode는 `cs281-cloud-work-prep/20261006T074130Z/`에서 유지된다. 새 실행 성공으로 과거 실패·미관측을 덮지 않는다. 기존 evidence base는 `07fd8ab7477442f930957c2f76646d3d1a8bcd1d`이며 새 단독 prefix만 추가했다.
