# D0008 native form 후보 사례와 검증 의무

기준 `defa8f2fe8afbaaaa6b29a4e6f3c751e1267b410`. dot의 2026-11-07 01:10 자문 전체를 읽고 현재 소스와 대조했다. 자문은 기술 입력이며 사용자 정책 결정이나 실행 승인으로 승격하지 않는다. 구현 경로 B는 부모의 명시 배정이다. 새 토큰·별도 앱·상주 프로세스·자식 제한·임의 TTL·일회 소비를 만들지 않는다.

ponytail: 기존 MCP Server의 form, 기존 WorkflowStore/SQLite transaction만 쓴다. SOLID: host transport는 좁은 handler factory, 승인 scope와 상태 검사는 service, 영속성과 writer lock은 기존 store가 맡는다. tool args/peer/checkpoint에서 승인 producer로 가는 API는 광고하지 않는다.

CS 의무: DB-BOUNDARY-001(parent 포기와 새 root 삽입의 원자성, 확인된 결정 저장과 실행 변경은 별도 commit), DB-ISOLATION-002/DB-CONSTRAINT-003(두 연결·중복 발급·CAS), DB-MIGRATION-004(v5 정규화·v6 보존·재열기), CONC-CANCEL-004(취소 후 늦은 accept 발급/변경 0)를 채택한다. root 변경 실패가 이미 확인된 결정을 소비하거나 없애지 않게 한다. 원시 host UI/사용자 귀속과 별도 DB의 presence 갱신까지 SQLite writer lock으로 보장하지 않는다.

실행 전 계획. 모든 사례 실제 결과는 **NOT_RUN**이며 root가 원격 TEST/CI에서 회수한다. 오라클은 공개 MCP 도구 반환과 실제 저장 root/run/승인 레코드이다. `InMemoryTransport`는 실제 SDK request/response·capability·cancel을 유지하되 실호스트 UI를 대체하므로 그 경계는 미검증이다.

| ID / 요구 | 입력·사전조건 | 절차 | 기대 결과·합격 기준 | 실제 |
| --- | --- | --- | --- | --- |
| AP-N01 임의 ref | gated parent 또는 foreign root, unknown ref | 실제 MCP open/release | 오류, form0, root 상태/revision 유지 | NOT_RUN |
| AP-N02 양성 producer | form 지원, 서버 pending 범위, accept+confirm=true | 실제 MCP open/release | form1, 정확 root 변경, 승인1 | NOT_RUN |
| AP-N03 의미 | accept+false / content 없음 / 문자열 true / decline / cancel | 실제 MCP release | 변경0, 승인0 | NOT_RUN |
| AP-N04 no-approval | 최초 root / 자기 release | 미지원 client에서 도구 호출 | 성공, form0 | NOT_RUN |
| AP-N05 reuse | 유효 결정 저장 후 실행 충돌, refs 없음, form 미지원/재열기 | 같은 scope 재시도 | 기존 결정 재사용, 재승인0 | NOT_RUN |
| AP-N06 scope | 같은 parent, 다른 목적/targets/actor/root/action | 유효 결정 참조로 도구 호출 | scope mismatch 거부, 변경0; 조각 결합/직적곱0 | NOT_RUN |
| AP-N07 기존 gate | wrong revision / online owner / 타 세션 parent | 유효 결정으로 호출 | 기존 오류 유지, 변경0 | NOT_RUN |
| AP-N08 cancel | form 대기 중 원 요청 AbortSignal, 이후 늦은 accept | 실제 SDK cancel 요청/지연 응답 | root/승인 변경0, relatedRequestId와 signal 전달 | NOT_RUN |
| AP-N09 pending 변경 | form 대기 중 args/actor/parent revision/state/owner 변경 | accept 후 처리 | 고정 범위 또는 stale 충돌, 변경0 | NOT_RUN |
| AP-N10 중복 | 동일 connection/request 응답 중복 | record 및 mutation 재시도 | 결정1, root mutation 최대1 | NOT_RUN |
| AP-S01 migration | v6 populated workflowDB | schema7로 열기·다시 열기 | 기존 root/run/metadata 보존, 승인 테이블 사용 가능 | NOT_RUN |
| AP-S02 rollback | 승인 INSERT 후 mutation 실패/강제 예외 | 같은 writer txn rollback | root/승인 부분 상태0 | NOT_RUN |
| AP-S03 두 연결 | 같은 root replace/replace, replace/release, release/release | 독립 SQLite 연결의 stale pending 실행 | 승자1, 패자 stale/transition, 승인 중복0 | NOT_RUN |
| AP-S04 철회 | 다른 연결에서 결정 철회 후 mutation | 기존 ref/refs 누락 재사용 시도 | revoked 결정으로 변경0 | NOT_RUN |
| AP-H01 실제 host | 필수 host/OS/version capability·UI 수락/거절/취소/재사용 | root 지정 실호스트 TEST | 화면/응답 출처/변경을 같은 후보로 결속 | NOT_RUN |

기존 정상 API 시험의 임의 승인 문자열을 새 형식으로 일괄 치환하지 않는다. baseline RED는 helper import 실패가 아니라 공개 API가 unbound ref를 허용하는 assertion이어야 한다. 신규 native producer/SQLite 사례는 고정된 신뢰 경계를 추가 검증하며 mock 결과를 실제 host PASS로 올리지 않는다.

원격 명령: `node node_modules/vitest/vitest.mjs run tests/mcp/ags38-approval-native.test.ts tests/mcp/ags38-approval-store.test.ts`. baseline RED는 동일 test-only 핀에서 `ags38-approval-native`의 `AP-N01`을 실행한다. 제품 실행은 이 Windows PC에서 하지 않는다. 통합 후 server/index 연결과 배포 번들은 root 소유이며 최종 fresh 독립 보안 감사가 남는다.

추가 migration 경계: 기존 inactive native shared composition의 workflow module을 version7/table allowlist로 맞추고 `PREVIOUS.workflow=6`을 보존한다. populated v6 header/table 형태를 실제 fixture로 복원한 뒤 현재 owner로 열어 기존 sequence·다른 module task 보존과 재열기를 확인한다. standalone workflow v5→6 정규화는 원 분기를 유지하고 v5/v6 각각 v7로 이전하는 사례를 둔다. `shared-connection.test.ts`와 `inactive-factory.test.ts`의 현재 schema 기대값만 실제 새 계약(version7/table33)으로 바꾸고 데이터 보존 오라클을 추가한다.

고정 신뢰 한계: native form의 capability는 client 신고이고 응답 전달은 host 운영 계약이다. 합성 Client accept를 사람 클릭·실사용 승인자 인증으로 보고하지 않는다. 승인 DB/producer 코드에 같은 OS 권한으로 임의 쓰는 악성 로컬 실행을 이 application 경계가 방어한다고 주장하지 않는다. 외부 continuity/presence DB와 workflow DB는 분산 원자적이지 않으며 현재 기존 read-at-mutation 의미를 보존한다. 사용자 정책에 없던 host-only/root-only/추가 자식 제한은 넣지 않았다.
