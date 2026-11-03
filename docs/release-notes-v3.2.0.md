# AGS 3.2.0 릴리스 노트

3.2.0은 설치된 모델 목록에 없는 모델로도 AGS가 실행되게 한다. Antigravity(agy)에서 workflow를 시작할 수 없던 결함과 Claude 세션에서 workflow 시작이 거부되던 결함(대화형 세션, 그리고 headless에서 다른 도구와 함께 부른 경우)도 고친다. workflow 관문이 Codex 작업을 멈추게 하던 두 결함(turn 끝 문구, 저장소 밖 문서 편집 차단)도 고친다. 그리고 이유가 기록되지 않은 채 시간만 지나면 작업을 거부하던 만료 네 가지를 없앤다. 3.1.1로 준비하던 수정에 이 변경을 더해 3.2.0으로 낸다. v3.1.1은 발행하지 않았다. DB 스키마 버전과 MCP 도구 목록은 바뀌지 않았다. 계약은 실행 관측(`ExecutionContext.v1`)의 두 필드가 null을 받게 되었고, 상태 정리 계획과 사전 점검 보고서에서 만료 필드가 빠졌다. 3.1.0을 쓰는 호스트는 3.2.0으로 바꾸고 AGS 프로세스를 다시 시작한다.

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

### Claude 세션의 workflow 시작

- 대화형 Claude는 PreToolUse hook이 도는 동안 호출 메시지를 transcript에 쓴다. 3.1.0의 실행 관측 hook은 처음 찾을 때 그 메시지를 놓친다. 그 뒤 다시 열어 확인할 때 메시지가 보이면 `CLAUDE_ISSUING_MESSAGE_REJECTED`로 거부했다. 그래서 대화형 세션에서 `start_workflow`·`record_stage_result`가 실패할 수 있었다.
- 이제 확인 단계에서 메시지가 보이면 한 번 더 찾고, 그때도 거부될 때만 거부한다.
- headless Claude(`claude -p`)에서도 모델이 `start_workflow` 같은 관측 대상 도구를 다른 도구와 한 메시지에서 함께 부르면 거부됐다(3.1.0부터). 호출 메시지가 아직 스트리밍 중이라 hook이 시작된 뒤에 기록되는데(Windows 시험 서버에서 441~463ms), hook은 0.3초만 기다렸고 headless에는 대신할 세션 모델 기록이 없어 `CLAUDE_MODEL_UNOBSERVED`로 끝났다. 이제 대신할 세션 모델이 없으면(headless, 서브에이전트) 호출 메시지를 5초까지 기다린다. 세션 모델이 있는 대화형 메인 세션은 지금처럼 0.3초 뒤 세션 모델로 관측한다.

### workflow 관문

- turn이 끝날 때 나오는 단계 확인 문구를 바꿨다. Codex는 이 문구를 받아 turn을 이어 가는데, 그 turn에서는 이 문구가 유일한 지시다. 3.1.0 문구 「빠진 단계를 지금 진행하거나, 필요 없으면 계획을 고쳐 그 단계를 빼라.」를 받은 Codex는 단계를 blocked로 기록하고 원래 작업을 하지 않은 채 멈췄다. 이제 문구는 workflow 목표를 보여 주고, 그 목표가 남았으면 방금 받은 요청을 끝냈어도 이어서 하라고 먼저 말한다. agy도 같은 문구로 turn을 이어 가므로 같은 결함이 있었다. 단계 결과는 그 단계의 작업과 검증을 마친 뒤에만 기록하라고 하고, 사용자의 답이나 승인을 기다려야 할 때만 이유를 한 줄로 쓰고 끝내라고 한다.
- workflow 없이 3개째 편집을 막을 때 세는 「제품 파일」을 버전 관리 아래의 파일로 좁혔다. 편집 대상의 상위 폴더에 `.git`(worktree·submodule의 `.git` 파일 포함), `.hg`, `.svn`, `.jj`가 있어야 센다. 3.1.0은 임시 폴더·메모 폴더·설정한 면제 경로만 빼고 모든 파일을 세서, 저장소 밖 질의 문서를 쓰던 Codex 세션이 막혔다. 상위 폴더를 읽다 오류가 나면 지금처럼 센다.

