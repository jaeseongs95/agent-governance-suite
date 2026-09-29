
## 43-e2-state-fix-main.log
| target | apply-1 | apply-2 | new-gen apply-1 | new-gen apply-2 |
|---|---|---|---|---|
| exp-T0-control | false | false | - | - |
| exp-T1-gen-unknown | false | false | false | false |
| exp-T2-gen-submitted | false | false | false | false |
| exp-T3-late-unknown | true | false | false | false |
| exp-T4-started-crash | false | false | false | false |
| exp-T5-ttl-unknown | false | false | false | false |
| exp-T6-ttl-late | false | false | true | false |
| exp-T1-gen-unknown (wrong-receipt) | false | - | - | - |

row invariance 00 -> 07 (all columns, rows present at 00):
- exp-T0-control rowid=7 state submitted->submitted UNCHANGED
- exp-T1-gen-unknown rowid=3 state unknown->unknown UNCHANGED
- exp-T2-gen-submitted rowid=4 state submitted->submitted UNCHANGED
- exp-T3-late-unknown rowid=5 state unknown->observed CHANGED
- exp-T4-started-crash rowid=6 state submitted->submitted UNCHANGED
- exp-T5-ttl-unknown rowid=1 state unknown->unknown UNCHANGED
- exp-T6-ttl-late rowid=2 state unknown->observed CHANGED

admission:
- T1-gen-unknown: reserve=false start=- outcome=- 2ndReserveActive=- claim1=null claim2Replay=null reserveAfterClaim=-
- T2-gen-submitted: reserve=false start=- outcome=- 2ndReserveActive=- claim1=null claim2Replay=null reserveAfterClaim=-
- T3-late-unknown: reserve=true start=true outcome=true 2ndReserveActive=false claim1={"recognized":true,"managed":true,"messages":["1649419d-afb0-44c9-b384-1e4d8c6072a9"]} claim2Replay={"recognized":false,"messages":0} reserveAfterClaim=false
- T4-started-crash: reserve=false start=- outcome=- 2ndReserveActive=- claim1=null claim2Replay=null reserveAfterClaim=-
- T5-ttl-unknown: reserve=false start=- outcome=- 2ndReserveActive=- claim1=null claim2Replay=null reserveAfterClaim=-
- T6-ttl-late: reserve=true start=true outcome=true 2ndReserveActive=false claim1={"recognized":true,"managed":true,"messages":["ae20b4e0-069f-4c14-b236-bbae93f0d120"]} claim2Replay={"recognized":false,"messages":0} reserveAfterClaim=false

late outcome on reconciled T3 old attempt: {"recorded":false}

apply-2 no-op: messageLogical 03==04 true; wal sha 03==04 true
newgen-2 no-op: messageLogical 05==06 true
defaultTrustDir in every snap: null
trust receipts/keyDigest/schema by snap: 00-pre-broker:2/c5b69183ad047431/3a305bbe 01-after-broker-start:2/c5b69183ad047431/3a305bbe 02-after-status-queries:2/c5b69183ad047431/3a305bbe 03-after-apply-1:2/c5b69183ad047431/3a305bbe 04-after-apply-2:2/c5b69183ad047431/3a305bbe 05-after-new-gen-apply:2/c5b69183ad047431/3a305bbe 06-after-new-gen-apply-2:2/c5b69183ad047431/3a305bbe 07-after-admission:4/c5b69183ad047431/3a305bbe 08-after-broker-stop:4/c5b69183ad047431/3a305bbe
T3/T6 rows at 07:
  exp-T3-late-unknown observed attempt=9e233057 observed=2026-09-28T06:05:15.000Z late=2026-09-28T06:05:15.001Z consumed=2026-09-28T08:04:38.823Z
  exp-T3-late-unknown observed attempt=f6310dae observed=2026-09-28T08:04:41.247Z late=null consumed=2026-09-28T08:04:41.247Z
  exp-T6-ttl-late observed attempt=c6eba2e9 observed=2026-09-28T06:05:15.000Z late=2026-09-28T06:05:15.001Z consumed=2026-09-28T08:04:40.177Z
  exp-T6-ttl-late observed attempt=6a2c6c41 observed=2026-09-28T08:04:41.795Z late=null consumed=2026-09-28T08:04:41.795Z
