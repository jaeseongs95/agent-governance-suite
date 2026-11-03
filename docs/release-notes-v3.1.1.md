# AGS 3.1.1 릴리스 노트

3.1.1은 설치된 모델 목록에 없는 모델로도 AGS가 실행되게 한다. Antigravity(agy)에서 workflow를 시작할 수 없던 결함과 대화형 Claude 세션에서 workflow 시작이 거부되던 결함도 고친다. DB 스키마와 MCP 도구 목록은 바뀌지 않았다. 실행 관측 계약(`ExecutionContext.v1`)에서 두 필드가 null을 받게 되었다. 3.1.0을 쓰는 호스트는 3.1.1로 바꾸고 AGS 프로세스를 다시 시작한다.

## 바뀐 점

### 모델 목록은 실행 허가가 아니다

- 3.1.0까지는 설치된 모델 목록에 없는 모델이나 목록이 모르는 effort가 관측되면 그 호출을 거부했다. 새 모델이 나오거나 다른 벤더 모델을 쓰면 workflow를 시작할 수 없었다.
- 이제 목록에 없는 모델은 `modelClass: null`과 `policyNotes: ["MODEL_NOT_IN_CATALOG"]`로 기록하고 실행한다. 호스트가 effort를 보고하지 않았거나 목록 밖 값이면 `reasoningEffort: null`로 기록한다. 목록의 지원 effort·최소 effort는 기록만 한다(`CURRENT_POLICY_EFFORT_UNSUPPORTED` 등).
- 메인 세션(root)은 사용자가 고른 모델·effort로 실행하며 모델·effort를 이유로 거부하지 않는다. 신원·결속·1회 소비 같은 관측 요건은 그대로다.
- 하한은 서브에이전트(child)가 기록하는, 하한이 계획된 단계에만 적용한다. effort를 관측하지 못하면 `REASONING_EFFORT_UNOBSERVED`, effort가 계획된 하한보다 낮으면 `REASONING_EFFORT_BELOW_FLOOR`, 목록이 아는 등급이 하한보다 낮으면 `MODEL_CLASS_BELOW_FLOOR`로 거부한다. 등급을 모르는 모델(`modelClass: null`)은 등급으로 거부하지 않고 기록한다.
- 설치된 어댑터의 기술자가 관측과 모순되면(호스트·모델 이름·정책 개정 불일치) 계속 거부한다.
- Codex는 effort를 보고하지 않아도 모델만으로 관측한다.

### Antigravity(agy) 실행 관측

- agy 1.4.12는 도구 호출 정보에 모델을 싣지 않고 호출 ID도 주지 않는다. 그래서 3.0.2부터 agy에서는 `plan_workflow`·`start_workflow`가 `BINDING_REQUIRED`(`ANTIGRAVITY_EXECUTION_UNOBSERVED`)로 실패했다.
- 이제 agy hook runner의 PreToolUse가 hook 입력의 `modelName`을 관측으로 기록한다. effort 접미사(예: `-medium`)는 hook 어댑터에서 떼어 effort로 기록한다. 서버는 (대화, 도구, 정규화한 인자의 digest)가 같은 가장 최근 기록을 꺼내 쓰고, 같은 키의 나머지 기록은 지운다. 그 대화·도구의 기록이 없으면 `ANTIGRAVITY_OBSERVATION_MISSING`, 기록은 있지만 인자가 다르면 `ANTIGRAVITY_OBSERVATION_UNMATCHED`로 거부한다. 인자를 바꾼 호출, 다른 대화의 기록, 관측 없는 호출은 계속 거부한다.
- agy는 hook 입력에 작업 폴더를 주지 않는 경우가 있다. 그래서 `workspace`를 생략한 `start_workflow`가 세션 현황판에서 작업 폴더를 찾지 못해 실패했다. 이제 PreInvocation hook이 세션의 cwd를 현황판에 기록한다. prompt 본문은 넘기지 않으므로, 깨우기만 하는 턴도 prompt 턴으로 기록된다.

### 대화형 Claude 세션의 workflow 시작

- 대화형 Claude는 PreToolUse hook이 도는 동안 호출 메시지를 transcript에 쓴다. 3.1.0의 실행 관측 hook은 처음 찾을 때 그 메시지를 놓친다. 그 뒤 다시 열어 확인할 때 메시지가 보이면 `CLAUDE_ISSUING_MESSAGE_REJECTED`로 거부했다. 그래서 대화형 세션에서 `start_workflow`·`record_stage_result`가 실패할 수 있었다.
- 이제 확인 단계에서 메시지가 보이면 한 번 더 찾고, 그때도 거부될 때만 거부한다.

## 업그레이드 시 확인할 것

- `ExecutionContext.v1`의 `modelClass`·`reasoningEffort`가 null일 수 있고 `policyNotes` 배열이 생겼다. 이 값을 직접 읽는 도구는 null을 처리해야 한다.
- agy는 플러그인을 다시 설치한다(`agy plugin install <v3.1.1 디렉터리>`). Codex는 `/hooks`에서 AGS hook을 다시 검토하고 신뢰한다.

## 알려진 제한

- agy 짝짓기는 호출 ID 없이 (대화, 도구, 인자)로 한다. 같은 대화에서 같은 인자로 같은 도구를 거의 동시에 두 번 부르면 어느 기록이 어느 호출 것인지 구분하지 않는다. 두 호출 모두 같은 세션의 같은 모델 관측이므로 결과는 같다.
- 새 호스트를 붙이려면 아직 ingress 목록과 호스트 목록을 함께 고쳐야 한다. 서브에이전트를 띄우는 시점의 관측도 아직 없다. 둘 다 3.2에서 다룬다.
- 3.1.0의 나머지 제한(셸로 바꾼 파일은 세지 않음, 구간은 turn마다 다시 셈)은 그대로다.

## 검증

<!-- 3.1.1 verification: filled in after the release-candidate runs -->
