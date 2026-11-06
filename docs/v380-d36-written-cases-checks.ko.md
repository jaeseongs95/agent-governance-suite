# D36 사례 기록 동사 교정 — 사전 검증 사례

기준: e96805c348f5a509a2185898ae517c21e45d3f49. 원 요구는 변경 전 사례를 작성하는 것이다. QB291 T4의 선행 기록 누락은 확정이고, 모델이 누락한 인과 원인은 미확정이다. 이번 후보는 공통 intake의 `사례를 정한다`만 `사례를 적는다`로 바꾼다. 특정 파일명·스킬 호출·추가 gate는 요구하지 않는다.

| 사례 | 입력·선행조건 | 절차·환경 | 기대·실패 기준 | 실제 결과 |
|---|---|---|---|---|
| C1 원 의무 복원 | 기준 intake와 동사 하나 교정 후보 | Git diff와 바이트 대조 | 한 구절만 다르고 4315 codepoints/9662 UTF-8 bytes 유지. 변경 전·무엇·어디·성공 결과·후행 실제 실행 의무 모두 유지. 다른 변경은 실패 | 직접 바이트·diff 대조 통과. 원본 9717B, SHA256 afad5fabebd6dbc31d0f4622727a16bfa5b62ccefafa5137454352eada38b7db |
| C2 근거 결속 | 교정 원본, 기존 r34 이하 frozen chain | r35를 append하고 기존 classification/소비자 검사. 실제 시험은 TEST/Actions | 새 digest/span이 정확하고 원 r34 이하·labels·budget·oracle·timeout 불변. 옛 digest나 변조 manifest 허용 시 실패 | 미실행 |
| C3 공개 전달 경로 | 공식 build/Claude/en 생성물 | 저장소 빌드 후 양 OS CI와 관련 TEST | ko/en MCP instructions 및 생성물에 새 의무가 한 번씩 전달되고 표적 회귀 통과. 로컬 제품시험은 실행하지 않음 | 미실행 |
| C4 실제 행동 | 기존 T4 실패 원문/fixture 및 새 후보 | 기존 native 수단으로 필요한 선행 문맥·전달을 고정할 수 있는지 먼저 확인. 가능하면 비코드 T4 한 회차 | 첫 HTML 변경 전에 요구별 사례의 방법·환경·성공 판정이 관측돼야 행동 PASS. 목표/일반 AC만 있으면 FAIL. 전달·선행 문맥을 고정하지 못하면 인과 비교는 판별 불가. 새 5턴 재실행·강한 모델·새 수집 계층으로 확대하지 않음 | 미실행 |

정적 문안 결속과 CI 성공은 실제 행동 개선이나 근본원인 확정이 아니다. 기존 QB291의 ORDER FAIL 및 T5 SCOPE FAIL은 보존한다.

후속 준비에서 T3 직후 snapshot이 없음을 확인했다. C4의 동일 문맥 인과 비교는 실행하지 않는다. 별도 새 대화의 행동 수용검사는 원 초기 22파일·원 T4 prompt·300초를 유지한 `v380-d36-t4-acceptance.spec.json`(SHA256 a8eef1d528acc2a1b2611d0459cf0b4222f48eb1d0c50f3d371de9d96ad8af39) 한 회차로 준비했다. 이전 대화·중간 상태와 다르므로 원 실패의 RED/GREEN이나 H4 인과 비교로 채점하지 않는다. 현재 실제 모델 실행은 미실행이다.

로컬 `pnpm build`, `pnpm claude:build`, `pnpm en:build`는 모두 exit0이다. 생성물은 공식 명령으로만 갱신했으며 로컬 제품시험은 실행하지 않았다.
