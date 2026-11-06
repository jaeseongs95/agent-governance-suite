# AGS 3.8 Windows host runtime 판별 사례

입력 핀: `a281139387af096e696f8d50cc089ad09e9291fc`, 작업 브랜치 `codex/ags38-host-runtime`.
원관측: `D:/codex/build/ags-01a14016-release-resume/defect-inventory.json`의 AGS3-D-0014, D-0016, D-0027. 이 파일의 과거 상태를 현재 실측으로 승격하지 않는다.
실행 위치: Windows TEST와 Linux TEST. 로컬은 소스 열람, `node --check`, lint만 허용한다. 기존 실패 재실행 성공을 원인 증명으로 보지 않는다.

## 관측과 경쟁 가설

| 결함 | 보존한 관측 | 가설 | 판별 관측 |
| --- | --- | --- | --- |
| D0014 | clean-room SessionStart 자식 stdout/stderr 0, 10s SIGTERM/ETIMEDOUT; 현재 smoke는 30s | H14a Node 로딩/번들 평가 지연; H14b stdin EOF 대기; H14c 동기 SQLite open/exec/prepare 또는 hook 처리 지연; H14d 처리 후 프로세스 생존 | preload 시작, fd0 읽기 시작/완료, SQLite 호출 시작/완료, beforeExit/exit, 부모 close와 CPU 사용 |
| D0016 | sibling profile-workspace 자식 10s SIGTERM 1회, 후속 미재현 | H16a 첫 stdin 조각/EOF 지연; H16b 파일 조사·Git 동기 자식 지연; H16c Node/번들 초기 평가 지연 | stdin 소비/EOF, Git spawnSync 시작/완료, 출력과 close 시각 |
| D0027 | copy+child+cleanup 전체 30s 실패(33004ms), child 제한은 10s | H27a 복사/정리 비용; H27b 서버 초기화 지연; H27c initialize 이후 tools/list 지연; H27d 응답 후 종료 대기 | 기존 acceptance-bundle-startup 단계 기록 및 responseIds; 추가 동일 clean-room 자식 관측 |

## 불변조건과 검증 의무

- CS-L1: stdin은 EOF 전 판정하지 않고 UTF-8 중간 경계의 원문을 보존한다. 자식 소비 marker를 받은 뒤 나머지 바이트와 EOF를 보내는 실제 pipe 시험으로 확인한다.
- CS-L2: 동기 호출 중 같은 이벤트루프의 timer가 실행된다고 가정하지 않는다. 부모의 실제 process timeout과 자식의 동기 경계 기록을 함께 쓴다.
- CS-L3: 응답 준비, JSON-RPC initialize/tools/list 수신, stdin EOF, 프로세스 close를 구별한다. 응답 ID와 종료 상태를 각각 검증한다.
- CS-L4: 시험 자식·임시 디렉터리만 정리한다. 실패 원출력과 단계 기록을 보존하고 timeout/cleanup 실패를 PASS로 바꾸지 않는다.
- CS-L5: 판별 계측은 시험 fixture의 preload에만 둔다. 새 상주 프로세스·운영 탐지 계층·timeout 증가는 도입하지 않는다.

## 실행 전 사례

