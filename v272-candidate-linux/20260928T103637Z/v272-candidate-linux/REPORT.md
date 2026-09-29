# v272-candidate-linux — 2.7.2 결합 최종 후보 84cd11dd Linux 검증

Linux cloud 컨테이너 한 곳에서 한 번만 돌린 실험이다. 사용자 PC의 설치 상태나 live 동작의 증거가 아니다.
시작 2026-09-28T10:13:21Z · 종료 2026-09-28T10:35:30Z · 로그 원문은 같은 폴더의 `NN-*.log`, 스크립트는 `scripts/`에 있다.

## 종합 판정
| 항목 | 판정 |
|---|---|
| 대상 대조(SHA·tree·parent·ls-tree·archive·dist hash) | PASS (모두 일치, archive hash도 git 2.43.0에서 일치) |
| AGENTS.md 검증 명령 | PASS (validate:official만 NOT_RUN: validator 부재) |
| 재빌드 동일성 | PASS (porcelain 비어 있음, 24/24 파일 일치) |
| 전체 test 2회 (`pnpm test --maxWorkers=2`) | PASS: 2회 모두 811 PASS / 0 FAIL / 1 SKIP |
| previous-broker v2.7.1 / v2.2.6 | PASS / PASS (skip 아님, 1/1 실행) |
| Node 24.0.0 전체 test와 runtime:check | PASS / PASS |
| 반복성 20회(seed 7001–7020) | PASS: 20회 모두 240 PASS, 0 FAIL, 1 SKIP, 변동 없음 |
| 설치 트리 smoke (a) stdio | PASS (version 2.7.2, 도구 28개) |
| 설치 트리 smoke (b) claude -p | PASS (plugin 2.7.2, MCP connected, hook 전부 exit 0, 도구 호출 성공, "세션 1개") |

## 1. 대상 대조
| 항목 | 기대 | 관측 | 판정 |
|---|---|---|---|
| origin/codex/v272-release | 84cd11ddd8267ced5169fb43b837f00a3f275b51 | 84cd11ddd8267ced5169fb43b837f00a3f275b51 (fetch와 ls-remote 둘 다) | PASS |
| tree | eed08f9675246c8519607f7b945dcd4055a14d92 | eed08f9675246c8519607f7b945dcd4055a14d92 | PASS |
| parent | 3d0d54b03925d30acece74d5529dce94113084d9 | 3d0d54b03925d30acece74d5529dce94113084d9 | PASS |
| ls-tree -r sha256 | 15117dd4…5ac22 | 15117dd408d06f32750fab934739a26dc5c5ea681237e546890b73eb61e5ac22 | PASS |
| archive tar sha256 | 841b5a82…9ed87 | 841b5a827b7aeca226c054e32871f60fdb58f6093c25026cf69ce6830479ed87 (git 2.43.0) | PASS |
| dist server.mjs (root·claude-plugin) | e7c9fae1…bfacda | 일치 | PASS |
| dist session-message-broker.mjs | fbb808e0…36f682 | 일치 | PASS |
| dist session-message-cli.mjs | 41977dab…42a98bb | 일치 | PASS |

## 2. 명령별 exit (/tmp/c, Node v24.21.0, pnpm 11.19.0)
| # | 명령 | exit | 판정 | 비고 |
|---|---|---|---|---|
| 02 | pnpm install --frozen-lockfile | 0 | PASS | |
| 03 | pnpm bundle:check | 0 | PASS | build 전에 실행 |
| 04 | pnpm claude:drift | 0 | PASS | "claude-plugin: fresh" |
| 05 | pnpm claude:check | 0 | PASS | "claude-plugin: fresh" |
| 06 | pnpm lint | 0 | PASS | "repository: valid" |
| 07 | pnpm build | 0 | PASS | 직후 `git status --porcelain` 비어 있음 (08) |
| 10 | pnpm runtime:check | 0 | PASS | "runtime: ready (29 skill CLIs, Node.js 24.21.0)" |
| 11 | pnpm validate:all | 0 | PASS | |
| 12 | pnpm validate:official | 1 | NOT_RUN | 제품 FAIL이 아니라 validator가 없어서 실행되지 않음. 원문: `Error: ENOENT: no such file or directory, access '/root/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py'` |
| 13 | pnpm release:check | 0 | PASS | "release metadata is synchronized" |
| 14 | pnpm source:check | 0 | PASS | "source lock is consistent" (원격 접근 없음, 404 없음) |
| 15 | git diff --check | 0 | PASS | 출력 없음 |
| 16 | git status --porcelain (검증 후) | 0 | PASS | 비어 있음 |

