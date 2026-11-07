# native Claude 예산 옵션: 사전 사례

기준 `1f050e5d89f84c4f5ed7157330cb7b032b5d693e`. 제품·원 D36 spec·22 fixture·T4 prompt는 변경하지 않는다. 선택 입력은 기존 CUE 환경 패턴의 `CUE_MAX_BUDGET_USD`이며 기본 무지정 동작을 유지한다.

## 선행조건·실제 경계

Linux TEST에서 원 operator와 동일한 Node24 PATH의 공식 Claude `2.1.316 (Claude Code)` help를 직접 읽었다. `--max-budget-usd <amount>`는 “Maximum dollar amount to spend on API calls (only works with --print)”다. operation `d931817797b37fb6a4fd7d7f31f7c725a27821496c7d13d0`, exit0. 기본 shell의2.1.314와 구분하며 원 Node24/CLI316 guard는 유지한다.

실제 `plugin-run.mjs` → `claude-stream.mjs` → native CLI argv 경로를 시험한다. driver는 이미 `-p`를 전달한다. 기존 `CLAUDE_BIN` seam에 합성 CLI를 넣어 인자를 관측하며 모델·로그인·hook·MCP는 실행하지 않는다. Linux 전용 원 runner이므로 다른 OS에서는 이 suite를 skip한다. 로컬 제품시험은 하지 않는다.

## engineering-test-plan

| ID·요구 | 입력·전제 | 절차 | 기대·FAIL 판정 | 최초 actual |
| --- | --- | --- | --- | --- |
| NB1 양수 cap 전달 | Claude cap `1`, `0.25`, 자기 synthetic plugin/files/turn | 실제 wrapper/driver execute 후 합성 CLI의 argv와 cleanup 읽기 | `-p`·원 model/effort/plugin-dir 보존, cap option/value 한 번, exit0·cleanup CONFIRMED. 누락·중복·다른 값 FAIL | NOT_RUN |
| NB2 무지정 보존 | Claude cap 환경입력 부재 | 동일 경계 한 합성 턴 | cap option 없음, model/effort 보존·exit0. 임의 기본 cap 추가 FAIL | NOT_RUN |
| NB3 잘못된 cap | `0`, `-1`, 빈 문자열, `NaN`, `Infinity` | 실제 wrapper CLI | 유한 양수 입력 오류·비정상 종료·run 및 CLI 기록 없음. fixture/child 시작 FAIL | NOT_RUN |
| NB4 Codex cap 금지 | Codex cap `1` | 실제 wrapper CLI | Claude 전용 오류·비정상 종료·run/child 없음. 임의 옵션 전달 또는 무시 성공 FAIL | NOT_RUN |
| NB5 Codex 기본 보존 | cap 없음, 유효 synthetic installed pin | 기존 prepare mode | host=codex·원 turn·exit0, 모델/CLI 시작0. 기본 경로 변화 FAIL | NOT_RUN |

명령은 `node --test tests/real-host/cue-ab/plugin-run-budget.node-test.mjs`로 고정한다. 같은 시험 바이트로 test-only RED와 수정 GREEN을 대조한다. cap 누락/입력 수락 assertion을 RED로 삼고 import·환경 오류는 제외한다. 새 runner·framework·native 모델 실행·설치·auth/config 복사는 하지 않는다.

## 보존과 제한

원 spec SHA256 `a8eef1d528acc2a1b2611d0459cf0b4222f48eb1d0c50f3d371de9d96ad8af39`, 원 operator SHA256 `78ce48f491c751040e748dbd3a73ced5e3f8dab3c227fe7a20e84d862f26eef7`는 보존한다. 새 후보에서는 별도 source/run/control·실제 Git tree 파일 수·전수 blob 검증을 쓰고 per-process env에 `CUE_MAX_BUDGET_USD=1`을 명시한다.

시험은 입력 검증·실제 native argv까지의 전달·무지정/Codex 보존까지만 입증한다. CLI의 실제 과금 집행·모델 적용·hook/cue 전문·선행 사례 준수·D36 해결은 NOT_RUN이다. 실제 회차의 예산 초과·시간초과를 보존하고 자동 재시도하지 않는다.