| ID / 요구 | 입력·사전조건 | 절차 | 기대 / 판정 기준 | 실제 |
| --- | --- | --- | --- | --- |
| HR14 / D0014 | Node24+, node_modules 없는 contracts/runtime/skills 및 bundled continuity-hook, 격리 state, SessionStart startup | 10s 부모 deadline으로 직접 실행하고 경계/CPU/close 기록 | exit0, stdout 비어 있음, 10s 이내. 실패 시 마지막 시작/완료 경계로 H14a-d 분리. 원인 미재현은 UNKNOWN 유지 | NOT_RUN |
| HR16 / D0016 | root 및 Claude 실제 profile-workspace CLI, 기존 python fixture, 한글 `리¢😀` taskObjective, 격리 state | 첫 한글 바이트 중간에서 split, 자식 소비 marker 대기, EOF 전 stdout 없음 확인, 나머지+EOF 전송; 10s deadline | PASS JSON, taskObjective 보존, signal null, exit0. marker/EOF/Git/close 기록으로 H16a-c 분리 | NOT_RUN |
| HR27 / D0027 | 설치물과 같은 clean-room server, initialize/initialized/tools/list 줄 입력 | 기존 acceptance-bundle-startup 30s 전체 제한과 10s child 제한 유지; 단계와 ID 기록. 새 fixture에서도 child와 복사/정리 각각 기록 | initialize id1, tools/list id2 및 plan_workflow 도구, exit0. 30s 전체 초과는 실패 유지 | NOT_RUN |
| HR-SYNTAX | 소유 새 `.mjs` | `node --check tests/runtime/ags38-host-runtime-startup.node-test.mjs` | exit0. 제품 동작 검증 아님 | PASS exit0, `34a778f7f936dfe808d7f2bf308eb9b21332eacf` 소스. `git diff --check`도 exit0 |

기존 runner: `scripts/run-tests.mjs`가 `.node-test.mjs`를 Node native runner로 수집하며 프로세스 시험은 서버 범위다. 새 runner/의존성 없이 이 경계를 사용한다.

## 원격 명령과 중단 조건

1. `git rev-parse HEAD`, Node version/platform/arch, 동시 node process의 CPU/WorkingSet 기록. 비밀·다른 세션 로그 열람 금지.
2. `node --test tests/runtime/ags38-host-runtime-startup.node-test.mjs`
3. `node --test --test-name-pattern=profile-workspace tests/tooling/sibling-stdin-utf8.node-test.mjs`
4. `pnpm exec vitest run tests/runtime/acceptance-bundle-startup.test.mjs --maxWorkers=1`
5. `node scripts/check-runtime.mjs`

각 명령을 순차 실행하고 SHA, 명령, 종료 코드, 원출력을 보존한다. 첫 실패는 제거하지 않는다. 새 관측 없는 동일 검사 반복 금지. 자식 timeout은 해당 사례 실패이며 다른 원인의 성공으로 덮지 않는다. 원인 확인 전 제품 코드 변경 금지.

## 최초 판정(Windows TEST 전)

DiagnosisReport.v1 의미 판정: NEXT_TEST. 세 과거 episode의 환경 digest/원시 실패 출력은 아직 전달되지 않아 원인을 확정하지 않았다. source에서 확인된 동기 stdin·SQLite·Git 경계는 지연 가능 경계이며 과거 실패의 인과 증명은 아니다. 제품 수리는 없음.

확인한 경계: `continuity-hook.ts`의 main은 `readFileSync(0)` → `runContinuityHook` → 동기 두 SQLite store 초기화·handle·close다. `profile-workspace.mjs`의 gitInfo는 timeout 없는 `spawnSync` 네 번을 사용한다. MCP `index.ts`는 store·validator·classification 초기화 뒤 `StdioServerTransport`에 연결한다. 이 사실만으로 과거 timeout 원인으로 판정하지 않는다.

저장소 `docs/ci-and-test-servers.md`는 Windows CI의 runtime smoke가 10.3s/14.6s/30.8s 이상으로 변동했고 프로세스 시험을 TEST 서버로 옮겼음을 기록한다. 이 과거 문서의 환경 설명도 세 원실패의 인과 증명이 아니며 현재 허용된 TEST에서 실측한다.

## Windows TEST 첫 판별 결과와 HR16 범위 회귀 계획

원자료 직접 조회: operation `1fac0eca5588c4a15248c70c4c7fd28991442c2ee303baa3`, output cursor 0/16384/32768, eof 35971 bytes, page SHA256 `2d3e142dbf32d99e24cd8cb92044bb68fda18f78e1beeb14c883427b77a7a79c`. remote `C:/ags-330-test/v380-host-01a14016/probe.log`, 소스 `34a778f7f936dfe808d7f2bf308eb9b21332eacf`, Node `24.22.2`.

