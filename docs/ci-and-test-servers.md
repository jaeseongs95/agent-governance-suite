# CI와 테스트 서버의 역할

## 원칙

CI가 실패하면 코드 결함이어야 한다. 러너가 바빠서 떨어지는 시험은 CI에 두지 않는다. 실제 프로세스와 OS 동작은 Linux·Windows 테스트 서버에서 실측한다.

## 나누는 기준

`scripts/test-scope.mjs`가 시험 파일 내용으로 정한다. 사람이 목록을 관리하지 않는다.

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

## 바꾼 이유(3.2.0)

- 예전 CI는 OS마다 job 하나에서 전체 시험 283개 파일을 돌렸다.
- Windows 러너에서는 파일 시간 합이 약 1605초였고, 10초를 넘는 파일이 42개였다. 그중 대부분은 실제 프로세스를 띄우는 시험이었다.
- 같은 시험이라도 러너 부하에 따라 걸리는 시간이 달랐다. 예를 들어 runtime smoke는 이 PC에서 8.8초 걸렸는데, CI에서는 10.3초, 14.6초, 30.8초 이상(시간 초과)으로 매번 달랐다.
- 빌드는 두 번 돌았다. `Build` 단계에 이어 `pnpm test` 안에서 또 빌드했다.
- runtime smoke도 두 번 돌았다. vitest 시험으로 한 번, `runtime:check` 단계로 또 한 번 돌았다.
- 바꾼 뒤 CI는 빌드를 한 번만 하고, 실측 시험과 runtime smoke는 테스트 서버로 옮겼다.
