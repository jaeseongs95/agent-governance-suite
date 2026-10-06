# CS suite 결과 분류 (7단계 출력에서 추출, 다시 실행하지 않음)

출처: `07-pnpm-test.log`(verbose)와 `07-vitest-results.json`. CS suite만 따로 다시 실행하지 않았다.

## 총괄

| 파일 | vitest 사례 | 결과 |
| --- | --- | --- |
| `tests/cs-engineering/workflow-integration.test.ts` | 15 | 15 PASS |
| `tests/cs-engineering/suite-integration.test.ts` | 1 (Node harness wrapper) | 1 PASS (2153ms) |

### Node harness 실제 검사 수: 관측 불가(NOT_VERIFIABLE)

wrapper(`suite-integration.test.ts`)는 `node --test cli-cleanroom.node.mjs core.node.mjs files.node.mjs reference-mechanisms.node.mjs`를 child process로 실행한다. child의 stdout/stderr는 `expect(result.status, ...)`가 실패할 때만 메시지에 나오므로, 통과한 이번 실행에서는 Node harness의 실제 검사 수와 사례별 상태가 출력되지 않았다. 관측된 사실은 child가 exit 0으로 끝났다는 것 하나다. 같은 suite를 반복 실행하지 말라는 지시에 따라 따로 실행하지 않았다.

참고용 정적 정보(실제 실행 수가 아님): 소스에서 `test(` 호출 위치는 cli-cleanroom 9곳(반복문 1곳), core 21곳(반복문 4곳), files 12곳(반복문 3곳), reference-mechanisms 17곳이다. 반복문이 사례 수를 늘리므로 정적 위치 수와 실제 실행 수는 다르다.

## workflow-integration.test.ts 사례 분류

모든 시간은 log의 verbose 표시값이다.

### 정상 경로
- PASS `registered CS providers are discoverable at bootstrap 25 and workflow 67` (417ms). registry의 CS provider phaseOrder가 [25,67]이고, bootstrap plan은 `blocked`다.
- PASS `selected review runs actual packaged CLI and finalizes with matching files` (1036ms). record 뒤 finalize 상태는 `passed`, handoff obligation은 [OB-CLAIM, OB-FENCE]다.
- PASS `actual MCP tools validate a selected CS stage with synthetic server observations` (750ms). 공개 MCP의 plan, open_convergence_root, claim, start_guarded, record_stage_result, finalize 경로를 탔다. **관측값은 synthetic이다.** 실제 Claude host 완주나 모델 품질의 증거가 아니다.
- PASS `file-backed CS output follows the same record and finalize validation` (802ms)

### 변이 거절(7건, 모두 거절되고 revision 0 유지)
- PASS `stage rejects missing-bundle without consuming its revision` (269ms)
- PASS `stage rejects stale-task without consuming its revision` (450ms)
- PASS `stage rejects raw-evidence without consuming its revision` (480ms)
- PASS `stage rejects provider-substitution without consuming its revision` (461ms)
- PASS `stage rejects NOT_RUN-as-PASS without consuming its revision` (531ms)
- PASS `stage rejects manifest-traversal without consuming its revision` (352ms)
- PASS `stage rejects candidate-target without consuming its revision` (450ms)

### FAIL/BLOCKED 상태
- PASS `proper unexecuted evidence records BLOCKED even with supplied observe policy` (446ms). NOT_RUN 근거는 observe policy에서도 `blocked`로 기록된다.
- FAIL verdict와 CLI의 nonzero exit 사례는 Node harness(core/cli-cleanroom) 쪽에 있다. 위 이유로 사례별 결과는 관측되지 않았다.

### record/finalize 재검사
- PASS `guarded lease/start and SQLite restart retain recorded bundle pins; finalize rereads evidence` (787ms). 기록 뒤 `candidate/queue.py`를 바꾸자 finalize가 거절됐다(`ok=false`).
- 정상 경로 중 selected review와 file-backed는 record 뒤 finalize 상태가 `passed`로 단언됐다. MCP 사례는 `finalize_workflow` 응답의 `ok=true`만 단언하고 상태값은 단언하지 않는다.

### SQLite 재시작
- PASS (위와 같은 사례) store를 닫고 다시 연 뒤에도 stageResults의 artifacts pin이 같았다.

### root / Claude tree
- root tree: `fixture(tree = "")`(workflow-integration.test.ts:33)는 기본값으로 저장소 루트의 `skills/registry.json`을 쓴다(46행). Claude tree 사례를 뺀 위의 사례들이 이 경로를 쓴다.
- PASS `generated Claude review and copied deployment CLI validate without node_modules` (1040ms). `fixture("claude-plugin")`로 record와 finalize가 `passed`가 됐다. `claude-plugin/skills/cs-engineering`과 `claude-plugin/runtime`을 임시 디렉터리에 복사해 node_modules 없이 `validate.mjs check-stage-bundle`을 실행했고 결과는 exit 0, verdict PASS였다.

### 경계(비선택)
- PASS `existing non-CS plan stays unselected and rejects unknown CS wire fields` (206ms)

## 정적 관측(실행하지 않음, 판단 보류)
- `skills/cs-engineering/assets/rules/*.json`의 `validationScope`(5개 파일, 20곳)와 `references/worked-example.md`(1곳)는 `tests/cs-engineering/reference-mechanisms.test.mjs`를 가리킨다. 실제 파일은 `reference-mechanisms.node.mjs`이고, 앞의 이름으로 된 파일은 없다. `claude-plugin/` 아래에서도 같은 문자열이 있는 파일을 찾았다(skills와 claude-plugin을 합쳐 12개 파일).
- `tests/cs-engineering/schema_reference_test.py`와 `sqlite_reference_test.py`는 package script, `scripts/*.mjs`, `.github`의 어디에서도 실행되지 않는다(grep 결과). 따라서 이번 15단계에서도 실행되지 않았다. 대체 검사로 따로 실행하지도 않았다.
