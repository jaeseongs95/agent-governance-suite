# Claude native T2·T4 절차 경계 수리

기준은 `7652c71037c07c4744b9d8f37f0a327d454d8c53`이다. 독립 검토보고서 `v380-claude-native-pilot-review.ko.md`를 먼저 읽고, 명시 허용된 TEST pilot의 `turn-2.jsonl`·`turn-4.jsonl` 중 해당 사건만 읽었다. 다른 턴·세션·인증·전역 설정은 열지 않았다.

- T2 원자료 SHA256 `c9447ce566dc831dda20b3441b37413ec7cdd4b280399a6c2d11ea43a581c4fe`: L74의 INVALID_INPUT exit2는 실제 assertion RED와 구분한다. L78의 RED exit1→GREEN exit0 뒤 L103에서 plan.json을 작성했고 L104의 READY/CONSISTENT는 사후 정합성만 보여 준다. 원 계획 선작성 실패는 유지한다.
- T4 원자료 SHA256 `5556fb469bfcf0f54fb2b7631df2bc001a37d29610669995db9f261fb8098f6a`: L11에서 외부 workflow 상태 쓰기까지 금지하는 entry-details를 읽은 뒤 L26~27 checkpoint_context가 revision3→4로 실제 상태를 썼다. 원 절차 FAIL은 유지한다.
- 소스 원인: 공통 intake와 checkpoint 도구 설명은 기록 호출을 조건 없이 요구하지만 blocker의 읽기 전용 계약은 이를 금지한다. test-engineering은 계획 작성 순서가 있으나 저장·사전 검사 시점이 불명확하고, 공통 CLI 목록은 run을 check-plan보다 먼저 제시하며 root-relative 파일 참조를 명확히 구별하지 않는다. 모델 내부 선택의 인과관계는 미확인이다.
- 연결: D31 실제 소비 진입점 확인, D32 단일 공통 intake와 기존 5,229자 cap, D36 사례 선작성, D38 도메인·호스트 독립, 기존 task의 읽기 전용/허용 실행 환경/권한을 유지한다. 새 감시·도구·registry·모델 호출은 추가하지 않는다.

| 사례 | 공개 경계·입력·전제 | 절차 | 기대 결과·판정 | 실제 |
| --- | --- | --- | --- | --- |
| NP01 | `skillIntakeText`와 MCP `serverInstructions`, ko/en; 읽기 전용 또는 상태 쓰기 금지 요청 | 실제 공통 intake 전달문과 blocker 계약을 대조 | checkpoint는 읽기 전용·상태 쓰기 금지가 아닐 때만 요구. 기존 허용 저장 조건과 원 금지는 유지 | d07 RED2 → 0626 GREEN2 |
| NP02 | MCP `tools/list`의 checkpoint_context, ko/en | 실제 서버의 공개 도구 설명을 조회 | 각 locale 설명도 읽기 전용·상태 쓰기 금지를 우선하며 다른 schema/도구 정책을 변경하지 않음 | d07 RED2 → 0626 GREEN2 |
| NP03 | native가 읽는 test-engineering SKILL 본문·공통 CLI 안내 | 계획 저장·check-plan이 테스트 구현·실행보다 먼저 명시되는지 확인 | 사후 READY/CONSISTENT가 선작성 근거가 되지 않음. `--root` 절대경로와 그 아래 상대 파일 참조를 구분 | d07 RED1 → 0626 GREEN1 |
| NP04 | 기존 source classification, content lock, frozen successor chain | 공식 pin 갱신 또는 append successor로 현재 바이트를 결속하고 원 역사 파일은 비교 | D32 cap≤5229, 과거 원본 hash 불변, 현재 source hash·선택 span의 의도한 변경만 추적 | 0626 추적2 PASS; 역사 잔존3 FAIL → 83 대상3 PASS, 아래 참조 |
| NP05 | 별도 TEST native T2/T4 재실행, root가 정한 동일 조건 | 실제 도구 순서와 상태 쓰기 유무를 관찰 | 계획이 RED/GREEN보다 앞서며 읽기 전용 진단에서 checkpoint 호출 0. 원 pilot FAIL은 덮지 않음 | NOT_RUN |

NP01~04는 전달문·계약 검사이며 실제 모델 행동 성공을 뜻하지 않는다. NP05는 root와 조율한 TEST에서만 실행한다. 로컬 제품 시험은 금지된다. 원자료 읽기 조회 `9a24c89a55a6b7bbcad9f8c055492bc3f66081f36d7c13d7` 및 좁은 사건 추출 `e9107acd2b39c73b3256a6dae8133c5697f79400e9b926a1`은 exit0/cleanupComplete:true로 끝났다.

