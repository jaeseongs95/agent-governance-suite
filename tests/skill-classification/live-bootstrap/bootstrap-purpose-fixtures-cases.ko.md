# bootstrap 목적·fixture 수리 사전 사례

기준1aed980a829d2328fffe96695d635c0fc058b29a. 구현 전 작성. 원45FAIL 및 목적 경계 보고서(b6b2ccb6)를 보존한다. 제품/bootstrap admission/evaluation/provider-retention핀/frozen corpus·oracle/hash/가격/원assertion/skip/timeout은 수정하지 않는다. local/TEST/모델 실행 금지이므로 아래 actual은 모두 NOT_RUN이다.

| ID·원AC | 입력·전제 | 절차(후속 TEST/Actions) | 기대·실패 판정 | actual |
| --- | --- | --- | --- | --- |
| H01 원case29 contract18gold/raw | 기존 기본 후계핀에 맞는 pre-purpose 역사 projection+현재 helper, 기본 목적 | 기존 contract-selfcheck 전체를 기존 CLI로 실행 | oracle18·raw 집계·21 request·응답보존·비밀/정답비전송·unknown/no-resend 원assertion 그대로. current retention으로 분모0 변경하면 FAIL | NOT_RUN |
| H02 원case30 expiry | 같은 coherent 역사 입력+현재 helper | 원6증거 만료·credential-await 만료 검사 | 원 fetch/예약 횟수·unknown/미착수·환경경계 유지 | NOT_RUN |
| H03 원case42–44 C1–C3 | 자기 소유 역사 fixture+현재 source/helper | 기존 seed복제·ID/authority 독립·원source/oracle/inventory 변조 검사 | 원error·실제 admission 재읽기·환경/전송0. sourcefixture변조가 real helper에 연결되지 않으면 FAIL | NOT_RUN |
| H04 원case45 authority/CAS/IPC | 역사 fixture+현재 helper/실제prepared-child | 기존43검사 전체 | revoke·clock·scope·fsync·claim/ledger 원bytes·경쟁 승자·재시작무전송 유지, child회수뒤에만fixture정리 | NOT_RUN |
| C01 원case31 currentbudget | 현재원문·독립wire·고정금액정책, 명시mockretention | 원budget suite와실제worker | prepare/run/worker 모두같은기존purpose, 원pico/반올림/unknown/cap/경합assertion 불변 | NOT_RUN |
| C02 원case33–34·41 currentwire | 현재metadata·독립encoder·명시mockretention | 기존dynamic current/stale/precision | 원source/wire/digest/길이·정수기대·환경전송0 유지. 역사자료를current로 보고하면 FAIL | NOT_RUN |
| C03 원case32 precision12 | 원12입력·expectedStatus/Reason·policySHA·독립wire | 원precision suite실행후각case결과보존 | 원산술·돈·ledger/무전송assertion 유지. 현12setup 원인은 아직미확정, 동일원인 선확정 금지 | NOT_RUN |
| B01 PRS01/04/06 | 원provider-retention 테스트무변경 | 기존provider-observation-retention.test.ts | 기본current거부·cache목적분리·live/무fetcher거부·qualityNOT_RUN/분모0 유지 | NOT_RUN |
| L01 fixture자원수명 | 역사준비/호출자성공·오류·자식실패 | 기존cleanup/finally와원자식exit관측 | 자기temp만정리, childclose전삭제금지, 원fail/cause보존·새retry/timeout증가0 | NOT_RUN |

원AC→파일: H01/H02=bootstrap-contract.test.mjs; H03=bootstrap-fixture-reuse.test.ts; H04=prepared-bootstrap.test.ts; H01~04공유=history-r04-boundary.mjs(기존archive준비/cleanup재사용,새runner0). C01=budget-regression.mts(동일파일worker포함); C02=dynamic-current-{stale,oracle}.mts/dynamic-precision-boundary.mts; C03=precision-regression.mts; C01~03=prepared-fixture.mts(기존readyEstimateMock의선택목적전달). 다른담당independent-wire-mutations.mts는읽기만.

