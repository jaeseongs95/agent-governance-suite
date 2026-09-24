# B14-m — storage 기대 file ID 출처·provisioning 계약

계약 ID: `ags-resource-storage-identity-provisioning/v1`, revision `1`. 상태: **CONTRACT_ONLY**. 이 문서는 자원 원장의 **보호된 기대 file ID**를 누가 어떻게 만들고 보관·전달·회전·복구하는지 고정한다. 도구 구현(B14-n), 운영 공급 증거(B14-o), 실제 SQLite 연결의 열린 파일 identity 증명(B14-h/B14-p), 제품 writer(B14-i)와 운영 설치는 이 문서의 범위가 아니다. 설계 동결만으로 출처를 실증했다고 기록하지 않는다.

## 참조 기준

| 참조 | 고정 값 | 사용 범위 |
| --- | --- | --- |
| V03-i 보호 설치 계약 | `docs/implementation-3x/protected-host-installation.ko.md` sha256 `17b38aaafcae4d310a4a09e153ef0e1567a9c0570c4d045ab14e2513883da181`, 공통 절 `protected-host-provisioning/v1` (base `d007f8a`) | installer(관리자·root) 신뢰 경계, installer 보호 subtree 경로, 절차 1·4(선점 거부, fail-closed 복구)만 권위로 소비한다(아래 미해결 참조). VM key/pin/worker fixture digest, VM 서비스 SID/uid는 강제하지 않는다. |
| B14-h storage trust 계약 | commit `476e6ce`, blob `08654d6290a7dfd50b329a9a702b50fb5acab989` (sha256 `a740fcb67b513377dfbaa7d9e8e4fddc0aaaca487f563787a63a25cfcd796f99`), `BLOCKED_CONTRACT` | 보호 대상과 공격자 모델, writer 채택 조건 2·3을 입력으로 쓴다. 이 문서는 조건 2의 "보호된 사전 등록 기록"만 정의한다. |
| B14-p probe 증거 | `docs/implementation-3x/evidence/sqlite-identity-capability.json` (commit `b772006`) | Windows에서 같은 연결의 handle로 `FileIdInfo`를 읽는 mechanism 관측. 기대 ID 출처 증거가 아니며, 그 실행물 출처도 증거에서 `notEstablished`다. |
| B14-k issuer | 별도 소유자, 미동결 | resource caller credential의 audience·발급·전달은 B14-k가 정한다. 이 문서는 그 결과를 소비 조건으로만 적는다. |

**미해결 참조:** V03-i가 전제한 VM Core의 Windows SYSTEM·Linux root 보호 서비스와 VM worker service 선택 경로는 FM 1.0과의 충돌 여부를 메인이 독립 감사하고 있다(2026-09-24 기준 미해결). B14-m은 그 VM Core 서비스 주체나 전역 daemon을 전제하지 않는다. V03-i에서 소비하는 것은 installer(관리자·root) 신뢰 경계, installer 보호 subtree 경로 `C:\ProgramData\agent-governance-suite`·`/etc/agent-governance-suite`, 절차 1·4의 선점 거부와 fail-closed 복구뿐이다. 감사 결과 V03-i 공통 provisioning 절이나 이 경로가 바뀌면 이 계약의 경로·역할 절을 다시 동결하기 전까지 `BLOCKED_CONTRACT`로 본다.

위 revision이나 digest가 바뀌면 이 계약의 해당 절을 다시 검토한다. caller가 revision·digest를 제공하는 방식은 허용하지 않는다. 이 문서는 참조 digest를 테스트로 강제하지 않는다. 강제 검사를 둘지는 메인이 정한다.

## 두 증명의 분리

storage 신뢰에는 서로 다른 두 증명이 필요하다. 하나로 다른 하나를 대신하지 않는다.

| 증명 | 질문 | 소유 | 이 문서와의 관계 |
| --- | --- | --- | --- |
| 기대 ID 출처(provenance) | 이 realm의 원장은 **어느 물리 파일이어야 하는가**, 그 값은 누가 기록했고 worker가 왜 바꿀 수 없는가 | B14-m 계약, B14-n 도구, B14-o 운영 증거 | 이 문서가 정의한다. |
| 열린 파일 identity(xOpen proof) | writer의 SQLite 연결이 **실제로 연 파일**의 OS identity는 무엇인가 | B14-h 계약, B14-p probe, B14-i writer | 이 문서는 비교할 기대값과 identity 형식만 공급한다. |

writer는 첫 schema write와 sidecar 생성 전에 xOpen identity와 이 계약의 등록 ID를 비교한다. 등록 ID는 path를 다시 `stat`한 값이 아니다. xOpen identity도 등록 절차의 근거가 아니다. 별도 storage OS principal이 있다고 해서 물리 identity가 증명된 것도 아니다(B14-h 조건 3).

## 공격자와 신뢰하지 않는 입력

- 공격자는 worker와 그 자손, 그리고 현재 broker와 같은 OS 사용자로 실행되는 모든 로컬 프로세스다. 현재 제품의 broker·AGS MCP는 worker와 같은 사용자이므로 **caller**로 분류한다. 같은 사용자가 쓸 수 있는 플러그인 설치 캐시·작업 트리·사용자 경로의 interpreter도 공격자가 바꿀 수 있다고 본다.
- 신뢰하지 않는 입력: caller JSON의 expected ID·path·realm 경로·registry 내용, argv, 환경 변수(`AGENT_GOVERNANCE_*` 경로 재정의 포함), stdin, cwd, 사용자 home 아래 파일, 현재 path의 `stat`/`lstat`, DB 안의 realm marker, `PRAGMA database_list`, 경로 해시로 만든 현재 `realmId`(`mcp-server/src/resource/authority-config.ts`), 도구가 스스로 보고하는 버전·digest.
- 현재 기본 경로 `~/.agent-governance-suite/resource.sqlite3`(`resolveResourceDatabasePath`)와 `0700`·동일 사용자 ACL은 운영 모드의 보호 출처가 아니다. 운영 모드에서 이 경로로 fallback하지 않는다. 운영 registry가 없으면 자원 기능은 unavailable이다.