broker env keys: PATH,HOME,AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR

## 44-e2-state-fix-direct.log
| target | apply-1 | apply-2 | new-gen apply-1 | new-gen apply-2 |
|---|---|---|---|---|
| exp-T0-control | false | false | - | - |
| exp-T1-gen-unknown | false | false | false | false |
| exp-T2-gen-submitted | false | false | false | false |
| exp-T3-late-unknown | true | false | false | false |
| exp-T4-started-crash | false | false | false | false |
| exp-T5-ttl-unknown | false | false | false | false |
| exp-T6-ttl-late | false | false | true | false |
| exp-T1-gen-unknown (wrong-receipt) | false | - | - | - |

row invariance 00 -> 07 (all columns, rows present at 00):
- exp-T0-control rowid=7 state submitted->submitted UNCHANGED
- exp-T1-gen-unknown rowid=3 state unknown->unknown UNCHANGED
- exp-T2-gen-submitted rowid=4 state submitted->submitted UNCHANGED
- exp-T3-late-unknown rowid=5 state unknown->observed CHANGED
- exp-T4-started-crash rowid=6 state submitted->submitted UNCHANGED
- exp-T5-ttl-unknown rowid=1 state unknown->unknown UNCHANGED
- exp-T6-ttl-late rowid=2 state unknown->observed CHANGED

admission:
- T1-gen-unknown: reserve=false start=- outcome=- 2ndReserveActive=- claim1=null claim2Replay=null reserveAfterClaim=-
- T2-gen-submitted: reserve=false start=- outcome=- 2ndReserveActive=- claim1=null claim2Replay=null reserveAfterClaim=-
- T3-late-unknown: reserve=true start=true outcome=true 2ndReserveActive=false claim1={"recognized":true,"managed":true,"messages":["295c25a2-62c7-4884-ba3b-4e0e99ce3706"]} claim2Replay={"recognized":false,"messages":0} reserveAfterClaim=false
- T4-started-crash: reserve=false start=- outcome=- 2ndReserveActive=- claim1=null claim2Replay=null reserveAfterClaim=-
- T5-ttl-unknown: reserve=false start=- outcome=- 2ndReserveActive=- claim1=null claim2Replay=null reserveAfterClaim=-
- T6-ttl-late: reserve=true start=true outcome=true 2ndReserveActive=false claim1={"recognized":true,"managed":true,"messages":["84558a4d-8cc6-4258-a5a7-4e45bd856104"]} claim2Replay={"recognized":false,"messages":0} reserveAfterClaim=false

late outcome on reconciled T3 old attempt: {"recorded":false}

apply-2 no-op: messageLogical 03==04 true; wal sha 03==04 true
newgen-2 no-op: messageLogical 05==06 true
defaultTrustDir in every snap: null
trust receipts/keyDigest/schema by snap: 00-pre-broker:2/c5b69183ad047431/3a305bbe 01-after-broker-start:2/c5b69183ad047431/3a305bbe 02-after-status-queries:2/c5b69183ad047431/3a305bbe 03-after-apply-1:2/c5b69183ad047431/3a305bbe 04-after-apply-2:2/c5b69183ad047431/3a305bbe 05-after-new-gen-apply:2/c5b69183ad047431/3a305bbe 06-after-new-gen-apply-2:2/c5b69183ad047431/3a305bbe 07-after-admission:4/c5b69183ad047431/3a305bbe 08-after-broker-stop:4/c5b69183ad047431/3a305bbe
T3/T6 rows at 07:
  exp-T3-late-unknown observed attempt=9e233057 observed=2026-09-28T06:05:15.000Z late=2026-09-28T06:05:15.001Z consumed=2026-09-28T08:04:42.500Z
  exp-T3-late-unknown observed attempt=35d0b66a observed=2026-09-28T08:04:45.194Z late=null consumed=2026-09-28T08:04:45.194Z
  exp-T6-ttl-late observed attempt=c6eba2e9 observed=2026-09-28T06:05:15.000Z late=2026-09-28T06:05:15.001Z consumed=2026-09-28T08:04:43.939Z
  exp-T6-ttl-late observed attempt=fd2b6ccf observed=2026-09-28T08:04:45.904Z late=null consumed=2026-09-28T08:04:45.904Z
