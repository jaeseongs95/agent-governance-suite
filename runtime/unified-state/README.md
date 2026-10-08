# 비활성 단일 파일 상태 후보

`authority.mjs`는 Node24의 내장 SQLite로 새 `ags-state.sqlite3` 하나를 열고 5종 module metadata, scope별 원 행·history, import source/intent/journal/conflict, lease, write receipt를 같은 파일에 저장한다. 설치경로나 환경변수·vendor별 DB resolver를 사용하지 않는다. `createProviderAdapter()`는 이미 열린 authority의 scope를 결속하며 DB를 새로 열지 않는다.

이 후보는 **fixture-only 컴포넌트**다. 실제 workflow/continuity/board/messaging/trust 전체 API, 인증된 host 신원, 기존 secret, MCP service와 운영 migration은 연결되지 않았다. caller가 제공한 fixture scope는 host-attestation이 아니다. stored trust receipt의 표현을 보존하지만 서명을 검증하거나 권한을 발급하지 않는다. 서로 다른 설치의 correlation을 계산·자동 rebind하지 않는다.

```js
import { InactiveUnifiedAuthority, createProviderAdapter, fixtureDigest } from "./authority.mjs";
const authority = new InactiveUnifiedAuthority({ directory: callerOwnedNewAbsoluteDirectory, mode: "fixture-only" });
const provider = createProviderAdapter(authority, { host: "fixture-host", sessionId: "fixture-session", taskId: "fixture-task" });
provider.importFixture({ snapshotJson: explicitSyntheticFixtureJson, sourceDigest: fixtureDigest(explicitSyntheticFixtureJson), intentId: "fixture-import" });
authority.close();
```

`directory`는 caller가 소유한 새 비활성 디렉터리여야 한다. 기존 운영 경로·DB를 인자로 주면 안 된다. resolver는 그 아래 파일명을 하나로 고정하고 linked DB와 다른 application/schema 파일을 거절한다. 이는 OS 인증/권한 sandbox가 아니며 동일 OS 권한의 공격자까지 격리한다고 주장하지 않는다.

fixture snapshot은 `sourceId`, `moduleVersions`, `records`로 구성한다. 각 record는 `module`, `table`, `scope`, 원 column을 그대로 가진 `row`다. 현재 source schema의 대표 구조에서 가져온 지원 table은 다음과 같다.

| module / source version | 지원되는 새 fixture 행 |
| --- | --- |
| workflow / 5 | `workflow_runs` |
| continuity / 2 또는 3 | `continuity_tasks`, `continuity_snapshots`, `continuity_requests` |
| board / 0(원 board는 user_version을 발급하지 않음) | `sessions` |
| messaging / 1 | `messages` |
| trust / 1 | `input_source_receipts` |

source의 실제 DB/schema를 조사한 결과가 아니다. 원 source code의 column/key 구조를 읽고 만든 부분 fixture이며 기존 계약 전체를 검증하는 importer도 아니다. 원 primary key 값과 JSON column 문자열은 보존하고 key·scope·revision·epoch는 별도 제약으로 결속한다. secret 소유 metadata table과 secret/key 필드의 import는 거절한다. `moduleVersions=3`은 opaque continuity 행 보존 입력을 허용한다는 뜻이며 legacy3 실행/복원 호환성 통과가 아니다.

한 global `user_version=1`과 별도 `module_schema`가 store별 user_version 충돌을 피한다. 기존 candidate의 table/module schema가 달라지면 조용히 초기화하지 않는다. source bytes digest·intent·scope를 먼저 결속하고 chunk의 records/history/journal/progress를 한 `BEGIN IMMEDIATE` commit에 둔다. ID/payload 충돌이면 chunk 데이터를 쓰지 않고 conflict를 기록한다. 다른 source로 같은 intent를 재사용한 시도는 기존 source pin·progress·완결 결과를 소급 변경하지 않는다. 동일 원 source/digest의 재시도·재개는 새 effect를 만들지 않는다.

원자 claim과 revision/lease generation/expiry 비교, history·write intent의 같은 commit이 stale 확정을 차단한다. scope는 host/session/task 3개 모두로 분리한다. 입력 형식과 scope를 먼저 검사한 뒤 한 `BEGIN IMMEDIATE` writer lock 안에서 유효한 authority time을 관측한다. domain 쓰기는 그 뒤의 SAVEPOINT에 두므로 stale claim·expiry 계산 오류 등의 domain 거절은 domain만 rollback하고 time을 commit한 뒤 원 오류를 반환한다. clock 자체가 유효하지 않거나 storage commit이 실패하면 완료로 보고하지 않는다. 이 local clock 처리는 실제 서비스의 신뢰 가능한 시간 authority를 증명하지 않는다.

commit과 로컬 응답 관측은 별도다. write intent는 `effectState=COMMITTED_LOCAL`, `responseState=UNKNOWN`으로 남고 명시적인 같은-scope receipt ACK만 `ACKED`로 바뀐다. commit 후 응답을 잃은 같은 intent의 replay는 기존 결과를 반환하고 effect를 반복하지 않는다. 외부 API 부작용의 exactly-once나 상대 업무 완료는 보장하지 않는다.

`inspect()`는 새 candidate의 table/count·`PRAGMA database_list`·integrity·foreign-key 검사만 제공한다. provider에 이 관리자 기능을 주지 않는다. `fault` callback은 비활성 fixture의 transaction/process 중단 주입용이며 서비스 운영 옵션이 아니다.

```text
node node_modules/vitest/vitest.mjs run tests/unified-state/authority.test.mjs --maxWorkers=1 --no-file-parallelism --no-cache --reporter=verbose
```

원 r1의 Windows local 12개 통과와 generation guard mutation 근거는 역사로 보존한다. D 독립 holdout에서 유효 time을 관측한 stale claim의 rollback이 time까지 되돌리는 결함을 발견했고, 원 후보는 같은 D oracle에서 실패했다. r2는 위 SAVEPOINT 경계로 수정하며 같은 oracle·기존 12개·다른 connection/process의 clock/expiry·부정 입력/clock 거절을 검사한다. 정확 결과와 후보 핀은 evidence/B/r2에 있으며 원 r1 PASS가 이 결함 부재의 근거는 아니다. 이를 전체 AGS·Cloud·실제 단일 공용 MCP·운영 이전 PASS로 확대하지 않는다.

남은 실제 결선은 별도 승인/구현/검증이 필요하다. `index.ts`와 broker가 common authority를 참조하고, 각 기존 store의 독자 `DatabaseSync`·global schema 초기화·secret owner·legacy SQL/API를 module repository로 바꾸어야 한다. 이 후보를 기존 constructor에 같은 경로로 넘기는 방식은 지원하지 않는다. 운영 source inventory·quiescence·secret/identity 절차·rollback·독립 감사·전환 승인은 이번에 수행하지 않았다.

의도적인 상한: source JSON 1MiB·1,000행, chunk 최대 1,000행, 한 SQLite writer. 더 큰 데이터는 승인된 source inventory와 처리량 근거가 생긴 뒤 chunked stream importer를 검토한다.