## 역할과 OS principal

역할은 특정 SID/uid/서비스 이름을 강제하지 않는다. 실제 값은 B14-o가 설치 대상에서 관측해 registry와 운영 증거에 기록한다. V03-i의 VM Core·AGS·worker와 같은 계정을 요구하지 않으며, B14-k issuer principal과 storage principal은 서로 다른 principal이어야 한다.

| 역할 | 설명 | registry·journal·lock | slot 파일(main DB) | realm 디렉터리·sidecar |
| --- | --- | --- | --- | --- |
| provisioning 운영자(installer) | 관리자 권한으로 보호 사본의 B14-n 도구를 실행하는 주체 | 유일한 작성자 | 배타 생성, owner/ACL 설정. 운영 중 쓰기 없음 | 생성과 ACL 설정 |
| storage principal | 원장 연결을 소유하는 writer의 **별도** OS principal. 실행 형식(상주 서비스, 요청 단위 보호 helper 등)은 이 계약이 정하지 않는다 | registry 읽기만. journal·lock 접근 없음. 쓰기·삭제·rename·ACL/owner 변경 거부 | 읽기·쓰기. 삭제·rename·ACL/owner 변경 거부 | 자기 sidecar 생성·읽기·쓰기·삭제. `writer.fence`는 읽기(공유 잠금)만. sidecar ACL 확대와 main DB 삭제·교체 거부 |
| caller(broker·AGS MCP, 현재 사용자 프로세스) | storage writer에 요청만 보낸다 | 접근 거부 | 접근 거부 | 접근 거부 |
| worker와 자손 | 불신 실행 | 쓰기·삭제·rename·link·ACL 변경 거부. registry에는 비밀이 없으므로 읽기 거부는 요구하지 않는다 | 읽기·쓰기·삭제·rename·link·ACL 변경 거부 | 같음 |

- storage principal은 신뢰된 writer다. 그가 main DB에 hardlink를 만들거나 가용성을 떨어뜨리는 행위는 이 계약의 신뢰 범위 안으로 보되, 결과는 탐지해 차단한다. link count ≠ 1이면 writer가 `BLOCKED_IDENTITY`로 막는다(아래 소비 규칙). storage principal이 registry를 바꿀 수 없으므로 손상된 writer도 교체된 파일을 등록 ID로 세탁할 수 없다. 읽기 handle로도 `writer.fence`의 배타 잠금은 잡을 수 있다. storage principal이 그렇게 해도 명령 실패와 `BLOCKED_MAINTENANCE`만 생기므로 같은 신뢰 범위의 가용성 저하로 본다.
- storage principal은 worker와 같은 실효 SID/uid, 같은 group을 통한 쓰기 권한, 또는 worker 프로세스에 대한 제어 권한을 가지면 안 된다. 반대로 worker는 storage writer 프로세스의 메모리·handle에 접근(Windows `PROCESS_VM_*`/`PROCESS_DUP_HANDLE`, Linux ptrace·`/proc/<pid>/fd`)할 수 없어야 한다. 이 조건을 관측하지 못하면 판정은 `UNKNOWN`이다.
- caller가 storage writer에 인증하는 credential(resource audience)은 B14-k가 발급·전달한다. B14-k가 동결되기 전에는 caller 인증이 `BLOCKED_CONTRACT`이며, 환경 변수나 같은 사용자 파일의 token으로 채우지 않는다.

## 고정 경로와 선택 배치

| OS | registry(설치 관리자 소유) | 원장 state 루트 | slot 파일 |
| --- | --- | --- | --- |
| Windows | `C:\ProgramData\agent-governance-suite\storage-identity\registry.json` | `C:\ProgramData\agent-governance-suite\resource-state` | `resource-state\<realmId>\resource.g<slot>.sqlite3` |
| Linux | `/etc/agent-governance-suite/storage-identity/registry.json` | `/var/lib/agent-governance-suite/resource-state` | `resource-state/<realmId>/resource.g<slot>.sqlite3` |

