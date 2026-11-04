# AGS 3.5.1 릴리스 노트

3.5.1은 모델이 한 세션에서 workflow를 여러 개 만들 수 있다는 걸 몰랐던 결함을 고친다. 처음에는 시험 과정 개선도 함께 넣으려 했으나 측정 뒤 후속 과제로 넘겼다(아래 「미룬 것」). 사용자 원문은 「이 두개를 3.5.1 로 릴리즈 내.」이고, 결함은 「모델이 워크플로우를 여러개 만들수있다는걸 인식을 못하는데 확인해줄래?」, 시험 과정은 「테스트 프로세스를 개선해야할거같은데.」「미리 빌드한걸로 띄우게하던지.」에서 나왔다. 시험 과정은 「걍 테스트 개선은 후속과제로 넘기고」에 따라 뺐다. DBMS 전환은 3.6.0으로 미룬다.

호환성: 공개 도구 계약, 오류 code, DB schema 버전은 바뀌지 않는다. 메시지 key `hooks.editGate.outsideScope` 하나가 늘었다.

## 다중 workflow를 모르던 결함

### 원인

한 세션은 겹치지 않는 writeTargets로 workflow를 여러 개 함께 진행할 수 있다(3.3.0). 그런데 이 사실은 `start_workflow` 도구 설명과 `skills/orchestrator/references/convergence-guard.md`에만 있었다. 공통 접수 블록(`skills/orchestrator/SKILL.md`)에는 한 번도 나오지 않았다. Claude Code와 agy는 AGS 도구를 지연 로드하므로, 모델은 처음에 도구 설명을 보지 못한다.

편집 관문 문구도 모델을 잘못 이끌었다. workflow가 진행 중인데 그 writeTargets 밖의 제품 파일을 세 개째 바꾸면, 관문은 workflow가 없을 때와 같은 「[AGS] workflow 없이 제품 파일 3개째 변경 … 먼저 workflow를 시작하라」를 냈다. 모델은 이미 workflow가 있는데 「workflow 없이」라는 말을 듣고, 새 workflow를 하나 더 만들 수 있다는 판단으로 가지 못했다.

### 바뀐 점

- **접수 블록에 한 문장.** workflow 항목에, 범위가 다른 작업은 writeTargets가 겹치지 않게 workflow를 따로 시작하고 한 세션이 그런 workflow 여러 개를 함께 진행할 수 있다는 문장을 넣었다(원문은 `skills/orchestrator/SKILL.md`에만 둔다). MCP 서버 instructions와 3.5.0의 세션 시작 hook이 같은 블록을 쓰므로 Claude Code·Codex·agy가 모두 받는다.
- **편집 관문 문구를 두 경우로 나눔.** workflow가 없으면 지금과 같은 `hooks.editGate.denied`를 낸다. 진행 중인 workflow가 있고 그 범위 밖이면 새 `hooks.editGate.outsideScope`를 낸다: 「[AGS] 진행 중인 workflow의 writeTargets 밖 제품 파일 3개째 변경: … 진행 중인 작업과 다른 작업이면 겹치지 않는 writeTargets로 workflow를 하나 더 시작하라. 한 세션은 workflow 여러 개를 함께 진행할 수 있다(최소 시작 호출 예: …).」 세는 방식과 거부 시점은 바뀌지 않았다(`mcp-server/src/continuity-service.ts`).
- **분류 결속.** 접수 블록 바이트가 바뀌어 `skills/orchestrator/classification.json`의 digest와 span 두 개(`applicability[5]`, `exclusions[4]`)의 위치를 다시 계산했다. 새 바이트는 specialist-behavior 결속(r18)의 정확한 후속본(`tests/skill-classification/fixtures.orchestrator-multi-workflow-source-successor.json`, r19)으로 이었고, 문맥 검사(`scripts/check-skill-context-optimization.mjs`)는 이 바이트를 54ef451f의 바이트로 투영해 기존 고정값을 그대로 검사한다.

## 미룬 것: 시험 과정 개선

전체 시험 시간을 54ef451f에서 단계별로 쟀다. 두 시험 서버는 모두 2 vCPU라 vitest와 node:test가 worker 1개로 돈다(CI 러너는 4 vCPU라 3개).

- Linux: 빌드 1.3초, vitest 1082초, node:test 159.5초, runtime 확인 12.7초.
- Windows: 설치 1초, 빌드 4초, vitest 1865초, node:test 202초, runtime 확인 18초(합 약 35분).
- vitest worker 2개: Linux는 862초로 줄고 모두 통과했다. Windows는 1551초로 줄었지만 `tests/tooling/skill-context-optimization.test.mjs`의 3개가 30초 한도를 넘었다. 이 파일은 `node:child_process`를 mock할 때마다 git 캐시가 새로 생겨 검사 한 번에 git을 200번 넘게 부르고, Windows에서는 1-worker로도 15초쯤 걸린다.
- node:test 동시 실행 2: Linux 159.5초 → 106.4초, 499개 모두 통과.
- 「미리 빌드한 걸로 띄우기」: bootstrap 자식의 tsx 변환 캐시가 있든 없든 110.6초 대 109.1초라 변환이 비용이 아니다.

worker 수를 바꾸는 것은 3.4.0 토론 결정(worker 수 유지)을 뒤집는 일이고, Windows에서 시간 한도를 넘는 시험이 먼저 고쳐져야 한다. 이 측정을 근거로 후속 판에서 다시 다룬다.

## 검증

시험 대상은 a3ff6640이다. 그 뒤로는 이 문서만 바뀌었다.

- Linux 시험 서버: 전체 시험 `TEST_SERVER_EXIT=0`(1318초). vitest 파일 277개 통과·1개 skip, 시험 4118개 통과(skip 15, todo 8). node:test 499/499 통과.
- Windows 시험 서버: 전체 시험 `TEST_SERVER_EXIT=0`(2435초). vitest 파일 276개 통과·2개 skip. node:test 498개 통과·1개 skip·실패 0.
- 실호스트(Linux, 6.7 체크리스트):
  - 실행 파일: Claude Code 2.1.314, codex-cli 0.166.0, agy 1.4.12.
  - headless로 `notes.txt`의 red를 blue로 바꾸는 실행이 셋 모두 exit 0이었고, 파일이 실제로 바뀌었다.
  - 도구 없이 접수 지침의 다중 workflow 문장을 인용하게 한 질문은 벤더마다 2회씩 6/6 YES였다. 6회 모두 문장을 그대로 인용했다.
  - 시험 뒤 `agy plugin list`·`codex plugin marketplace list`·Codex 설정은 시험 전과 같았다.
  - Claude 대화형 실행은 하지 않았다. 이번 변경은 transcript나 호출 시점에 기대지 않는다.
