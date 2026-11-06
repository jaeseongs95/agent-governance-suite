# AGS3-D-0008 승인 결속 사례

기준: `a281139387af096e696f8d50cc089ad09e9291fc`. 공개 경계는 `WorkflowService.openConvergenceRoot`와 `releaseConvergenceRoot`다. 기존 Vitest와 `InMemoryWorkflowStore`를 쓰며 호스트 입력 관측과 실제 SQLite/프로세스 경계는 대체한다. 제품 시험 실행 위치는 TEST/CI이며 로컬 실행은 금지한다.

원인: 두 공개 경계가 `userApprovalRefs.length`만 검사한다. `TrustService`는 `directUserInputAttestation:false`이고 `TrustStore`는 직접 사용자 입력 발급을 거부하므로 이 출처 영수증을 승인으로 승격하지 않는다.

불변조건: 승인 필요 행위에서 승인 참조가 호스트/embedding이 구성한 resolver로 실제 기존 사용자 결정에 해석되어야 하며, 그 결정의 행위·root·호출 주체가 일치해야 한다. resolver 부재는 미검증이며 승인 성공이 아니다. 승인 실패는 root 상태·revision을 바꾸지 않는다. 사용자가 정한 만료가 있을 때만 적용하며 임의 만료나 일회용 소비 정책을 만들지 않는다. 자기 root 해제는 현재 소유권 검사만 유지한다.

SOLID: 정책은 신뢰된 결정 해석의 작은 함수 계약에 의존한다. 특정 호스트의 로그나 인증 파일을 정책 모듈이 읽지 않는다. production resolver 구현이 없는 상태를 완전 수리로 보고하지 않는다.

| 사례 | 입력·사전조건 | 절차 | 기대 결과·합격 판정 | 실제 결과 |
| --- | --- | --- | --- | --- |
| AP01 | needs-review parent, refs `["anything"]`, resolver 없음 | open replacement 호출 | 오류, parent 상태/revision 유지 | NOT_RUN |
| AP02 | open root, 타 주체, owner ended, refs `["anything"]`, resolver 없음 | release 호출 | 오류, root 상태/revision 유지 | NOT_RUN |
| AP03 | 각 행위에서 resolver가 해당 ref에 대해 null 반환 | 교체/해제 호출 | 오류, 상태 유지 | NOT_RUN |
| AP04 | 기존 사용자 결정의 행위/root/actor 중 하나가 다름 | 같은 공개 경계 호출 | 오류, 상태 유지 | NOT_RUN |
| AP05 | 결속 일치, 사용자가 명시한 expiresAt이 과거/현재/유효하지 않음 | 공개 경계 호출 | 오류, 상태 유지 | NOT_RUN |
| AP06 | 결속 일치, expiresAt 없음 또는 미래 | 공개 경계 호출 | 기존 ref 그대로 수락, 교체 open 또는 해제 abandoned | NOT_RUN |
| AP07 | 동일 ref 중복 | 공개 경계 호출 | 중복 입력 거부, 상태 유지 | NOT_RUN |
| AP08 | 같은 주체에게 두 root에 명시적으로 적용되는 기존 결정 | 동일 ref로 각 root 행위 | 기존 결정을 새 토큰 없이 재사용 | NOT_RUN |
| AP09 | 자기 root, refs 없음 | release 호출 | abandoned; 별도 승인 요구 없음 | NOT_RUN |
| AP10 | 타 세션 root, owner online, 유효 결정 | release 호출 | OWNER_SESSION_ONLINE; 상태 유지 | NOT_RUN |
| AP11 | 교체 parent를 다른 세션 소유로 표시, 유효 결정 | open replacement 호출 | ROOT_NOT_OWNED; 상태 유지 | NOT_RUN |

기대값은 D0008 원문 AC와 기존 소유권 계약에서 정한다. 회귀 오라클은 API 오류와 저장소 root 상태/revision이다. 해시·문자열 존재·자기 선언한 originKind만으로 사용자의 결정을 인증했다고 하지 않는다. 기준 구현에서 AP01/AP02가 수락되는 assertion 실패와 수정 구현에서 같은 시험의 통과를 TEST 담당자가 회수한다. import/실행기 실패는 red로 인정하지 않는다.

원격 명령: `corepack pnpm install --frozen-lockfile && node node_modules/vitest/vitest.mjs run tests/mcp/ags38-approval.test.ts` (동일 시험 digest로 baseline test-only commit과 fix commit 비교). 생성물 신선도와 전체 통합/실호스트 검증은 통합 담당자 소유다.

상태: 시험 계획 작성 완료, 제품 실행 NOT_RUN. 수리 담당 v380_approval_fix, TEST 담당 root 지정 담당자, 권한 경계 독립감사 필요. 생산 composition에서 기존 사용자 결정을 해석할 허용 정본 경로는 미확정이며 D0008 완전 수리의 남은 제한이다.

생산 경로 추적: `builtin-hook-host-adapters.ts:88`은 실제 `input.prompt`를 wake marker 분류에만 쓰고 `:105`에서 `wakeCandidates/wakeOnly`만 전달한다. `InputObservation`에는 원문·사용자 결정 필드가 없다. `continuity-hook.ts:232`의 사용자 입력 처리는 fork parent pin과 checkpoint cue뿐이다. `host-input-adapter.ts`의 `LineageRead`는 구조 ID·시각만 받는다. `TrustStore.recordInputSource`의 실제 producer는 `session-message-hook.ts:346`과 `session-message-wake-port.ts:201`의 peer이며 권한 효과는 none이다. `TrustStore:102`는 user-turn 발급을 거부한다. 이 관측으로 기존 생산 사용자 승인 resolver가 없음을 판단했으며, 다른 세션 대화/로그/인증 파일은 열지 않았다.

부분 구현: `root-approval.ts`는 host/composition이 해석한 기존 결정과 현재 행위·root·actor의 결속만 검사하는 모듈이다. 이 모듈 자체는 사용자 결정 producer가 아니며 도구 입력의 자기 선언을 신뢰하도록 연결하면 안 된다. `workflow-service.ts`는 다른 worker 단일 소유이므로 이 작업 사본에서는 수정하지 않았다. 미연결 모듈을 D0008 수리 완료나 GREEN으로 보고하지 않는다.

정적 확인: Node `v24.19.0`에서 신규 test와 helper 각각 `node --check` 종료 0, `git diff --check` 종료 0. 제품 시험/동적 red/green/전체 tsc는 NOT_RUN. test-only 핀 `ebb2b432ae99b775e0bea9519e167ef9384cb387`은 새 모듈 import 없이 기준 결함 구현의 공개 경계를 실행한다.
