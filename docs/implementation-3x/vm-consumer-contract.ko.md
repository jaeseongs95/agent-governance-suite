# V01-a — VibeMarshal 소비 계약 동결

## 출처와 판정 범위

VibeMarshal(`D:\codex\flowmarshal`)의 깨끗한 `main`을 `ffe3dfa7afc8037adb7199527b6befb56f5d9744`로 고정하고 아래 파일의 **Git blob bytes와 checkout bytes가 같음**을 확인했다. SHA-256은 원본 파일 bytes 기준이다. 이 문서는 해당 ref의 소비자 요구이며, AGS가 현재 제공한다거나 실제 플러그인 적합성이 통과했다는 판정이 아니다. 동결된 최소 예시는 [fixture](fixtures/vm-consumer-contract.json)에 있다.

| ID | 실제 경로 | SHA-256 |
|---|---|---|
| G | `src/flowmarshal/engine/governance_gate.py` | `cc5fca4ebb467865018e1064c736df55c10f10730cbc58d143aaa368a794d0bf` |
| C | `src/flowmarshal/engine/governance_conformance.py` | `b36befa37df8e27b2eb3e37c0d752aa9379773a43ea4dea7e23821fedfea8428` |
| CLI | `src/flowmarshal/engine/cli.py` | `117e7a4aa9774ca942cb8a6ae83a8a390fddc691a90ac6978729f2a0fdfb9cbc` |
| TG | `tests/test_engine_governance_gate.py` | `7533334f819b23639d67b9a29fe0eec962deceb5d37016b80d367679cd565370` |
| TC | `tests/test_engine_governance_conformance.py` | `26041ef2c0492aecbe719e8a8982d5ed6168dad6ed347b9db9ebe4d117e846f2` |

각 표의 출처 ID는 이 ref, 실제 경로, source hash를 함께 가리킨다. `TG`/`TC`의 fake 플러그인 값은 소비자 검증용 예시이며 AGS 배포 경로의 증거가 아니다.

## Loader·manifest·서명 CLI

| 요구 | 소비 위치와 출처 |
|---|---|
| 플러그인 루트의 `host-integration.json`을 JSON으로 읽고 `format`을 `agent-governance-suite.host-integration.v1`과 대조한다. `entryPoints`는 배열이다. | G `GovernancePlugin.preflight`, TG `PluginSurfaceTests` |
| `mcp-server`, `host-attestation-cli`, `scope-baseline`, `scope-compare`, `acceptance-cli` 각각에 문자열 `id`, 문자열 `path`, 문자열 배열 `executionClosure`가 필요하다. 진입점과 closure의 모든 파일은 실제로 플러그인 루트 안에 있어야 한다. `path`는 manifest에서 조회하며 고정된 AGS 내부 경로를 요구하지 않는다. | G `CONSUMED_SURFACE`, `GovernancePlugin.preflight`; TG `PATHS`, `test_preflight_names_the_failed_check` |
| Node 22.13 이상에서 `node <mcp-server path>`로 MCP stdio 서버를 시작한다(해당 ref의 gate 검사값). AGS는 Node 24 이상만 지원하므로 AGS와 함께 쓸 때의 실효 하한은 Node 24다. `initialize` → `notifications/initialized` → `tools/list`를 수행하며 일곱 도구 이름이 모두 있어야 한다. 서버의 `serverInfo`와 manifest의 `plugin`은 자기 보고 label이다. | G `McpStdioClient`, `GovernancePlugin._node/_client/preflight` |
| 모델 대응표는 환경 변수 `FLOWMARSHAL_GOVERNANCE_MODEL_CLASSES`가 가리키는 JSON 파일이다. `format=flowmarshal-governance-model-classes-v1`, 비어 있지 않은 `classes` 객체, 공백이 아닌 모델 이름, 값 `lightweight/general/deep/frontier`가 필요하다. 중복 key·추가 최상위 key를 거부한다. 플러그인 루트는 `FLOWMARSHAL_GOVERNANCE_PLUGIN_ROOT` 또는 `check-plugin --plugin-root`로 전달한다. | G `load_model_classes`, `GovernanceSettings`; CLI `_cmd_governance_check_plugin`; TG `test_model_class_table_is_rejected_before_typed_use` |
| 서명 CLI는 `node <host-attestation-cli path>`를 인자 없이 실행하고 UTF-8 JSON을 stdin으로 받는다. 입력 필드는 `host=flowmarshal-engine`, `tool`, `input`, `model`, `modelClass`, `reasoningEffort`, `actorId`이다. exit 0과 JSON stdout의 문자열 `token`을 요구하며 해당 token을 MCP 인자 `_hostAttestation`에 추가한다. token의 내부 bytes/서명 알고리즘은 이 소비자가 해석하지 않는다. | G `GovernancePlugin.call`; TG `test_signing_submits_the_host_and_the_class_from_the_injected_table`, `test_refused_or_malformed_signing_and_failed_scripts_are_effect_free_mismatches` |
| `scope-baseline`과 `scope-compare`는 `node <entry path> <request-json-file>`로, `acceptance-cli`는 `node <entry path> --input <request-json-file>`로 호출한다. exit 0의 JSON stdout을 검사한다. | G `GovernancePlugin.script`, `GovernanceTaskGate._script`; TG `test_entry_points_come_from_the_manifest_and_identity_is_derived_from_the_closure` |

