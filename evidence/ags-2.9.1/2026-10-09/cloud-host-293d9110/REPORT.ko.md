로컬 후보 구현을 완료했습니다. `codex/cloud-host-discovery-fix`의 commit은 `293d9110affb7048c703cf4ac6e14dcfe0a9ea3b`, tree는 `63dd3ae9e5910ffa2fa3c3ee456c2d7a7b646ce7`입니다. 부모 commit/tree는 지정된 `c6a8019be30e4bf5ee9a36147ca45ae28b0f75b6` / `28f2f2ed8a864405320f6d20e7bc5004e8466ad3`입니다. 환경 연결 확인 후 같은 환경에서 작업을 이어갔으며, 별도 Cloud 환경이나 중복 구현 작업을 시작하지 않았습니다.

대상 테스트 106 PASS / 0 FAIL입니다. 동일 테스트·argv·의존성의 격리 red/green 증거에서는 원본 gateway의 의미 있는 assertion 실패 11건과 후보의 11 PASS를 확인했습니다. `check-proof` 결과는 CONSISTENT이며 이는 로컬 증거 일관성 검사입니다. 실제 호스트의 AGENT 선택·SKILL 읽기·적용이나 독립 감사 통과를 뜻하지 않습니다. 유료 API 0, Claude 호출 0, 호스트 모델 turn 0입니다. 전체 1257-test suite는 재실행하지 않았습니다.

변경은 허용된 5개 파일뿐입니다. 원본 핀 checkout의 tracked 1567개 파일은 모두 기존 SHA를 유지했고 후보의 보호 경로 변경도 0개입니다. 최종 change-scope-guardian은 PASS입니다. `inventory.ts`, `service.ts`, `runtime.ts`, 메타데이터, R14/R13 harness, dist, Claude 생성물은 바꾸지 않았습니다. push·PR·main·릴리스 작업도 없습니다.

- `gateway.ts`: 승인된 config의 `hostDiscoveryRef` 또는 서버 소유 `observeHostSkills` 관측을 읽습니다. caller classify JSON으로 관측을 주입할 수 없습니다. 호스트 관측 digest를 operation에 묶어 관측 변경 시 재사용/수용을 거부하고, accept의 모든 await 뒤 최종 작업 상태를 동기 재관측한 다음 선택을 저장합니다.
- `host-discovery-adapter.ts`: installed/hostSupported는 기존 InventoryOptions로 전달합니다. enabled는 기존 registry 정책과 호스트 관측의 교집합이며 disabled 후보 자체는 유지합니다. 외부 설치 root도 관측값에서 동적으로 읽습니다. 없거나 무효/만료된 관측은 UNAVAILABLE/local-tree, 설치 목록에 있지만 메타데이터가 없는 스킬은 INCOMPLETE/host로 보고합니다. 알려진 효과적 인벤토리가 같으면 기존 qualification digest를 유지하고, 관측 시간/개정은 별도 operation digest로 묶습니다. 고정 후보 이름 목록이나 이름 매핑을 추가하지 않았습니다.
- 기존 gateway 테스트는 실제 인벤토리에서 구성한 합성 서버 소유 관측으로 fixture를 보강했습니다. 기존 assertion과 기준 조건을 유지했습니다. 신규 gateway/adapter 테스트는 아래 경계와 실제 gateway/service/files를 검사하며 공급자 및 호스트 관측만 모의로 대체합니다.

검사 입력·기대·관측은 다음과 같습니다. 세부 입력/코드는 해당 테스트와 `evidence/temp-stdio-probe.json`에, source SHA는 `evidence/source-integrity.json`에 있습니다.