- 실제 제품시험은 `PROBE_EXIT=1`: Node 집계 tests5/pass3/fail2(상위 집계 포함). 원자료를 읽은 wrapper exit0는 제품시험 통과가 아니다.
- HR14: 466ms, exit0, fd0 읽기61→62ms, SQLite 처리·close 후 beforeExit/exit297ms. D0014 원실패 미재현이며 원인 UNKNOWN 유지.
- HR16 source ASCII 첫 자식: 10023ms SIGTERM, stdout0. stdin enter264/first-consumed272/eof274ms. Git 호출339→492,492→643,643→783ms, 네 번째783ms enter 뒤 완료 없이 종료. 소스의 네 번째 명령은 `git -C <workspaceRoot> status --porcelain=v1 --untracked-files=all`이며 workspaceRoot는 저장소 하위 python fixture다. 요청 workspace 밖 전체 checkout 조사를 하는 경계에서 정체가 직접 관측됐다. stdin EOF 대기 가설은 이 실행에서 반박됐다.
- HR16 Claude ASCII 후속 자식: 5368ms, 네 번째 Git719→5198ms. 그 다음 split UTF8:1096ms, 네 번째 Git689→925ms. 실행 순서에 따른 차이는 실측이며 OS cache/백신 등 내부 원인은 확정하지 않는다. 후속 성공으로 첫 실패를 덮지 않는다.
- HR27:1457ms exit0 및 initialize/tools-list 정상, copy2655ms, cleanup153ms. D0027 원실패 미재현이며 원인 UNKNOWN 유지.

HR16-SCOPE 사전 사례: 격리 Git 저장소 안 nested workspace를 프로파일한다. 외부 tracked 파일 수정 및 외부 untracked 파일 추가 후 nested dirtyState와 fingerprint는 clean 기준과 같아야 한다. 같은 repository root를 요청하면 dirty여야 한다. nested 내부 tracked 파일 수정 후에는 dirty 및 fingerprint 변경을 감지해야 한다. 전후 Git status는 같아야 한다(읽기 전용). 입력·절차는 새 `tests/tooling/ags38-host-runtime-git-scope.node-test.mjs`, 실행은 TEST의 `node --test tests/tooling/ags38-host-runtime-git-scope.node-test.mjs`. 수정 전 RED와 수정 후 GREEN은 원래 파일을 되돌리지 않고 별도 핀으로 실행한다. 현재 NOT_RUN.

수리 불변조건: gitInfo의 소비자는 workspace의 vcsType/currentRef/dirtyState와 profileFingerprint의 currentRef/currentRevision/status뿐이다. branch·revision 조회는 유지하고 status만 요청 workspace의 `-- .` pathspec으로 제한한다. 요청 내부 변경 감지와 저장소 root 요청의 전체 상태 감지는 유지해야 한다. 원래10s 자식 제한은 유지한다.

## 수리 전달 상태

- 회귀 test-only 핀: `40511b5061a7ea2285a7b533e7fd1d093d861634`. 소스 변경 전 RED 실행 대상이며 실제 결과 NOT_RUN.
- 제품 수리 핀: `ab7b8e6af4a09f55a0f08f9340536172d15a9532`. `skills/workspace-convention-profiler/scripts/profile-workspace.mjs:123`의 status argv에 `-- .`를 추가한 한 줄 변경. Git ref/revision과 자식 timeout은 변경하지 않았다.
- source와 새 scope test의 로컬 `node --check`, `git diff --check` 종료 코드0. 로컬 제품시험·Docker·서버 직접 변경·생성물 수정은 수행하지 않았다.
- GREEN 후보는 root 소유 Claude 생성물 재생성 후 핀을 고정하고 Windows TEST에서 scope 회귀와 기존 startup probe를 실행한다. 현재 NOT_RUN이며 SOURCE_FIXED 수용 또는 VERIFIED 판정을 하지 않는다.
- 인과 범위: 새 Windows episode의 EOF 이후 repository-wide Git status 정체는 직접 관측·최소 수리했다. 최초 3.6.0 단발 episode와 OS cache/백신 내부 원인은 여전히 미확인이다. D0014/D0027은 이번 미재현으로 종료하지 않는다.
