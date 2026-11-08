# AGS 3.8.0 업그레이드와 기존 데이터 이관

기존 AGS를 쓰고 있다면 **3.8.0 플러그인을 처음 실행하기 전에 아래 순서로 백업과 이관을 준비하십시오.** 에이전트에게 맡기지 않아도 관리자가 직접 수행할 수 있는 절차입니다. 이미 3.8.0을 실행했다면 먼저 4절에서 schema를 확인하고 해당 경로를 따르십시오.

3.8.0은 기존 continuity SQLite schema 1·2·3을 4로 바꿉니다. 현재 메모리는 `continuity_current_memory`, 이전 내용은 `continuity_memory_history`로 분리합니다. 기존 current의 `JSON({status, core, evidenceRefs})` 전체가 UTF-8 기준 2000 byte 이하면 그 의미를 그대로 유지해 자동 이관합니다. 2000 byte는 상한이며 채워야 할 분량이 아닙니다. 초과 current가 있으면 관리자가 의미를 보존한 mapping을 준비해야 합니다. 필요한 mapping이 없거나 원본 digest가 달라지면 `MIGRATION_INCOMPLETE`로 전체 이관을 원자적으로 rollback하고 원래 schema를 유지합니다. 본문을 자르거나 빈 값으로 바꿔 이관하지 않습니다.

이 절차는 작업 기록 DB인 `continuity.sqlite3`용입니다. workflow·현황판·메시지 DB를 이 파일로 착각하거나, 다른 DB에 아래 CLI를 적용하지 마십시오. 원시 대화·로그·인증 파일과 다른 세션의 history는 열거나 입력에 넣지 않습니다. 내부 history를 직접 조회하는 과정도 없습니다.

## 1. 실행 도구와 별도 작업 폴더 준비

터미널에서 다음 명령으로 Node.js 버전을 확인합니다. Node.js 24.0.0 이상이 필요합니다.

```text
node --version
```

