# AGS 2.9.1 cloud metadata candidate evidence

24개 스킬의 적용/제외 중복을 분리하고 원문 누락 6건과 단계별 registry 전제 45건을 보존한 **로컬 소스 후보**의 전달 자료다. 동일 최종 테스트로 R13은 15 FAIL/16 PASS, 후보는 31 PASS. 관련 9개 파일의 회귀는 고유 196 PASS다. 합성 JEV encode body는 136,489→108,472 bytes(20.53% 감소)다. 실제 모델 품질·통합·릴리스 통과를 뜻하지 않는다.

- 기준/유일 parent: `c6a8019be30e4bf5ee9a36147ca45ae28b0f75b6`
- 기준 tree: `28f2f2ed8a864405320f6d20e7bc5004e8466ad3`
- 원래 결과 source commit: `737416547b02d60df2b29d0f093143bdab54cf01`
- 결과 source tree: `1bbfc9256e3f19038bd82dadd6a1bde3978e70a3`
- 변경: 24 `skills/*/classification.json`, `inventory.ts`, inventory test의 26파일 / 1,106 추가·203 삭제.
- 실제 API/JEV/Claude 호출 0. 게시를 위해 시험을 새로 실행하거나 제품 코드를 바꾸지 않았다.
- 게시 base는 `fe7c99d935827156b4c675179766b54806c5e937`이며 기존 12,385파일(이전 12,378 + service 게시물7)을 모두 보존한다. 제품 루트에 패치를 적용하지 않는다.

## 원천·극성·문맥

SKILL.md/참고문서/registry 원문은 그대로다. SHA에 결속된 원천 span을 선택적 반개구간 UTF-8 byte 범위로 나누고 exact duplicate 값만 제거했다. 원문 설명을 새로 요약하거나 앞단 LLM 호출을 추가하지 않았다. 기존 23개 배열의 완전 중복과 ponytail 공통 span을 해소했다. 모든 24개 스킬은 유지되며 공개 공통REQ/RESP, provider wire schema, 모델 중앙 설정, InventoryOptions/host 입력은 바꾸지 않았다. 새 neutral skill은 기존 external root에서 inventory/wire 25개로 전달됐다.

기존 unique source union 66개 범위를 266개 조각으로 원문 복원 대조했다. 독립 read-only reviewer는 24개 원천 SHA와 비공백 바이트 1회 보존, 보호 문맥9개, registry 전제45개를 확인했다. 초안의 주어·단계·선행 문맥 분리 위험5개는 최종 해소됐다. registry 원문 값은 `{phase, capabilities, precondition}`으로 소속을 함께 보존한다. 공개 snapshot은 line sourceMap을 유지하고 byte selector는 classification 파일 digest에 결속한다. 최종 선택은 AGENT이며 분류기는 지원 역할이다.

누락6개는 software-security-auditor/independent-audit-gate의 감사 재현 금지 역할 맥락, session-board의 공유 checkout 수정 전 조회, recovery의 원본 diagnosis/frozen digest, blocker의 read-only 허용, panel의 strict capability 부족 시 worker0 조건이다. 첫 두 사례는 기존 context failure 구체 재현이고 뒤 네 사례는 이번 감사에서 새로 식별한 정적 누락이다. 실제 모델 오판·권한 우회를 관측한 것은 아니다. 초기 문맥 위험5개 역시 초안의 정적 발견이며 최종 해소했다.

## 자료와 실제 결과