| 검사 | 입력 | 기대 | 관측/증거 |
|---|---|---|---|
| HD1 | code-review 설치/지원 true, 호스트 enabled false | 후보 유지, enabled false, SELECTED 거부, PARTIAL needed/runnable 분리 | PASS; `final-host-regression.json`, `engineering-{red,green}-receipt.json` |
| HD2 ×2 | code-review installed 또는 hostSupported false | 해당 필드 false, PARTIAL 선택은 가능하되 runnable 제외 및 정확한 차단 사유 | PASS; NOT_INSTALLED / HOST_UNSUPPORTED |
| HD3 | 호스트 발견 없음 | UNAVAILABLE/local-tree, HOST_DISCOVERY_UNAVAILABLE, NEEDS_INPUT, 공급자 호출 없음 | PASS; 원본은 discovery 필드 부재 |
| HD4 | 설치 관측에 external-system-skill 추가, root/메타데이터 없음 | INCOMPLETE/host, INSTALLED_SKILL_UNEXPOSED, 가짜 taxonomy 생성 없음 | PASS; 공급자 호출 없음 |
| HD5 | 분류 후 host revision 변경 | 이전 선택 수용 거부 및 STALE_CLASSIFICATION_OPERATION | PASS; 원본은 valid true로 수용하여 red 실패 |
| HD6 | 승인된 config → 상대 hostDiscoveryRef → 파일 | 실제 파일 읽기, disabled 반영, 파일 원문 변경 없음 | PASS |
| AC runtime ×5 | readRuntime await 동안 취소/제거/revision/digest/sourceRef 변경 | HOST_TASK_CHANGED_OR_NOT_OBSERVED, 선택 저장 없음 | 5 PASS; 원본은 valid true로 저장하여 5 red 실패 |
| AC discovery ×5 | 호스트 읽기 await 동안 동일 5개 변경 | 동일 최종 fence | 5 PASS; 원본에는 해당 await 경로가 없어 red 범위에서 제외 |
| AC 정상 | 동일 작업 및 반복 선택 | 성공과 멱등성, 읽기/적용/검증 주장 없음 | PASS; NOT_OBSERVED / NOT_RUN 유지 |
| Adapter 13건 | 중립 외부 ID/root, registry disabled, 빈 설치 목록, 시간/개정 갱신, 순서 교환, duplicate/expired/future/relative-root/extra-field, await 후 시계, 비밀 포함 예외, malformed/oversized/missing 파일 | 동적 발견·sourceRefs 유지, registry 상한, 올바른 불가용 상태, 내용 불변시 qualification 유지, 무효 입력 원문/예외 비밀 비노출 | 13 PASS; `adapter-regression.json`, `final-host-regression.json` |
| 기존 MCP gateway 38건 | 실제 MCP Client/Server in-memory transport + 모의 공급자 | actor/동시 요청/RAW/의무 스킬/REMOTE 승인/receipt 경계 유지 | 38 PASS; `final-host-regression.json` |
| 인접 inventory/request/validation 37건 | 기존 파일을 수정 없이 실행 | 후보 전체성·RAW 보존·선택 검증 회귀 없음 | 37 PASS; `adjacent-regression.json` |
| 임시 compiled MCP stdio | 발견 없음 / 승인된 host 파일 / 외부 메타데이터 누락 각각 6개 요청 | 로컬 목록을 full-host로 오인하지 않음, 선택 권한 AGENT 유지 | 세 조건 PASS; `temp-stdio-probe.json` |

stdio의 6개 입력은 named `$test-engineering`, unnamed 회귀 검출력 점검, 복합 구현+CS+테스트, 읽기 전용 diff 리뷰, 모호한 “이거 처리해 줘”, 오타 `$test-enginering`입니다. 발견 없음과 메타데이터 누락에서는 NEEDS_INPUT입니다. 승인된 완전한 합성 host 파일 조건은 provider profile을 의도적으로 비워 UNAVAILABLE / attempts 0이며 RAW originalPrompt 동일성을 확인했습니다. 여섯 입력 모두 agentSelectedSkillIds=null입니다. 실제 AGENT가 해당 프롬프트를 처리해 최종 스킬을 선택했다는 주장은 하지 않습니다. 합성 응답이 있는 gateway 회귀에서도 selection은 테스트가 만든 별도 결정입니다.

기존 실패와 이번 후보에서 확인한 경계를 구분합니다.

