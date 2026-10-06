# STATUS: claude-final-1 회수본 (worklog-append-1)

- 회수 시각: 2026-10-06T06:24:34Z. 새 시험·재실행·설치 재실행은 하지 않았다. 읽기 전용 확인과 파일 정리만 했다.
- 받은 source: HEAD `b7341d3e6636b79217b1f3d37d7a5014fcbf47be`, tree `5648f76558e923244cedf78a8263892d00df8299`, dirty 0(시작·종료·회수 시점 모두)
- 단계별 원 로그: 상위 폴더의 `logs/`와 `commands.jsonl`(seq 01–35), 이 폴더의 `raw-logs/`(seq 36–44). 기계 판독용 표는 상위 `status.json`에 있다.

| 단계 | 상태 | 마지막 실행 명령(seq) | 종료 사유 |
|---|---|---|---|
| A1 install | PASS | `pnpm install --frozen-lockfile --store-dir $ST/pnpm-store` (01) | exit 0, lock 변경 없음 |
| A2 bundle:check(build 전) | PASS | `pnpm bundle:check` (02) | exit 0 |
| A3 source:check | PASS | `pnpm source:check` (03) | exit 0 |
| A4 claude:drift | PASS | `pnpm claude:drift` (04) | exit 0, `claude-plugin: fresh` |
| A5 lint | PASS | `pnpm lint` (05) | exit 0 |
| A6 build | PASS | `pnpm build` (06) | exit 0, build 뒤 dirty 0 |
| A7 test(브리프 argv) | PASS(합계만) | `pnpm test -- --reporter=verbose --reporter=json --outputFile.json=…` (07) | exit 0, 916/5/0. reporter 인자가 무시돼 JSON 없음 |
| A7b test(`--` 제거) | PASS | `pnpm test --reporter=verbose --reporter=json --outputFile.json=…` (08) | exit 0, 921 = 916 pass / 5 skip / 0 fail |
| A8 node --test 관측 | PASS(관측) | `node --test --test-reporter=spec tests/cs-engineering/*.node.mjs` (09) | exit 0, 133/0 skip |
| A9 validate:all | PASS | (10) | exit 0 |
| A10 claude:check | PASS | (11) | exit 0, fresh |
| A11 bundle:check(build 후) | PASS | (12) | exit 0 |
| A12 release:check | PASS | (13) | exit 0 |
| A13 diff --check / fsck / porcelain / base 범위 diff --check | PASS | (14–17) | 모두 exit 0, porcelain 0 |
| runtime:check, skills:context-check | 기존근거결속 | 실행 안 함 | 4ba evidence 08·13 |
| validate:official | NOT_RUN | 실행 안 함 | 담당 Codex Cloud `01a10ee6` |
| B 복사·해시 | PASS | 셸 복사·sha256 비교(wrapper 밖) | 463/463 일치, node_modules 없음 |
| B validate.mjs 4종 | PASS | (18–21) | exit 0/0/0/2, 기대값 일치 |
| B MCP STDIO | PASS | (22) | 도구 28개, `$ref` 0, 조합자 0, 접수 문구 있음 |
| B plugin validate / --strict | 일반 PASS / strict 판정은 root | (23, 24) | 둘 다 exit 0, 경고 0 |
| C1 설치·목록·상세 | PASS | (25–28) | version 2.8.0, cs-engineering 노출 |
| C1 설치 캐시 해시 | PASS | 셸 비교(wrapper 밖) | 463 일치 / 불일치 0 / 누락 0 |
| C1 mcp list | PASS | (29) | Connected. 실행 경로는 readFromFolder 복사본 |
| C2 auth | PASS | (30) | loggedIn, oauth_token |
| C2 F1 | PASS(조건 1개 미충족) | 하위 세션 (32) | finalize passed. plan에서 bootstrap 25 선택은 관측 안 됨(67만 선택) |
| C2 NEG | PASS(거절 확인) | 하위 세션 (32) | finalize `INTEGRITY_FAILED` |
| C2 SUB | PASS | 하위 세션 (32) | actor `…:agent-0505a0db…` |
| C2 R24 1차 | FAIL | 하위 세션 (32) | `MISSING_EVIDENCE`. 입력 template 결함, 원출력 보존 |
| C2 F1B(strace) | PASS | 하위 세션 (34) | passed. record·finalize에서 check-stage-bundle 실행 관측 |
| C2 R24B | PASS | 하위 세션 (34) | passed. 260 KB outputFile |
| 게시: commit | 로컬만 PASS | `git commit -q -F …` (41) | commit `eff886e8…` |
| 게시: push | **FAIL(403)** | `git push origin HEAD:evidence` (43) | exit 128, git proxy 거부: 저장소가 세션 허용 범위 밖 |
| 후처리 원 로그 게시(append-1) | BLOCKED | 이 폴더(로컬 commit) | 같은 403 사유로 push 불가. 재시도 안 함 |

## 회수 시점 관측
- worker 재시작 뒤 kernel 가동 시간이 17.59초로 초기화됐다. container ID와 디스크 상태는 그대로다(`environment-recheck.json`).
- 재시작 전에 돌던 하위 Claude 세션과 MCP 프로세스는 남아 있지 않다(`ps-after-restart.txt`). 회수 단계에서 강제 종료한 프로세스는 없다.
