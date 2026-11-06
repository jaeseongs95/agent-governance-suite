# AGS 3.8 시험 유효성 수리 사례

대상: `a281139387af096e696f8d50cc089ad09e9291fc`, 전용 브랜치 `codex/ags38-test-validity`.
범위: AGS3-D-0019, AGS3-D-0024, AGS3-D-0026. `ponytail`, `test-engineering` 적용.
제품 시험은 Linux/Windows TEST 또는 GitHub Actions에서 실행한다. 로컬은 구문·정적 검사만 한다.

| 사례 / 요구 | 입력·전제 | 절차 / 공개 경계 | 기대 결과·실패 판정 | 실제 결과 |
| --- | --- | --- | --- | --- |
| TV19-01 / D0019 | 현재 저장소 배치의 skill, 공용 runtime, 현행 native 회귀 파일. 외부 cwd. | `node skills/evaluation-validity-auditor/scripts/runtime-smoke.mjs`; 이 명령은 node_modules 없는 임시 suite에 복사한 native 회귀를 실행하고 설치 위치의 core를 import한다. | 종료 0, native assertion 통과 및 설치 import 성공. 구 경로·누락 의존성·시험 실패는 nonzero. | NOT_RUN (원격 담당 실행 대기) |
| TV19-02 / D0019 | TV19-01과 같은 격리 입력에서 공용 schema runtime을 제거 | 같은 공개 smoke 실행 | nonzero와 누락 파일 진단. 소스 저장소 의존성을 빌려 성공하면 FAIL. | NOT_RUN |
| TV24-01 / D0024 | 합성 정상 session_meta, turn_context, token_usage_record. 실제 사용자 로그 금지. | 기존 `execute` → provider 결과 원본 → WorkflowService record/finalize | PASS, partialReasons 빈 배열, 수작업 totals 10/3/2/12와 digest 일치, Markdown 생성 없음, workflow passed. | NOT_RUN |
| TV24-02 / D0024 | TV24-01 뒤 손상 JSONL 행 추가 | 동일 생산자·workflow 경로 | PARTIAL, 정확한 손상 사유 1개, 정상 usage totals 보존, 생산된 digest를 변조하지 않고 workflow passed. | NOT_RUN |
| TV24-03 / D0024 | TV24-01의 usage 행이 없는 session/context | 동일 생산자·workflow 경로 | PARTIAL 및 token_count 미관측 사유(usage record가 없으면 legacy 판독 경로). 관측 thread 0, 누락 usage를 0으로 위장하지 않음. | NOT_RUN |
| TV26-01 / D0026 | 기존 전체바이트 고정 대상 evaluation/recovery/preflight core와 smoke, 새 executable 경로에 의미 없는 코드 주석 변경 | 공개 `checkSkillContextOptimization`; 같은 입력에 `verifySourceLockOffline` | context pass 유지, source-lock의 해당 owner mismatch는 검출. 코드 provenance는 source-lock가 담당한다. | NOT_RUN |
| TV26-02 / D0026 | 고정 문맥·classification·계약의 한 바이트 변경 및 미승인 문서 추가 | 기존 및 보강한 공개 checker mutation | context fail. 문맥 의미 보존·계약·초기 로드·registry 권한·역사 결속 요구를 유지한다. | NOT_RUN |
| TV26-03 / D0026 | native executable 과거 blob을 읽으면 실패하는 Git 관측 | 기존 공개 checker 시험 | context pass, executable history read 0. 새 스크립트마다 수동 successor hash 추가 불필요. | NOT_RUN |
| TV26-04 / D0026 | preflight private/platform/expiry 역사 체인의 문맥·계약 8경로 및 별도 executable 경계 | 기존 node-native compatibility 시험 | 문맥·계약 8경로의 기존 과거/현재/한 바이트 변이 판정을 유지. 실행 파일은 context successor로 투영하지 않고 raw digest를 유지하며 source-lock mutation이 변경을 탐지한다. | NOT_RUN |

원 오라클과 변경 이유: D0019는 사라진 `test/core.test.mjs`, `<skill>/runtime` 경로 때문에 제품 검사에 도달하지 못했다. 현행 suite의 실제 native 회귀를 같은 배포 배치로 복사해 실행한다. D0024의 PASS 결과 verdict/digest 덮어쓰기는 producer가 PARTIAL을 만들었다는 증거가 아니므로 실제 손상·자료 누락 입력으로 교체한다. D0026의 실행 파일 전체 digest는 문맥 계약의 오라클이 아니다. 문맥·계약의 기존 정확한 바이트 pin과 초기 로드/재구성/권한 검사를 보존하고 실행 파일의 변경 감지는 source-lock의 실제 mismatch로 대조한다. 오라클 변경 전후를 동일 red/green으로 표현하지 않는다.

원격 실행 명령: `node node_modules/vitest/vitest.mjs run tests/evaluation-validity-auditor/runtime-smoke.test.mjs tests/codex-token-usage-analyzer/integration.test.mjs tests/tooling/skill-context-optimization.test.mjs`.
추가 node-native 명령: `node --test tests/tooling/preflight-private-preparation-compatibility.node-test.mjs`.
사전 소스 재대조에서 TV24-03의 최초 사유 문구(`token_usage_record 미관측`)를 `token_count 미관측`으로 교정했다. usage record가 하나도 없으면 legacy 분기가 선택되는 현재 공개 계약에 근거하며 PARTIAL·관측 0·누락값 null 요구는 그대로다. 최초 시험 실행 전의 오라클 교정이다.
red/green은 동일 시험 SHA·명령으로 test-only와 production-fix 후보를 비교한다. D0024는 오라클 자체의 수리이므로 기존 잘못된 시험과의 red/green 주장은 하지 않는다.
native 호스트 전체 동작·설치·배포·릴리스 판정은 이 작업의 검증 범위에 포함하지 않는다.
