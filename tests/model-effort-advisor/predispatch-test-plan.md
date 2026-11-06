# 호출 전 모델·추론 선택 시험 계획

기준: `14549a2e83fd9143cf8184bd71979db23fd43172`. 기존 현재 설정 상담은 역사 호환 사례로 보존하고 새 호출 전 계약을 별도로 검증한다. 제품 시험은 TEST/GitHub Actions에서 실행한다. 로컬은 구문·JSON·diff 정적 검사만 허용한다. 실행 전 실제 결과는 모두 NOT_RUN이다.

| ID / 요구 | 입력·전제 | 절차 / 공개 경계 | 기대 결과·통과/실패 기준 | 실제 결과 |
| --- | --- | --- | --- | --- |
| P01 현재 메인 관측 불필요 | 일반 구현 assignment, 검증 가능한 범위, host 지원 조합·근거, 현재 모델 입력 없음 | `adviseSubagentModel` API 및 CLI 실행 | READY, adapter의 balanced 조합 선택; 현재 모델 질문·UI 상담 없음. 둘 중 하나라도 다르면 실패 | NOT_RUN — TEST/Actions에서 실행 |
| P02 역할·난도·검증 가능성 | discovery/routine/direct와 complex-reasoning/complex/limited, 실제 판단 signals | 같은 adapter의 각 역할 추천으로 실행 | 해당 역할의 기존 resolver 결과를 보존하고 입력 판단 근거를 반환; 문자열 길이나 파일 수로 class를 추정하면 실패 | NOT_RUN — TEST/Actions에서 실행 |
| P03 품질·비용 선호 | 같은 assignment에 economy/balanced/quality | 기존 resolver 결과 및 선택 모델 비교 | 각 profile의 지원 조합만 선택; assignment·권한·에이전트 수를 생성/변경하면 실패 | NOT_RUN — TEST/Actions에서 실행 |
| P04 명시 선택 우선 | model-only/effort-only 사용자 지정과 부분 지원 조합 | API 호출, 원 입력 전후 비교 | 기존 resolver의 override·fallback 의미 보존, 입력 불변; 없는 effort를 채우면 실패 | NOT_RUN — TEST/Actions에서 실행 |
| P05 고위험 하한 | high/critical 또는 independent-audit, 하한 미달 사용자값·미관측 상속 | API 및 CLI 실행 | 공통 policy의 general/high 하한 미충족은 BLOCKED/exit1; 검증 쉬움이나 economy로 하한을 낮추면 실패 | NOT_RUN — TEST/Actions에서 실행 |
| P06 알 수 없는 상속 | low risk, inheritanceSupported=true, inherited 미제공 | API 및 CLI 실행 | INHERIT_UNVERIFIED, selection=null, 실제 적용 주장 없음; high risk에서는 BLOCKED | NOT_RUN — TEST/Actions에서 실행 |
| P07 공급자 독립 | 다른 이름을 쓰는 두 adapter, 동일 role/profile과 지원 의미 | customPresets 인자로 API/CLI 실행 | 각 adapter ID를 그대로 사용하고 공통 상태·의미 동일; vendor명 분기로 선택하면 실패 | NOT_RUN — TEST/Actions에서 실행 |
| P08 미지원·모호한 입력 | 지원 배열 없음/중복 ID/알 수 없는 class·effort/근거 없음/현재 UI 필드 삽입/위임 승인 필드 삽입 | API 오류·CLI stderr 검사 | 유효하지 않은 입력은 거부, CLI exit2와 제한된 오류 code; 입력 sentinel 노출·발명한 지원값·권한 생성은 실패 | NOT_RUN — TEST/Actions에서 실행 |
| P09 요청·호출·관측 분리 | 새 advice.routingOptions와 existing recordModelApplication, 실제 호출 인자, observation null/일치/불일치 | 기존 recorder 실행 | 인자만 전달한 경우 unverified, 일치 host 관측만 applied; 불일치·허위 인자 보존/거부 의미 유지 | NOT_RUN — TEST/Actions에서 실행 |
| P10 역사 호환·현재 successor 분리 | 기존 frozen behavior/support fixture와 v1 schema·guard | 기존 역사 시험 + 새 predispatch 시험 실행 | frozen bytes/oracle 유지, 새 스킬은 successor 계약만 안내; 옛 UI 상담을 새 동작 성공으로 합산하면 실패 | NOT_RUN — TEST/Actions에서 실행 |

검증 수준: fixture 기반 공개 API/CLI 구성 시험이며 실제 호스트 dispatch·모델 품질·과금·권한·감사는 증명하지 않는다. 이 작업은 독립 모델 행동 평가를 실행하지 않는다. red/green은 새 API가 기준 commit에 없으므로 동일 시험의 사전 실행 대신 P01/P08/P09의 계약 음성 사례로 검출력을 확인한다. 실제 TEST 실행 전 통과 수를 보고하지 않는다.

## 정적 검사 실제 결과

2026-11-07, 작업 폴더 `D:/codex/build/ags-01a14016-advisor-predispatch`, 변경 후보의 source 기준:

- `node --check skills/model-effort-advisor/scripts/advise.mjs`: exit 0.
- `node --check tests/model-effort-advisor/predispatch.test.mjs`: exit 0.
- `node --check tests/model-effort-advisor/current-provider.test.mjs`: exit 0.
- `runtime/schema-validation.mjs`의 Ajv2020으로 공통 policy를 등록하고 새 request/advice schema 두 개 compile: exit 0. 실제 조언·모델 선택은 실행하지 않았다.
- `node scripts/validate-skill.mjs --name model-effort-advisor`: exit 0, `model-effort-advisor: valid`.
- 역사 schema/guard/declaration 및 동결 fixture 세 개를 기준 SHA 원본과 바이트 대조: 6개 일치. classification source span/digest 5개 정적 대조: 일치.
- `git diff --check`: exit 0.
- `skill-creator/scripts/quick_validate.py`: 실행 실패, `ModuleNotFoundError: No module named 'yaml'`. 환경 의존성 부재이며 스킬 검증 성공으로 처리하지 않는다. 저장소 정적 validator 결과와 구분한다.

## 통합 후 TEST/Actions 실행 명령

root가 새 registry와 공식 생성물을 통합한 후보에서 다음 기존 runner를 실행한다. `current-provider.test.mjs`는 새 registry provider를 요구하므로 구 registry를 가진 분리 브랜치에서는 실행하지 않는다.

```text
pnpm exec vitest run tests/model-effort-advisor tests/skill-quality/model-effort-support.test.mjs tests/coordinate-subagents/model-routing.test.mjs tests/mcp/model-policy-regression.test.ts
```

실제 호스트 dispatch·동시성·모델 품질·과금·독립 행동 평가: NOT_RUN. 위 fixture 기반 시험의 성공으로 승격하지 않는다.
