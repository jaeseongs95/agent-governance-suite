# AGS 3.2.1 릴리스 노트

3.2.1은 Antigravity(agy) 설치본을 release마다 자동으로 만들어 붙인다. AGS 실행 코드, DB 스키마, MCP 도구 목록, 계약은 3.2.0과 같고 버전 표기만 바뀌었다. 3.2.0을 쓰는 호스트는 바꾸지 않아도 된다.

## 바뀐 점

### agy 설치본 자동 생성

- 저장소를 통째로 받은 폴더(디렉터리 442개)를 `agy plugin install`로 설치하면 Antigravity 앱의 맞춤 설정 → 설치됨 화면이 "Loading installed plugins..."에서 멈출 수 있다. 앱이 플러그인 폴더의 디렉터리를 감시 대상으로 등록하다 멈추는 것이 원인이고, agy가 읽지 않는 `claude-plugin/`, `tests/`, `.git/`이 디렉터리 대부분을 차지했다.
- 3.2.0에서는 agy가 읽는 파일만 손으로 묶어 release에 올렸다(`agent-governance-suite-antigravity-v3.2.0.zip`, 디렉터리 172개).
- 이제 묶을 경로는 `release/antigravity-package.json` 한 곳에 둔다. `scripts/build-antigravity-package.mjs --ref <tag> --out <zip>`이 그 목록으로 `git archive`를 실행한다. 3.2.0 태그로 실행하면 3.2.0에 올린 zip과 바이트까지 같다.
- release를 게시하면 `.github/workflows/antigravity-package.yml`이 그 태그로 zip을 만들어 `agent-governance-suite-antigravity-<tag>.zip`으로 붙인다. 이미 있는 release는 같은 workflow를 `workflow_dispatch`(입력 `tag`)로 실행해 다시 만들 수 있다.
- `tests/tooling/antigravity-package.test.mjs`는 hooks.json의 hook runner, mcp_config.json의 서버, 그 둘이 상대 경로로 불러오는 파일, 서버가 플러그인 루트에서 읽는 `skills/`·`contracts/`·`runtime/`이 목록에 빠지면 실패한다. 프로세스를 띄우지 않으므로 CI에서 돈다.

## 업그레이드 시 확인할 것

- agy는 release의 `agent-governance-suite-antigravity-<tag>.zip`을 풀어 `agy plugin install <풀린 폴더>/agent-governance-suite`로 설치한다. Antigravity 앱이 켜져 있으면 기존 설치 폴더를 지우지 못해 `used by another process`로 실패하므로 앱을 닫고 설치한다.
- Claude Code와 Codex 설치 방법은 바뀌지 않았다.

## 알려진 제한

- 디렉터리 수를 줄여도 Antigravity 앱의 감시자 결함 자체가 없어지지는 않는다. 멈춤이 다시 나타나는지는 앱에서 확인해야 한다.
- 묶음 검사는 실행 파일 안의 상대 경로 문자열과 정해진 세 디렉터리를 본다. 문자열을 조합해 만드는 새 경로는 이 검사가 찾지 못하므로 실호스트 시험으로 확인한다.

## 검증