`preflight`는 manifest·closure 파일 bytes SHA-256, closure tree, 진입점 표, Node, 소비 표면, 모델 대응표 digest를 `local_derived` identity로 만든다(G `GovernancePlugin.preflight`). manifest의 `plugin.version`은 판정용 버전 고정값이 아니다(TG `test_entry_points_come_from_the_manifest_and_identity_is_derived_from_the_closure`). 실제 제품 AGS 번들의 다섯 `path`와 각 `executionClosure`는 이 ref에서 **미확인**이다. `TG.PATHS`의 `dist/`·`moved/` 경로는 fake 플러그인 fixture일 뿐이다.

## MCP 도구·응답과 engine 호출 순서

모든 도구는 JSON-RPC `tools/call` 결과의 첫 `content[0].text`를 JSON으로 해석한 `ok:true` envelope의 `data`를 소비한다. `ok:false`는 계약 불일치다(G `mcp_envelope`, `mcp_data`, `GovernanceTaskGate._mcp`). 다음 최소 필드와 타입은 G `CONSUMED_SURFACE`, `_fields`가 선언·강제하며 `bool`은 `int`로 받아들이지 않는다.

| 도구 | `data` 최소 필드 | 호출·거부 근거 |
|---|---|---|
| `plan_workflow` | `executionMode:str`, `stages:list`; 각 stage의 `requiredCapability:str`, `stageId:str` | G `plan_stages`, C `_Probe.run`: 서명 없는 호출은 `ok:false / BINDING_REQUIRED`, 서명된 호출은 `orchestrated`와 정확히 네 capability(`change-scope-baseline-capture`, `minimal-implementation`, `change-scope-assurance`, `acceptance-evidence-validation`)를 요구한다. 선택적 `executionRequirement`가 있으면 object의 `minimumModelClass`는 null 또는 네 model class 중 하나다. |
| `open_convergence_root` | `rootId:str`, `revision:int` | G `_open`, C `_Probe.run` |
| `claim_workflow_attempt` | `leaseId:str`, `rootRevision:int` | G `_open`, C `_Probe.run` |
| `start_guarded_workflow` | `runId:str`, `revision:int` | G `_open`, C `_Probe.run` |
| `record_stage_result` | `revision:int` | G `stage_record_arguments`, `_record`, C `_Probe.run`: baseline → implementation → scope → acceptance 순서로 기록한다. 네 stage 모두 서명 관측을 전달한다. |
| `finalize_workflow` | `state:str` | G `_finish`, C `_Probe.run`: 모든 stage 뒤 `passed`여야 한다. |
| `abort_workflow` | 별도 필수 필드 선언 없음 | G `CONSUMED_SURFACE`, C `_Probe.run`: conformance는 `state=aborted`를 확인한다. |

