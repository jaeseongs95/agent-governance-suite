# AGS3 D0007·D0013 경계 회귀 사례

- 기준: `a281139387af096e696f8d50cc089ad09e9291fc`, branch `codex/ags38-core-boundary`.
- 소유: provider semantics·host discovery. acceptance 스킬 구현은 별도 작성자 소유이며 통합 전까지 직접 변경하지 않는다.
- 수준: 실제 gateway/inventory 파일 읽기 + 호스트 CLI stdout 대체. 실제 호스트 목록 조회·모델 호출·설치·bundle clean-room은 root TEST 담당이 별도 수행한다.
- 실행: TEST 또는 CI에서 `pnpm exec vitest run tests/mcp/ags38-core-boundary.test.ts`. 로컬 제품 시험 금지로 이 작업 사본에서는 실행하지 않는다.

| 사례 | 요구·공개 진입점 | 입력·전제 | 절차 | 기대·통과 기준 | 실제 결과 |
|---|---|---|---|---|---|
| CB-01 | D0007 `assertProviderSemantics`의 배포 import 경계 | security skill scripts를 사용할 수 없는 번들 환경 | 기존 esbuild로 공개 모듈을 번들하며 해당 skill script 경로만 거부 | core 번들 성공, skill script 부재가 core를 깨지 않음 | NOT_RUN |
| CB-02 | D0013 `RuntimeSkillClassificationGateway.inventory()` | 설치 root의 manifest·SKILL.md·classification.json과 host CLI 설치/활성 기록이 일치 | 기본 gateway의 observer로 Claude CLI JSON을 읽고 inventory 조회 | host discovery COMPLETE, 실제 스킬 설치/활성/지원 true | NOT_RUN |
| CB-03 | 같은 진입점, 비활성 host 설치 | CB-02에서 CLI enabled=false | inventory 재조회 | 설치 true, 활성 false. registry 활성화로 덮어쓰지 않음 | NOT_RUN |
| CB-04 | 같은 진입점, 관측 실패 | CLI throw·잘못된 JSON·지원되지 않은 host | 각각 inventory 조회 | UNAVAILABLE와 HOST_DISCOVERY_UNAVAILABLE. 오류 비밀을 노출하지 않음 | NOT_RUN |
| CB-05 | 같은 진입점, 경로·버전 변경 | CLI installPath가 다른 root이거나 설치 버전 불일치 | inventory 조회 | 현재 실행 tree를 실제 설치된 것으로 주장하지 않음 | NOT_RUN |
| CB-06 | 같은 진입점, freshness | 같은 관측 내용으로 연속 조회·실제 enablement 변경 | inventory 재조회 | 동일 의미의 revision 안정, 활성 변경은 inventory digest 변경 | NOT_RUN |

RED는 이 사례 그대로 test-only SHA를 TEST에서 실행해 회수한다. import 오류 자체가 원결함인 CB-01 외에는 runner/import 부재를 유효 RED로 세지 않는다. GREEN은 같은 테스트 파일 digest·명령으로 fix SHA를 실행한다. fixture가 대체한 host CLI 실행은 실호스트 통과 근거가 아니다.

## 현재 구현·관측 한계

