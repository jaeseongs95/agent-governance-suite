# V01-b — AGS 제공 surface와 VibeMarshal 소비 계약 대조

## 고정 입력과 판정

- 소비자: VibeMarshal `D:\codex\flowmarshal` ref `ffe3dfa7afc8037adb7199527b6befb56f5d9744`. [V01-a 소비 계약](vm-consumer-contract.ko.md)의 loader·CLI·MCP·script 요구를 그대로 사용한다. 소비자 근거는 해당 문서의 `G/C/CLI/TG/TC` 경로와 SHA-256이다.
- 제공자: AGS `D:\codex\거버전스 3.0\agent-governance-suite` ref `4b1a94ab6b28f6af02c21aadd9408bee43c6a3f0` (`codex/v260-semantic-decision-layer`). 아래 파일은 `git show <AGS ref>:<path>`의 bytes와 깨끗한 checkout bytes가 같았다.
- 소비 fixture: `docs/implementation-3x/fixtures/vm-consumer-contract.json`, SHA-256 `6feb70e34d16a6fd48e31f26545061427fcc8aba26724debe41cdd49c31c2230`. `consumerRef`는 위 VM SHA다. fixture의 `dist/`·`moved/`는 VM 테스트의 **fake 플러그인 경로**이며 AGS 배포 경로가 아니다.

이 비교는 소스와 패키지 파일의 현재 상태를 고정한다. **실행 호환 PASS가 아니다.** 지금의 AGS에는 VM용 manifest와 서명 CLI가 없고 `flowmarshal-engine` host attestation provider가 지원되지 않는다. V01-a의 기대값은 이 차이에 맞춰 수정하지 않았다.

## 제공자 근거 파일

| ID | AGS ref의 정확한 파일 | SHA-256 |
|---|---|---|
| M | `.mcp.json` | `47773149e144e64ec56e4d16ed8c5afd188c3d951b44da997e475b9bcc405862` |
| I | `mcp-server/src/index.ts` | `fe1cd9781a0bcd2484f8fbeae106a6fc4b27bf7d0fa0e7d2172a12aa15ed7141` |
| S | `mcp-server/src/server.ts` | `9647cea48a8af5bb70f4559d1079a9a10c3ae3e5a14a547707d48a0ff953d9e9` |
| R | `mcp-server/src/runtime-config.ts` | `4d0a08a848d718d87d4e82536a77632544548c1e0513303ae78728bf34dedb46` |
| A | `mcp-server/src/host-attestation.ts` | `34255700dd13eee27c068143b02b668393bec552f9b2098670ba5a5c4881c49d` |
| H | `mcp-server/src/host-attestation-hook.ts` | `b2ac2d87b811f67a4e635582a8924521bc79d34d6ebf10dab81fde2c2236caac` |
| W | `mcp-server/src/workflow-service.ts` | `d9640f86b6c5c65cbd1cc61486031c93a748185eeaa76e2b5d1d01cbc8842629` |
| P | `mcp-server/src/response-projections.ts` | `984b22e1edaa66abbf0c892d71dbeba3f9635b733ad8cd63679276325e2b68e4` |
| B | `mcp-server/dist/server.mjs` | `68a1f0551764502ae7425d7b8b775553b43204846268a7753a812a694456569f` |
| CB | `skills/change-scope-guardian/scripts/capture-workspace-baseline.mjs` | `c7f6b887fa94697434568ed987b66d81525841949bf64ebfdadcc6f5dcecfe69` |
| CC | `skills/change-scope-guardian/scripts/compare-change-scope.mjs` | `017e03abb617f5fa9d582e1b812b78f1dfa570e411970ae9aa6afb4a67b9e1ba` |
| CL | `skills/change-scope-guardian/scripts/lib.mjs` | `0fa25746036db845760c61a41a53dcbb012c40ec310640a1ef5a3a993c500562` |
| AC | `skills/acceptance-evidence-validator/scripts/cli.mjs` | `296b2a8d0eb3690f69538e2cc1693e0129af3b2a95d6c9792d88ae2821fa6e9c` |
| AI | `skills/acceptance-evidence-validator/scripts/io.mjs` | `f04aacb1603b18aa3b431cbcc96eb7f815ee7af9ece586d3e7c1221149f78dc0` |
| AL | `skills/acceptance-evidence-validator/scripts/core.mjs` | `0a340ef81cafbc1d08edfdd042480d14ede06fbce407417be6d4def4ca7a4216` |
| K | `skills/registry.json` | `891aca9dc176ff96e2c59db2fe16e86ad8933635e6fd4017955bf32df851c016` |