1. 기존 read-only 조사에서 보고한 host enabled 미연결 및 full-host discovery 공백: 이번 후보는 관측 공급 경계와 불완전성 보고를 추가하고 negative 재현에서 교정됨을 확인했습니다. disabled 후보가 남는 것 자체는 오류가 아닙니다. 메타데이터 없는 외부 스킬을 문제로 보고하는 것이 정당하며 unmapped=[]을 강제하지 않습니다.
2. 기존 R13 gateway의 await 중 작업 변경 수용: 고정 입력으로 5가지 변경을 재현했고 후보의 최종 동기 fence에서 모두 차단했습니다.
3. 기존 번들 비교 실패: 제품 변경 전에 `node scripts/check-bundle.mjs`가 `mcp-server/dist/server.mjs is stale`로 실패했습니다. `base-bundle-check.stderr`에 원문이 있습니다. 공유 dist는 소유권 밖이라 수정하지 않았습니다. 변경 소스의 임시 bundle 컴파일 및 node_modules 없는 temp-install stdio는 PASS입니다.
4. 초기 red 시도 중 테스트 fixture가 decision에 허용되지 않은 cancelled 필드를 넣어 ZodError/timeout을 만들었습니다. 이를 수정하고 동일한 최종 테스트로 유효한 red/green을 다시 실행했습니다. 그 초기 실패는 제품 결함이나 red 성공에 포함하지 않습니다. JSON reporter가 stdout 대신 자동 파일로 쓰던 초기 formal receipt도 assertion witness 부족으로 제외하고 verbose reporter의 최종 receipt만 채택했습니다.
5. 실제 호스트 이름 prefix→canonical ID 연결, gpt-6.1 reasoning profile 등은 이번 소유권/구현 범위에서 제외했습니다.

최종 실행 근거:

- `evidence/final-host-regression.json`: 69 PASS = 기존 gateway 38 + 신규 gateway 18 + adapter 13.
- `evidence/adjacent-regression.json`: 37 PASS. 합계 106개 distinct test.
- `evidence/engineering-red-receipt.json`, `engineering-green-receipt.json`: frozen scope/argv/환경/테스트 SHA, 원시 stdout/stderr, 종료 코드, 시각. red 11 FAIL / 7 filtered, green 11 PASS / 7 filtered. 원본 gateway만 다른 격리 copy에 후보 adapter/test 동일 bytes를 두었으며 원본 gateway는 adapter를 import하지 않습니다.
- `evidence/final-proof-check.json`, `engineering-test-result.json`: CONSISTENT, issues []. 재검증 명령: `node skills/test-engineering/scripts/run.mjs check-proof --root /workspace/ags291-host-discovery-fix/evidence/proof-root --plan plan.json --proof proof.json`.
- `evidence/final-typecheck.{stdout,stderr}`, `final-lint.{stdout,stderr}`: tsc --noEmit 및 허용 5개 파일 ESLint 각각 exit 0. `git diff --check`도 통과했습니다.
- `evidence/final-scope-report.json`: PASS / in-scope 5 / excluded·unplanned·overlap 0. 자동 생성 .vitest report는 증거 위치로 옮겨 후보 트리에서 제거했습니다.
- `evidence/source-integrity.json`: 변경 파일 SHA와 원본/보호 경로 보존. 최종 git status clean.
- 전달물: `host-discovery-fix.patch` (git am용), `host-discovery-fix.diff` (binary diff), 이 보고서, 증거 archive.

남은 통합/미실행 범위는 명확합니다. 호스트가 canonical ID/installed/supported/enabled/root 및 freshness를 담은 승인된 snapshot을 실제로 생성·갱신하는 producer는 구현하지 않았습니다. 기존 readClassificationRuntime 경계에서 승인된 파일을 소비할 수 있게 만들었고, 미공급시 fail closed합니다. 실제 Codex 설치 플러그인→AGENT 선택→SKILL read→적용 연결, 실제 공급자 품질 qualification은 NOT_RUN입니다. readStatus/appliedStatus 공백을 가짜 영수증으로 채우지 않았습니다. 최종 통합 담당자가 공유 bundle을 갱신해야 설치 캐시에 이번 수정이 반영됩니다. 이 후보는 소스 commit이며 릴리스 완료를 주장하지 않습니다.