[3.8.0 태그 소스 ZIP](https://github.com/jaeseongs95/agent-governance-suite/archive/refs/tags/v3.8.0.zip)을 내려받아 **플러그인 설치 경로와 분리된 관리용 폴더**에 풉니다. 태그가 공개되기 전에는 이 링크를 사용할 수 없습니다. 임의의 최신 브랜치나 3.7 설치물의 CLI로 대체하지 마십시오. 소스 ZIP에는 실행용 번들이 들어 있어 `pnpm install`이나 빌드 없이 아래 파일을 사용할 수 있습니다.

```text
mcp-server/dist/continuity-memory-migration.mjs
```

명령 예시는 이 ZIP을 푼 저장소 루트에서 실행합니다. `<...>`는 관리자가 확인한 실제 절대 경로로 바꿉니다. Windows PowerShell과 macOS/Linux 터미널에서 같은 `node 파일 인자` 형태를 씁니다. 경로에 공백이 있으면 큰따옴표를 유지하십시오. 백업과 임시 JSON을 둘 개인 관리 폴더를 별도로 만들고, Git 저장소·공개 업로드·에이전트의 작업 자료 경로에 두지 않습니다.

## 2. 호스트마다 실제 DB 경로 확인

사용 중인 호스트의 **실제 AGS MCP 및 hook 실행 환경**에서 경로를 확인하십시오. 새 터미널의 환경이 앱의 환경과 같다고 가정하지 않습니다. 인증 설정 전체나 환경 변수 전체를 출력할 필요는 없습니다. 필요한 경로 항목만 확인합니다.

| 실행 경로 | continuity DB 결정 방법 |
| --- | --- |
| Codex·Antigravity(agy)의 공용 런타임 | `AGENT_GOVERNANCE_CONTINUITY_DB_PATH`가 있으면 우선합니다. 없으면 `AGENT_GOVERNANCE_DB_PATH`가 가리키는 workflow DB 옆의 `continuity.sqlite3`를 씁니다. 두 항목이 없으면 아래 OS 기본 위치를 씁니다. 상대 경로 override는 해당 프로세스의 작업 디렉터리 기준이므로 절대 경로로 확인하십시오. |
| Claude Code 플러그인 | 배포 wrapper와 hook이 `${CLAUDE_PLUGIN_DATA}/continuity.sqlite3`를 사용하도록 설정합니다. Claude 플러그인의 실제 `CLAUDE_PLUGIN_DATA` 값을 확인하십시오. 일반 터미널의 override가 이 wrapper 설정을 덮는다고 가정하지 않습니다. |

공용 런타임의 OS 기본 위치는 다음과 같습니다. 특정 PC의 사용자명이나 드라이브를 공통 경로로 쓰지 마십시오.

- Windows: `%LOCALAPPDATA%\agent-governance-suite\continuity.sqlite3`. `LOCALAPPDATA`가 없으면 사용자 홈의 `AppData\Local` 아래입니다.
- macOS: `~/Library/Application Support/agent-governance-suite/continuity.sqlite3`.
- Linux: `$XDG_STATE_HOME/agent-governance-suite/continuity.sqlite3`. `XDG_STATE_HOME`이 없으면 `~/.local/state/agent-governance-suite/continuity.sqlite3`.

호스트가 같은 파일을 쓰면 한 번만 이관합니다. Claude 등에서 서로 다른 파일을 쓰면 **파일마다 백업·판별·이관을 따로 수행**합니다. `AGENT_GOVERNANCE_SHARED_STATE_DIR`는 현황판·메시지 등의 공용 상태 경로이며 continuity DB 경로 확인을 대신하지 않습니다. 파일이 없거나 경로를 확정하지 못하면 새 빈 DB를 만들지 말고 여기서 멈춥니다. override의 전체 목록은 [상태 저장과 마이그레이션](https://github.com/jaeseongs95/agent-governance-suite/blob/v3.8.0/docs/operations.md#상태-저장과-마이그레이션)을 참고하십시오.

## 3. 해당 DB의 모든 writer 종료 후 백업

진행 중인 작업을 저장하고 해당 DB를 공유하는 Codex·Claude Code·agy 세션과 AGS MCP·hook·relay를 정상 종료합니다. 자동 재실행도 멈추십시오. 설치 폴더가 달라도 같은 DB를 열 수 있습니다. 운영체제의 프로세스 목록에서 실행 파일과 설치 경로를 대조해 해당 writer가 종료됐는지 확인합니다. 모르는 프로세스를 일괄 강제 종료하지 마십시오. 종료 여부를 확인할 수 없다면 이관을 진행하지 않습니다. 이후 7절까지 해당 호스트를 다시 열지 않습니다.

**사용 중인 SQLite의 main 파일만 탐색기나 `cp`로 복사하면 WAL의 committed 변경이 빠질 수 있습니다.** `-wal`·`-shm` 파일을 먼저 삭제하지 마십시오. 아래는 [Node.js 표준 `node:sqlite`의 `backup`](https://nodejs.org/download/release/v24.14.0/docs/api/sqlite.html#sqlitebackupsourceDb-path-options)을 쓰는 관리용 코드입니다. SQLite backup API로 WAL의 committed 내용을 포함하는 일관된 백업을 만듭니다. 기존 백업을 덮어쓰지 않도록 목적 파일을 `wx`로 먼저 확보합니다.

다음 코드를 개인 관리 폴더의 새 UTF-8 파일 `backup-sqlite.mjs`로 저장합니다. 제품에 추가로 설치하는 프로그램이 아닙니다.

```js
import { closeSync, openSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';

const [source, destination] = process.argv.slice(2);
if (!source || !destination || !path.isAbsolute(source) || !path.isAbsolute(destination)) {
  throw new Error('Use absolute source and NEW destination paths');
}
const sourcePath = realpathSync(source);
if (!statSync(sourcePath).isFile()) throw new Error('Source must be an existing file');
const db = new DatabaseSync(sourcePath, { readOnly: true });
try {
  closeSync(openSync(destination, 'wx', 0o600));
  await backup(db, destination);
} finally {
  db.close();
}
const copy = new DatabaseSync(destination, { readOnly: true });
try {
  const checks = copy.prepare('PRAGMA quick_check').all();
  if (checks.length !== 1 || checks[0].quick_check !== 'ok') throw new Error('Backup check failed');
  console.log(JSON.stringify({ ok: true, schema: copy.prepare('PRAGMA user_version').get().user_version }));
} finally {
  copy.close();
}
```

다음 예시의 `backup-sqlite.mjs`도 저장한 파일의 절대 경로로 바꿉니다.

```text
node "<backup-sqlite.mjs>" "<existing-continuity.sqlite3>" "<new-pre-3.8-backup.sqlite3>"
```

종료 코드 0과 `{"ok":true,"schema":...}`를 확인합니다. 도중에 실패한 목적 파일은 완성된 백업으로 쓰지 말고, 원인을 확인한 뒤 다른 새 목적 경로로 실행합니다. 백업에도 비공개 이력이 들어 있으므로 에이전트에게 읽히거나 공개하지 마십시오. 파일 권한은 OS 설정에도 영향을 받으며, 같은 OS 사용자의 shell 접근을 격리하는 기능은 아닙니다.

## 4. schema를 확인하고 진행 경로 선택

백업 결과의 `schema`로 현재 DB의 이관 전 상태를 확인합니다. 이후 확인이 필요할 때는 다음 코드를 개인 관리 폴더의 새 UTF-8 파일 `check-continuity-schema.mjs`로 저장해 사용합니다. 기존 파일을 읽기 전용으로 열어 schema와 SQLite 무결성만 확인하며 current·history 본문을 출력하지 않습니다.

```js
import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const input = process.argv[2];
if (!input || !path.isAbsolute(input)) throw new Error('Use an absolute existing database path');
const file = realpathSync(input);
if (!statSync(file).isFile()) throw new Error('Database must be an existing file');
const db = new DatabaseSync(file, { readOnly: true });
try {
  const checks = db.prepare('PRAGMA quick_check').all();
  if (checks.length !== 1 || checks[0].quick_check !== 'ok') throw new Error('Database check failed');
  console.log(JSON.stringify({ ok: true, schema: db.prepare('PRAGMA user_version').get().user_version }));
} finally {
  db.close();
}
```

```text
node "<check-continuity-schema.mjs>" "<existing-continuity.sqlite3>"
```

| 결과 | 다음 행동 |
| --- | --- |
| schema 1·2·3 | 5절부터 진행합니다. 3.8.0 실행이 이관 오류로 실패한 뒤에도 이 상태라면 원 schema가 남은 경로입니다. 백업 후 current mapping을 준비합니다. |
| schema 4 | 이미 자동 또는 관리 이관된 상태입니다. `export-current`와 `apply`는 `ALREADY_MIGRATED`로 거부합니다. 다시 legacy mapping을 만들지 말고 7절로 갑니다. 지금 만든 schema 4 백업은 3.7로 되돌리는 백업이 아닙니다. |
| 그 밖의 값 또는 무결성 오류 | 파일 선택과 버전을 확인하고 중단합니다. SQL로 schema 번호만 바꾸거나 빈 DB로 대체하지 마십시오. |

## 5. current만 내보내고 크기별로 mapping 준비

다음 명령은 **이관이 지원되는 당시 current만** 관리자 파일로 내보냅니다. history를 내보내거나 열람하지 않습니다. 출력 파일은 아직 없는 새 경로여야 합니다.

```text
node mcp-server/dist/continuity-memory-migration.mjs export-current --database "<existing-continuity.sqlite3>" --output "<new-current-mapping.json>"
```

종료 코드 0과 `EXPORTED_CURRENT`를 확인하고 응답의 다음 항목을 함께 확인합니다.

| 항목 | 뜻 |
| --- | --- |
| `count` | 지원되는 current를 내보낸 수입니다. |
| `excludedReceiverTasks` | current 후보 중 기존 `continuity_delta_state`가 있어 제외한 작업 수입니다. 과거 epoch의 수신 상태가 남아 있어도 작업 전체를 제외하며 해당 snapshot 본문은 내보내지 않습니다. |
| `exclusionReason` | 제외한 작업이 있으면 `RECEIVER_STATE_UNSUPPORTED`, 없으면 `null`입니다. |

`excludedReceiverTasks`가 1 이상이면 작은 `count`나 빈 출력 배열을 모든 current의 부재 또는 이관 준비 완료로 해석하지 마십시오. 이 가이드는 제외된 수신 상태를 새 current로 변환하지 않습니다. 적용을 진행하지 말고 원래 DB와 사전 백업을 유지한 채 오류 코드로 지원을 요청하십시오. 제외된 작업을 임의 mapping으로 추가하거나 수신 상태·예전 snapshot 본문을 읽어 current를 재구성하지 않습니다.

내보낸 JSON 배열의 각 항목에는 정확히 세 키 `taskCorrelation`, `expectedSnapshotDigest`, `memory`가 있습니다. 별도 새 파일 `prepared-mapping.json`을 만들어 배열을 준비하십시오. `taskCorrelation`과 `expectedSnapshotDigest`는 내보낸 값 그대로 둡니다. `memory`에도 정확히 `status`, `core`, `evidenceRefs` 세 키가 있어야 합니다. `core`에는 `objective`, `completionCriteria`, `constraints`, `decisions`, `progress`, `blockers`, `nextActions`가 있고, 근거에는 `artifactId`, `locator`, `digest`, `verified`가 있습니다. 키를 덧붙이거나 이름을 바꾸지 않습니다.

각 항목의 크기는 보기 좋게 들여쓴 파일 전체가 아니라 **공백 없이 직렬화한 `memory` JSON 전체의 UTF-8 byte**로 판단합니다. 다음 코드를 개인 관리 폴더의 새 UTF-8 파일 `memory-sizes.mjs`로 저장합니다. current 본문이나 식별자를 출력하지 않고 배열 순번과 byte 수만 출력합니다.

```js
import { readFileSync } from 'node:fs';
try {
  const mappings = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  if (!Array.isArray(mappings)) throw new Error('Expected a mapping array');
  for (const [index, item] of mappings.entries()) {
    const bytes = Buffer.byteLength(JSON.stringify(item.memory), 'utf8');
    console.log(JSON.stringify({ index, bytes, withinLimit: bytes <= 2000 }));
  }
} catch {
  console.error('MEMORY_SIZE_CHECK_FAILED');
  process.exitCode = 1;
}
```

```text
node "<memory-sizes.mjs>" "<new-current-mapping.json>"
```

읽기·JSON 파싱·크기 계산에 실패하면 원문이나 오류 객체 대신 `MEMORY_SIZE_CHECK_FAILED`만 출력하고 종료 코드 1을 반환합니다. 이때는 출력된 일부 항목만으로 전체 확인에 성공했다고 보지 말고 입력 파일과 JSON 형식을 확인하십시오.

- **2000 byte 이하:** 해당 current의 `memory`를 그대로 유지하십시오. 작다는 이유로 내용을 다시 요약하지 않습니다.
- **2000 byte 초과:** 해당 current만 사람이 읽고 의미를 최적화합니다. 목표, 완료 조건, 현재 유효한 사용자 교정, 제약과 결정, 미완료 상태와 blocker, 다음 행동에 필요한 근거를 보존합니다. 중복과 이미 효력이 없는 완료 내역을 정리하되 판단에 필요한 연결을 잃지 않게 합니다. 필수 근거의 hash·ID를 바꾸거나 긴 refs 목록으로 본문을 대신하지 않습니다. 무작정 앞부분만 자르기, 빈 `core`·빈 값으로 대체하기, 필요한 항목·근거를 버려 통과시키기는 금지합니다. 의미를 보존한 채 상한 안에 넣지 못하면 적용하지 말고 기존 버전과 백업을 유지합니다.

편집한 파일에도 같은 크기 명령을 실행해 **모든 항목**이 상한 안인지 확인합니다. 크기 확인은 의미 보존이나 계약 검증을 대신하지 않습니다. JSON 문법, 필드 계약과 digest 일치는 `apply`가 검사합니다. 원본 digest를 새로 계산해 써 넣어 불일치를 무시하지 마십시오. 출력이 빈 배열 `[]`이고 `excludedReceiverTasks`도 0이면 내보낼 current가 없는 상태입니다. 제외한 작업이 있으면 위의 수신 상태 안내를 따르고 임의 항목을 만들지 않습니다.

## 6. 준비한 mapping 적용

호스트와 writer가 계속 종료된 상태인지 다시 확인한 뒤 실행합니다.

```text
node mcp-server/dist/continuity-memory-migration.mjs apply --database "<existing-continuity.sqlite3>" --mapping "<prepared-mapping.json>"
node "<check-continuity-schema.mjs>" "<existing-continuity.sqlite3>"
```

첫 명령의 **종료 코드 0과 `MIGRATED`를 확인한 뒤에만** 두 번째 명령을 실행합니다. 이어 schema 4인지, 무결성 확인에 성공했는지 확인합니다. `count`는 mapping 항목 수이며 과거 history의 수나 의미 보존 검증 결과가 아닙니다. 중간 실패를 다음 명령의 성공으로 덮어 보고하지 마십시오.

내보낸 JSON과 prepared mapping은 교체가 끝난 뒤 과거 본문 사본이 됩니다. 에이전트가 접근하는 작업 폴더·첨부·참고 링크에서 회수하고 Git이나 공개 이슈에 올리지 마십시오. 관리자가 보관할 필요가 있으면 비공개 백업과 함께 별도 관리합니다. 같은 OS 사용자의 직접 파일·shell 접근은 현행 권한을 따르며, 이 절차가 별도 OS 격리를 제공하지는 않습니다.

## 7. 호스트 플러그인 갱신과 재적재

사용하는 모든 호스트의 AGS를 3.8.0으로 갱신합니다. 같은 DB를 공유하는 3.7 프로세스와 3.8 프로세스를 함께 실행하지 마십시오. 설치 방법은 [Codex·Claude Code·agy 설치 안내](https://github.com/jaeseongs95/agent-governance-suite/blob/v3.8.0/README.md#설치)를 따릅니다.

- Codex: 기존 AGS MCP·relay를 종료한 뒤 플러그인을 갱신하고 새 세션을 엽니다. `/hooks`에서 hook을 다시 신뢰합니다.
- Claude Code: 플러그인을 갱신하고 기존 세션을 종료한 뒤 새 세션에서 MCP와 hook을 재적재합니다. Claude 전용 DB 경로가 유지되는지 확인합니다.
- Antigravity(agy): 앱을 완전히 닫고 새 설치본으로 갱신한 뒤 다시 엽니다.

CLI가 없는 Antigravity 네이티브 앱은 [위 설치 안내의 수동 설치 절차](https://github.com/jaeseongs95/agent-governance-suite/blob/v3.8.0/README.md#antigravity-agy)로도 갱신할 수 있습니다.

각 호스트가 사용하는 DB에 대해 4절의 읽기 전용 확인으로 schema 4를 확인합니다. 호스트에서 AGS 도구가 정상 연결되는지도 확인합니다. 기존 API를 직접 호출하는 연동은 새 계약에 맞춰 수정해야 합니다. `load_context`는 `schemaVersion`만으로 자기 current를 읽고, 반환된 `stateToken`을 `checkpoint_context`·`purge_direct_context`의 `expectedStateToken`으로 전달합니다. 기존 `expectedRevision`을 계속 보내지 마십시오. 데이터 이관 성공과 실제 호스트 hook의 동작 확인은 서로 다른 확인입니다.

## 8. 실패 원인별 대응과 3.7 복구

CLI 실패는 종료 코드 1과 `MIGRATION_CLI_FAILED`의 `reason`으로 확인합니다. 원문과 mapping을 공개하지 말고 오류 코드·Node 버전·호스트·schema 번호만 기록하십시오.

| 오류 또는 상황 | 대응 |
| --- | --- |
| `ALREADY_MIGRATED` | schema 4 경로입니다. export/apply를 반복하지 말고 7절을 진행합니다. |
| `MIGRATION_INCOMPLETE` | 원 schema와 백업을 유지하고 current mapping의 누락, 원본 digest 변경, 초과 크기를 확인합니다. writer가 다시 실행됐다면 종료 후 새 이름으로 current를 다시 내보내고 mapping을 준비합니다. |
| `RECEIVER_STATE_UNSUPPORTED` | 수신 상태가 있는 작업의 mapping 적용은 지원하지 않아 거절됩니다. 이관을 중단하고 원래 DB와 사전 백업을 보존합니다. 새 export 응답의 `excludedReceiverTasks`와 `exclusionReason`을 확인하고 지원을 요청하십시오. 해당 작업의 mapping을 임의로 만들거나 원본·수신 상태를 SQL로 바꾸지 않습니다. |
| `MEMORY_TOO_LARGE`, `INVALID_MEMORY` | 해당 `memory`의 크기 또는 필드 계약을 고칩니다. 빈 값이나 항목 삭제로 의미 손실을 숨기지 않습니다. |
| `INVALID_MAPPING_JSON`, `INVALID_MAPPING`, `DUPLICATE_MAPPING` | JSON 배열, 정확한 세 키, 중복 없는 `taskCorrelation`, 원본 digest 형식을 확인합니다. |
| `DATABASE_PATH_NOT_ABSOLUTE`, `DATABASE_NOT_FILE`, 파일 없음·접근 거부 | 호스트의 실제 DB와 절대 경로·권한을 다시 확인합니다. 관리자 권한으로 임의 우회하거나 새 DB를 만들지 않습니다. |
| 출력 파일이 이미 있음 | 기존 export나 백업을 덮어쓰지 말고 새 출력 경로를 정합니다. |
| `UNSUPPORTED_SCHEMA`, `INCOMPATIBLE_SCHEMA`, `CORRUPT_DATABASE`, `INVALID_LEGACY_CURRENT`, 그 밖의 오류 | 적용을 중단하고 원본·백업을 보존합니다. schema 번호·digest를 직접 고치지 말고 오류 코드로 지원을 요청합니다. |

**3.7로 되돌리려면 3.8을 처음 실행하기 전에 만든 schema 1·2·3의 일관된 백업이 필요합니다.** schema 4 DB를 3.7이 읽을 수 있다고 가정하지 마십시오. 3.8 실행 후에만 만든 백업이나 export JSON은 이 사전 백업을 대신하지 못합니다. 사전 백업이 없다면 본 절차로 3.7 복구를 보장할 수 없습니다.

복구가 필요하면 다음 순서를 따릅니다.

1. 같은 DB를 사용하는 모든 호스트·AGS 프로세스를 정상 종료하고 재실행을 막습니다. 현재 상태를 남기려면 3절의 backup 코드로 **별도의 새 파일**에 보존합니다.
2. 사전 백업에 4절의 schema 확인을 실행해 무결성과 schema 1·2·3을 확인합니다. 백업은 수정하지 않습니다.
3. 원래 DB와 같은 디스크에 새 격리 폴더를 만들고 현재 DB 파일 및 같은 이름의 `-wal`·`-shm` 파일이 있으면 모두 그 폴더로 이동합니다. 정확히 해당 DB의 파일만 옮기고 삭제하지 마십시오. 실행 중인 writer가 있거나 이동이 실패하면 멈춥니다. 옛 WAL을 복구 DB 옆에 남기지 않습니다.
4. 원래 DB 경로가 비어 있는지 확인한 뒤 아래 명령으로 사전 백업에서 DB를 복원합니다. 목적 경로에 파일이 이미 있으면 코드가 거부합니다.

   ```text
   node "<backup-sqlite.mjs>" "<pre-3.8-backup.sqlite3>" "<original-continuity.sqlite3>"
   node "<check-continuity-schema.mjs>" "<original-continuity.sqlite3>"
   ```

5. 복원 명령의 종료 코드 0을 확인한 뒤 schema 확인 명령을 실행합니다. schema 1·2·3과 무결성 확인에 성공하면 기존 3.7 플러그인으로 되돌리고 재적재합니다. 3.8 플러그인을 먼저 실행하면 다시 이관을 시도합니다. 호스트별로 서로 다른 DB를 사용했다면 각 파일의 백업으로 각각 복원합니다.

복원은 **백업 시점 이후의 변경을 되돌립니다.** 3.8에서 새로 기록한 current를 과거 백업에 합치는 절차는 제공하지 않습니다. 복구 후에도 사전 백업과 격리한 파일은 확인이 끝날 때까지 보존하십시오.