`M`은 Codex용 MCP 서버를 `node mcp-server/dist/server.mjs`로 시작한다. `B`는 커밋된 번들이며 `pnpm bundle:check`가 이 ref에서 통과했다. 다음 표의 **제공**은 이 ref의 소스·파일 존재를 뜻하고, VM의 실제 설치물 실행을 뜻하지 않는다.

## 소비 요구별 대조

| V01-a 소비 요구 | AGS ref의 실제 제공 파일·entrypoint | 판정과 연결 경계 |
|---|---|---|
| 플러그인 루트 `host-integration.json`: `format=agent-governance-suite.host-integration.v1`, 다섯 `entryPoints[].{id,path,executionClosure}` | 루트 `host-integration.json` **없음**. `M`은 Codex용 MCP 설정이며 VM manifest가 아니다. | **미구현**. V02에서 descriptor/manifest 계약을 만들고 V06에서 실제 package path·closure hash를 발행해야 한다. VM fake `PATHS`를 복사하지 않는다. |
| `mcp-server` | `M`이 `mcp-server/dist/server.mjs`를 시작하고 `B`가 존재한다. `S`의 MCP 서버가 초기화·도구 목록을 제공한다. | **제공, manifest 미연결**. VM manifest의 `mcp-server` entrypoint와 closure는 아직 없다. V02/V06이 실제 상대 경로와 실행 파일 집합을 결속해야 한다. |
| `plan_workflow`, `open_convergence_root`, `claim_workflow_attempt`, `start_guarded_workflow`, `record_stage_result`, `finalize_workflow`, `abort_workflow` | `S`의 `tools/list` 등록과 `tools/call` 분기 모두 일곱 이름을 가진다. `S.toolResult`는 첫 text content에 `ok/data/error` JSON을 넣는다. `W`가 도구 동작을 제공하고 `P`의 compact projection은 root ID·revision, run ID·revision·state를 유지한다. `K`에는 VM 네 required capability가 있다. | **이름·최소 응답 필드 구조는 제공**, 행동 적합성은 미확인. `plan_workflow`의 추가 stage metadata(`kind`, `minimumReasoningEffort` 등)는 VM이 요구한 필드보다 넓다. 일곱 도구의 실제 순차 conformance는 V10에서 검사한다. |
| `scope-baseline`: `node <path> <request file>`, `manifestSha256:str`, `entries:list` | `CB`가 위치 인자 JSON을 읽어 `CL.captureBaseline`을 호출한다. `CL`은 commit 비교 및 두 필드를 반환한다. | **스크립트·핵심 필드 제공**, VM entry ID/closure 미발행. V02/V06에서 `scope-baseline`으로 연결한다. |
| `scope-compare`: 같은 위치 인자, `verdict/summary/findings/currentDigest` 및 비 PASS 거부 | `CC`가 `CL.compareScope`를 호출한다. `CL`은 네 필드와 `PASS`, `BLOCKED`, `NEEDS_APPROVAL`, `INCONCLUSIVE` 판정을 낸다. | **스크립트·핵심 필드 제공**, VM entry ID/closure 미발행. V02/V06에서 `scope-compare`로 연결한다. |
| `acceptance-cli`: `--input <request file>`, JSON stdout의 `verdict`, refuting evidence는 비 PASS | `AC`는 `AI.readJsonArgument(..., "--input")`을 사용하고 `AL.analyzeAcceptance`의 `PASS/FAIL/BLOCKED/NEEDS_INPUT` JSON을 쓴다. | **스크립트·핵심 필드 제공**, VM entry ID/closure 미발행. V02/V06에서 `acceptance-cli`로 연결한다. |
| `host-attestation-cli`: stdin의 `host=flowmarshal-engine`, `tool/input/model/modelClass/reasoningEffort/actorId`를 받아 stdout JSON `token`; VM이 `_hostAttestation`으로 전달 | `mcp-server/dist/host-attestation-cli.mjs`와 동등한 호스트 중립 stdin CLI가 **없음**. `H` 및 `mcp-server/dist/host-attestation-hook.mjs`는 Claude Code PreToolUse hook이며 VM CLI protocol이 아니다. `A`의 signer/verifier도 `host:"claude-code"`와 Claude 모델군에 묶여 있다. | **미구현·호환 불일치**. H/A의 호출 결속·서명 검증 아이디어는 재사용 후보지만 VM의 관측을 Claude 관측으로 위장할 수 없다. V03이 VM host observation의 신뢰 입력을 고정하고 V04-a/b가 host 중립 signer·bounded stdin CLI를 제공해야 한다. |
| VM host의 서버 측 trusted observation | `R.resolveHostAttestation`은 값이 정확히 `claude-code`일 때만 provider를 반환한다. `I`는 그 경우에만 `HostAttestationProvider`를 만들며, `S`는 provider가 있을 때만 `_hostAttestation`을 벗겨 검증한다. `W`는 유효한 무서명 요청에 신뢰 관측이 없으면 `BINDING_REQUIRED`로 거부한다. | **`flowmarshal-engine` 미지원**. VM이 환경 변수 `AGENT_GOVERNANCE_HOST_ATTESTATION=flowmarshal-engine`을 주더라도 현 ref의 provider는 null이다. VM token을 동봉한 요청의 정확한 오류 코드는 여기서 단정하지 않는다. signer CLI만 추가해도 해결되지 않으며 V03/V04에서 server verifier·host adapter까지 연결해야 한다. |
| VM의 `flowmarshal-governance-model-classes-v1` 대응표 | 이는 VM `GovernancePlugin.load_model_classes`가 읽는 호출자 제공 파일이다. AGS ref에는 VM 전용 대응표 생성기·model class 발급자가 없다. | **VM 소유 입력**. 클래스 표를 AGS의 실제 host 관측으로 취급하면 안 된다. V03은 신뢰된 모델 관측과 대응표 주장을 분리해야 한다. |
| 제품 gate와 16개 consumer conformance 검사 | VM `governance_gate.py`·`governance_conformance.py`가 소비자 흐름과 검사를 소유한다. AGS ref에는 VM용 `host-integration.json` 및 signer CLI가 없으므로 현재 설치형 consumer conformance 실행 근거가 없다. | **NOT_RUN / 실행 호환 미판정**. AGS 측 V10, VM 측 V11/V12에서 실제 artifact·host 조건을 갖춰 검사한다. |

## 재사용과 다음 연결점

재사용 가능한 AGS 구현은 `S/W/P/B`의 MCP 도구·envelope·compact 응답, `CB/CC/CL`의 change scope 스크립트, `AC/AI/AL`의 acceptance CLI다. `A/H`는 **Claude Code 전용 구현**이므로 VM용 새 host 관측 producer·signer·verifier 경계가 필요하다. 필요한 연결 작업은 V02 manifest → V03 관측 challenge → V04-a/b signer/CLI → V06 package surface → V10 AGS conformance 순서로 분리된다. VM의 실제 Governance Port와 engine 연결은 VM 작업 V07~V09의 범위다.

이번 동결에서는 제품 코드·V01-a 계약·fixture를 바꾸지 않았고, VM 실사용 token이나 workflow를 실행하지 않았다. `tests/coordinate-subagents/v3x/V01-b.test.mjs`는 이 AGS ref에 존재하지 않아 실행 완료로 기록하지 않는다. 기존 AGS의 host attestation, scope, acceptance 집중 테스트만 실행했다. 그 결과는 각 구현의 로컬 동작 근거이며 VM과의 실행 호환 PASS를 뜻하지 않는다.
