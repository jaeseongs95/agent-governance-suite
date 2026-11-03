# TaskEnvelope.v1 필드 작성 기준

## 목표와 범위

`objective`는 사용자가 얻으려는 결과를 한 작업 수준으로 적는다. 구현 방법을 목표에 섞지 않는다. `scope.included`와 `scope.excluded`에는 확인된 대상을 기록하고, 같은 대상이 양쪽에 들어가지 않게 한다.

필드가 비어 있다는 사실을 요청이나 지침에서 확인한 경우에만 빈 배열을 쓴다. 자료가 부족한 경우에는 빈 배열로 확정하지 않고 `ambiguities`에 남긴다.

## 작업 단위와 경로

`workUnits`는 목표를 설명하는 coarse unit이다. 각 ID는 고유해야 하고 dependency는 같은 envelope의 work unit만 가리켜야 한다. 순환 의존성을 만들지 않는다.

`writeTargets`는 repository-relative POSIX 경로다. 정확한 파일은 `src/app.ts`, 디렉터리 전체는 `src/generated/`처럼 쓴다. 절대 경로, `..`, backslash와 `*`, `?`, `[]`, `{}` 같은 암묵적 glob은 허용하지 않는다. 예정 경로라는 이유만으로 범위를 넓히지 않는다.

## 기능과 실행 정보

`requiredCapabilities`는 결과에 필요한 기능만 기록한다. provider 이름이나 세부 실행 순서는 넣지 않는다. `decision`은 충돌이나 복잡성이 실제 입력에서 확인되는 경우에만 표시한다.

`orchestration.requested`에는 [공통 실행 방식 판정](../../orchestrator/references/entry-details.md#초기-라우팅)에 따른 MCP 통합 실행 선택을 기록한다. 사용자의 명시적 workflow 요청 여부, 작업 길이나 MCP 연결 여부만으로 정하지 않는다. `orchestration.mcpAvailable`에는 현재 MCP 도구를 실제로 사용할 수 있는지 관측한 사실을 기록한다. `requested: false`이면 계획기는 direct 계획을 반환하며, 필요한 전문 스킬과 권한·검증·독립 감사 조건은 각 적용 범위대로 유지한다. 호스트별 호출 표기는 이 공통 판정을 바꾸지 않는다.

`task-contract`가 자연어 요청에서 envelope를 만드는 일반 경로는 `plan_workflow` 전 bootstrap이다. 계약 작성 요청만 받았다면 이후 workflow를 시작하지 않는다.
