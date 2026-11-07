# bootstrap 목적·fixture 수리 사전 사례

기준1aed980a829d2328fffe96695d635c0fc058b29a. 구현 전 작성. 원45FAIL 및 목적 경계 보고서(b6b2ccb6)를 보존한다. 제품/bootstrap admission/evaluation/provider-retention핀/frozen corpus·oracle/hash/가격/원assertion/skip/timeout은 수정하지 않는다. local/TEST/모델 실행 금지이므로 아래 actual은 모두 NOT_RUN이다.

| ID·원AC | 입력·전제 | 절차(후속 TEST/Actions) | 기대·실패 판정 | actual |
| --- | --- | --- | --- | --- |
| H01 원case29 contract18gold/raw | 고정 history-r04 archive+현재 helper, 기본 목적 | 기존 contract-selfcheck 전체를 기존 CLI로 실행 | oracle18·raw 집계·21 request·응답보존·비밀/정답비전송·unknown/no-resend 원assertion 그대로. current retention으로 분모0 변경하면 FAIL | NOT_RUN |
| H02 원case30 expiry | 같은 coherent 역사 입력+현재 helper | 원6증거 만료·credential-await 만료 검사 | 원 fetch/예약 횟수·unknown/미착수·환경경계 유지 | NOT_RUN |
| H03 원case42–44 C1–C3 | 자기 소유 역사 fixture+현재 source/helper | 기존 seed복제·ID/authority 독립·원source/oracle/inventory 변조 검사 | 원error·실제 admission 재읽기·환경/전송0. sourcefixture변조가 real helper에 연결되지 않으면 FAIL | NOT_RUN |
| H04 원case45 authority/CAS/IPC | 역사 fixture+현재 helper/실제prepared-child | 기존43검사 전체 | revoke·clock·scope·fsync·claim/ledger 원bytes·경쟁 승자·재시작무전송 유지, child회수뒤에만fixture정리 | NOT_RUN |
| C01 원case31 currentbudget | 현재원문·독립wire·고정금액정책, 명시mockretention | 원budget suite와실제worker | prepare/run/worker 모두같은기존purpose, 원pico/반올림/unknown/cap/경합assertion 불변 | NOT_RUN |
| C02 원case33–34·41 currentwire | 현재metadata·독립encoder·명시mockretention | 기존dynamic current/stale/precision | 원source/wire/digest/길이·정수기대·환경전송0 유지. 역사자료를current로 보고하면 FAIL | NOT_RUN |
| C03 원case32 precision12 | 원12입력·expectedStatus/Reason·policySHA·독립wire | 원precision suite실행후각case결과보존 | 원산술·돈·ledger/무전송assertion 유지. 현12setup 원인은 아직미확정, 동일원인 선확정 금지 | NOT_RUN |
| B01 PRS01/04/06 | 원provider-retention 테스트무변경 | 기존provider-observation-retention.test.ts | 기본current거부·cache목적분리·live/무fetcher거부·qualityNOT_RUN/분모0 유지 | NOT_RUN |
| L01 fixture자원수명 | 역사준비/호출자성공·오류·자식실패 | 기존cleanup/finally와원자식exit관측 | 자기temp만정리, childclose전삭제금지, 원fail/cause보존·새retry/timeout증가0 | NOT_RUN |

원AC→파일: H01/H02=bootstrap-contract.test.mjs; H03=bootstrap-fixture-reuse.test.ts; H04=prepared-bootstrap.test.ts; H01~04공유=history-r04-boundary.mjs(기존archive준비/cleanup재사용,새runner0). C01=budget-regression.mts(동일파일worker포함); C02=dynamic-current-{stale,oracle}.mts/dynamic-precision-boundary.mts; C03=precision-regression.mts; C01~03=prepared-fixture.mts(기존readyEstimateMock의선택목적전달). 다른담당independent-wire-mutations.mts는읽기만.

CS 적용: CONC-CLAIM-001 원단일승자/실제child경합을보존, CONC-FENCE-002 authority/ledger revision재검증과외부bytes보존을보존, CONC-CANCEL-004 childclose/fixturefinally정리경계를보존. IMP004 자원소유자는 기존source-scratch와호출자가지며공유fixture캐시를추가하지않는다. 새락/폴링/DB0. 동적의무는승인환경TEST에서만판정하며정적검사를제품PASS로보고하지않는다.

원RED: server-1aed.log SHA092c532fa028fcc053dcd22583d7a3639817ff70793691802d27d9cd8f3360b6, case29–31/33–34/41–45는prepare275 ORACLE_SOURCE_MISMATCH, case32는PRECISION_BOUNDARIES_FAILED·12개ASSERTION_OR_SETUP_FAILED/assertion:null. 기존oracle를바꾸는RED/GREEN쌍을만들지않는다.

향후명령: Node24/동일lockfile을갖춘TEST/Actions에서 `pnpm exec vitest run tests/skill-classification/live-bootstrap/bootstrap-contract.test.mjs tests/skill-classification/live-bootstrap/bootstrap-fixture-reuse.test.ts tests/skill-classification/live-bootstrap/prepared-bootstrap.test.ts tests/skill-classification/live-bootstrap/provider-observation-retention.test.ts`. 실행환경의공용heavy.lock·원owner슬롯은root가결정한다. 이번구현자TEST/모델실행0.