## 3. 재빌드 hash (build 후 작업 파일 대 `git show 84cd11dd:<path>`)
| path | working sha256 | committed sha256 | 결과 |
|---|---|---|---|
| `claude-plugin/hooks/continuity-hook.mjs` | `66cdba408b0555349589f7356a67f32833fa318e8565bc0fb576db96e1d2335b` | `66cdba408b0555349589f7356a67f32833fa318e8565bc0fb576db96e1d2335b` | MATCH |
| `claude-plugin/hooks/hooks.json` | `f357de9601dadc387d51d805508def7e844b2580b4ba2343b17d13dd157cf017` | `f357de9601dadc387d51d805508def7e844b2580b4ba2343b17d13dd157cf017` | MATCH |
| `claude-plugin/hooks/host-attestation-hook.mjs` | `a60ca41e0430c1568b928f18d8177cfd37e517826db6afb1d4bd29de3a6976ee` | `a60ca41e0430c1568b928f18d8177cfd37e517826db6afb1d4bd29de3a6976ee` | MATCH |
| `claude-plugin/hooks/session-board-hook.mjs` | `dc8516fb287dbd17436af8d53d9d4703809aaf64d9d6624ab0b3ed7193694697` | `dc8516fb287dbd17436af8d53d9d4703809aaf64d9d6624ab0b3ed7193694697` | MATCH |
| `claude-plugin/hooks/session-message-hook.mjs` | `7c9fe1a241a1c9413d1ecc4de0c4a6be03bff33266559630857f41ce770b59b0` | `7c9fe1a241a1c9413d1ecc4de0c4a6be03bff33266559630857f41ce770b59b0` | MATCH |
| `claude-plugin/hooks/skill-trigger-hook.mjs` | `5bad59e4809be0e3241a0a48767f8bda5f67e85a9dd23d19bfebedbb71f4f5ad` | `5bad59e4809be0e3241a0a48767f8bda5f67e85a9dd23d19bfebedbb71f4f5ad` | MATCH |
| `claude-plugin/mcp-server/dist/continuity-hook.mjs` | `6b386c368acc2a54b832addb647494e517dec0d48e36b310f1ff0381eaa52f70` | `6b386c368acc2a54b832addb647494e517dec0d48e36b310f1ff0381eaa52f70` | MATCH |
| `claude-plugin/mcp-server/dist/host-attestation-api.mjs` | `9efb5a1daa7cb3708f5519db2612d465d3f5bcc5c2e2594696d4fbde914a0e09` | `9efb5a1daa7cb3708f5519db2612d465d3f5bcc5c2e2594696d4fbde914a0e09` | MATCH |
| `claude-plugin/mcp-server/dist/host-attestation-hook.mjs` | `fb9dcfbc87a9e1d1ed6b689a59d47343f773ffdf6815a7e4f4ed2ae4dfcfe9c4` | `fb9dcfbc87a9e1d1ed6b689a59d47343f773ffdf6815a7e4f4ed2ae4dfcfe9c4` | MATCH |
| `claude-plugin/mcp-server/dist/server.mjs` | `e7c9fae1476372231f4f874a9c2a4a886e91ea0d4362a1caf0d75c0c14bfacda` | `e7c9fae1476372231f4f874a9c2a4a886e91ea0d4362a1caf0d75c0c14bfacda` | MATCH |
| `claude-plugin/mcp-server/dist/session-board-hook.mjs` | `597da92a6e9db853dcdf7cd0ef149561f6a36d5d6ed98be6c8f935204878b549` | `597da92a6e9db853dcdf7cd0ef149561f6a36d5d6ed98be6c8f935204878b549` | MATCH |
| `claude-plugin/mcp-server/dist/session-message-broker.mjs` | `fbb808e0fd8d52df17db7e7a8eeac84ed675f83a3abca9039f79740f2536f682` | `fbb808e0fd8d52df17db7e7a8eeac84ed675f83a3abca9039f79740f2536f682` | MATCH |
| `claude-plugin/mcp-server/dist/session-message-cli.mjs` | `41977dabc6a50c36e3128b50ed7717fc6057f60760601356c2d67d4c842a98bb` | `41977dabc6a50c36e3128b50ed7717fc6057f60760601356c2d67d4c842a98bb` | MATCH |
| `claude-plugin/mcp-server/dist/session-message-hook.mjs` | `3f4790c5f706b7ae79a3e38639f5e37baf4b1a71a1bbad8a4dfb039253dc67ea` | `3f4790c5f706b7ae79a3e38639f5e37baf4b1a71a1bbad8a4dfb039253dc67ea` | MATCH |
| `claude-plugin/mcp-server/dist/session-message-relay.mjs` | `c3c03c2772d4b6c02d693103816c16c3f456daed92039ebb2f62edf706c0afe0` | `c3c03c2772d4b6c02d693103816c16c3f456daed92039ebb2f62edf706c0afe0` | MATCH |
| `mcp-server/dist/continuity-hook.mjs` | `6b386c368acc2a54b832addb647494e517dec0d48e36b310f1ff0381eaa52f70` | `6b386c368acc2a54b832addb647494e517dec0d48e36b310f1ff0381eaa52f70` | MATCH |
| `mcp-server/dist/host-attestation-api.mjs` | `9efb5a1daa7cb3708f5519db2612d465d3f5bcc5c2e2594696d4fbde914a0e09` | `9efb5a1daa7cb3708f5519db2612d465d3f5bcc5c2e2594696d4fbde914a0e09` | MATCH |
| `mcp-server/dist/host-attestation-hook.mjs` | `fb9dcfbc87a9e1d1ed6b689a59d47343f773ffdf6815a7e4f4ed2ae4dfcfe9c4` | `fb9dcfbc87a9e1d1ed6b689a59d47343f773ffdf6815a7e4f4ed2ae4dfcfe9c4` | MATCH |
| `mcp-server/dist/server.mjs` | `e7c9fae1476372231f4f874a9c2a4a886e91ea0d4362a1caf0d75c0c14bfacda` | `e7c9fae1476372231f4f874a9c2a4a886e91ea0d4362a1caf0d75c0c14bfacda` | MATCH |
| `mcp-server/dist/session-board-hook.mjs` | `597da92a6e9db853dcdf7cd0ef149561f6a36d5d6ed98be6c8f935204878b549` | `597da92a6e9db853dcdf7cd0ef149561f6a36d5d6ed98be6c8f935204878b549` | MATCH |
| `mcp-server/dist/session-message-broker.mjs` | `fbb808e0fd8d52df17db7e7a8eeac84ed675f83a3abca9039f79740f2536f682` | `fbb808e0fd8d52df17db7e7a8eeac84ed675f83a3abca9039f79740f2536f682` | MATCH |
| `mcp-server/dist/session-message-cli.mjs` | `41977dabc6a50c36e3128b50ed7717fc6057f60760601356c2d67d4c842a98bb` | `41977dabc6a50c36e3128b50ed7717fc6057f60760601356c2d67d4c842a98bb` | MATCH |
| `mcp-server/dist/session-message-hook.mjs` | `3f4790c5f706b7ae79a3e38639f5e37baf4b1a71a1bbad8a4dfb039253dc67ea` | `3f4790c5f706b7ae79a3e38639f5e37baf4b1a71a1bbad8a4dfb039253dc67ea` | MATCH |
| `mcp-server/dist/session-message-relay.mjs` | `c3c03c2772d4b6c02d693103816c16c3f456daed92039ebb2f62edf706c0afe0` | `c3c03c2772d4b6c02d693103816c16c3f456daed92039ebb2f62edf706c0afe0` | MATCH |

