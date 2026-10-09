# SS29 — 점수와 불확실성 표현: 실행 준비 계획

상태: PREPARATION_COMPLETE_WAITING_PARENT. 제품 시험과 Claude API 호출은 NOT_RUN.

1. 부모의 검증된 R17 commit/tree, 독립 SOURCE 판정, 고정 원격 게시 근거, 공통 Claude 모델/effort·성공한 API 인증 절차·선행 검사를 받는다. 현재 로컬 보고만 있는 fa1e250c1cbc4f8f446f2e2ddeb516f4e439edbb / 43d2b4e49cdb6993c48d7adc792a3ef17426092e를 검증됐다고 가정하지 않는다. 이전 main/c6a8019를 대체 후보로 시험하지 않는다.
2. 검증된 후보를 격리 체크아웃하고 commit/tree 및 적용 AGENTS.md, 관련 SKILL.md, .agents/skills, Claude overlay를 다시 읽는다. 제품 코드와 생성물은 읽기 전용으로 유지한다. Sol은 입력/환경/근거/비용을 관리하며, 실제 제품 경계 호출·시험 명령·호스트 관측은 Claude Code가 수행한다.
3. source-integrity.json과 input-evidence.json의 고정 입력 및 기대값을 사용한다. originalPrompt=null, oracle=null, semantic accuracy=null을 보존한다. 승인된 운영 host framing을 사용하되 원래 사용자 요청으로 표시하지 않는다. 기존 SS29.development.test.ts는 공개 SHA256 e20d48142ddf1ac0f1095588f6c436a2c198338750ceb47ea66d923ff6d1ed61이며 원시 사본의 hash와 다르다. 임의로 R17 fixture/oracle binding assertion을 고치지 말고 불일치는 보고한다. 후보 안 tests/에 파일을 넣어야 하면 제품 무수정 범위와 부모 절차가 허용한 격리 시험 overlay를 먼저 확인한다.
4. 공통 설정으로 실제 Claude CLI를 API 인증 실행한다. 키는 프로세스 환경에서만 부모 절차대로 사용하고 값을 argv/파일/로그에 넣지 않는다. 영구 인증·권한·네트워크 설정을 변경하지 않는다. 정확한 모델/effort, CLI 버전, 로드한 plugin/MCP, cwd, 후보 commit/tree, 실행 시간/argv/exit, 토큰/캐시/비용을 기록한다. 버전 확인은 인증 성공이나 AGS 로드 증거가 아니다.
5. 원래 다섯 변형을 mock 입력으로 실제 공개 service/gateway 경계와 Claude 호스트에 연결한다. JEV Noul 변형도 mock이며 JEV API 호출 권한을 뜻하지 않는다. 실제 provider dispatch 없이 점수 의미와 정책을 재현하며 mock 경계를 명시한다.

| 변형 | 기대 결과 |
|---|---|
| cosine_similarity=0.82 | 종류·값·미보정 의미 보존. 82% 성공 확률/confidence 금지. |
| classifier_score logit=2.4 | raw logit 종류·값 보존. 확률 환산 또는 공통 threshold 비교 금지. |
| noul_probability=0.82 | 원시 yes 확률 의미 유지. AGS 정확도/안전 확률로 확대하거나 confidence 추가 금지. |
| 점수 없는 응답 | 값 없음과 calibrated=false 의미 전달, 가짜 수치 금지, scored와 absent 구별. |
| 전부 threshold 미달 | uncertain/abstained 및 baseline fallback. 점수만으로 no-skill 확정 금지. baseline 미해결 항목만 NEEDS_INPUT/PARTIAL. |

6. 공개 직렬화 output·Claude 사용자 문구·사용 가능한 UI/보고서와 provider별 threshold policy revision/digest를 모두 확인한다. 입력 REQ에 남은 점수 문자열은 실제 결과가 전달된 증거가 아니다. Historical Noul 정책 .8/.2 및 경계 0/.2/.20000000000000004/.5/.7999999999999999/.8/1을 사전 기준 그대로 확인하며 임의 튜닝하지 않는다. 실제 후보의 승인된 provider 정책 revision을 별도로 추적한다.
7. Claude의 selected/read/applied/verified를 실제 도구 호출·읽은 파일·적용 의무·검증 결과에 연결한다. 관측되지 않은 단계는 NOTRUN, final selection은 null로 둔다. Sol의 지침 읽기나 mock response는 Claude host receipt를 대체하지 않는다. UI를 관측하지 못하면 그 범위를 NOTRUN으로 남긴다.
8. 명령 실패·timeout·인증 실패·API 실패를 보존하고 성공할 때까지 재시도하지 않는다. 모든 비용은 $2 사례 소프트 한도에 포함한다. 다음 호출 최대 예상비용이 잔액을 넘거나 한도에 접근하면 중단한다. JEV는 별도 배정 전 호출하지 않는다.
9. 결과는 원래 명세에서 판정한다. 과거 12 PASS/5 FAIL 또는 회귀 1 PASS/22 skipped를 새 정답이나 전체 PASS로 사용하지 않는다. 과거 score kind/value 유실은 하나의 원인으로만 참조한다. 새 실행이 모든 필수 host/UI/baseline 근거를 충족하지 않으면 부분 근거와 NOTRUN을 분리해 보고한다.
10. 새 고유 SS29 run 경로에 정제된 보고/근거/해시만 추가하고 evidence 브랜치를 fast-forward 게시한다. 비밀·개인정보·원본 채팅은 제외하며 고정 commit의 원격 파일 바이트를 다시 읽어 hash를 검증한다.