제품 dispatch에서는 provider·preflight·적합성 확인 뒤 `plan_workflow` → root → claim → start → baseline capture와 stage 기록으로 진행한다. 완료 단계는 snapshot C1, Worker 관측, scope verify, acceptance, finalize 순서다(G `GovernanceTaskGate._open/_finish`). `record_stage_result`의 요청에는 `schemaVersion`, `runId`, `stageId`, `expectedRevision`, `state`, `output`, `evidence`, `findings`, `blockers`, `responseMode`, `error`, `outputFile`이 들어간다(G `stage_record_arguments`). 이는 AGS 제공 구현의 성공 증거가 아니다.

## 스크립트 출력과 최소 정상·거부 예시

G `CONSUMED_SURFACE`, `GovernanceTaskGate._open/_finish`, C `_Probe.run` 기준이다. baseline 요청은 `schemaVersion`, `repositoryRoot`, `mode=capture`, `comparisonTarget=commit`, `commit`, `taskEnvelope`를 보낸다. 반환에는 `manifestSha256:str`, `entries:list`가 필요하다. compare 요청은 `mode=verify`, C1 commit, 기존 `baseline`, `baselineArtifactDigest`를 보낸다. 반환에는 `verdict:str`, `summary:dict`, `findings:list`, `currentDigest:str`가 필요하며 verdict는 `PASS/NEEDS_APPROVAL/BLOCKED/INCONCLUSIVE` 중 하나다. acceptance 요청은 `taskEnvelope`, commit `target`, `evidence`, `verificationCommands`, `knownLimitations`, `criterionOverrides`를 보낸다. 반환의 `verdict:str`는 `PASS/NEEDS_INPUT/FAIL/BLOCKED` 중 하나다.

fixture의 `manifest.valid`는 TG의 fake 경로와 closure 파일을 그대로 사용한 **loader 구조 정상 예시**다. `manifest.reject`는 format 불일치·진입점 누락·closure 탈출에 대한 소비자 거부다. `attestation`, `mcp`, `scripts` 예시는 G/C/TG/TC에서 실제 확인한 필드와 판정만 담는다. 동적 commit·digest·token 값은 fixture가 지정하지 않으며 고정 문자열을 실제 값처럼 제공하지 않는다. conformance의 거부 두 가지는 서명 없는 `plan_workflow → BINDING_REQUIRED`, 범위 밖 파일 또는 refuting evidence → 비 PASS다(C `_Probe.run`, TC `ConformanceFake`). 실제 AGS 설치물에 fixture를 실행한 적합성 PASS는 **미관측**이다.

## 적합성 검사와 남은 확인

C `CHECKS`는 `attestation_required`, `plan`, `root`, `claim`, `start`, `abort`, `baseline`, `record_baseline`, `scope_out_of_scope`, `scope_in_scope`, `record_implementation`, `record_scope`, `acceptance_refuted`, `acceptance`, `record_acceptance`, `finalize`의 16개다. 임시 Git repo와 임시 plugin state에서 실행한다. 반환은 `flowmarshal-governance-conformance-v1`, `provenance=local_derived`, `verdict=PASS/FAIL`, 검사별 결과이며 실제 모델·usage·Task validation 증거가 아니다(C `run_conformance`, `_observe`). 채택 명령은 `flowmarshal-engine governance check-plugin`이고 비 PASS면 0 아닌 exit code다(CLI `_cmd_governance_check_plugin`). 제품 gate는 프로젝트에서 처음 보는 closure identity와 검사 집합을 검사하며 결정적 FAIL을 재생한다(G `GovernanceTaskGate._conform`).

이 Task에서 확인되지 않은 것은 AGS의 실제 배포 진입점 경로·closure, token wire format과 signer의 신뢰 근거, 실제 host 관측, 설치물 conformance 결과다. 이 항목을 정상 fixture로 추측하거나 지원 완료로 표시하지 않는다. VM의 현재 Python 검사 관례는 `tests/test_engine_governance_gate.py`와 `tests/test_engine_governance_conformance.py`의 `unittest`다(TG, TC). 계획상 `tests/v3x/`는 이 pin ref에 없으므로 그 경로에서 검사를 실행했다고 주장하지 않는다.
