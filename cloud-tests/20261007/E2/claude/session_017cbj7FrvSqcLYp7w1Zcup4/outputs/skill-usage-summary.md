# E2 실행 요약 (스킬 활용·변경분 검토·검사 결과)

## 환경 (실제 관측)
- host: Claude Code remote(Cloud) 세션. `CLAUDE_CODE_REMOTE=true`, `CLAUDE_CODE_ENTRYPOINT=remote`, `IS_SANDBOX=1`
- OS: Linux 6.18.44-fc-v77 x86_64, Ubuntu 24.04.5 LTS
- 모델/provider: 세션 설정값 `claude-opus-5-5`(시스템 프롬프트 기준). 실제 서빙 모델·provider는 별도 관측하지 않음
- git: repo `jaeseongs95/agent-governance-suite`, HEAD `b28a442ad424b255283fe32fe3c0e661b195fa4e`(pin 일치), branch `claude/ledger-duplicate-fix-c2z0jd`, 작업 전후 `git status --short` 비어 있음
- Node: `/opt/node24/bin/node` v24.21.0만 사용(PATH 기본 node는 v22.22.0, 사용 안 함)
- 저장소 작업 디렉터리: `/home/user/agent-governance-suite`(읽기만 함)
- E2 작업 폴더: 세션 scratchpad 아래 `e2work/`(payload 원 byte 복원, 결과는 `output/e2/`에만 작성)

## 스킬·도구 선택과 연결
| 순서 | 스킬/도구 | 선택 이유 | 입력 → 출력 |
|---|---|---|---|
| 1 | `agent-governance-suite:ponytail` (Skill 도구로 호출) | 코드 수정 단계. 플러그인 접수 기준이 코드 작성 전에 호출을 요구 | 계약·원본·checker 읽기 → `candidate.mjs`(표준 라이브러리만, 최소 diff) |
| 2 | 세션 현황판 `update_session_status` (MCP) | PreToolUse 훅이 첫 Bash 전에 요구 | 한 줄 상태 기록. 요청 원문·비밀 없음 |
| 3 | `agent-governance-suite:acceptance-evidence-validator` (Skill 도구 + `scripts/cli.mjs`) | 완료 보고 전 수용 기준 A1~A6을 실행 근거와 대조 | `acceptance-input.json` → `acceptance-report.json` |

선택하지 않은 스킬: `task-contract`(요청과 공개 계약이 이미 명확해 `scope.md`로 대신 정리), `change-scope-guardian`·`mutation-risk-preflight`(commit·push·삭제·배포 없음), `independent-audit-gate`(저위험 단일 프로세스 픽스처, 운영 영향 없음), `coordinate-subagents`(서브에이전트 미사용. Fable 포함 서브에이전트 0개).

## 원본 결함과 수정
| 결함(원본) | 후보 수정 |
|---|---|
| `beforeCommit` await 전에 ID를 예약하지 않아 동시 같은 요청이 각자 반영 | 신규 ID를 await 전에 동기적으로 `records`에 pending entry로 예약하고, 같은 ID 요청은 `entry.done`을 기다림 |
| 기존 ID의 amount를 비교하지 않음 | pending/completed 모두 amount 불일치면 `CONFLICT`, hook·효과 없음 |
| completed 재요청이 저장 객체를 그대로 반환 | 모든 반환을 `{ ...result }` 복사본으로 |
| 재요청·대기 요청에서 `loseAck` 무시 | 결과 확정 뒤 모든 경로에서 `loseAck`면 `ACK_LOST` |
| `pending` 항상 0, `keys`에 pending 미포함 | pending 계수, `keys = records.size`(pending+completed) |
| `request.amount`를 여러 번 읽음(getter로 검증값과 반영값이 달라질 수 있음) | `id`, `amount`를 한 번만 읽어 지역 변수로 검증·반영 |
| `beforeCommit` 실패 처리 없음 | 실패 시 예약 삭제·pending 감소 후 같은 오류를 원 호출과 대기 요청에 전달 |