dist와 hooks 폴더에 추적되지 않은 파일은 없다.

## 4. 전체 test
| 실행 | 방식 | 파일 | tests | PASS | FAIL | SKIP | exit |
|---|---|---|---|---|---|---|---|
| 17 run1 | `node vitest.mjs run` 직접 실행 | 60 | 812 | 810 | 1 | 1 | 1 |
| 18 run2 | `node vitest.mjs run` 직접 실행 | 60 | 812 | 810 | 1 | 1 | 1 |
| **20 run1** | **`pnpm test --maxWorkers=2`** | 60 | 812 | **811** | **0** | 1 | 0 |
| **21 run2** | **`pnpm test --maxWorkers=2`** | 60 | 812 | **811** | **0** | 1 | 0 |

- 17·18의 FAIL: `tests/tooling/commands.test.mjs > skill maintenance commands > forwards pnpm script arguments without a standalone separator` (`expect(process.env.npm_execpath).toBeTruthy()`, received undefined). 이 테스트는 pnpm으로 실행될 때만 설정되는 `npm_execpath`를 요구한다. 17·18에서는 vitest를 pnpm 없이 직접 실행했기 때문에 실패했다. 실행자 쪽 문제이므로 제품 FAIL로 세지 않는다. 저장소가 정한 `pnpm test`로 두 번 다시 실행한 결과(20·21)를 판정 근거로 쓴다. 두 로그는 모두 보존했다.
- SKIP(모든 실행에서 같음): `tests/session-messaging/previous-broker.test.ts > preserves queued messages when new hooks meet the previous released broker`. `AGS_PREVIOUS_BROKER_PATH`가 없을 때 skipIf로 건너뛴다. 5절에서 따로 실행했다.
- Windows에서 관측된 "812 PASS"와 다른 점: 이 환경에서는 previous-broker가 skip되어 811 PASS + 1 SKIP이다.

