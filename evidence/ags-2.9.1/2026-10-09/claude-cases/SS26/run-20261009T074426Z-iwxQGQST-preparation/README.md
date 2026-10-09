# SS26 — 정본 metadata 변경과 cache 무효화

준비 상태: PREPARATION_COMPLETE_WAITING_FOR_PARENT. 실제 Claude Code API 시험과 제품 시험은 NOT_RUN이다. 준비 완료는 시험 PASS가 아니다. 이번 준비의 유료 호출·재시도·실패 호출·토큰·캐시 사용·비용은 모두 0이다.

## 고정 원래 입력과 기준

입력 근거는 공개 evidence commit af579e2caa8c09b380bdf88b5e9c675b0b0b9c68의 evidence/ags-2.9.1/2026-10-09/cases/SS26/이다. original-spec.json은 원래 SS26.embedded-source.json의 바이트 동일 사본이며 SHA256은 bab77eb04da7f60ecd1b179b86e5744218505ccac7a7456767a5b4d999eca3db이다. 원래 제목은 “정본 metadata 변경과 cache 무효화”이다. originalPrompt와 semantic oracle은 null이며 자연어 정답이나 의미 정확도를 발명하지 않는다.

원래 입력: 정본 SKILL.md와 registry의 고정 revision을 단일 loader로 읽는다. v1 이후 설명·적용·제외 조건 변경, 신규 스킬 추가, ID 중복, 설명 누락, ID/version/짧은설명/taxonomy/apply/exclude의 정본·생성물 불일치, 삭제·비활성화를 각각 제공한다. SKILL.md와 registry의 담당 필드가 충돌하는 변형도 둔다.

필수 동작: 각 요청은 해당 revision의 전체 유효 descriptor로 평가한다. ID/version/짧은설명/taxonomy/apply/exclude별 정본·생성물 source-map을 고정하고 그 우선순위와 필드 책임을 지키며 신규 스킬을 반영한다.

기대 결과: 원천 변경 후 descriptor·REQ digest가 바뀌고 관련 cache가 무효화된다. 부정/제외 조건 변경도 다음 분류에 반영된다. 새 스킬은 정본 추가·loader 재읽기만으로 노출되며 selector 코드 수정은 0이다. 삭제된 후보의 늦은 결과는 현재 선택을 덮지 않는다.

허용·보류: 원천·설명·inventory·profile model revision에 결속된 cache. 설명 부족·충돌은 구체적 입력 공백으로 보류하고 다른 완전 후보까지 숨기지 않는다. 정본 역할이나 revision을 확인할 수 없거나 필수 설명·적용/제외가 누락됨.

금지 행동: 선택기 내부 수기 설명 목록만 갱신; SKILL.md 변경 후 옛 REQ·embedding·직렬화 cache 재사용; 누락·중복 ID를 조용히 정상 처리; 원천 충돌을 추정으로 덮어씀.

증거: E0·E2·E4, source→loader→descriptor→REQ→cache key 연결, 신규·삭제·충돌 diff, 선택기 코드 무변경 근거. 합성 snapshot만 변경한다. 정본 제품 파일과 생성 배포물을 수정하지 않는다.

12개 변형은 description, applicability, exclusion, new-skill, duplicate-id, missing-description, id-conflict, version-conflict, taxonomy-conflict, source-generated-conflict, delete, disable이다. source-generated-conflict에는 id/version/description/taxonomy/apply/exclude 6개 field 검사, SKILL/registry 필드 책임 검사와 적용·제외 누락 검사도 포함한다. 독립 완전 후보 complete는 불완전 subject 때문에 숨겨지면 안 된다. 삭제·비활성화 중 늦게 도착한 분류는 STALE_CLASSIFICATION으로 거부되어야 하며 현재 선택을 덮어쓰면 안 된다.

## 입력 무결성과 기존 결과