Windows TEST RED: test-only `d07db8b658944dd5008a8f60349107ad88c53b4e`, Node `v24.22.2`, 기존 SRC와 동일 lockfile의 의존성을 격리 worktree에 junction으로 연결했다. `AGS_TEST_SCOPE`는 unset, 제품의 기본값은 `all`이다. 명령은 `node C:/ags-330-test/repo/node_modules/vitest/vitest.mjs run tests/mcp/ags38-native-procedure-boundaries.test.ts --maxWorkers=1`; 실제 native exit1, 8.92초였다. NP01 ko/en 2개, NP02 ko/en 2개, NP03 1개가 각각 해당 지시문 부재의 AssertionError로 실패했다. 수집 ID `4de2f2680df63587434400b901bf3e6bdd1c080130dacd42`, cleanupComplete:true. 실행기 오류가 아니며 이 5개 실패를 보존한다. 원 TEST 파일 SHA256은 `95f4333f375d8b8677e5448d40920850c0f8e2eba8fb926accaf9155cc59e12b`다.

후보 정적 대조(제품 시험 아님): 공통 intake는 조건절만 추가해 5,224자로 기존 5,229자 cap을 유지했다. 두 descriptor의 selected span 24개 중 `orchestrator:applicability[4]`만 조건절이 바뀌고 나머지는 동일하다. r32 manifest는 3,373 bytes, `sha256:4009ff57230ff7587bb4e4053b36f26328b7119708fe40dec301a0d6544e1d08`로, 원 r31의 exact 부모 hash와 현재 4개 원문을 결속한다. 60개 source binding과 content lock 49파일의 실제 bytes 불일치는 각각 0개이며, 기존 frozen manifest 변경도 0개다. locales ko/en에서는 checkpoint_context 설명 외 key 변경 0개다. 역사 context checker에는 기존 successor 배열의 새 exact 원본→현재 hash만 추가했다.

해당 TypeScript·역사 checker의 실제 ESLint, `node --check`, `git diff --check`는 exit0이다. GREEN은 root의 공식 i18n catalog·bundle 생성 후 같은 TEST 파일로 실행한다. source locale 수정만으로 아직 생성하지 않은 `tools/list` 출력을 GREEN으로 보지 않는다. 실제 native 행동 NP05는 NOT_RUN으로 유지한다.

Windows 통합 `0626bde1a4e3fedbd928312910b5e87c0082548a` 실행: 같은 원 TEST 파일 hash를 확인한 뒤 NP01~03 5/5가 GREEN이었다. r32 추적 2개, parent-accountability 1개, D31/D32 5개, D36~41 8개, retention 2개(기존 내부 13 oracle 포함)도 통과했다. 전체 7파일 48개는 **45 PASS·3 FAIL**, native exit1/87.84초/cleanupComplete:true다. 조회 `277c99146adf294b3750b41acc61601431cc90a0fa025537`를 보존한다. 실패 3개는 역사 source-binding의 옛 app[4]를 현재 inventory에서 찾는 두 소비자와 옛 test-engineering 전체 source digest를 현재 파일에 적용한 소비자다. 옛 바이트·hash 판정은 유지하고, 현재 inventory 대조만 승인된 r32 current span에 결속하며 quote-only 과거 판정은 당시 source로 읽도록 수정했다. 후속 후보는 아래 별도 실행에 결속한다.

CI `42266572948`의 양 OS 정적 검사에서도 test-engineering integrated checksum이 갱신되지 않은 실패가 있었다. `scripts/lib.mjs`의 기존 공식 `computeDirectoryChecksum`(상대 파일명과 정규화된 bytes 길이 framing)을 사용해 현재 `sha256:9bc323e3b34dec1131aa4e2c83861198562396cf6339517d30defe1590a0814d`를 계산했고 `skills/source-lock.json`의 해당 1개 값만 갱신했다. 이 source는 `internal`이라 upstream ref/checksum 필드가 없으며, 다른 모든 source 기록과 역사 anchor는 그대로다. `node scripts/check-source-lock.mjs`와 `node scripts/validate-repository.mjs`의 실제 정적 검사는 각각 exit0이었다. 패키지에 복사되는 source-lock 생성물은 root가 공식 생성한다.

Windows 부족분 재실행: 새 exact `83c38441c8eabc149595f900099dbe9a905198c3` 작업본에서 `node C:/ags-330-test/repo/node_modules/vitest/vitest.mjs run tests/skill-classification/source-binding-successor.test.ts --maxWorkers=1 -t 'chains the intake blocked-step rule|chains the intake verify-and-ask rules|replaces both historical quote-only'`를 실행했다. 조회 `00b6148d7d34c20244a18547d850647f50d3fb3b5abff801`, native exit0/8.24초/cleanupComplete:true, 대상 3개 PASS이며 필터 밖 22개는 미선택이다. 0626의 전체 45 PASS·3 FAIL을 이 결과로 덮거나 83의 전체 48개 통과로 환산하지 않는다. 원 NP01~03의 5개 GREEN은 동일 TEST bytes의 0626 관측이고, 실제 모델 행동 NP05는 계속 NOT_RUN이다. Windows 추가 실행은 하지 않으며 evidence 담당자에게 종료를 공유했다.
