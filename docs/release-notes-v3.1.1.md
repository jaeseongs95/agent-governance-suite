# AGS 3.1.1 릴리스 노트

3.1.1은 설치된 모델 목록에 없는 모델로도 AGS가 실행되게 한다. Antigravity(agy)에서 workflow를 시작할 수 없던 결함과 대화형 Claude 세션에서 workflow 시작이 거부되던 결함도 고친다. workflow 관문이 Codex 작업을 멈추게 하던 두 결함(turn 끝 문구, 저장소 밖 문서 편집 차단)도 고친다. DB 스키마와 MCP 도구 목록은 바뀌지 않았다. 실행 관측 계약(`ExecutionContext.v1`)에서 두 필드가 null을 받게 되었다. 3.1.0을 쓰는 호스트는 3.1.1로 바꾸고 AGS 프로세스를 다시 시작한다.

## 바뀐 점

### 모델 목록은 실행 허가가 아니다

- 3.1.0까지는 설치된 모델 목록에 없는 모델이나 목록이 모르는 effort가 관측되면 그 호출을 거부했다. 새 모델이 나오거나 다른 벤더 모델을 쓰면 workflow를 시작할 수 없었다.
- 이제 목록에 없는 모델은 `modelClass: null`과 `policyNotes: ["MODEL_NOT_IN_CATALOG"]`로 기록하고 실행한다. 호스트가 effort를 보고하지 않았거나 목록 밖 값이면 `reasoningEffort: null`로 기록한다. 목록의 지원 effort·최소 effort는 기록만 한다(`CURRENT_POLICY_EFFORT_UNSUPPORTED` 등).
- 메인 세션(root)은 사용자가 고른 모델·effort로 실행하며 모델·effort를 이유로 거부하지 않는다. 신원·결속·1회 소비 같은 관측 요건은 그대로다.
- 하한은 서브에이전트(child)가 기록하는, 하한이 계획된 단계에만 적용한다. effort를 관측하지 못하면 `REASONING_EFFORT_UNOBSERVED`, effort가 계획된 하한보다 낮으면 `REASONING_EFFORT_BELOW_FLOOR`, 목록이 아는 등급이 하한보다 낮으면 `MODEL_CLASS_BELOW_FLOOR`로 거부한다. 등급을 모르는 모델(`modelClass: null`)은 등급으로 거부하지 않고 기록한다.
- 설치된 어댑터의 기술자가 관측과 모순되면(호스트·모델 이름·정책 개정 불일치) 계속 거부한다.
- Codex와 Claude Code는 effort를 보고하지 않아도 모델만으로 관측한다. 3.1.0의 Claude 관측은 hook에 effort가 없으면 `CLAUDE_EFFORT_UNOBSERVED`로 root 호출까지 거부했다. 이제 `reasoningEffort: null`로 기록하고, effort 하한이 있는 child 단계만 `REASONING_EFFORT_UNOBSERVED`로 거부한다.

### Antigravity(agy) 실행 관측

- agy 1.4.12는 도구 호출 정보에 모델을 싣지 않고 호출 ID도 주지 않는다. 그래서 3.0.2부터 agy에서는 `plan_workflow`·`start_workflow`가 `BINDING_REQUIRED`(`ANTIGRAVITY_EXECUTION_UNOBSERVED`)로 실패했다.
- 이제 agy hook runner의 PreToolUse가 hook 입력의 `modelName`을 관측으로 기록한다. effort 접미사(예: `-medium`)는 hook 어댑터에서 떼어 effort로 기록한다. 서버는 (대화, 도구, 정규화한 인자의 digest)가 같은 가장 최근 기록을 꺼내 쓰고, 같은 키의 나머지 기록은 지운다. 그 대화·도구의 기록이 없으면 `ANTIGRAVITY_OBSERVATION_MISSING`, 기록은 있지만 인자가 다르면 `ANTIGRAVITY_OBSERVATION_UNMATCHED`로 거부한다. 인자를 바꾼 호출, 다른 대화의 기록, 관측 없는 호출은 계속 거부한다.
- agy는 hook 입력에 작업 폴더를 주지 않는 경우가 있다. 그래서 `workspace`를 생략한 `start_workflow`가 세션 현황판에서 작업 폴더를 찾지 못해 실패했다. 이제 PreInvocation hook이 세션의 cwd를 현황판에 기록한다. prompt 본문은 넘기지 않으므로, 깨우기만 하는 턴도 prompt 턴으로 기록된다.
- hook runner가 관측 기록 hook이나 현황판 hook을 띄우다 실패하거나 시간 제한(2초)에 걸리면 그 사실을 stderr에 남긴다. 3.1.1 이전 후보에서는 결과를 버려서, 현황판 기록이 빠져도 아무 표시가 없었다.