- `<slot>`은 realm 안에서 1부터 증가하는 slot 번호다. 최초 provisioning은 `g1`, 회전마다 1씩 늘린다. intent가 한 번 잡은 slot 번호는 결과와 관계없이 다시 쓰지 않는다. 예외는 같은 `created` identity를 이어받는 복구 roll-forward의 intent 재기록뿐이다. `storage-identity` 디렉터리에는 journal `provision-journal.jsonl`, 잠금 `provision.lock`, 임시 registry `registry.<nonce>.tmp`, generation별 보관본 `history/registry.g<generation>.<nonce>.json`을 둔다. 각 realm 디렉터리에는 installer 소유 `writer.fence`를 둔다. `isolate`의 격리 위치는 state 루트 아래 installer 전용 `.isolated/<nonce>/`이며 realm 디렉터리와 같은 볼륨이다.
- `C:\ProgramData\agent-governance-suite`와 `/etc/agent-governance-suite`는 V03-i가 정한 installer 보호 subtree다. `/var/lib/agent-governance-suite`는 이 계약이 추가하는 installer 소유 보호 subtree이며 V03-i 절차 1(선점 거부, 동일 설치 증명 전 덮어쓰기 금지)을 따른다. `C:\`, `C:\ProgramData`, `/`, `/etc`, `/var`, `/var/lib`, `/usr`, `/usr/lib`의 시스템 ACL은 바꾸지 않는다.
- **Linux 선택 배치:** realm 디렉터리 `root:<storage-group>` mode `1770`(sticky), slot 파일 `root:<storage-group>` mode `0660`. storage principal은 sidecar(`-journal`, `-wal`, `-shm`)를 만들고 자기 소유 sidecar만 지울 수 있다. sticky bit 때문에 root 소유 slot 파일은 지우거나 rename할 수 없다. worker는 그 group에 속하지 않으며 디렉터리 통과 권한이 없다. storage principal이 자기 sidecar의 mode를 넓힐 수 있으므로 writer가 열기 전에 sidecar를 검사한다(소비 규칙). `fs.protected_regular` 같은 sticky 디렉터리 관련 커널 설정이 SQLite 열기에 주는 영향은 B14-n/o가 실제로 관측한다.
- **Windows 선택 배치:** realm 디렉터리는 installer owner이고 상속을 끊는다. storage principal에게는 그 디렉터리에만 적용되는(비상속) `FILE_ADD_FILE`·목록·읽기 ACE를 주고 `FILE_DELETE_CHILD`는 주지 않는다. 자식에 상속되는 `OWNER RIGHTS`(S-1-3-4) ACE로 sidecar 소유자에게 읽기·쓰기·`DELETE`만 주고, 소유자의 암묵적 `WRITE_DAC`·`READ_CONTROL`을 이것으로 제한한다. `CREATOR OWNER` ACE는 쓰지 않는다. slot 파일은 installer owner이며 storage principal에 읽기·쓰기만 주고 `DELETE`/`WRITE_DAC`/`WRITE_OWNER`는 주지 않는다.
- 위 배치는 **요구 결과**를 만족하는 선택안이다. B14-n/o는 비트나 ACE 목록이 아니라 실효 권한과 실제 접근 거부로 판정한다. 파일 시스템이나 OS가 역할표의 결과를 만들지 못하면 해당 설치는 `UNSUPPORTED`이며 자원 기능은 unavailable이다. 요구를 낮춰 통과시키지 않는다.

## 경로 보호 판정 (V03-i 기준)

registry, state 루트, 도구 보호 경로까지의 경로는 두 구간으로 나눠 판정한다.

1. **시스템 부모 구간**(`C:\`, `C:\ProgramData`, `/`, `/etc`, `/var`, `/var/lib`, `/usr`, `/usr/lib`): 일반 사용자의 새 항목 생성 권한은 기본 ACL에 있을 수 있으므로 판정 대상이 아니다. installer 보호 subtree 자체와 그 부모에 대해 worker·일반 사용자가 삭제·rename·교체, reparse/junction·symlink 전환, mount/bind-mount, ACL/owner 변경을 할 수 없음만 확인한다(V03-i "고정 경로와 신뢰 경계").
2. **installer subtree 구간**(`agent-governance-suite` 이하): 각 디렉터리·파일의 owner가 installer(Windows `Administrators`/`SYSTEM`, Linux root)이고, 쓰기·삭제·`WRITE_DAC`·`WRITE_OWNER`·`FILE_DELETE_CHILD` 권한을 가진 principal이 **허용 목록**뿐인지 확인한다. 허용 목록은 installer와, realm 디렉터리·slot 파일·sidecar에 한해 위 선택 배치의 storage principal 권한이다. sidecar만은 owner가 storage principal이어야 하므로 owner 규칙에서 제외하고 writer 소비 규칙으로 따로 검사한다. 목록 밖 principal의 쓰기 계열 권한은 모두 실패다. 이 판정은 worker principal을 알지 못해도 성립한다.

권한은 SID·group·deny/allow·상속·privilege를 포함한 실효 권한으로 평가한다. 검사 중 parent·subtree 교체·삭제·권한 완화·metadata 조회 실패는 거부한다.

## 물리 file identity 정의

identity는 **열린 handle**에서 읽는다. 경로 문자열 비교는 identity가 아니다. B14-h/i writer도 SQLite 연결의 handle에서 같은 형식을 만들어 비교한다.

| OS | 비교 키 | 필수 보조 값 |
| --- | --- | --- |
| Windows | `GetFileInformationByHandleEx(FileIdInfo)`의 64-bit `VolumeSerialNumber`와 128-bit `FileId` | `FileStandardInfo.NumberOfLinks == 1`, reparse attribute 없음, 볼륨 파일 시스템 이름 |
| Linux | `fstatfs`의 `f_fsid`, `st_ino`, 같은 FD에 `name_to_handle_at(fd, "", AT_EMPTY_PATH)`로 얻은 file handle 종류와 bytes | `st_nlink == 1`, 일반 파일, 파일 시스템 magic. `st_dev`(major·minor)와 `statx` `stx_btime`은 진단용으로만 기록 |

- Linux에서 inode 번호만으로는 삭제 뒤 재사용을 막지 못한다. **생성 번호를 포함한 file handle을 주는 파일 시스템만** 지원한다. `stx_btime`은 시계 정밀도 때문에 대체 수단으로 인정하지 않는다. `st_dev`는 장치 번호 할당에 따라 재부팅 후 바뀔 수 있으므로 비교 키에 넣지 않는다. B14-n/o는 사용한 파일 시스템에서 handle에 생성 번호가 들어가는지와 재부팅 전후 비교 키가 같은지를 실제로 관측한다. 관측하지 못하거나 달라지면 그 파일 시스템은 `UNSUPPORTED`다. 일부 파일 시스템은 `f_fsid`를 장치 번호에서 만든다. 재부팅 한 번의 관측은 장치 번호 재배정까지 증명하지 못하므로, `f_fsid`가 장치 번호에서 유도되는 파일 시스템도 `UNSUPPORTED`로 둔다. 어느 파일 시스템이 해당하는지는 B14-n/o가 확인한다.
- Node `fs.fstat`의 `ino`/`dev`는 Windows에서 128-bit `FileIdInfo`가 아니고 Linux에서 생성 번호를 주지 않는다. Node만으로 만든 도구는 이 계약의 identity 공급원이 될 수 없다.
- realm 디렉터리의 identity도 같은 방식으로 열린 handle에서 읽어 등록한다.

## 보호 registry `AgsResourceStorageRegistry.v1`

registry는 installer만 쓰는 JSON 파일 하나다. 운영 중에는 storage principal이 읽기만 한다.

| 필드 | 뜻 |
| --- | --- |
| `schemaVersion`, `contractId`, `revision` | `1.0.0`, 이 문서의 계약 ID, `1` |
| `provisioningReference` | `protected-host-provisioning/v1`과 V03-i 문서 sha256 |
| `generation` | 1부터 단조 증가하는 정수. 모든 교체마다 1 증가 |
| `previousRegistrySha256` | 직전 generation 파일 bytes의 SHA-256. 첫 generation은 `null` |
| `os`, `storagePrincipal` | OS와 storage principal의 실제 SID 또는 uid/gid·보조 group |
| `toolIdentity` | installer가 **보호 사본에서 측정한** B14-n 도구·helper·interpreter digest와 대조한 기준 digest 출처 |
| `realms[]` | realm 항목 배열 |

realm 항목: `realmId`(provisioning이 생성한 128-bit 무작위 hex, path에서 유도하지 않음), `authorityId`(`ags-resource-authority-v1`), `realmDirectory`(고정 절대 경로), `directoryIdentity`, `fenceIdentity`, `slots[]`.

slot 항목: `slot`(정수), `databasePath`(`resource.g<slot>.sqlite3`의 고정 절대 경로), `fileIdentity`(위 정의의 전체 값), `fileSystem`, `state`, `createdAtGeneration`, `supersedesSlot`(회전 때 이전 slot 번호, 아니면 `null`).

slot `state`:

| 값 | 뜻 | writer 사용 |
| --- | --- | --- |
| `ACTIVE` | caller 요청을 받는 원장 | 읽기·쓰기 |
| `PENDING` | 회전 대상 새 파일. 등록 ID는 확정됐으나 아직 caller에 노출하지 않음 | migration 대상으로만 쓰기. caller admission 금지 |
| `RETIRED` | 회전으로 물러난 이전 원장. 보존 | 사용 금지 |
| `QUARANTINED` | 불일치·손상으로 격리 | 사용 금지 |

불변식:

1. `realmId`는 registry 안에서 유일하고, 같은 realm 안에서 `slot` 번호는 유일하다. realm마다 `ACTIVE`는 최대 하나, `PENDING`은 최대 하나다.
2. `databasePath`와 `fileIdentity`는 모든 realm의 모든 slot(`RETIRED`·`QUARANTINED` 포함)에서 유일하다.
3. `fileIdentity`는 같은 볼륨의 workflow·continuity·session DB, 세션 현황판과 broker 상태 파일의 identity와 달라야 한다. B14-n은 등록 시 알려진 경로가 있으면 그 파일을 열어 대조한다.
4. registry에는 비밀·요청 원문·DB 내용이 없다. 경로·identity·principal ID·digest만 있다.
5. storage principal은 registry를 고칠 수 없으므로 운영 중 상태 전이를 registry에 기록하지 않는다. 빈 파일에 첫 schema를 쓰는 초기화는 DB 내용의 변화일 뿐 registry 전이가 아니다.

## 불변 private delivery

기대 ID는 **보호 파일을 storage principal이 직접 여는 경로로만** writer에게 전달된다.

1. writer는 연결을 열 때마다 아래 6의 fence 공유 잠금을 얻은 뒤 고정 registry 경로를 시스템 루트부터 handle 기반으로 해석한다. Linux는 `openat2`와 `RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS`를, Windows는 reparse 거부와 부모 handle identity 재확인을 쓴다. 각 구간은 위 "경로 보호 판정"으로 검사한다.
2. 검사한 **그 handle**에서 bytes를 한 번 읽어 메모리에 둔다. 읽은 뒤 같은 handle의 identity와 크기가 검사 때와 같은지 다시 확인한다. schema, `contractId`, `revision`, 불변식을 검증한다.
3. writer는 사용한 registry `generation`과 sha256을 원장 meta 표에 기록한다. 나중에 더 낮은 generation을 읽으면 rollback으로 보고 차단한다. 같은 generation인데 sha256이 다르면 변조로 보고 차단한다.
4. registry 내용, expected ID, 경로는 argv, 환경 변수, stdin, caller 요청, broker IPC, 로그, fixture 인자로 전달하지 않는다. caller 요청에 `expectedFileId`, `databasePath`, `registry`, `registryPath` 같은 필드가 있으면 **무시하지 않고 거부**한다.
5. caller는 `realmId`로 대상 realm만 고를 수 있다. 그 realm에 `ACTIVE` slot이 없으면 거부한다. caller가 그 realm을 쓸 권한이 있는지는 B14-k resource credential로 판정한다.
6. **writer fence:** writer는 caller가 준 `realmId`가 `^[0-9a-f]{32}$` 형식인지 먼저 확인하고, 아니면 경로를 만들지 않고 거부한다. 그다음 연결을 열기 전에 해당 realm의 `writer.fence` 공유 잠금(Linux `flock(LOCK_SH|LOCK_NB)`, Windows `LockFileEx` 공유 모드와 `LOCKFILE_FAIL_IMMEDIATELY`)을 얻는다. 그 뒤 registry를 1~2로 **새로** 읽어 판정한다. 잠근 fence handle과 realm 디렉터리의 identity·owner가 registry의 `fenceIdentity`·`directoryIdentity`와 다르면 `BLOCKED_PROVENANCE`다. 연결을 닫을 때까지 잠금을 유지한다. 잠금을 얻지 못하면 `BLOCKED_MAINTENANCE`를 반환하며, 기다리거나 이전에 읽은 registry를 쓰지 않는다. 기존 slot의 state를 바꾸는 명령(`rotate-commit`, `rotate-abort`, `restore`, `quarantine`)은 registry 교체 전에 그 realm의 `writer.fence` 배타 잠금을 non-blocking으로 얻어야 하고, 얻지 못하면 실패한다. `recover`도 기존 slot의 state를 바꾸는 동작(`restore`·`rotate-commit`·`rotate-abort`·`quarantine` intent의 roll-forward)에는 대상 realm의 배타 잠금을, registry 재발행에는 모든 realm의 배타 잠금을 같은 방식으로 얻어야 한다. 잠금은 획득부터 journal의 `committed` 기록까지 같은 프로세스가 같은 handle로 유지하고, 그 뒤에 푼다. 단계마다 따로 실행되는 helper가 잠금을 잡고 끝나는 구현은 허용하지 않는다. 이 강제는 도구와 writer가 수행하며 writer의 실행 형식(상주 서비스, 요청 단위 helper)이나 OS 서비스 관리자에 의존하지 않는다. `provision`·`rotate-prepare`는 기존 slot의 state를 바꾸지 않으므로 fence 없이 새 slot만 추가한다.

## provisioning 도구 실행물 무결성

installer 권한으로 실행되는 도구가 사용자 쓰기 가능한 위치에 있으면 worker가 registry를 간접적으로 오염시킬 수 있다. 운영 provisioning은 다음을 모두 만족할 때만 실행한다.

1. B14-n 도구(`resource-storage-provisioning.mjs`), OS helper 스크립트·바이너리, interpreter(Windows는 보호된 `node.exe`와 System32 `powershell.exe`, Linux는 보호된 `node`와 helper)를 installer 보호 경로(Windows `C:\ProgramData\agent-governance-suite\tools\storage-provisioning\<digest>\`, Linux `/usr/lib/agent-governance-suite/tools/storage-provisioning/<digest>/` 또는 동등한 root 소유 불변 경로)에 설치하거나 복사한다.
2. 보호 사본의 digest를 **사용자 상태 밖의 기준값**(검증된 릴리스 tag·manifest처럼 운영자가 독립 경로로 얻은 값)과 대조한 뒤에만 관리자 권한으로 실행한다. 플러그인 설치 캐시, 작업 트리, 사용자 PATH의 interpreter를 직접 실행하지 않는다.
3. 명시적 환경 블록으로 실행한다. `NODE_OPTIONS`, `NODE_PATH`, `PSModulePath`, 사용자 profile(`-NoProfile`), cwd 기반 module 검색 같은 재정의를 제거한다. Windows PowerShell 5.1 `Add-Type`은 C# 소스와 컴파일된 DLL을 `%TEMP%`에 쓰고 불러오므로 `TEMP`·`TMP`를 installer 전용 디렉터리(`storage-identity\tmp`)로 지정한다. 그렇게 할 수 없으면 런타임 컴파일을 금지하고, 보호 경로에 digest가 고정된 assembly만 쓴다.
4. `toolIdentity`에는 installer가 보호 사본에서 측정한 digest와 기준값 출처를 기록한다. 도구가 스스로 보고한 값은 쓰지 않는다. 조건을 만족하지 못하면 운영 provisioning은 `BLOCKED_CONTRACT`이고, 작업 트리에서 실행한 결과는 `FIXTURE_ONLY`다.

## 원자적 신규 생성과 등록

B14-n `provision`(새 realm)과 `rotate-prepare`(기존 realm의 새 slot)는 다음 순서를 따른다. 실패하면 아래 복구 규칙이 판단할 수 있는 상태만 남긴다.

1. **잠금:** `storage-identity` 안의 `provision.lock`을 installer 전용 배타 잠금으로 연다. 이 잠금은 **단일 registry writer 잠금**이다. registry나 journal을 바꾸는 모든 명령(`provision`, `rotate-prepare`, `restore`, `rotate-commit`, `rotate-abort`, `quarantine`, `isolate`, `recover`의 roll-forward·재발행)은 이 잠금을 non-blocking으로 먼저 얻고, 그다음 필요한 `writer.fence`를 얻는다. 잠금을 얻지 못하면 실패한다(대기 후 강제 해제 없음).
2. **intent 기록:** installer 전용 append-only journal `provision-journal.jsonl`에 `{op, realmId, slot, databasePath, targetGeneration, nonce}`를 쓰고 flush·fsync한다. `op`는 `create`, `rotate` 또는 `restore`다. `restore`는 `backupSha256`도 기록하며, 이 단계 전에 fence 배타 잠금을 얻는다.
3. **realm 디렉터리:**
   - 새 realm(`create`): state 루트를 handle 기반으로 열고 경로 보호 판정을 통과시킨 뒤, 부모 handle 기준 배타 생성으로 realm 디렉터리를 만든다(Linux `mkdirat` 후 `openat2` no-follow, Windows `NtCreateFile(FILE_DIRECTORY_FILE, FILE_CREATE, FILE_OPEN_REPARSE_POINT)`와 보호 security descriptor). 이미 있으면 실패한다. 이어 그 디렉터리 handle 기준으로 installer 소유 `writer.fence`를 배타 생성한다(storage principal 읽기만). journal에 `{op:"dirCreated", nonce, directoryIdentity, fenceIdentity}`를 쓴다.
   - 기존 realm(`rotate`·`restore`): realm 디렉터리를 no-follow로 열어 identity가 registry `directoryIdentity`와 같고 경로 보호 판정을 통과하는지 확인한다. 새로 만들지 않는다.
4. **배타 파일 생성:** realm 디렉터리 handle 기준으로 `resource.g<slot>.sqlite3`를 배타 생성한다. Linux는 `openat2(O_CREAT|O_EXCL|O_NOFOLLOW, RESOLVE_BENEATH|RESOLVE_NO_SYMLINKS)`, Windows는 부모 handle 기준 `NtCreateFile(FILE_CREATE, FILE_OPEN_REPARSE_POINT)`를 쓴다. 생성 시점 security descriptor, 또는 같은 handle의 `fchown`/`fchmod`·`SetSecurityInfo`로 owner·ACL을 설정한다. `create`·`rotate`는 크기 0 파일로 끝낸다. 크기 0 파일은 SQLite의 유효한 빈 DB이며 도구는 SQLite를 열지 않는다. `restore`는 같은 handle에 백업 bytes를 쓰고 fsync한 뒤 sha256이 intent의 `backupSha256`과 같은지 확인한다.
5. **같은 handle readback:** 4에서 만든 **그 handle**에서 file identity, link count, 크기, 실효 ACL을 읽는다. 이어 디렉터리 handle 기준 no-follow로 같은 이름을 새로 열어 identity가 같은지 확인한다. 다르면 실패다.
6. **identity journal:** journal에 `{op:"created", nonce, fileIdentity, size}`(`restore`는 `sha256` 포함)를 쓰고 fsync한다.
7. **registry 교체:** 새 generation의 전체 registry를 같은 디렉터리에 배타 생성한 임시 파일 `registry.<nonce>.tmp`(installer 전용 ACL)에 쓰고 fsync한다. 같은 bytes를 보관본 `history/registry.g<generation>.<nonce>.json`에도 배타 생성·fsync한다. `create`·`restore`는 새 slot을 `ACTIVE`로, `rotate`는 `PENDING`으로 추가한다. Linux는 `renameat` 후 디렉터리 fsync로 교체한다. Windows는 임시 파일 handle에 `SetFileInformationByHandle(FileRenameInfoEx, FILE_RENAME_FLAG_REPLACE_IF_EXISTS | FILE_RENAME_FLAG_POSIX_SEMANTICS)`를 쓰거나 `MoveFileExW(MOVEFILE_REPLACE_EXISTING)`를 쓴다. `ReplaceFileW`는 교체 대상의 속성을 이어받고 부분 실패 상태를 남기므로 쓰지 않는다. rename 직전에 현재 registry의 sha256이 새 registry를 만들 때 기준으로 읽은 registry의 sha256과 같은지 다시 확인한다(잠금 아래 compare-and-swap). 다르면 교체하지 않고 실패한다.
8. **registry readback:** registry를 "불변 private delivery" 1~2와 같은 방식으로 다시 읽어 generation, `previousRegistrySha256`, 새 slot과 5의 identity가 일치하는지 확인한다. journal에 `{op:"committed", nonce, generation, registrySha256}`를 쓴다.
9. **registry 전용 변경:** `rotate-commit`, `rotate-abort`, `quarantine`은 1의 `provision.lock`과 fence 배타 잠금을 차례로 얻은 뒤 intent `{op, realmId, slot, targetGeneration, nonce}`를 기록하고 7~8만 수행한다.
10. **보고:** 결과는 redacted receipt(경로, identity, principal ID, generation, sha256, 실효 권한 관측)만 출력한다.

현재 path를 `stat`한 값을 등록하거나, 이미 있는 파일을 registry에 채택(adopt)하는 명령은 두지 않는다.

## 재등록 금지와 회전

- **재등록 금지:** 기존 slot의 `fileIdentity`를 현재 파일에 맞춰 덮어쓰는 동작은 없다. identity 불일치를 "갱신"으로 해결하지 않는다.
- **회전:**
  1. `rotate-prepare`가 위 1~8로 새 slot을 `PENDING`으로 등록한다. writer가 쓰기 전에 보호 기대 ID가 먼저 존재한다.
  2. writer는 새 연결에서 registry를 다시 읽어 `PENDING` slot을 xOpen identity로 결속한 뒤 migration 대상으로만 쓴다. 이 migration은 writer 측 별도 leaf가 소유한다.
  3. migration과 writer 검증이 끝나면 운영자가 writer 연결을 모두 닫게 한 뒤 `rotate-commit`을 실행한다. 열린 연결이 있으면 fence 배타 잠금을 얻지 못해 명령이 실패한다. 이 명령은 새 generation 하나에서 새 slot을 `ACTIVE`로, 이전 slot을 `RETIRED`로 바꾸고 7~8과 같은 교체·readback을 거친다. 이전 파일은 삭제하지 않고 보존한다.
  4. 회전을 포기하면 `rotate-abort`가 `PENDING` slot을 `QUARANTINED`로 바꾼다. 파일은 보존한다.
- **백업 복원:** `restore`는 백업 bytes를 새 slot으로 배타 생성한 파일에 복사한다. 외부 파일을 rename·hardlink로 들여오지 않는다. 등록 identity는 복사 대상 파일 생성 handle의 값이다. 기존 `ACTIVE` slot은 같은 generation에서 `QUARANTINED`가 된다. 내용의 realm marker·무결성 검증은 writer가 따로 수행하며 identity 근거가 아니다.
- **격리:** 불일치·손상이 발견되면 운영자가 `quarantine`으로 해당 slot을 `QUARANTINED`로 바꾸는 generation만 쓸 수 있다. 파일과 sidecar는 보존한다.

## crash·재시작 복구

B14-n `recover`는 journal과 실제 상태를 대조해 아래 표 밖의 자동 동작을 하지 않는다. 운영자 선택이 필요한 행은 명시 명령으로만 진행하고 그 선택을 journal에 기록한다.

| 관측 | 판정과 허용 동작 |
| --- | --- |
| `create` intent만 있고 realm 디렉터리·파일 없음 | intent를 `aborted`로 기록 |
| `rotate`·`restore` intent만 있고 slot 파일 없음 | intent를 `aborted`로 기록. 그 slot 번호는 다시 쓰지 않음 |
| `create` intent, 디렉터리만 있고 `dirCreated` 없음 | `BLOCKED_ORPHAN`. 도구가 만든 디렉터리임을 입증할 수 없다. 운영자가 `isolate`로 보호 격리 위치에 옮긴 뒤 새 realm으로 재시작 |
| `dirCreated` 있음, 디렉터리 identity가 journal과 같고 `writer.fence` 외 항목 없음, fence identity가 journal과 같음 | 같은 intent(nonce·slot)로 4부터 재개하거나, fence와 디렉터리를 함께 제거하는 roll-back 중 운영자가 선택 |
| intent 있고 slot 파일이 있으나 `created` 없음 | `BLOCKED_ORPHAN`. 자동 삭제·등록 금지. 운영자가 `isolate`로 격리 이동하고 같은 slot 번호를 쓰지 않는 새 slot으로 재시작 |
| `created` 있음, registry에 없음, 파일 identity·link count 1·크기(와 `restore`의 sha256)가 journal과 같음 | 7~8 roll-forward 또는 `isolate` roll-back 중 운영자가 선택. roll-forward는 현재 최대 generation보다 1 큰 `targetGeneration`과 새 nonce로 intent를 다시 기록한 뒤 수행한다. 참조되지 않는 이전 nonce의 보관본은 journal에 기록하고 제거한다 |
| `created` 있음, 파일 identity·크기·sha256 중 하나가 journal과 다름 | `BLOCKED_TAMPER`. 보존하고 중단 |
| `registry.<nonce>.tmp`가 남음 | 현재 registry와 identity가 다르고 그 nonce가 journal에서 미완료이면 제거하고 기록. 그렇지 않으면 `BLOCKED_REGISTRY` |
| registry 전용 변경 intent만 있고 `committed` 없음 | 현재 registry sha256이 그 nonce의 보관본 `history/registry.g<targetGeneration>.<nonce>.json`과 같으면 8을 다시 수행해 `committed` 기록. 마지막 `committed` 값과 같으면 `aborted` 기록. 둘 다 아니면 `BLOCKED_REGISTRY` |
| journal에 같은 generation의 `committed`가 둘 이상 있음, 또는 현재 registry가 마지막 `committed`의 보관본과 다르면서 미완료 intent의 보관본으로도 설명되지 않음 | `BLOCKED_REGISTRY`. 자동 복구하지 않고 운영자 재설치·재qualification으로만 복구 |
| `isolate` intent만 있고 `isolated` 없음 | 원래 위치와 격리 위치에서 journal에 기록된 identity를 찾는다. 한 곳에서만 발견되면 그 결과를 기록하고, 없거나 다르면 `BLOCKED_TAMPER` |
| registry 새 generation이 보이나 `committed` 없음 | 8의 readback을 다시 수행하고 일치할 때만 `committed` 기록 |
| registry 파싱 실패·generation 역행·`previousRegistrySha256` 불일치 | `BLOCKED_REGISTRY`. 먼저 위 행들로 미완료 intent를 모두 해소한다. 미완료 intent가 남아 있으면 재발행하지 않는다. 복원 원본은 sha256이 journal의 마지막 `committed` `registrySha256`과 같은 `history/registry.g<generation>.<nonce>.json`뿐이다. 그 내용을 journal에 나온 모든 `committed` generation과 `targetGeneration`의 최댓값보다 1 큰 generation으로 다시 발행하고, `previousRegistrySha256`은 마지막 `committed` sha256으로 둔다. 더 오래된 보관본이나 별도 백업으로 되돌리지 않는다. 이 조건을 만족하는 보관본이 없거나, journal이 손상됐거나, registry 손상 때문에 미완료 intent를 해소할 수 없으면 `BLOCKED_REGISTRY`를 유지하고 운영자 재설치·재qualification으로만 복구한다. 재발행 후 전체 `verify` |

잠금 보유 프로세스가 죽은 경우에도 잠금을 강제 해제하지 않는다. OS가 잠금을 해제한 뒤 `recover`를 수행한다. 자동 권한 완화, root ACL 수정, 환경 변수 경로 우회는 복구가 아니다(V03-i 절차 4).

## writer 소비 규칙 (B14-h/i에 넘기는 fail-closed 표)

writer는 연결을 열 때마다 fence 공유 잠금을 얻고 registry를 새로 읽어 아래 순서로 판정한다. 모든 차단은 명시 오류 코드로 caller에 반환하고 연결·FD·잠금을 닫는다. 실패를 삼키거나 기본 경로·새 DB로 fallback하지 않는다.

| 조건 | 결과 |
| --- | --- |
| `writer.fence` 공유 잠금 획득 실패 | `BLOCKED_MAINTENANCE` |
| registry 없음·읽기 실패·경로 보호 판정 실패·schema·불변식 오류 | `BLOCKED_PROVENANCE` |
| realm 항목 없음, 요청 대상 slot이 `ACTIVE`(caller)·`PENDING`(migration) 아님 | `BLOCKED_REALM` |
| 등록 slot 파일 없음 | `BLOCKED_MISSING` (자동 생성 금지) |
| xOpen identity ≠ 등록 `fileIdentity`, link count ≠ 1, reparse/symlink | `BLOCKED_IDENTITY` (파일·sidecar 보존) |
| 이미 있는 sidecar가 storage principal 소유가 아니거나, link count ≠ 1, 허용 목록 밖 권한, reparse/symlink | `BLOCKED_IDENTITY` |
| 원장 meta의 registry generation보다 낮음, 같은 generation의 sha256 다름 | `BLOCKED_ROLLBACK` |
| xOpen identity가 다른 slot·realm 또는 다른 DB와 같음 | `BLOCKED_ALIAS` |
| OS·파일 시스템이 identity 정의를 충족하지 못함, metadata 조회 실패 | `UNSUPPORTED` 또는 `UNKNOWN` (둘 다 차단) |
| caller가 expected ID·경로·registry 필드를 보냄 | 요청 거부 |

크기 0이고 identity가 일치할 때만 writer가 첫 schema write를 수행한다. 크기가 0보다 크면 schema 초기화 없이 내용의 realm marker와 registry `realmId`를 대조한다.

## B14-n 도구 범위

- 대상 파일: `scripts/qualification/resource-storage-provisioning.mjs`, fixture `tests/coordinate-subagents/v3x/fixtures/resource-storage-provisioning/`, 집중 검사 `tests/coordinate-subagents/v3x/B14-n.test.mjs`.
- 명령: `provision`, `rotate-prepare`, `rotate-commit`, `rotate-abort`, `restore`, `quarantine`, `isolate`, `recover`, `verify`. journal op는 intent(`create`, `rotate`, `restore`, `rotate-commit`, `rotate-abort`, `quarantine`, `isolate`)와 진행 기록(`dirCreated`, `created`, `isolated`, `committed`, `aborted`)으로 한정한다. `verify`는 읽기 전용이며 registry와 실제 파일을 새 handle로 열어 identity·link count·실효 권한·principal·도구 digest를 대조한다. 각 쓰기 명령은 위 journal op를 남긴다.
- OS API 접근: Node만으로는 위 identity·ACL·`openat2`·`name_to_handle_at`를 얻을 수 없다. Windows는 B14-p 선례대로 System32 Windows PowerShell 5.1과 P/Invoke(`GetFileInformationByHandleEx`, `NtCreateFile`, `SetFileInformationByHandle`, `SetSecurityInfo`)를 쓰며 `node_modules`와 제3자 native 바이너리는 쓰지 않는다. Linux는 `openat2`·`name_to_handle_at`·`fstatfs`를 호출할 수단이 필요하다. 설치물에 bare npm import 없이 이를 닫을 수단이 없으면 Linux 지원은 `UNSUPPORTED`로 보고하고 메인이 native helper leaf를 먼저 분할한다(B14-n 선행 조건).
- 필수 fixture 사례: 다른 realm·slot 오용, hardlink alias(link count 2), 경로 교체 후 복원, worker 권한으로 registry 변조 시도, 서로 다른 realm의 registry 변경 명령 동시 실행, 부모·파일 권한 완화, sidecar 권한 확대, 선점된 realm 디렉터리, 복구 표의 각 중단 지점에서 재시작, generation 역행, 임시 registry 잔여, caller 필드 주입, 크기 > 0 파일 채택 시도, 보호 사본이 아닌 도구 실행, writer 연결이 열린 상태의 `rotate-commit`·`restore`·`quarantine`, 오래된 보관본으로 registry 복원 시도, writer 연결이 열린 상태의 `recover` roll-forward·재발행, 형식이 잘못된 `realmId`, 잘못된 `writer.fence` identity, 보호되지 않은 `TEMP`에서 `Add-Type` 실행. 격리 임시 디렉터리에서 실제 별도 principal이나 보호 경로를 만들지 못한 사례는 `FIXTURE_ONLY`나 `UNKNOWN`이며 운영 PASS가 아니다.
- 기대 ID는 fixture JSON에서 신뢰하지 않는다. 테스트는 도구가 실제 OS handle에서 읽은 값과 도구가 만든 registry만 사용한다.

## B14-o 운영 증거 범위

- 대상 파일: `docs/implementation-3x/evidence/resource-storage-identity-qualification.json`.
- 필요한 승인 묶음: Windows/Linux qualification host, storage principal 생성, `/var/lib/agent-governance-suite`·도구 보호 경로·`storage-identity` 보호 subtree 생성, 운영 registry 등록, ACL/mode 변경, 되돌리기 절차. 승인 전에는 실행하지 않으며 계획 Task 등록은 승인이 아니다.
- 기록할 직접 관측: 보호 사본 도구·helper·interpreter digest와 기준값 출처, OS build, 파일 시스템 종류와 file handle 생성 번호 포함 여부, 재부팅 전후 identity 비교 키 안정성, storage principal의 실제 SID 또는 uid/gid, registry generation·sha256, 각 slot의 등록 identity와 `verify`의 새 handle identity 일치, 경로 보호 판정 결과, **worker principal로 실제 수행한** registry·slot 파일·부모·sidecar 쓰기·삭제·rename·link 시도의 거부 결과.
- 판정 어휘: 모두 관측된 항목만 `PROVISIONED_OBSERVED`다. 미승인·미설치·미관측은 `NOT_OBSERVED` 또는 `BLOCKED_CONTRACT`로 남긴다. B14-n fixture 결과와 caller 임시 ID는 운영 증거로 옮기지 않는다.
- B14-o 결과는 xOpen identity 증거가 아니다. B14-h가 같은 host에서 writer 연결의 xOpen identity를 이 registry와 따로 결속해야 한다.

## 현재 판정과 필요한 별도 생산자

현재 운영 판정은 **`BLOCKED_CONTRACT`**다. 저장소와 설치물에는 storage principal writer, 보호 registry, 보호 사본 provisioning 도구, 지원 조합의 native writer가 없다. B14-c staged 후보와 현재 `DatabaseSync` 기반 schema write는 이 계약의 writer가 아니며 차단 상태를 유지한다.

이 계약만으로 닫히지 않는 책임:

| 책임 | 소유 |
| --- | --- |
| provisioning 도구와 fixture | B14-n |
| 승인된 운영 공급 증거 | B14-o |
| caller의 resource credential 발급·전달 | B14-k |
| storage principal로 writer를 실행하는 형식(상주 서비스 또는 요청 단위 helper, 권한 전환 수단, OS 등록 방식, caller→writer IPC). VM Core 서비스나 전역 daemon을 전제하지 않는다. 허용되는 실행 형식이 확정되지 않은 OS는 `UNSUPPORTED`다 | 미해결 계약. B14-i writer 또는 메인이 분할할 별도 leaf |
| Linux `openat2`·`name_to_handle_at` 호출 수단 | B14-n이 닫지 못하면 별도 native helper leaf |
| 도구·interpreter 보호 설치와 기준 digest 배포 | B14-n이 형식을 정하고, 실제 설치는 B14-o 승인 범위 |
| 회전 시 데이터 migration | writer 측 별도 leaf |
| xOpen identity와 등록 ID 결속, sidecar 검사 | B14-h/B14-i |