## 5. previous-broker (설치 트리는 git archive로 풀었고 node_modules 없음)
테스트 파일이 요구하는 env는 `AGS_PREVIOUS_BROKER_PATH`다(12행). `BROKER_TEST_PLUGIN_ROOT`는 선택값이며 기본값은 후보 저장소 루트이고, 설정하지 않았다.
| tag | commit | broker sha256 (= tag blob) | 결과 | 판정 |
|---|---|---|---|---|
| v2.7.1 | d5c5932cd5a0d87630f6ed94f8e3721181ab9864 | d4b667d417c6c8a8beaf749a2209ab1a8d1548a26d1f819dfcc6238a6711ab80 | 1 passed (1591ms), exit 0 | PASS |
| v2.2.6 | 863ed7ac807a306e8c5cabcfb99c8ac0a5a5d1ea | 14f9345d3b18611fe0d5799ae56d65e3e80708ee288bbd771aafa5611a1a1cc3 | 1 passed (1398ms), exit 0 | PASS |

## 6. Node 24.0.0 (SHASUMS256.txt 검증 OK, 별도 PATH)
| 명령 | 결과 | 판정 |
|---|---|---|
| `pnpm test --maxWorkers=2` (23) | 60 파일, 812 tests: 811 PASS / 0 FAIL / 1 SKIP(previous-broker, 같은 이유), exit 0 | PASS |
| `pnpm runtime:check` (24) | "runtime: ready (29 skill CLIs, Node.js 24.0.0)", exit 0 | PASS |

## 7. 반복성: session-messaging 폴더와 stdio-integration, shuffle, `--maxWorkers=2`, Node 24.21.0
대상은 `tests/session-messaging`(8파일)과 `tests/mcp/stdio-integration.test.ts`로 모두 9파일이다.
| seed | files | tests | pass | fail | skip | duration |
|---|---|---|---|---|---|---|
| 7001 | 9 | 241 | 240 | 0 | 1 | 27.7s |
| 7002 | 9 | 241 | 240 | 0 | 1 | 29.7s |
| 7003 | 9 | 241 | 240 | 0 | 1 | 26.9s |
| 7004 | 9 | 241 | 240 | 0 | 1 | 24.6s |
| 7005 | 9 | 241 | 240 | 0 | 1 | 30.0s |
| 7006 | 9 | 241 | 240 | 0 | 1 | 28.3s |
| 7007 | 9 | 241 | 240 | 0 | 1 | 31.6s |
| 7008 | 9 | 241 | 240 | 0 | 1 | 31.7s |
| 7009 | 9 | 241 | 240 | 0 | 1 | 25.9s |
| 7010 | 9 | 241 | 240 | 0 | 1 | 25.3s |
| 7011 | 9 | 241 | 240 | 0 | 1 | 27.4s |
| 7012 | 9 | 241 | 240 | 0 | 1 | 24.7s |
| 7013 | 9 | 241 | 240 | 0 | 1 | 27.0s |
| 7014 | 9 | 241 | 240 | 0 | 1 | 27.3s |
| 7015 | 9 | 241 | 240 | 0 | 1 | 31.4s |
| 7016 | 9 | 241 | 240 | 0 | 1 | 24.9s |
| 7017 | 9 | 241 | 240 | 0 | 1 | 29.9s |
| 7018 | 9 | 241 | 240 | 0 | 1 | 25.5s |
| 7019 | 9 | 241 | 240 | 0 | 1 | 25.0s |
| 7020 | 9 | 241 | 240 | 0 | 1 | 26.3s |

