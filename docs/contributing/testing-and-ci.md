# CI와 테스트 서버의 역할

## 원칙

CI가 실패하면 코드 결함이어야 한다. 러너가 바빠서 떨어지는 시험은 CI에 두지 않는다. 실제 프로세스와 OS 동작은 Linux·Windows 테스트 서버에서 실측한다.

## 나누는 기준

`scripts/test-scope.mjs`가 시험 파일 내용으로 정한다. 사람이 목록을 관리하지 않는다. 대상은 vitest가 찾는 모든 시험 파일(저장소 전체에서 `node_modules`·`.git` 제외)과 `run-tests.mjs`가 모으는 node:test 파일이다. `tests/tooling/test-scope.test.mjs`가 이 대상과 두 실행기가 실제로 모으는 파일 목록이 같은지 확인한다. 3.4.0 전에는 `tests/` 아래만 분류해서 `antigravity-connector/hooks/`의 프로세스 시험이 CI에서 돌았다.

- **테스트 서버 전용**: 시험 파일이나, 그 파일이 가져오는 `tests/`·`scripts/`·`skills/` 아래 로컬 모듈이 다음 중 하나를 쓰는 경우다.
  - `child_process`
  - `worker_threads`
  - stdio MCP 서버(`StdioClientTransport`)
- **CI**: 나머지 시험. 프로세스 안에서만 돌기 때문에 판정이 러너 속도에 따라 바뀌지 않는다.

`node scripts/test-scope.mjs`를 실행하면 두 쪽의 파일 수가 나온다.

## 실행 위치

| 위치 | 명령 | 범위 |
|---|---|---|
| GitHub Actions(ubuntu·windows) | `AGS_TEST_SCOPE=ci node scripts/run-tests.mjs` | 정적 검사 + CI 범위 시험 |
| Linux·Windows 테스트 서버 | `pnpm test:server` | 전체 시험 + 설치 런타임 smoke(`check-runtime.mjs`) |

발행 후보는 두 곳에서 모두 통과해야 한다. 이와 별도로 Claude·Codex·agy 실호스트 시험도 테스트 서버에서 한다.

서버 전용 시험은 CI Windows에서 돌지 않는다. Windows 동작은 Windows 테스트 서버 전체 시험에서만 확인된다. 3.3.0 후보에서는 이 단계에서 시험 fixture의 `D:/` 드라이브 고정 경로가 드러났다. 이 서버에는 D:가 없다.

### 개발 중 확인(3.4.0)

`AGS_TEST_SCOPE=server node scripts/run-tests.mjs`는 서버 전용 시험만 돈다. 개발 중에는 CI(`ci` 범위, ubuntu·windows)와 테스트 서버(`server` 범위)를 동시에 돌려 같은 시험을 두 번 기다리지 않는다. 두 범위를 합치면 전체다. 정해진 값 밖의 `AGS_TEST_SCOPE`는 오류로 멈춘다. 발행 후보는 지금처럼 범위 없이 전체를 돈다.

`run-tests.mjs`는 vitest가 실패해도 node:test를 끝까지 돌리고 `{"runner":"summary","vitestExitCode":…,"nodeExitCode":…}`로 두 결과를 함께 알린다. 종료 코드는 하나라도 실패하면 실패다. 예전에는 vitest가 실패하면 node:test가 돌지 않아 그 결과를 보려고 다시 돌려야 했다.

이 방향은 3.4.0 토론으로 정했다(reviewer 3명, 결정 기록은 [`docs/release-notes/release-notes-v3.4.0.md`](../release-notes/release-notes-v3.4.0.md)). isolate·pool·worker 수는 바꾸지 않았다. 모듈 캐시와 공유 상태 디렉터리 때문에 시험 사이 상태가 섞일 수 있고, 2코어 서버에서는 vitest가 이미 worker를 1개만 쓴다. 시간은 느린 시험의 원인을 고쳐 줄였다.

## 바꾼 이유(3.2.0)

- 예전 CI는 OS마다 job 하나에서 전체 시험 283개 파일을 돌렸다.
- Windows 러너에서는 파일 시간 합이 약 1605초였고, 10초를 넘는 파일이 42개였다. 그중 대부분은 실제 프로세스를 띄우는 시험이었다.
- 같은 시험이라도 러너 부하에 따라 걸리는 시간이 달랐다. 예를 들어 runtime smoke는 이 PC에서 8.8초 걸렸는데, CI에서는 10.3초, 14.6초, 30.8초 이상(시간 초과)으로 매번 달랐다.
- 빌드는 두 번 돌았다. `Build` 단계에 이어 `pnpm test` 안에서 또 빌드했다.
- runtime smoke도 두 번 돌았다. vitest 시험으로 한 번, `runtime:check` 단계로 또 한 번 돌았다.
- 바꾼 뒤 CI는 빌드를 한 번만 하고, 실측 시험과 runtime smoke는 테스트 서버로 옮겼다.