manifest payload 107개, SHA256SUMS 108개, 고정 Git blob 109개와 embedded baseline/current source 121개의 SHA256을 대조했고 불일치는 0이었다. 전체 해시와 Git blob은 input-integrity.json에 있다. fixture 17ade7e27cc11ffee8cc0b7b2070785617861d4c3384448cf24fce75f40d87e9, frozen oracle 5db1d67cef8719c40b17b0ab07003f01f765746d34ced0b326e59fadb2efe055 및 sourceSpec body digest는 역사적 결속값으로 보존했다. 전체 fixtures.json과 standalone TEST-SPEC.seq7.ko.md가 이 공개 패키지에 없으므로 그 원본·후보 결속을 새로 확인했다고 주장하지 않는다. 원래 r1 stdout/stderr/command receipt도 MISSING_ORIGINAL 상태를 유지한다.

기존 후보 c6a8019의 offline 결과는 12개 변형 중 4 PASS·8 FAIL, binding 1 PASS이며 최종 isolated exit 1이다. 별도 targeted regression은 2 PASS·4 skipped이고 전체 suite PASS가 아니다. 불완전/충돌 metadata가 독립 완전 후보를 gateway에서 숨기는 실패와 삭제/비활성화 후 과거 inventory의 늦은 결과가 SUCCESS로 반환되는 실패가 기록되어 있다. 실제 AGENT 선택 덮어쓰기는 관측되지 않았으며 selected/read/applied/verified는 모두 NOT_RUN, 최종 선택 IDs와 host receipt는 null이다. 기존 실패나 미실행을 기대 정답으로 바꾸지 않는다.

## Claude Code에서 확인할 단계

Sol은 환경·입력·판정 근거를 관리하고 실제 제품 작업은 Claude Code가 호스트 도구로 수행한다. 검증된 후보의 격리 사본에서 Claude가 지침, 원래 입력과 실제 공개 코드 경계를 읽고 기존 SS26 기계적 테스트를 실행해야 한다. 동일한 frozen input/test bytes로 모든 변형, cache/profile 결속과 field source-map, 독립 후보 유지, 신규 스킬 노출과 늦은 삭제/비활성화 결과 거부를 확인한다. 실행 argv와 상세 단계는 preparation.json에 있다.

이 테스트는 외부 분류 provider를 mock으로 대체한다. 실제 Claude Code가 실행해도 mock 분류가 Claude 의미 판정이나 실제 host selection receipt로 승격되지 않는다. host selected/read/applied/verified는 실제 host 도구·관측·현재 task binding과 supported receipt로 확인할 수 있는 단계만 인정한다. 합성 receipt는 만들지 않는다.

## 현재 준비와 재개 조건

지정 Claude CLI는 2.1.286 (Claude Code)이며 절대 경로에서 --version과 --help로 로컬 확인했다. 기본 PATH에는 없다. API 인증은 아직 검증하지 않았다. 시크릿 값·원본 채팅·개인정보를 게시하지 않았고 영구 인증, 권한, 네트워크 정책을 변경하지 않았다. .agents/skills가 없어 로컬 skills의 AGENTS.md와 관련 SKILL.md 및 test-design/test-proof/CLI 지침을 읽었다. 읽은 지침 checkout은 준비용 기존 소스이며 최종 제품 후보 시험이 아니다. 최종 후보에서 지침을 다시 확인해야 한다.

보고된 R17 commit fa1e250c1cbc4f8f446f2e2ddeb516f4e439edbb / tree 43d2b4e49cdb6993c48d7adc792a3ef17426092e는 부모의 독립 SOURCE 판정과 원격 게시 검증을 아직 받지 않았다. 이전 main 또는 c6a8019를 이번 제품 후보로 시험하지 않았다.

부모가 검증된 최종 후보·공통 Claude model/revision/options·성공한 API 인증 방식·선행 검사 결과·실행 재개를 보내면 진행한다. API soft budget은 준비 호출까지 USD 2이며 39개 예약 합계 USD 78은 소비 목표가 아니다. 모든 호출의 token/cache/retry/failure/cost를 기록하고 한도 접근 또는 비용 불명 시 다음 호출을 멈춘다. JEV는 별도 배정 전 호출하지 않는다.

산출물은 이 고유 run 경로의 정제된 보고서·근거·해시 목록뿐이다. evidence 브랜치에 추가만 하며 다른 작업 파일, 제품 소스 및 생성 배포물은 수정하지 않는다. 고정 게시 commit의 원격 blob 재읽기 결과는 게시 후 별도 로컬 receipt로 확인한다.