### 시간 만료 제거

다른 세션이 준비를 마친 서비스 교체를 사전 점검 결과의 15분 만료 때문에 미루고 절차를 다시 정리하는 일이 있었다. 고정 만료 상수를 모두 찾아 도입 커밋과 설계 문서에서 이유를 확인했다. 아래 넷은 이유가 기록되어 있지 않았고, 시간 말고 다른 장치가 이미 같은 위험을 막고 있어 뺐다.

- **사전 점검 receipt 15분**(`mutation-risk-preflight`): 시간이 지났다는 이유만으로는 receipt를 거부하지 않는다. 실행 직전 검증은 지금처럼 원 관측 시점으로 보고서를 다시 만들어 비교하고, 현재 시점으로 다시 평가해 행동·대상·환경·승인·fingerprint·복구 계획·영향 범위가 바뀌었으면 거부한다. 승인 증거 자체의 `expiresAt`은 그대로 적용한다. 보고서(`MutationPreflightReport.v1`)에서 `validUntil`이 빠졌다.
- **실행 관측 5분**: 서버가 호출 시점에 만들어 바로 쓰는 관측이라 실제로 걸리는 경로가 없었다. 재사용은 한 번 소비 기록이 영구히 막는다. 미래 시각의 관측만 거부한다. 관측에 `expiresAt`을 더 싣지 않으며, 저장된 계획에 남은 `expiresAt`은 무시한다.
- **상태 정리 token 15분**: 미리보기를 확인하는 데 걸리는 시간으로 거부하지 않는다. 한 번만 쓸 수 있고, 확인을 기다리는 동안 후보가 바뀌면 digest가 달라 거부된다. DB 경로·스키마 결속과 삭제 전 backup도 그대로다. 계획(`StateCleanupPlan.v1`)에서 `expiresAt`이 빠졌다.
- **workflow 단계 시도 lease 300초**: claim한 뒤 시작까지 5분이 넘으면(권한 승인 대기, 긴 생각, 컨텍스트 압축) 시작이 거부되고 다시 claim해야 했다. 이제 lease는 시간으로 만료되지 않는다. 대신 같은 root에 새 claim이 오면 아직 시작하지 않은 lease를 대체한다. 그래서 claim한 세션이 죽거나 leaseId를 잃어도 다시 claim 한 번이면 풀린다. 대체는 root revision을 비교해 바꾸는 쓰기(CAS)가 성공한 같은 트랜잭션 안에서만 하므로, 거부된 claim은 남의 lease를 건드리지 않는다. 대체된 lease는 root revision이 낡아 시작할 수 없다. 시도 예산은 시작한 시도만 세므로 대체는 예산을 쓰지 않는다. 어떻게 할지는 독립 reviewer 셋(동시성, 운영성, 단순성)과 별도 Judge 토론으로 정했다. `leaseTtlSeconds`와 lease의 `expiresAt`은 저장된 root의 digest와 맞추기 위해 남겼고 검사하지 않는다. 두 claim이 동시에 오면 진 쪽은 `LEASE_CONFLICT` 또는 `STALE_REVISION`을 받는다.

세션 메시지 TTL·draft·wake, peer-wait, 세션 현황판 보존, 업데이트 확인 캐시처럼 만료가 없으면 자리가 영구히 잡히거나 같은 조회가 반복되는 시간 창은 기능상 필요해 남겼다. continuity 후보 token 1시간, JEV 프로필 `qualification.validUntil`, 호스트 발견 자료 `expiresAt`은 이번에 바꾸지 않았다.

## 업그레이드 시 확인할 것

- `ExecutionContext.v1`의 `modelClass`·`reasoningEffort`가 null일 수 있고 `policyNotes` 배열이 생겼다. 이 값을 직접 읽는 도구는 null을 처리해야 한다.
- `StateCleanupPlan.v1`의 `expiresAt`, `MutationPreflightReport.v1`의 `validUntil`이 없어졌다. 이 값을 읽던 도구는 고쳐야 한다. 실행 관측에도 `expiresAt`이 더 실리지 않는다.
- lease가 있는 동안 두 번째 claim이 `LEASE_CONFLICT`로 거부된다고 가정한 도구는, 이제 그 claim이 앞 lease를 대체한다는 점을 반영해야 한다.
- agy는 플러그인을 다시 설치한다(`agy plugin install <v3.2.0 디렉터리>`). Codex는 `/hooks`에서 AGS hook을 다시 검토하고 신뢰한다.

