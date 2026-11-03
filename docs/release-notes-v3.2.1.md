# AGS 3.2.1 릴리스 노트

3.2.1은 Antigravity(agy) 설치본을 release마다 자동으로 만들어 붙이고, 에이전트가 workflow 하한과 스킬 분류 결과를 잘못 읽고 작업을 멈추던 문제를 도구 설명으로 고친다. `start_workflow`로 시작한 run에서 시험·리뷰 단계를 기록할 수 없던 문제도 고친다. 3.2.0에 손으로 올린 agy 설치본에서 빠진 파일 2개도 채운다. DB 스키마, MCP 도구 목록과 입력 스키마, 계약은 3.2.0과 같다. 바뀐 것은 도구 설명 문장, `start_workflow` 응답에 더한 필드 2개, 버전 표기, release 도구다. 3.2.0을 쓰는 호스트는 3.2.1로 바꾸고 AGS 프로세스를 다시 시작하면 새 설명이 보인다.

## 바뀐 점

### agy 설치본 자동 생성

- 저장소를 통째로 받은 폴더(디렉터리 442개)를 `agy plugin install`로 설치하면 Antigravity 앱의 맞춤 설정 → 설치됨 화면이 "Loading installed plugins..."에서 멈출 수 있다. 앱이 플러그인 폴더의 디렉터리를 감시 대상으로 등록하다 멈추는 것이 원인이고, agy가 읽지 않는 `claude-plugin/`, `tests/`, `.git/`이 디렉터리 대부분을 차지했다.
- 묶을 경로는 `release/antigravity-package.json` 한 곳에 둔다. `scripts/build-antigravity-package.mjs --ref <tag> --out <zip>`이 그 목록으로 `git archive`를 실행한다. 제외 패턴은 git의 `glob` 지정으로 넘겨 `**/`가 디렉터리 0개도 뜻하게 했다. 시험의 `path.matchesGlob`과 같은 뜻이다.
- release를 게시하면 `.github/workflows/antigravity-package.yml`이 그 태그로 zip을 만들어 `agent-governance-suite-antigravity-<tag>.zip`으로 붙인다. 같은 workflow를 `workflow_dispatch`(입력 `tag`)로 실행하면 다시 만들어 바꿔 붙인다. workflow는 그 태그의 스크립트와 목록을 쓰므로 v3.2.1 이후 태그에서만 동작한다.
- `tests/tooling/antigravity-package.test.mjs`는 hooks.json의 hook runner, mcp_config.json의 서버, 그 둘이 상대 경로로 불러오는 파일, engineering-practices `CONTENT_LOCK.json`이 적은 파일, 서버가 플러그인 루트에서 읽는 `skills/`·`contracts/`·`runtime/`이 목록에 빠지면 실패한다. 프로세스를 띄우지 않으므로 CI에서 돈다.
- README의 agy 설치 안내를 이 zip으로 바꿨다. `scripts/sync-release-metadata.mjs`가 `release-agy` 표식 안의 다운로드 주소와 파일 이름도 release 버전으로 맞춘다.

### 3.2.0 agy 설치본 수정

- 3.2.0에 올린 `agent-governance-suite-antigravity-v3.2.0.zip`에는 `claude-overlay/adaptations/code-review.json`과 `test-engineering.json`이 빠져 있었다. 그래서 그 설치본에서 `node runtime/engineering-practices/cli.mjs self-check`가 `IO_ERROR`로 실패했다(`catalog`·`check-*` 명령은 영향 없음). 3.2.1 목록으로 v3.2.0 태그를 다시 묶어 같은 이름으로 바꿔 올렸다(파일 614개, 디렉터리 174개).

### workflow 하한과 스킬 분류 안내

