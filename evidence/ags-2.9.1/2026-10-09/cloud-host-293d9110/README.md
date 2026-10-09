# AGS 2.9.1 host discovery 후보 증거

원본 후보: `293d9110affb7048c703cf4ac6e14dcfe0a9ea3b`
후보 tree: `63dd3ae9e5910ffa2fa3c3ee456c2d7a7b646ce7`
원본 부모: `c6a8019be30e4bf5ee9a36147ca45ae28b0f75b6`
기준 tree: `28f2f2ed8a864405320f6d20e7bc5004e8466ad3`

기존 실행 결과는 대상 테스트 106 PASS / 0 FAIL, 동일 테스트 red/green 11 의미 있는 assertion FAIL → 11 PASS, 로컬 proof consistency CONSISTENT입니다. 유료 API·Claude 호출·실제 호스트 모델 turn은 모두 0입니다. 실제 AGENT 선택→SKILL 읽기→적용은 NOT_RUN입니다.

이번 커밋은 증거 게시만 합니다. 기존 evidence 트리를 보존하며 제품 루트와 main을 변경하지 않고 후보 패치를 적용하지 않습니다. 새 구현이나 테스트 재실행은 없습니다. REPORT.ko.md는 앞선 로컬 구현 단계의 원본 보고서이며 당시 push를 하지 않았다는 설명은 그 단계에 해당합니다.

- [후보 패치](candidate.patch): git-am 형식. 개인 작성자 헤더를 `AGS Evidence <evidence@example.invalid>`로 교체했으며 diff body는 원본과 byte-identical입니다. 적용하면 새 commit identity가 생깁니다. 원본 후보 SHA는 위 provenance입니다. 기준 commit 위에서 통합 담당자가 적용해야 하며 이 evidence-only 브랜치 루트에는 적용하지 않습니다.
- [코드 diff](candidate.diff): 원본 binary diff 그대로입니다.
- [테스트 요약](test-summary.json), [원본 상세 보고서](REPORT.ko.md), [검토 근거](review-notes.md), [미완료 한계](integration-limitations.json).
- [stdio 관측](stdio-observations.public.json): 기존 세 조건 × 여섯 named/unnamed/복합/읽기전용/모호/오타 합성 요청의 정확한 입력과 관측값. 큰 중복 SDK 자료는 제외하고 원본 bytes/SHA256을 남겼습니다.
- `evidence/`: 기존 최종 회귀 JSON, source/scope/proof 검사 결과, 로그. `proof-root/`: 기존 frozen source/plan/proof와 원시 red/green receipt. 이 하위 소스는 증거용 snapshot이며 제품 적용을 의미하지 않습니다.
- `manifest.json`과 `size-and-inventory.json`: 게시 파일 bytes/SHA256. `SHA256SUMS`: 자신을 제외한 모든 게시 파일의 hash 목록.

한계: 실제 호스트 snapshot producer 및 호스트 연결, 실제 스킬 읽기·적용, 통합 bundle/설치 캐시 반영, 실제 공급자 품질 qualification은 미완료/NOT_RUN입니다. timeoutMs는 positive int만 검사하며 상한은 아직 추가되지 않았습니다. 임시 bundle/stdio PASS를 통합 bundle 완료로 해석하지 않습니다. 기존 pinned base의 bundle freshness FAIL도 그대로 기록합니다.

개인 작성자 정보, 자격정보·비밀값·개인 대화·호스트 상태 DB와 불필요한 원시 자료는 제외했습니다. 게시된 prompt/actor/source/오류 sentinel은 합성 fixture입니다. 소스 diff와 나머지 선택된 기존 증거는 변경 없이 보존했고, 원본 및 게시된 파일 hash를 provenance.json에 연결했습니다.