20회 모두 PASS 수가 240으로 같았고 FAIL은 한 번도 없었다. SKIP 1건은 매번 previous-broker(env 없음)였다.

## 8. 설치 트리 smoke (이 환경에서만 판정)
- /tmp/inst는 `git archive 84cd11dd`로 만들었고 node_modules가 없다. 상태 env 6개는 모두 /tmp/R 아래를 가리키게 했다(`scripts/smoke-env.sh`).
- (a) stdio (28): initialize 응답 serverInfo는 `{"name":"agent-governance-suite","version":"2.7.2"}`, protocol은 2025-06-18이다. tools/list는 28개를 돌려줬다. **PASS**
- (b) `claude -p` (30, 요약은 31). claude 2.1.283, cwd /tmp/R/work.
  - init: plugin `agent-governance-suite` 2.7.2 (path /tmp/inst/claude-plugin), MCP `plugin:agent-governance-suite:agent-governance-suite`의 status는 **connected**, 노출된 도구는 28개다.
  - hook: SessionStart 3개, UserPromptSubmit 3개, PostToolUse(ToolSearch), PreToolUse(list_session_status)는 permissionDecision allow와 _sessionBinding host=claude-code 주입, PostToolUse(list_session_status), Stop. 모두 outcome success, exit 0.
  - 도구 호출: `list_session_status` 결과는 ok:true이고 sessions 1개다(current:true). 참고로 같은 항목의 stale 값이 true였다. 최종 답은 "세션 1개입니다.", is_error false, 3 turns.
  - 판정 **PASS**
- $HOME/.agent-governance-suite: smoke 전후 목록(경로·크기·mtime)의 diff가 비어 있어 **새 파일이 없다** (27, 32). 이 폴더의 기존 파일(session-messaging/trust.sqlite3*, 10:13:15 생성)은 이 cloud 세션을 연 호스트 Claude Code가 띄운 main checkout(b31eeff) MCP 서버 PID 183이 만든 것이다(29). 후보 검증과는 관계없다.
- 관찰: smoke가 띄운 broker(/tmp/inst/claude-plugin/.../session-message-broker.mjs, PID 9704)는 `claude -p`가 끝난 뒤에도 남아 있었다. SIGTERM 뒤 4초 안에 종료했다(33, 34). 상주 broker 설계에 맞는 동작으로 보이지만 판정하지 않았다(UNKNOWN).
- /tmp/R에 생성된 파일 이름과 크기만 34에 적었다. 키·토큰·trust DB 본문은 evidence에 넣지 않았다.

## NOT_RUN과 이유
- `pnpm validate:official`: Codex 공식 validator(`/root/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py`)가 컨테이너에 없어 ENOENT로 exit 1이 났다. validator는 실행되지 않았다.
- 그 밖에 NOT_RUN은 없다. source:check는 원격 조회를 하지 않았으므로 NOT_VERIFIABLE 항목도 생기지 않았다. 서비스 429/5xx나 네트워크 실패도 없었다.

## 환경
Node v24.21.0(latest-v24.x)과 v24.0.0은 둘 다 SHASUMS256으로 검증했다(00). pnpm 11.19.0(corepack), git 2.43.0, claude 2.1.283. 컨테이너 기본 Node는 v22.22.2였고 사용하지 않았다.