### 대화형 Claude 세션의 workflow 시작

- 대화형 Claude는 PreToolUse hook이 도는 동안 호출 메시지를 transcript에 쓴다. 3.1.0의 실행 관측 hook은 처음 찾을 때 그 메시지를 놓친다. 그 뒤 다시 열어 확인할 때 메시지가 보이면 `CLAUDE_ISSUING_MESSAGE_REJECTED`로 거부했다. 그래서 대화형 세션에서 `start_workflow`·`record_stage_result`가 실패할 수 있었다.
- 이제 확인 단계에서 메시지가 보이면 한 번 더 찾고, 그때도 거부될 때만 거부한다.

### workflow 관문

- turn이 끝날 때 나오는 단계 확인 문구를 바꿨다. Codex는 이 문구를 받아 turn을 이어 가는데, 그 turn에서는 이 문구가 유일한 지시다. 3.1.0 문구 「빠진 단계를 지금 진행하거나, 필요 없으면 계획을 고쳐 그 단계를 빼라.」를 받은 Codex는 단계를 blocked로 기록하고 원래 작업을 하지 않은 채 멈췄다. 이제 문구는 workflow 목표를 보여 주고, 그 목표가 남았으면 방금 받은 요청을 끝냈어도 이어서 하라고 먼저 말한다. agy도 같은 문구로 turn을 이어 가므로 같은 결함이 있었다. 단계 결과는 그 단계의 작업과 검증을 마친 뒤에만 기록하라고 하고, 사용자의 답이나 승인을 기다려야 할 때만 이유를 한 줄로 쓰고 끝내라고 한다.
- workflow 없이 3개째 편집을 막을 때 세는 「제품 파일」을 버전 관리 아래의 파일로 좁혔다. 편집 대상의 상위 폴더에 `.git`(worktree·submodule의 `.git` 파일 포함), `.hg`, `.svn`, `.jj`가 있어야 센다. 3.1.0은 임시 폴더·메모 폴더·설정한 면제 경로만 빼고 모든 파일을 세서, 저장소 밖 질의 문서를 쓰던 Codex 세션이 막혔다. 상위 폴더를 읽다 오류가 나면 지금처럼 센다.

## 업그레이드 시 확인할 것

- `ExecutionContext.v1`의 `modelClass`·`reasoningEffort`가 null일 수 있고 `policyNotes` 배열이 생겼다. 이 값을 직접 읽는 도구는 null을 처리해야 한다.
- agy는 플러그인을 다시 설치한다(`agy plugin install <v3.1.1 디렉터리>`). Codex는 `/hooks`에서 AGS hook을 다시 검토하고 신뢰한다.

## 알려진 제한