- Antigravity에서 `gemini-4-argon`(medium) 메인 세션이 `plan_workflow` 응답의 단계 하한(`minimumModelClass: general`, `minimumReasoningEffort: high`)과 `MODEL_NOT_IN_CATALOG`를 보고, 단계 기록이 거부될 것이라며 작업을 멈췄다. 3.2.0은 하한을 서브에이전트가 통과 기록을 낼 때만 적용하고 메인 세션은 모델·effort로 거부하지 않는데, 응답과 도구 설명 어디에도 그 사실이 없었다.
- 이제 `plan_workflow`·`start_workflow`·`record_stage_result` 설명에 하한은 서브에이전트의 통과 기록에만 적용되고 메인 세션은 거부되지 않으며, `MODEL_NOT_IN_CATALOG`와 `modelClass: null`은 기록일 뿐이라고 적는다.
- 같은 세션에서 `classify_skills`가 `NEEDS_INPUT`(`HOST_DISCOVERY_UNAVAILABLE`)을 돌려주자 분류를 진행할 수 없다고 보고했다. 이 값은 분류 지원(`AGENT_GOVERNANCE_CLASSIFICATION_CONFIG`)이 설정되지 않았다는 뜻이다. 이제 `classify_skills` 설명은 그때 `get_skill_inventory`에서 직접 골라 작업을 계속하라고 하고, `get_skill_inventory` 설명은 그 값이 설치된 스킬을 못 쓴다는 뜻이 아니라고 적는다.

### `start_workflow`로 시작한 run의 시험·리뷰 단계 기록

- `test-sensitivity-review`와 `change-code-review` 단계는 기록할 때 `engineering-stage-bundle`에 workflow의 TaskEnvelope 원본을 넣어 `taskDigest`와 맞춰 봐야 한다. 그런데 `start_workflow`는 서버가 기본값으로 채운 TaskEnvelope를 응답에 넣지 않았다. 그래서 `start_workflow`로 시작한 에이전트는 서버 코드를 읽고 envelope를 재구성하지 않는 한 이 두 단계를 기록할 수 없었다.
- 이제 `start_workflow` 응답에 `taskEnvelope`와 `taskDigest`가 들어 있다. `taskDigest`는 engineering-practices CLI의 `hashJson`과 같은 값이다.
- `start_workflow` 설명에 두 단계의 조건을 적었다. `test-sensitivity-review`는 수용 기준마다 required red-green 또는 mutation 사례가 필요하고, `change-code-review`는 리뷰 requirements가 수용 기준과 같아야 한다. CI 실행·release·설치처럼 시험으로 보일 수 없는 기준은 이 단계를 고른 run에 넣지 않는다. 지금까지는 설명이 이 단계를 예로 들면서 조건을 알리지 않아서, 기록하는 시점에 가서야 거부됐다.

## 업그레이드 시 확인할 것

- agy는 release의 `agent-governance-suite-antigravity-<tag>.zip`을 풀어 `agy plugin install <풀린 폴더>/agent-governance-suite`로 설치한다. Antigravity 앱이 켜져 있으면 기존 설치 폴더를 지우지 못해 `used by another process`로 실패하므로 앱을 닫고 설치한다.
- 예전 AGS의 도구 스키마 캐시(`~/.gemini/antigravity-cli/mcp/agent-governance-suite_ags/`, `~/.gemini/antigravity-ide/mcp/agent-governance-suite_ags/`)가 남아 있으면 `_sessionProof`처럼 지금은 없는 필드가 보인다. AGS는 이 필드를 인자로 받지 않는다(`RESERVED_CALLER_FIELD`).
- Claude Code와 Codex 설치 방법은 바뀌지 않았다.

## 알려진 제한

- 디렉터리 수를 줄여도 Antigravity 앱의 감시자 결함 자체가 없어지지는 않는다. 멈춤이 다시 나타나는지는 앱에서 확인해야 한다.
- 묶음 검사는 실행 파일 안의 상대 경로 문자열, 내용 잠금 목록, 정해진 세 디렉터리를 본다. 문자열을 조합해 만드는 새 경로는 이 검사가 찾지 못하므로 실호스트 시험으로 확인한다.
- 하한과 분류 안내는 도구 설명이다. 에이전트가 설명을 읽지 않고 예전 기억으로 판단하는 것까지 막지는 못한다.

## 검증