- [candidate.patch](candidate.patch): author identity만 generic public evidence 표기로 바꿨다. 코드 diff는 원본과 바이트 동일하다.
- [pins.json](pins.json), [changed-files.sha256](changed-files.sha256): source/result commit·tree, 부모, 변경26파일의 Git blob/SHA256.
- [test-results.json](test-results.json): 동일 final test SHA/argv, RED→GREEN, 63+133 PASS, 실제 검사와 한계. 단독31 및 반복 실행을 고유196에 더하지 않았다. RED15개에는 새 byte-selector feature/error-contract 테스트6개가 포함되며 독립 결함15개라는 주장이 아니다.
- [run-receipts.public.json](run-receipts.public.json), [logs/](logs/): 실제 기존 receipt의 허용 필드와 필요한 stdout/stderr 발췌. 원본digest는 retained originals의 digest다. 정제본은 원본 contract 검증 대상으로 가장하지 않는다. 부분snapshot·unsigned consistency의 한계를 유지한다.
- [independent-review.public.json](independent-review.public.json), [partition-proof.json](partition-proof.json): 원천/문맥 전수 검토, 변경 외 tracked1,541 파일의 불변 검증 및 protected hashes. reviewer 제품 쓰기/API 호출0. 실제 모델 선택 정확도는 미검증이다.
- [size-and-inventory.json](size-and-inventory.json): 고정 합성87B prompt에서 크기 분해 및 all24/new skill 결과. 로컬 cl100k 39,394→28,581, o200k 30,290→23,547은 실제 provider usage가 아니다. 과거 약41,700개는 당시 body/tokenizer/framing 부재로 정확히 재현하지 못했다.
- [integration-limitations.json](integration-limitations.json): 실제 SHA pin24건 mismatch, CONTENT_LOCK INTEGRITY_FAILED, 서버 bundle stale 실패와 담당 통합 작업.
- [provenance.json](provenance.json), [manifest.json](manifest.json), [SHA256SUMS](SHA256SUMS): 원본과 공개자료 bytes/SHA를 구분한다. 자격정보·환경값·개인 대화·개인 로컬경로·불필요한 원본로그는 제외했다.

## 적용 방법 — 총괄의 단일 통합 branch

이 디렉터리에서 `sha256sum -c SHA256SUMS`를 실행한다. 제품 저장소의 정확한 기준 commit/tree를 확인하고 별도의 통합 branch에서 검토한다. evidence 브랜치 제품 루트에는 적용하지 않는다. `PATCH_FILE`은 확보한 공개 patch의 위치로 지정한다.

```sh
git rev-parse HEAD HEAD^{tree}
git apply --check "$PATCH_FILE"
git am "$PATCH_FILE"
```

충돌하면 최신 제품 head로 자동 대체하거나 덮어쓰지 말고 총괄이 검토한다. 정확한 기준에서 적용하면 변경26파일 SHA는 changed-files.sha256, 전체 tree는 result source tree와 일치해야 한다. 파일hash 검증은 제품 root에서 변경 digest list의 경로를 지정해 `sha256sum -c`로 실행한다. 다른 통합 변경이 있으면 전체 tree가 달라질 수 있다. author 정제·새 committer/time 때문에 적용 commit SHA가 원래 결과source SHA와 같을 것이라고 주장하지 않는다.

검증 재현 argv는 test-results.json에 있다. RED 재현은 기준 checkout에 최종 테스트 파일만 복사하고 해당 argv를 실행하며, GREEN은 source patch 적용 결과에서 같은 테스트를 실행한다. 실제 paid API/Claude를 켜지 않는다. 통합 후 최종 작성자가 metadata SHA pins, CONTENT_LOCK, server bundle 및 필요한 canonical 배포 projection을 갱신·검토한다. 이후 새 inventory/profile 조합으로 실제 품질 qualification과 영향 범위 검증을 별도로 수행한다.

## 미완료와 권한 경계

실제 모델품질/semantic qualification·최종 AGENT 선택, 통합bundle freshness/build/clean-room/runtime 통과, CONTENT_LOCK 통과, 전체1257suite, R14 writer 검증, host E2E·릴리스는 미완료다. SHA pin/CONTENT_LOCK/bundle은 기존 읽기 전용 검사에서 FAIL이며 게시로 고치지 않았다. 로컬 소스 scope PASS를 전체 repository PASS나 릴리스 승인으로 해석하지 않는다. JEV OFF는 동일 벤더의 고정 저비용 quality-qualified fallback이며 all-external OFF와 별개인 기존 정책을 유지한다.