- agy 짝짓기는 호출 ID 없이 (대화, 도구, 인자)로 한다. 같은 대화에서 같은 인자로 같은 도구를 거의 동시에 두 번 부르고 두 hook 기록이 서버가 꺼내기 전에 모두 쌓이면, 첫 호출이 가장 최근 기록을 쓰면서 같은 키의 기록을 모두 지운다. 그래서 두 번째 호출은 `ANTIGRAVITY_OBSERVATION_MISSING`으로 거부되고 다시 부르면 된다. 남은 기록을 지우는 것은 보내지 않은 호출의 기록이 나중 호출에 쓰이지 않게 하기 위해서다. 반대로 hook은 돌았지만 서버로 보내지지 않은 호출의 기록은 하루 동안 남는다. 그 사이 같은 대화에서 같은 인자로 같은 도구를 부르면, 그 기록이 더 최근 기록이 없을 때 쓰일 수 있다. 그 사이에 모델을 바꿨다면 바꾸기 전 모델로 기록된다.
- 새 호스트를 붙이려면 아직 ingress 목록과 호스트 목록을 함께 고쳐야 한다. 서브에이전트를 띄우는 시점의 관측도 아직 없다. 둘 다 3.2에서 다룬다.
- 대화형 Claude 세션에서는 실행 관측 호출(`plan_workflow`·`start_workflow`·`record_stage_result`·`classify_skills`·`record_skill_selection`)마다 hook이 transcript를 처음부터 끝까지 읽는다. 호출 메시지가 hook보다 늦게 기록되어 처음 찾기에서 놓치기 때문이다. Windows 시험 서버 측정에서는 100MB 0.9초, 300MB 2.3초, 500MB 4.3초가 걸렸다. 이 기울기면 1.2GB쯤에서 hook 제한 시간 10초에 닿아 호출이 막힐 수 있다(외삽). 전체를 읽는 것은 호출 메시지가 없다는 것을 증명한 뒤에만 세션 모델로 대신 관측하기 위해서다. 그래서 끝 쪽만 읽도록 줄이지 않고, 3.2에서 이미 읽은 구간의 판정을 세션별로 저장해 새로 붙은 부분만 읽게 고친다. headless 세션은 메시지를 바로 찾으므로 크기와 상관없이 2ms였다.
- 3.1.0의 나머지 제한(셸로 바꾼 파일은 세지 않음, 구간은 turn마다 다시 셈)은 그대로다.
- 버전 관리 밖의 제품(`git init` 전에 만드는 새 프로젝트, 저장소 밖 설정 파일)은 편집 관문이 세지 않는다.

## 검증

전체 시험의 대상 커밋은 `6821760a`이다. 그 뒤 커밋은 이 노트만 바꾼다.

- CI: run 41566494855(`6821760a`), ubuntu-latest·windows-latest(Node 24) 모두 성공.
- Linux 시험 서버 전체 시험(`node scripts/build.mjs && node scripts/run-tests.mjs`, `6821760a`): 종료 코드 0. vitest 시험 파일 270개 통과·1개 skip, 시험 3978개 통과·15 skip·8 todo. node:test 486/486 통과.
- 공식 배포판 실호스트 시험(`start_workflow` 1회 호출, `workspace` 인자 없음, 관측은 각 호스트의 AGS 상태 DB에서 읽음). `57a75d1c`에서 네 호스트를 시험했다. `6821760a`는 agy hook runner만 바꿨으므로 agy만 다시 시험했다.
  - Claude Code 2.1.316(Windows, `--plugin-dir`, headless, API key): ok, `claude-opus-5-5 / deep / medium`.
  - Claude Code 2.1.316(Windows, `--plugin-dir`, 대화형 ConPTY): ok, `claude-sonnet-5-5 / general / medium`. 이 시험 서버의 API key로는 대화형 요청만 API가 `400 credit balance too low`를 돌려줘서(같은 key로 headless는 성공), 대화형은 구독 로그인으로 실행했다.
  - Codex 0.166.0(Windows, 로컬 마켓플레이스): ok, `gpt-6.1-sol / general / low`. 설치본 파일 1,950개의 해시가 원본과 같았다.
  - agy 1.4.12(Linux, `agy plugin install`): `57a75d1c`·`6821760a` 모두 ok, `gemini-4-argon / null / medium / ["MODEL_NOT_IN_CATALOG"]`. 현황판에 임시 프로젝트 cwd가 기록됐다.
- 수정 전 코드(`f95be489`)에서도 Claude Haiku(`claude-haiku-5-5 / lightweight / medium`)와 대화형 Sonnet이 ok였다. Claude Code 2.1.316은 세 모델 모두 hook에 effort를 실었다. 그래서 effort 없는 Claude 관측은 단위 시험(`tests/mcp/host-attestation.test.ts`, `tests/mcp/model-capability-contract.test.ts`)으로만 확인했다.