- security 검증 공용 정본은 `runtime/provider-security-semantics.mjs`이며 기존 skill core는 이를 재수출한다. 원 구현 byte를 옮겼고 별도 정책 복사본은 만들지 않았다.
- Claude 기본 observer는 실제 `claude plugin list --json` 결과의 설치·활성 상태와 현재 실행 설치 root의 realpath·manifest version을 대조한다. `sourceRef`는 해당 설치 scope만 가리키며 전체 호스트의 외부 스킬 발견을 주장하지 않는다.
- CLI JSON 형식 근거: [Claude 공식 CLI 문서](https://code.claude.com/docs/en/plugins/cli-reference). 제품 버전별 실제 CLI 동작은 TEST 실관측이 남아 있다.
- [Codex 공식 CLI 소스](https://github.com/openai/codex/blob/main/codex-rs/cli/src/plugin_cmd.rs)의 설치목록에는 현재 설치 경로 결속 필드가 없다. Codex·agy는 실제 설치 경로/지원 상태의 신뢰 관측이 확보될 때까지 기본 observer가 UNAVAILABLE를 유지한다. D0013 전체 수용 완료가 아니다.
- acceptance core/schema는 별도 작성자의 수정 SHA를 기다린다. provider의 acceptance script import와 다른 core-skill imports는 root 통합의 잔존 범위다.
- 이 작업 사본의 `node --check runtime/provider-security-semantics.mjs`, `node --check skills/software-security-auditor/scripts/core.mjs`, `git diff --check`: exit 0. 제품 시험·tsc·bundle/clean-room·실호스트: NOT_RUN. branch Actions 조회: 0개(`gh run list --branch codex/ags38-core-boundary --limit 4`).
- 최종 test file SHA256: `d97974835b00c359df4b3a795c12d88e782b024a65a9eb7e228c9dcaeccfce28`. RED 후보는 baseline + `d42ae935` + test mock 정정 `cef5e9c9`, GREEN 후보는 `cef5e9c9`다.

## D0007 후속 공유 구현 사례

후속 기준은 root 통합 `c4121acb`를 포함한 `aee5a669`다. 기존 acceptance 내용 ID·권한 digest 수정과 최신 카탈로그 정책을 보존한다. 구현은 runtime 한 곳, 기존 skill 실행파일은 재수출 facade다. 기존 JSON schema·카탈로그는 공개 선언 계약 데이터로 유지하며 runtime adapter만 그 경로를 해석한다. JSON·구현 복사본이나 registry를 추가하지 않는다.

| 사례 | 요구·공개 진입점 | 입력·전제 | 절차 | 기대·통과 기준 | 실제 결과 |
|---|---|---|---|---|---|
| CB-07 | D0007 provider·host execution·trust·inactive stores·board hook의 모듈 공개경계 | 모든 skill scripts import가 실패하는 배포 환경; JSON metadata는 존재 | esbuild의 module resolution에서 skill 실행파일만 거부하고 각 core 공개 진입점을 번들 | 모든 core bundle 성공; runtime이 skill 구현을 재수출해 숨기면 이 검사도 실패 | NOT_RUN |
| CB-08 | 기존 catalog skill export | 선언 exact ID/alias·미등록 ID·profile 전용키 | 기존 `resolveCatalogModel` 호출 | exact/alias만 승인, 이름 추측 거부, profile 전용키 기본 거부 | NOT_RUN |
| CB-09 | 기존 collaboration skill export | 1.2 결정·사용자 금지·독립감사 필요 | 기존 structural diagnostic 호출 | 사용자 금지와 독립감사 의무 유지, 잘못된 route 거부 | NOT_RUN |
| CB-10 | 기존 board skill export | 메모리 SQLite; 현재입력·summary·role | 기존 공개 함수로 기록 후 summary만 갱신·재조회 | role 보존, summary 최신값, 별도 db handle 종료 | NOT_RUN |

실행은 TEST/CI에서 `pnpm exec vitest run tests/mcp/ags38-core-boundary-shared.test.ts`. 기존 acceptance 내용ID/authority, 협업결정, 모델정책, board, unified-state 회귀도 TEST에서 실행한다. root 소유 index.ts/server.ts의 board import 2개는 정확 diff를 전달해 통합한다.

후속 구현의 정적 확인: 공용 acceptance·catalog·collaboration·board 본문 4개가 기준의 동일 구현과 일치함을 import 경로·소유 설명 변경만 정규화해 비교했다(exit 0). acceptance의 `sourceEvidenceById` 원근거 authority digest와 최신 catalog의 `profile_only_keys` 거부를 그대로 보존했다. `node --check` 11개 및 `git diff --check` exit 0. core의 skill 실행파일 import 검색 잔존은 root 소유 index.ts/server.ts의 board import 2개이며 정확 변경을 전달했다. 제품 시험은 TEST 담당 실행 대기(NOT_RUN). 후속 test file SHA256은 `585d710dbec46f1bee41a9b25cd78cba863809061207cbe7a276f4ced0e0a8f5`다.

## Catalog 단독 CLI 호환 수리

`ed951bb8`의 catalog runtime facade가 runtime 없이 skill 폴더만 복사하는 기존 CLI 계약을 깨뜨리는 것을 소스에서 확인했다. 승인된 호환안은 독립 CLI resolver를 원래 skill 위치에 보존하고, core의 `createCatalogExecutionAdapters`가 같은 선언 metadata를 admission용 native Map으로 한 번 컴파일하는 것이다. runtime의 catalog adapter는 JSON metadata만 공급한다. CLI의 profile 추천 함수와 core의 실관측 ID admission은 서로 다른 실제 책임이며 함수 구현 사본을 만들지 않는다.

| 사례 | 공개경계·입력·전제 | 절차 | 기대·판정 | 실제 결과 |
|---|---|---|---|---|
| CB-11 | skill 폴더만 복사; 공통 runtime·node_modules 없음 | 복사한 `scripts/model-routing.mjs`를 인자 없이 실행. 기존 coordinate 회귀의 resolve/record도 함께 실행 | 기존 bare usage key 출력, 실제 resolve/record 회귀 통과 | NOT_RUN |
| CB-12 | `createCatalogExecutionAdapters`; exact ID/alias·profile 전용키·없는 alias 대상·alias minimum override | 합성 선언metadata로 suite 구성하고 각 raw ID 조회; 이후 원본metadata 변경 | exact/alias만 admission, profile raw/없는 대상 거부, alias minimum 우선, 원본 변경이 컴파일된 suite를 바꾸지 않음 | NOT_RUN |

TEST 명령: `pnpm exec vitest run tests/mcp/ags38-core-boundary-shared.test.ts tests/coordinate-subagents/model-routing.test.mjs tests/mcp/model-policy-regression.test.ts tests/mcp/host-attestation.test.ts tests/mcp/model-capability-contract.test.ts`. 로컬 제품 시험은 실행하지 않는다.

최종 catalog 책임 경계: `runtime/model-catalog-adapter.mjs`는 기존 catalog JSON의 정적 export만 한다. `createCatalogExecutionAdapters`는 선언 ID·alias를 native Map으로 컴파일하고 alias별 effort override와 capability 배열을 snapshot으로 보존한다. 이후 admission은 그 Map 조회만 사용한다. skill의 `model-catalog-adapter.mjs/.d.mts`는 최신 통합기준 `aee5a669`의 원본과 diff 0으로 복원했다. 공유 resolver 구현의 사본은 남기지 않았다. 변경한 `.mjs` 2개 구문 검사와 `git diff --check` exit 0. standalone/core 동작 및 tsc는 TEST 실행 대기(NOT_RUN).

## CB02·CB03 fixture 원인 수리

- 기준: root `b3a697c30f1890d54d6d52e897b8b666547551f0`, branch `codex/ags38-host-observer-fixture`.
- 원격 증거: `/home/mcpops/ags-tests/ags38-01a14016-20261107/green1-core.log`, 조회 `04b005964f93f88cadfe6a803fcafe8acbe1c4b2d54cb307`의 CORE 구간에서 CB02·CB03은 `skills: []`, `discovery.status: UNAVAILABLE`로 실패했다. 같은 묶음의 acceptance 실패는 별도 담당 소유다.
- 소스에서 확인한 경로: fixture는 registry에 스킬을 등록하지 않고 classification metadata에도 capabilities를 주지 않았다. `inventory.ts`는 registry 밖 스킬의 capabilities/version을 필수로 확인하므로 `MISSING_CAPABILITY_OR_VERSION`으로 제외한다. observer는 inventory issue가 있을 때 null을 반환한다. 제품 observer의 실패 폐쇄 동작을 느슨하게 만들 사유가 아니다.
- 수리: fixture에 누락된 선언 capabilities를 복구하고, 모든 host 오류 사례 전에 실제 inventory loader로 fixture issue 0개를 확인한다. mock CLI가 실제 호출됐는지도 검사한다. 이전 음성 사례의 UNAVAILABLE만으로 CLI 오류 경계가 실행됐다고 판단하지 않는다.

| 사례 | 공개경계·입력·전제 | 절차 | 기대·판정 | 실제 결과 |
|---|---|---|---|---|
| CB02/03 재검증 | 정상 metadata와 합성 host CLI 설치 기록 | loader precondition 확인 후 gateway inventory·disablement 조회 | loader issues 0개, CLI 실제 호출, 기존 COMPLETE/disablement oracle 유지 | NOT_RUN |
| CB04 재검증 | 정상 metadata에서 CLI throw/잘못된 JSON/미지원 host만 변경 | gateway inventory 조회·CLI 호출 확인 | throw/JSON은 CLI 호출 후 UNAVAILABLE, 미지원 host는 CLI 호출 없이 UNAVAILABLE | NOT_RUN |
| CB13 | 정상 fixture에서 capabilities만 제거 | gateway inventory 조회 | skills 비어 있음, MISSING_CAPABILITY_OR_VERSION 및 HOST_DISCOVERY_UNAVAILABLE 보존 | NOT_RUN |

TEST 명령: `pnpm exec vitest run tests/mcp/ags38-core-boundary.test.ts`. 이 수정의 입력은 합성 CLI stdout이며 실제 Claude/Codex/agy 설치 관측 성공을 뜻하지 않는다. 실제 host 목록이 비었거나 임시 `--plugin-dir` 경로가 installed 목록에 없는 상태는 별도 제한으로 유지한다. 로컬 제품 시험은 실행하지 않는다.