## 알려진 제한

- agy 짝짓기는 호출 ID 없이 (대화, 도구, 인자)로 한다. 같은 대화에서 같은 인자로 같은 도구를 거의 동시에 두 번 부르고 두 hook 기록이 서버가 꺼내기 전에 모두 쌓이면, 첫 호출이 가장 최근 기록을 쓰면서 같은 키의 기록을 모두 지운다. 그래서 두 번째 호출은 `ANTIGRAVITY_OBSERVATION_MISSING`으로 거부되고 다시 부르면 된다. 남은 기록을 지우는 것은 보내지 않은 호출의 기록이 나중 호출에 쓰이지 않게 하기 위해서다. 반대로 hook은 돌았지만 서버로 보내지지 않은 호출의 기록은 하루 동안 남는다. 그 사이 같은 대화에서 같은 인자로 같은 도구를 부르면, 그 기록이 더 최근 기록이 없을 때 쓰일 수 있다. 그 사이에 모델을 바꿨다면 바꾸기 전 모델로 기록된다.
- 새 호스트를 붙이려면 아직 ingress 목록과 호스트 목록을 함께 고쳐야 한다. 서브에이전트를 띄우는 시점의 관측도 아직 없다. 둘 다 다음 버전에서 다룬다.
- 대화형 Claude 세션에서는 실행 관측 호출(`plan_workflow`·`start_workflow`·`record_stage_result`·`classify_skills`·`record_skill_selection`)마다 hook이 transcript를 처음부터 끝까지 읽는다. 호출 메시지가 hook보다 늦게 기록되어 처음 찾기에서 놓치기 때문이다. Windows 시험 서버 측정에서는 100MB 0.9초, 300MB 2.3초, 500MB 4.3초가 걸렸다. 이 기울기면 1.2GB쯤에서 hook 제한 시간 10초에 닿아 호출이 막힐 수 있다(외삽). 전체를 읽는 것은 호출 메시지가 없다는 것을 증명한 뒤에만 세션 모델로 대신 관측하기 위해서다. 그래서 끝 쪽만 읽도록 줄이지 않고, 다음 버전에서 이미 읽은 구간의 판정을 세션별로 저장해 새로 붙은 부분만 읽게 고친다. headless 세션은 메시지를 바로 찾으므로 크기와 상관없이 2ms였다.
- 3.1.0의 나머지 제한(셸로 바꾼 파일은 세지 않음, 구간은 turn마다 다시 셈)은 그대로다.
- 버전 관리 밖의 제품(`git init` 전에 만드는 새 프로젝트, 저장소 밖 설정 파일)은 편집 관문이 세지 않는다.
- 시작한 뒤 끝나지 않은 run은 지금처럼 `abort_workflow`로 닫아야 다음 claim을 할 수 있고, 다시 시도하려면 실패 지문과 새 근거가 필요하다. 이번 lease 변경은 시작 전 lease만 다룬다.
- 같은 root를 두 에이전트가 번갈아 claim하면 서로의 시작 전 lease를 대체할 수 있다. 시작은 하나만 되므로 안전 문제는 아니지만 진행이 늦어질 수 있다.
- 대신할 세션 모델이 없는 Claude 호출은 호출 메시지를 5초까지 기다린다. 한 메시지의 도구 입력이 길어 5초 안에 스트리밍이 끝나지 않으면 여전히 `CLAUDE_MODEL_UNOBSERVED`로 거부되고, 그 도구를 따로 다시 부르면 된다. 어차피 거부될 호출(다른 세션의 메시지, 메시지를 늦게 쓰는 서브에이전트)은 거부까지 최대 5초가 더 걸린다. transcript가 아주 크면 이 대기와 전체 읽기가 hook 제한 시간 10초를 넘을 수 있다.

## 검증

(후보 시험 뒤 채운다.)