broker env keys: PATH,HOME

## 45-e2-state-fix-claude-direct.log
| target | apply-1 | apply-2 | new-gen apply-1 | new-gen apply-2 |
|---|---|---|---|---|
| exp-T0-control | false | false | - | - |
| exp-T1-gen-unknown | false | false | false | false |
| exp-T2-gen-submitted | false | false | false | false |
| exp-T3-late-unknown | true | false | false | false |
| exp-T4-started-crash | false | false | false | false |
| exp-T5-ttl-unknown | false | false | false | false |
| exp-T6-ttl-late | false | false | true | false |
| exp-T1-gen-unknown (wrong-receipt) | false | - | - | - |

row invariance 00 -> 07 (all columns, rows present at 00):
- exp-T0-control rowid=7 state submitted->submitted UNCHANGED
- exp-T1-gen-unknown rowid=3 state unknown->unknown UNCHANGED
- exp-T2-gen-submitted rowid=4 state submitted->submitted UNCHANGED
- exp-T3-late-unknown rowid=5 state unknown->observed CHANGED
- exp-T4-started-crash rowid=6 state submitted->submitted UNCHANGED
- exp-T5-ttl-unknown rowid=1 state unknown->unknown UNCHANGED
- exp-T6-ttl-late rowid=2 state unknown->observed CHANGED

admission:
- T1-gen-unknown: reserve=false start=- outcome=- 2ndReserveActive=- claim1=null claim2Replay=null reserveAfterClaim=-
- T2-gen-submitted: reserve=false start=- outcome=- 2ndReserveActive=- claim1=null claim2Replay=null reserveAfterClaim=-
- T3-late-unknown: reserve=true start=true outcome=true 2ndReserveActive=false claim1={"recognized":true,"managed":true,"messages":["47845077-b2c3-44ea-b194-f20caa1ab332"]} claim2Replay={"recognized":false,"messages":0} reserveAfterClaim=false
- T4-started-crash: reserve=false start=- outcome=- 2ndReserveActive=- claim1=null claim2Replay=null reserveAfterClaim=-
- T5-ttl-unknown: reserve=false start=- outcome=- 2ndReserveActive=- claim1=null claim2Replay=null reserveAfterClaim=-
- T6-ttl-late: reserve=true start=true outcome=true 2ndReserveActive=false claim1={"recognized":true,"managed":true,"messages":["c2e31b04-c46b-403f-85a9-5e162cc9a755"]} claim2Replay={"recognized":false,"messages":0} reserveAfterClaim=false

late outcome on reconciled T3 old attempt: {"recorded":false}

apply-2 no-op: messageLogical 03==04 true; wal sha 03==04 true
newgen-2 no-op: messageLogical 05==06 true
defaultTrustDir in every snap: null
trust receipts/keyDigest/schema by snap: 00-pre-broker:2/c5b69183ad047431/3a305bbe 01-after-broker-start:2/c5b69183ad047431/3a305bbe 02-after-status-queries:2/c5b69183ad047431/3a305bbe 03-after-apply-1:2/c5b69183ad047431/3a305bbe 04-after-apply-2:2/c5b69183ad047431/3a305bbe 05-after-new-gen-apply:2/c5b69183ad047431/3a305bbe 06-after-new-gen-apply-2:2/c5b69183ad047431/3a305bbe 07-after-admission:4/c5b69183ad047431/3a305bbe 08-after-broker-stop:4/c5b69183ad047431/3a305bbe
T3/T6 rows at 07:
  exp-T3-late-unknown observed attempt=9e233057 observed=2026-09-28T06:05:15.000Z late=2026-09-28T06:05:15.001Z consumed=2026-09-28T08:04:46.677Z
  exp-T3-late-unknown observed attempt=1f4ff7e1 observed=2026-09-28T08:04:49.685Z late=null consumed=2026-09-28T08:04:49.685Z
  exp-T6-ttl-late observed attempt=c6eba2e9 observed=2026-09-28T06:05:15.000Z late=2026-09-28T06:05:15.001Z consumed=2026-09-28T08:04:48.150Z
  exp-T6-ttl-late observed attempt=3d7a4d08 observed=2026-09-28T08:04:50.399Z late=null consumed=2026-09-28T08:04:50.399Z
broker env keys: PATH,HOME
