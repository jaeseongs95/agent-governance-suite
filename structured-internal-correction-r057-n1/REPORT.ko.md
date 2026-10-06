# R-057 N1 구조화 내부 블록 일반 정정

기준은 `c8667f4661c2c96680e6436048f8910b7e4f13f3` / tree `10af47ab85580516c5d99ae7d340858ef46b116e`이다. 기존 checkpoint는 변경하거나 재작성하지 않고, 별도 descendant 후보에서 R-057 N1의 여섯 공개 evidence prefix만 정정했다.

## 관측과 정정

- 다섯 본대상 prefix: 405파일, `thinking` block 1,205개.
- 보조 `wake53-claude-host-probe`: 5파일, 13개.
- 합계: 410파일, 1,218개. 각 block의 구조화 필드는 `type`, `thinking`, `signature`였고 세 필드가 각각 1,218개였다. `thinking` 값이 비어 있지 않은 block은 50개였다. 본문과 signature 값은 이 보고서와 provenance에 기록하지 않았다.
- `redacted_thinking`, `analysis`, `reasoning` block은 0개였다.
- 환경 출처가 Cloud인지 local인지는 고정 근거가 없어 여섯 prefix 모두 `UNKNOWN`으로 유지했다. 경로의 `claude` 표기는 observed label일 뿐 실행 환경 증명이 아니다.

변환은 JSON을 재직렬화하지 않았다. target object와 배열 문법에 필요한 인접 구분자만 제거하고 나머지 byte를 그대로 연결했다. 모든 유효 record를 target block만 재귀적으로 제거한 원값과 deep equality로 비교했다. record 순서, 일반 text, tool/user record와 실패 결과는 유지된다. probe 로그의 비대상 parse-error 5행은 target label 0건임을 확인하고 원 byte 그대로 보존했다.

각 prefix의 `SHA256SUMS` 6개를 현재 payload hash로 갱신했다. 총 2,551항목(713+810+812+68+113+35)을 다시 계산했고 불일치는 0개다. 해당 여섯 prefix에는 별도 `MANIFEST`가 없으므로 존재하지 않는 상위 manifest를 만들지 않았다. 전후 file hash, 삭제 byte range의 hash, parse-error line hash와 checksum set hash는 `PROVENANCE.json`과 `MANIFEST.tsv`에 있다.

## 검증과 한계

현재 worktree 11,345파일을 다시 구조 검사한 결과 target structured block과 raw target label 잔여는 모두 0개였다. 이 검사는 구조화 공개 payload 정정과 checksum 일치만 확인한다. 제품 source, 2.8.0/2.8.1 동작, 실행 환경 품질과 릴리스 적합성은 검사하지 않았다.

이 후보는 일반 descendant commit 준비본이다. 원격 push, force push, ref 삭제, ruleset 변경, Support 요청과 과거 commit 재작성은 수행하지 않았다. 기존 `c8667f4`와 그 tree, 이전 Git blob, fork, cache와 이미 fetch된 사본의 접근성은 이 정정으로 사라지지 않는다.