구현 중 정적 판별로 fixture 선택을 구체화했다. r04 archive는18gold지만 기본 loader가그historical hash에서source-successor를읽지않으므로H03의원후계manifest변조거부를검증할수없다. 원assertion을바꾸지않고,기존history helper의source-scratch/process/cleanup을재사용하여현재기본후계manifest/corpus/currenthelper를복사한뒤기존retirement정본14549a2e의3skill전체(coordinate-subagents/model-effort-advisor/codex-token-usage-analyzer)+registry를역사bytes로재현한다. 이projection은단일과거revision snapshot이라고주장하지않는다. 기존7핀의previousDigest및현기본61핀과원문정적비교61/61일치·불일치0을확인했다. 새gold·후계hash·purpose추가0. 원r04 archive/CLI2종/고정SHA/그역사budget·precision기대는그대로다. H01~04입력의‘coherent역사’는이검증된기본핀projection이다. 실제제품시험은여전히NOT_RUN이다.

CS 적용: CONC-CLAIM-001 원단일승자/실제child경합을보존, CONC-FENCE-002 authority/ledger revision재검증과외부bytes보존을보존, CONC-CANCEL-004 childclose/fixturefinally정리경계를보존. IMP004 자원소유자는 기존source-scratch와호출자가지며공유fixture캐시를추가하지않는다. 새락/폴링/DB0. 동적의무는승인환경TEST에서만판정하며정적검사를제품PASS로보고하지않는다.

원RED: server-1aed.log SHA092c532fa028fcc053dcd22583d7a3639817ff70793691802d27d9cd8f3360b6, case29–31/33–34/41–45는prepare275 ORACLE_SOURCE_MISMATCH, case32는PRECISION_BOUNDARIES_FAILED·12개ASSERTION_OR_SETUP_FAILED/assertion:null. 기존oracle를바꾸는RED/GREEN쌍을만들지않는다.

향후명령: Node24/동일lockfile을갖춘TEST/Actions에서 `pnpm exec vitest run tests/skill-classification/live-bootstrap/bootstrap-contract.test.mjs tests/skill-classification/live-bootstrap/bootstrap-fixture-reuse.test.ts tests/skill-classification/live-bootstrap/prepared-bootstrap.test.ts tests/skill-classification/live-bootstrap/provider-observation-retention.test.ts`. 실행환경의공용heavy.lock·원owner슬롯은root가결정한다. 이번구현자TEST/모델실행0.

## 구현 후 정적 결과

- 계획8da4be9ccab1a1fcaff5d4339c2509e2dc7b9101, current 목적전달85892d21d36bd24ec20cca6b60fcfe7cbead4730, 기본역사핀projection f0239fbec53d3a05bc78948e3ebc21611d8645c7을각각commit/push했다.
- Node24.19.0 `node --check` 변경10코드파일전부exit0, `git diff --check` exit0. 원assertion 줄200개(15+28+7+71+30+5+31+13)는명시purpose인자추가만정규화해값·순서동일을정적대조했다. 220개라고중간메시지에쓴것은합산오기이며200개가정본이다.
- current5caller의prepare/run26곳(14+4+2+4+2)과dynamic3곳readyEstimateMock의명시purpose전달을정적으로확인했다. budget의실제worker분기도같은파일내전달대상이다.
- 보호경로 mcp-server/src·evaluation.ts·bootstrap.mts·provider-retention-sources.mts·frozen corpus·budget/precision oracle·history-r04 archive/oldbudgetscript·independent-wire-mutations.mts는1aed대비diff0. 원contract-selfcheck/expiry/prepared-regression/prepared-child/PRS시험도byte동일이다.
- 기본fixture는과거역할3skill과registry를자기scratch에만복원한다. 현재모듈·기존61핀/manifest·corpus를사용하므로원C2의manifest변조·context-continuity복귀거부도유효한입력에서검사한다. provenance용git show는currentRepo에서만읽고변조대상은fixture뿐이다. 실제bootstrap admission이이전체경로를통과했다는결과는아직NOT_RUN이다.
- 원r04CLI의archive지문·예전돈정책/기대·기존timeout은그대로다. 새export를import만해도r04시험이자동실행되지않게기존CLIentry경계를명시했다. 자기fixture는callback종료뒤finally에서만회수하고 prepared wrapper는child close뒤에정리한다.
- 정적검사도중조회경로에`../`를정규화하지않은검사기1건과purpose옵션추가를정규화하지않은assertion비교기1건이실패했다. 경로/비교정규화를고쳐동일보호파일/원assertion을대조완료했으며이를제품RED나회귀PASS로세지않는다.
- 전제: TEST/Actions의기존Git역사objects(14549a2e포함)·tar·동일lockdeps. 새설치/전역설정/auth/HOME변경0. TEST/Actions실행·typecheck/lint·CS정형CLI검증은NOT_RUN이며구문/정적근거를행동·수용PASS로승격하지않는다.
