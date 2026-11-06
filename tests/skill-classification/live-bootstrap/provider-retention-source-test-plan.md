# Provider retention: current source preparation

기준 후보: `fe233d02202ac94ae38948d33acc5b1ac1bc529e`.
원 실패: [CI 42309533698 / Linux job 128207248172](https://github.com/jaeseongs95/agent-governance-suite/actions/runs/42309533698/job/128207248172).

첫 시험은 아래 7개 원문 결속 불일치를 보고했고, 두 번째 시험은 같은 준비 단계의 `ORACLE_SOURCE_MISMATCH`로 종료했다. provider의 13개 응답 보존 사례가 실패했다고 해석하지 않는다.

| 파일 | 승인된 변경 근거 |
| --- | --- |
| `skills/codex-token-usage-analyzer/SKILL.md` | 사용자 삭제 지시, `0ad3f846343374e66ee2dea0c95d73764addbf27`; 현재 부재를 요구한다. |
| `skills/codex-token-usage-analyzer/classification.json` | 같은 삭제 지시와 commit; 등록용 원문도 부재를 요구한다. |
| `skills/coordinate-subagents/SKILL.md` | `20e17f4ebad385118da5e79332972c24dd41f742`: 승인된 위임의 모델·추론 선택을 호출 전 advisor로 연결한다. |
| `skills/coordinate-subagents/references/entry-details.md` | 같은 호출 전 책임 연결이며 위임 여부·인원·권한은 기존 담당에 둔다. |
| `skills/coordinate-subagents/classification.json` | `c7ebdb973f01c96b04312ad832c8c3b1708ce5b0`: 원 selected text를 보존하고 이동한 line/byte와 digest를 재결속한다. |
| `skills/model-effort-advisor/SKILL.md` | `20e17f4e`의 벤더 독립 호출 전 선택 역할 전환과 `98d4beafffa12f2dbc55119a509d326194dfdca2`의 분야 독립 표현 수정이다. |
| `skills/model-effort-advisor/classification.json` | 같은 새 역할의 선택·제외 범위와 원문 위치를 결속한다. |

이 변경은 기존 모델 적절성 golden의 의미보존으로 간주하지 않는다. 기존 `fixtures.json`, source-successor 파일, history-r04와 기본 준비 경로는 유지한다. 명시적인 `provider-observation-retention` 준비만 새 결속을 사용하고 모델 품질 oracle을 채점하지 않는다. 전용 실행은 `offline-mock` 표시와 주입한 fetcher를 모두 요구해 native fetch로 넘어가지 않는다. 새 옵션은 제품 설정이나 CLI config에 추가하지 않는다.

## 사례와 판정

모든 사례의 실행 환경은 Actions/TEST이고, 아래 실제 결과는 아직 `NOT_RUN`이다. 로컬에서는 syntax/static 검사만 실행한다.

| 사례 | 입력·전제 | 절차 | 기대 결과와 실패 기준 | 실제 |
| --- | --- | --- | --- | --- |
| PRS-01 | 기준 후보의 실제 원문, 기본 source-binding loader | 동결 fixture·r35 결속으로 현재 7개 파일 비교 | 원 실패와 같은 7개 불일치. 기본 loader가 새 목적을 자동 허용하면 실패 | NOT_RUN |
| PRS-02 | 같은 원문, 명시 retention 준비 | exact 7개 override의 이전 지문을 기존 결속에 대조하고 현재 지문 확인 | 불일치 0; 삭제 2개는 null, 변경 5개는 고정 SHA와 같음 | NOT_RUN |
| PRS-03 | 승인 목록 밖 경로, 틀린 이전 지문, 현행 한 바이트 변경, 삭제 파일 복귀 | resolver와 실제 prepare를 각각 호출 | 목록 밖 결속 유지, 이전 지문 불일치 거부, drift/복귀 시 dispatch 전 거부 | NOT_RUN |
| PRS-04 | retention 준비로 생성한 캐시 후 기본 준비 | 같은 repo에서 준비 모드를 바꿔 호출 | 기본 경로가 retention 캐시를 재사용하지 않고 원 mismatch로 거부 | NOT_RUN |
| PRS-05 | 명시 retention 준비와 offline mock 13개 사례 | 원 보존/no-resend 시험 실행 | 원 13개 사례·타임아웃·보존·삭제·usage·1회 전송 oracle 유지; 모델품질 NOT_RUN | NOT_RUN |
| PRS-06 | retention purpose와 offline-mock 이외 실행 종류 | env/fetch trap을 둔 run 호출 | 환경 열람·전송 전에 거부; 실제 호출 0 | NOT_RUN |

검증 명령: TEST/Actions에서 `pnpm exec vitest run tests/skill-classification/live-bootstrap/provider-observation-retention.test.ts` 및 관련 bootstrap 회귀. 기존 실패 후보에서 PRS-01/원 2개 실패를 재현하고 수정 후보에서 PRS-02~06을 실행한다. 새 timeout·재시도·golden 교체는 하지 않는다.

## 구현 시 정적 확인

- 원 CI의 7개 expected/actual을 직접 확인했다. 새 binding의 이전 지문은 r35 체인의 최종값과 7/7 일치하고, 현재 SHA·크기 또는 부재는 기준 후보와 7/7 일치한다.
- `coordinate-subagents`의 기존 selected text는 기준 `14549a2e`와 현재 후보 사이에서 16/16 동일하다. advisor의 의미 변경은 동일하다고 주장하지 않는다.
- 원 13개 retention 사례 정의는 바이트로 보존했다. 새 assertions는 평가 목적·모델품질 NOT_RUN·채점 분모 0만 추가한다.
- 수정된 TypeScript 5개 파일은 `node --check` 종료 코드 0이다. 기존 root의 의존성을 읽기 전용으로 참조한 TypeScript 검사도 최종 진단 0이다. `git diff --check`는 종료 코드 0이다.
- 제품 시험 및 모델 실행은 수행하지 않았다. PRS-01~06의 실제 결과는 계속 `NOT_RUN`이다.