## 고정된 변경분 검토 (`candidate.diff`, 후보 sha256 `cafc929fe14143fd86e46c97fc85c80cb0972e31419e53ee75e631906b45660a`)
- 예약: `records.set`과 `pending += 1`이 첫 `await` 전에 실행된다. 같은 tick의 두 번째 호출은 entry를 찾아 대기한다(C04, X03 100건 동시 → hook 1회).
- 실패 경로: `catch`에서 삭제·감소 후 재throw. 원 호출이 `entry.done`을 항상 await하므로 처리되지 않은 rejection이 생기지 않는다(30회 반복 실행에서 stderr 비어 있음).
- 성공 경로: `pending -= 1`부터 `entry.result` 설정까지 await 없이 한 번에 실행돼 중간 상태가 관측되지 않는다.
- 상한: pending과 completed가 모두 `records`에 있어 `records.size >= maxKeys`로 함께 제한한다. 기존 ID는 상한 검사 전에 처리해 재시도를 허용한다. 완료 ID는 퇴거하지 않는다.
- 비용: Map 조회 O(1), 상태 O(maxKeys), 대기열·재시도 루프 없음.
- 검토 중 확인한 남은 위험(수정하지 않음): ① `beforeCommit`이 영원히 끝나지 않으면 예약과 대기 요청도 끝나지 않는다. 계약이 네트워크 취소를 범위 밖으로 둠. ② 대기 요청들은 같은 Error 객체를 받는다. ③ `options`가 `null`이면 구조 분해에서 TypeError(상태 변화 없음). 계약에 정의 없음.

## 실행한 명령과 결과 (모두 `/opt/node24/bin/node`, cwd = e2work)
| 명령 | exit | 결과 | 산출물 |
|---|---|---|---|
| `node tools/restore.mjs payload.json e2work` (scratchpad) | 0 | 11개 파일 bytes·sha256 일치, manifest sha256 = pin `4dd6cc2d…c98d` | (stdout 대화 기록) |
| `node verify-inputs.mjs` (작업 전) | 0 | PASS 10/10 | `verify-inputs.stdout.json` |
| `node e2/checker.mjs e2/target-original.mjs` | 1 | FAIL, PASS 3/11 · FAIL 8/11 (C03~C10 FAIL) | `checker-original.stdout.json` |
| `node e2/checker.mjs output/e2/candidate.mjs` | 0 | PASS 11/11 | `checker-candidate.stdout.json` |
| `node output/e2/extra-checks.mjs output/e2/candidate.mjs` | 0 | PASS 11/11 | `extra-candidate.stdout.json` |
| `node output/e2/extra-checks.mjs e2/target-original.mjs` | 1 | FAIL, PASS 4/11 | `extra-original.stdout.json` |
| mutant 6개 × (checker, extra) | 아래 | 6개 모두 최소 한 검사가 검출 | `mutation.stdout.json` |
| 후보 checker+extra 30회 반복 | 0 ×30 | 30/30 | `repeat.stdout.txt` |
| `node verify-inputs.mjs` (작업 후) | 0 | PASS 10/10 | `verify-inputs-after.stdout.json` |
| `node <AEV>/scripts/cli.mjs --input output/e2/acceptance-input.json` | 0 | verdict PASS, AC-001~AC-006 satisfied, unresolved 0 | `acceptance-report.json` |

### mutation 검사 (candidate.mjs에 결함 1개씩 주입, exit 1 = 검출)
| mutant | checker | extra |
|---|---|---|
| m1 CONFLICT 검사 제거 | 1 | 1 |
| m2 저장 객체 그대로 반환 | 1 | 1 |
| m3 실패 시 예약 해제 안 함 | 1 | 1 |
| m4 재요청에서 ACK_LOST 생략 | 1 | 0 |
| m5 반영 시 `request.amount` 다시 읽기 | 0 | 1 |
| m6 pending 계수 안 함 | 1 | 1 |

m5는 기준 checker가 검출하지 못하고 보강 검사 X09만 검출한다. 첫 m5(재읽기만 하고 값을 쓰지 않는 등가 mutant)는 무효라 교체했고, X09도 1회 읽기 뒤 값이 바뀌는 getter를 추가해 강화했다.

## NOT_RUN / 확인하지 못한 조건
- E4·E9(지시에 따라 실행 안 함), 저장소 전체 검사(`pnpm lint/build/test/validate:*`), git commit·push·PR·릴리스·설치
- Node 20/22 실행, 실제 시간복잡도·heap·처리량 benchmark, cross-process·재시작 내구성, 운영 DB·외부 API·호스트 기능
- 독립 감사(independent-audit-gate) 및 evaluator/witness 대조: 제공되지 않음
- 실제 서빙 모델·provider 관측(세션 설정값만 기록)

## 남은 문제
- `beforeCommit`이 끝나지 않으면 예약과 대기 요청이 무기한 남음(계약상 취소 범위 밖)
- 기준 checker는 m5(검증 뒤 입력 재읽기)를 검출하지 못함. 기준 checker는 수정하지 않았고 보강 검사로만 보완
- checker PASS는 AGS E2E PASS가 아님(manifest `completion` 문구)
