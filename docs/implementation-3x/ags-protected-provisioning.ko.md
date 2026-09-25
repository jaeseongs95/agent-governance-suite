# B14-s — AGS 공통 보호 provisioning 계약 (VM 독립)

계약 ID: `ags-protected-provisioning/v1`, revision `1`. 상태: **CONTRACT_ONLY**. 이 문서는 V03-i의 공통 provisioning 요구 가운데 AGS core가 단독으로 소비하는 부분을 VM 실행물과 분리해 고정한다. 소비자는 B14 영역의 issuer·storage·도구·설치 후보 Task다(아래 P9).

이 문서의 동결은 **설계 동결**일 뿐이다. OS 서비스 설치, 계정·ACL·mode 적용, 실효 권한 검증, 실제 token/UID 관측, SQLite xOpen proof, 설치 후보 qualification 중 어느 것도 뜻하지 않는다. `host-supported`, `configured`, `observed` 상태를 부여하지 않는다.

## P0. VM 독립 원칙

- **P0.1** AGS core 소비자는 다음을 실행 선행으로 요구하지 않는다: VM Core signer/reader 프로세스, VM worker service와 Core→worker IPC, VM protected-state producer, VM interpreter(Python) package closure, `flowmarshal` 경로·`protected-installation.json`·`core-state`, V03-i의 VM key/pin/worker fixture digest.
- **P0.2** AGS 보호 주체에 VM Core·AGS MCP·VM worker와 같은 SID/uid·서비스 계정을 요구하지 않는다. 보호 주체의 credential·비밀을 worker와 공유하지 않는다.
- **P0.3** VM 쪽 생산자가 없다는 사실은 AGS core 소비자의 판정을 막지 않는다. 반대로 AGS core 소비자의 결과는 VM 경로(V03-j/k/f/h)의 운영 자격 근거가 아니다.
- **P0.4** VM 전용 조건은 삭제하거나 완화하지 않는다. V03-i에 그대로 남아 VM 소비자를 구속한다(P10의 `VM 전용 유지` 행).

## P1. VM 참조 호환 revision

| 참조 | 고정 값 |
| --- | --- |
| 원본 문서 | `docs/implementation-3x/protected-host-installation.ko.md` (V03-i) |
| 계약 ID·revision | `ags-vm-protected-host-installation/v1`, revision `1` |
| 공통 절 | `protected-host-provisioning/v1` (앵커 `#protected-host-provisioning-v1`) |
| commit | `6006844e8da8bbe5d9f1aeed0a74682bd3c16928` |
| 문서 sha256 | `256f388cc79bce643166f397398b2e8f013591ffac04a27327f4f1abc6fbc99c` |
| V03-i manifest | `tests/coordinate-subagents/v3x/fixtures/protected-host-installation/manifest.json` (위 sha256을 authority로 결속) |

- **P1.1** 이 계약은 V03-i 문서와 fixture를 고치지 않는다. V03-i는 AGS↔VM 경로(V03-j·V03-k)의 권위로 그대로 남는다. 이 계약은 V03-i를 대체하지 않고, V03-i 공통 절이 B14에 허용한 범위("installer 신뢰 경계, 역할 분리, 설치 기록 보호, 회전·복구 불변 조건"을 권위로 참조하고 V 전용 digest·주체는 강제하지 않음)를 AGS core 조항으로 옮긴다.
- **P1.2** V03-i 문서 sha256이 위 값과 다르면 이 계약의 추적표(P10)를 다시 검토하기 전까지 소비자는 이 계약을 `BLOCKED_CONTRACT`로 본다. caller·argv·환경 변수가 revision이나 digest를 제공하는 방식은 허용하지 않는다.
- **P1.3** 두 계약이 충돌하는 것으로 보이면 느슨한 쪽을 적용하지 않는다. 해당 소비자는 `BLOCKED_CONTRACT`로 멈추고 총괄이 두 계약 중 하나를 개정한다.

## P2. 고정 경로와 신뢰 경계

| OS | 시스템 부모(기본 ACL 변경 금지) | AGS installer 보호 subtree |
| --- | --- | --- |
| Windows | `C:\`, `C:\ProgramData` | `C:\ProgramData\agent-governance-suite` |
| Linux | `/`, `/etc`, 소비자가 추가 subtree를 두는 `/var`, `/var/lib`, `/usr`, `/usr/lib` | `/etc/agent-governance-suite` |

- **P2.1** 시스템 부모의 owner/ACE·mode를 시스템 전체에서 바꾸지 않는다. 소비자는 같은 규칙을 따르는 installer 소유 subtree를 추가할 수 있다(예: B14-m의 `/var/lib/agent-governance-suite`, 도구 보호 경로). 추가 subtree도 P2·P6.1을 모두 따른다.
- **P2.2** 이미 provision된 보호 subtree와 그 부모 자체에 대해 worker·일반 사용자·패키지 작성자·caller가 rename/delete/replace, reparse/junction·symlink 전환, mount/bind-mount, ACL/owner 변경을 할 수 없어야 한다. 시스템 부모에서 일반 사용자의 새 항목 생성 권한은 판정 대상이 아니다.
- **P2.3** 권한은 SID·group·deny/allow·상속·privilege를 포함한 **실효 권한**으로 평가한다. Windows에서는 subtree 자체의 `DELETE`, 부모의 `FILE_DELETE_CHILD`, `WRITE_DAC`, `WRITE_OWNER`를 포함한다. 단순 ACL 비트 목록이나 subtree 파일 ACL만으로 판정하지 않는다.
- **P2.4** Linux는 root부터 보호 subtree와 파일까지 owner, mode, ACL, mount/bind-mount, symlink를 확인하고 worker·일반 계정의 부모 교체·쓰기·소유권 변경 가능성을 거부한다.
- **P2.5** 경로는 디렉터리 handle 기반으로 해석하고 열린 파일의 identity를 다시 확인해 TOCTOU를 닫는다. Linux는 `openat2`의 `RESOLVE_NO_SYMLINKS` 같은 경로 제약 또는 동등한 증거를 쓴다. Windows는 reparse 검출과 함께 열린 handle의 volume/file identity와 각 부모의 교체 불가를 검사한다.
- **P2.6** 검사 중 parent/subtree 교체·삭제·권한 완화·metadata 조회 실패는 거부한다(fail-closed).

## P3. 설치 기록 보호

- **P3.1** 설치 기록·registry·정책처럼 보호 주체가 신뢰하는 파일은 caller 입력이 아니라 installer가 AGS 보호 subtree에 작성한 보호 파일이다. 구체적인 파일 경로·schema는 소비 Task가 정한다(예: B14-m `storage-identity/registry.json`).
- **P3.2** 기록은 계약 ID·revision·참조 digest, OS, installer와 보호 주체의 실제 principal ID·group·privilege 정책, 고정 절대 경로, OS 서비스 ID(있으면), 허용된 build digest와 launcher/interpreter closure digest 가운데 소비 Task가 쓰는 항목을 담는다. self-reported JSON만으로 실효 ACL·token·hash 확인을 대체하지 않는다. 파일의 신뢰는 P2의 보호와 설치 측정에 의존한다.
- **P3.3** 임의 `--db`·`--artifacts`·argv·환경 변수·cwd·사용자 home 경로로 보호 기록을 고르지 않는다. 기록이 없으면 해당 기능은 unavailable이며 사용자 경로로 fallback하지 않는다.

## P4. 역할·principal 분리와 실제 관측

| 역할 | 설명 |
| --- | --- |
| installer | 관리자(Windows `Administrators`/`SYSTEM`, Linux root) 권한으로 provisioning·회전·복구만 수행한다. 운영 중에는 접근하지 않는다. |
| AGS 보호 주체 | issuer/receiver, storage writer처럼 보호 파일·비밀을 소유하는 별도 OS principal. 개수·실행 형식·서비스 여부는 소비 Task가 정한다. |
| caller | 현재 사용자로 실행되는 broker·AGS MCP. 보호 주체에 요청만 보낸다. |
| worker와 자손 | 불신 실행. 같은 사용자의 모든 로컬 프로세스를 포함한다. |

- **P4.1** 역할은 특정 SID/uid/서비스 이름을 강제하는 식별자가 아니다. 실제 값은 설치 대상에서 관측해 보호 기록에 남긴다. 보호 주체가 worker·caller와 같은 실효 SID/uid, 같은 group을 통한 쓰기 권한, 또는 서로의 프로세스 제어·읽기 권한을 가지면 실패다. 서로 다른 목적의 보호 주체를 분리할지는 소비 Task가 정하며(B14-m은 issuer principal과 storage principal의 분리를 요구), 같은 principal 공유를 분리 근거로 쓰지 않는다.
- **P4.2** Windows 보호 주체는 SCM이 installer-provisioned 별도 비특권 서비스 계정으로 시작한다(권한 전환 형식이 달라도 같은 관측 의무를 진다). caller·worker와 구분되는 **실효 접근 권한**의 primary token을 관측하며, SID 이름만 다른지 또는 restricted token 명칭만 있는지로 통과시키지 않는다. 보호 주체가 자식을 만들면 명시적 환경 블록과 최소 handle 상속을 사용한다.
- **P4.3** Linux 보호 주체는 systemd의 별도 비특권 `User`/`Group` 또는 동등한 installer 설정으로 시작한다. 보조 group·capability·상속 FD·환경을 정리하고, 실행 뒤 uid/euid/gid/egid/groups/capability를 실제 프로세스에서 관측한다. `no_new_privs` 같은 설정 이름만으로 접근 거부를 대체하지 않는다. 일반 `Popen`으로 다른 uid로 바꾸는 경로는 권한 없이 성립하지 않는다.
- **P4.4** worker·caller principal로 보호 파일·registry·비밀·endpoint·보호 프로세스 메모리/handle(Windows `PROCESS_VM_*`/`PROCESS_DUP_HANDLE`, Linux ptrace·`/proc/<pid>/fd`)에 대한 **실제 접근 시도가 거부되는지** 관측한다. 서비스 계정·identity가 실제 설치 환경에서 마련되지 않으면 운영 판정은 `BLOCKED_CONTRACT`이고, 관측하지 못하면 `UNKNOWN`이다.
- **P4.5** 두 역할이 같은 실효 principal로 실행되는 동안에는 파일 ACL만으로 둘 사이의 OS 분리를 주장하지 않는다. 현재 제품의 broker·AGS MCP는 worker와 같은 사용자이므로 caller로 분류한다.

## P5. private IPC 결속과 전달

- **P5.1** caller→보호 주체 IPC는 OS peer identity(Windows named-pipe client 실효 token, Linux `SO_PEERCRED` 등)와 보호 서비스 identity를 확인하고 단회 request ID에 묶는다. 같은 SID/uid의 공개 pipe ACL, caller가 고르는 IPC 주소나 token, 공용 broker token·localhost TLS는 인증 근거가 아니다.
- **P5.2** 보호 주체 밖에서 온 응답·작업 결과·staging 자료는 조작 가능한 불신 입력이며, 보호 주체가 자체 기록과 대조해 검증하기 전에는 근거가 아니다. worker 자손은 보호 endpoint·control handle을 상속·duplication·재연결할 수 없어야 한다.
- **P5.3** 비밀 bytes, 보호 경로, 기대 identity, 주체 신원은 argv·환경 변수·stdin·caller JSON·로그·fixture·메시지로 전달하거나 고르게 하지 않는다. 보호 값은 보호 주체가 보호 파일을 직접 여는 경로로만 전달된다. caller가 그런 필드를 보내면 무시하지 않고 거부한다.
- **P5.4** OS별 endpoint·프로토콜·수명 구현은 생산자 leaf(B14-q-a/B14-q, B14-r)의 책임이다. 이 계약은 요구 결과만 고정한다.

## P6. 설치·회전·복구 불변 조건

- **P6.1** installer는 보호 subtree가 없음을 확인한 뒤 보호된 owner/ACL 또는 mode로 생성한다. 이미 존재하면 owner·identity·reparse·권한을 검사해 허용된 동일 설치임을 증명하기 전에는 덮어쓰지 않는다. 사용자 선점 디렉터리는 실패다. 설치 기록과 서비스 정의의 revision·경로·principal을 동시에 고정한다.
- **P6.2** installer만 비밀·registry·pin을 임시 보호 파일로 작성하고, 완전한 검증 후 원자적으로 교체·동기화한다. 함께 해석되는 값(현재 generation, 설치·주체 ID, 정책 버전, 공개키 대응 등)은 함께 읽어 검증한다. 비밀 원문은 로그·fixture·메시지·worker 환경에 넣지 않는다.
- **P6.3** 보호 주체와 도구의 실행물·interpreter/launcher closure는 보호 subtree 또는 동등한 불변 설치 경로에서 측정한다. 사용자 쓰기 가능 DLL/module/search path, cwd, argv·env override, `.cmd` wrapper, 플러그인 설치 캐시·작업 트리를 보호 실행물로 인정하지 않는다. 선택 경로는 측정된 interpreter closure다: 보호된 `node.exe`/`node`, 진입 스크립트, 실행 인수, OS loader가 실제 읽는 dependency·module bytes를 후보별 manifest에 결속한다(Node 24+·pnpm 11·esbuild 기준, `node_modules` 없는 설치물). closure를 닫을 수 없으면 해당 leaf는 `NEEDS_SPLIT`으로 보고하고 지원 OS를 추정하지 않는다.
- **P6.4** 시작 전, 보호 파일 읽기 전후, 보호 요청 처리 전후에 경로 identity와 실제 실행 주체를 관측한다. 불일치·조회 불가·서비스 재시작·회전 중간 상태는 fail-closed다. 복구는 installer의 재설치·회전과 재qualification으로만 한다. 자동 권한 완화, root ACL 수정, 환경 변수 경로 우회는 복구가 아니다.
- **P6.5** 실제 운영 단계의 사용자 결정은 대상 Windows/Linux host, installer·보호 주체·caller·worker의 실효 주체, 실행 형식과 build 도구, 비밀·registry 회전·철회 방법, 보호 subtree 설치/되돌리기 권한과 관측 자료를 **한 묶음으로** 제시해 받는다. 이 계약 시점에 그 입력·권한을 받지 않았고 설치하지 않았다.

## P7. 원자적 source identity

- **P7.1** 보호 주체가 신뢰하는 값의 출처는 경로 문자열이나 현재 path의 `stat`이 아니라 **열린 handle의 identity**다. 보호 파일은 부모 handle 기준 배타 생성(no-follow)으로 만들고, 생성한 그 handle에서 identity를 읽은 뒤 이름으로 새로 열어 같은지 확인한다.
- **P7.2** 보호 기록 교체는 같은 디렉터리의 임시 보호 파일 작성·fsync 후 원자적 rename으로 하고, 교체 직전 현재 bytes가 기준으로 읽은 bytes와 같은지 확인한다(잠금 아래 compare-and-swap). 교체 뒤 같은 방식으로 다시 읽어 확인한다.
- **P7.3** 이미 있는 파일을 현재 identity로 채택(adopt)하거나, 등록된 identity를 현재 파일에 맞춰 재등록하지 않는다. 구체적인 identity 형식·registry·journal·복구 표는 소비 Task가 정한다(storage는 B14-m).

## P8. OS 선택과 완료 범위

- **P8.1** `selectedOS`는 `windows`, `linux`, `windows-linux` 중 하나이며 추정하지 않는다. Windows와 Linux는 서로 독립으로 선택·검증한다. 한 OS의 생산자·관측이 없어도 다른 OS의 판정은 진행할 수 있다.
- **P8.2** 단일 OS 완료는 그 OS scope에만 유효하다. `windows-linux` 완료에는 양쪽 각각의 실제 설치 후보·관측 근거가 필요하며, 한 OS 결과를 다른 OS나 결합 완료로 전용하지 않는다.
- **P8.3** 지원 수단(OS API, 파일 시스템, 서비스 관리자, build 도구)이 없는 OS는 `UNSUPPORTED` 또는 `BLOCKED_CONTRACT`이며 요구를 낮춰 통과시키지 않는다.

## P9. 판정 어휘와 Progress 매핑

이 Task(B14-s)의 산출 판정:

| 산출 | 뜻 | Progress |
| --- | --- | --- |
| `AGS_PROTECTED_PROVISIONING_CONTRACT_FROZEN` | 추적표에 삭제·완화된 hard 조건이 없고 V03-i 참조가 현행 bytes와 일치하며 독립 감사를 통과한 설계 동결 | `COMPLETED`를 요청할 수 있다 |
| `BLOCKED_CONTRACT_SCOPE` | V03-i 또는 V 영역 문서를 고쳐야만 수용 기준을 충족할 수 있음 | `BLOCKED`로 보고. `COMPLETED` 금지 |
| `CONTRACT_FAILED` | hard 조건 누락·완화, 참조 불일치, 감사 실패 | `BLOCKED`로 보고. `COMPLETED` 금지 |
| `NOT_RUN` | 착수 조건 미충족 등으로 수행하지 않음 | 미실행으로 보고. `COMPLETED` 금지 |

`COMPLETED`가 아니면 후속 B14 Task의 dependency를 풀지 않는다. `FROZEN`은 소비자의 운영 판정을 바꾸지 않는다. 소비자의 운영 판정은 `BLOCKED_CONTRACT`·`LIVE_PENDING`·`FIXTURE_ONLY`·`UNKNOWN`·`UNSUPPORTED`를 그대로 쓰며, `FIXTURE_ONLY`·`READY_FOR_QUALIFICATION` 같은 합성 결과는 운영 `host-supported/configured/observed`가 아니다. `UNKNOWN`을 PASS로 올리지 않는다.

소비자:

| Task | 이 계약에서 소비하는 조항 |
| --- | --- |
| B14-k issuer 계약 | P0·P2~P6·P8 |
| B14-q-a/B14-q (Windows), B14-r (Linux) issuer 주체·private channel | P2·P4·P5·P6.3·P6.4·P8 |
| B14-m storage 기대 ID (이미 동결) | P2·P6.1·P6.4·P7과 같은 내용을 V03-i에서 직접 소비 중이다. 참조를 이 계약으로 옮길지는 B14-m 소유자의 후속 개정 대상이며 이 Task는 B14-m 문서를 고치지 않는다 |
| B14-n·B14-n-w·B14-n-w-b·B14-n-w-c·B14-n-l 도구·primitive·fixture | P2·P3·P4.4·P6·P7·P8 |
| B14-h storage trust | P4·P7 (xOpen proof는 B14-h 자체 책임) |

## P10. 추적표: V03-i 공통 요구 → 이 계약

상태 어휘: `보존`(같은 조건을 그대로 옮김), `일반화`(VM 역할 이름을 AGS 역할로 바꾸되 조건 강도는 같거나 강함), `VM 전용 유지`(VM 실행물에만 해당하므로 V03-i에 그대로 남고 AGS core 실행 선행이 아님). 삭제·완화 상태는 없다. 인용은 V03-i 원문 그대로다.

| ID | V03-i 원문 | 새 조항 | 상태 |
| --- | --- | --- | --- |
| T01 | 「`C:\`·`ProgramData`의 owner/ACE를 시스템 전체에서 변경하지 않는다」 | P2.1 | 보존 |
| T02 | 「worker·일반 사용자·패키지 작성자가 rename/delete/replace, reparse/junction 전환, ACL/owner 변경을 할 수 없어야 한다」 | P2.2 | 보존 |
| T03 | 「실효 권한을 SID·group·deny/allow·상속·privilege와 함께 평가한다」 | P2.3 | 보존 |
| T04 | 「단순 ACL 비트 목록 또는 subtree 파일 ACL만으로 판정하지 않는다」 | P2.3 | 보존 |
| T05 | 「root부터 보호 subtree와 파일까지 owner, mode, ACL, mount/bind-mount, symlink를 확인하고」 | P2.4 | 보존 |
| T06 | 「디렉터리 핸들 기반 경로 해석과 열린 파일의 identity 재확인으로 TOCTOU를 닫아야 한다」 | P2.5 | 보존 |
| T07 | 「열린 핸들의 volume/file identity와 각 부모의 교체 불가를 검사한다」 | P2.5 | 보존 |
| T08 | 「검사 중 parent/subtree 교체·삭제·권한 완화·metadata 조회 실패는 거부한다」 | P2.6 | 보존 |
| T09 | 「이 파일은 caller 입력이 아니라 설치 관리자의 보호 파일이며」 | P3.1 | 일반화 |
| T10 | 「self-reported JSON만으로 실효 ACL·token·hash 확인을 대체하지 않는다」 | P3.2 | 보존 |
| T11 | 「임의 `--db`·`--artifacts`·환경 변수로 운영 기록을 고르지 않는다」 | P3.3 | 보존 |
| T12 | 「역할은 동일 SID/uid/서비스 이름을 강제하는 식별자가 아니다」 | P4.1 | 보존 |
| T13 | 「worker가 Core와 같은 실효 SID/uid 또는 같은 읽기·프로세스 제어 권한을 가지면 실패다」 | P4.1 | 일반화 |
| T14 | 「SID 이름만 다른지 또는 restricted token 명칭만 있는지로 통과시키지 않는다」 | P4.2 | 보존 |
| T15 | 「명시적 환경 블록과 최소 handle 상속을 사용한다」 | P4.2 | 보존 |
| T16 | 「실행 뒤 uid/euid/gid/egid/groups/capability를 실제 child에서 관측하고」 | P4.3 | 일반화 |
| T17 | 「그 설정 이름만으로 접근 거부를 대체하지 않는다」 | P4.3 | 보존 |
| T18 | 「일반 `Popen`으로 다른 uid로 바꾸는 경로는 권한 없이 성립하지 않는다」 | P4.3 | 보존 |
| T19 | 「서비스 계정·identity가 실제 설치 환경에서 마련되지 않으면 운영 검사는 `BLOCKED_CONTRACT`다」 | P4.4 | 보존 |
| T20 | 「AGS가 key를 읽을 수 있는 같은 주체라면 key 파일 ACL만으로 AGS 자체에 대한 key 접근 차단을 주장하지 않는다」 | P4.5 | 일반화 |
| T21 | 「같은 SID/uid의 공개 pipe ACL, caller가 고르는 IPC 주소나 token은 인증 근거가 아니다」 | P5.1 | 보존 |
| T22 | 「응답은 worker가 조작 가능한 자료로 취급한다」 | P5.2 | 일반화 |
| T23 | 「worker가 작성하는 workspace/staging 결과는 불신 입력이고」 | P5.2 | 일반화 |
| T24 | 「AGS pipe·VM Core control handle을 상속·duplication·재연결할 수 없어야 하며」 | P5.2 | 일반화 |
| T25 | 「key bytes는 AGS argv/env/stdio로 전달하지 않는다」 | P5.3 | 일반화 |
| T26 | 「caller JSON, argv 또는 환경 변수로 key/pin 경로, signer 신원, Core row나 승인된 call을 고르게 해서는 안 된다」 | P5.3 | 일반화 |
| T27 | 「worker service 설치·IPC 프로토콜·수명은 OS별 신규 생산자 leaf의 필수 책임이다」 | P5.4 | 일반화 |
| T28 | 「이미 존재하면 owner·identity·reparse·권한을 검사해 허용된 동일 설치임을 증명하기 전에는 덮어쓰지 않는다」 | P6.1 | 보존 |
| T29 | 「사용자 선점 디렉터리는 실패다」 | P6.1 | 보존 |
| T30 | 「설치 기록과 서비스 정의의 revision·경로·principal을 동시에 고정한다」 | P6.1 | 보존 |
| T31 | 「완전한 검증 후 원자적 교체·동기화한다」 | P6.2, P7.2 | 보존 |
| T32 | 「key 원문은 로그·fixture·메시지·worker 환경에 넣지 않는다」 | P6.2 | 일반화 |
| T33 | 「사용자 쓰기 가능 DLL/module/search path, cwd, argv·env override, `.cmd` wrapper를 보호 실행물로 인정하지 않는다」 | P6.3 | 보존 |
| T34 | 「**선택 경로는 측정된 interpreter closure**다」 | P6.3 | 보존 |
| T35 | 「`NEEDS_SPLIT`으로 보고하고 지원 OS를 추정하지 않는다」 | P6.3, P8.3 | 보존 |
| T36 | 「불일치·조회 불가·서비스 재시작·회전 중간 상태는 fail-closed다」 | P6.4 | 보존 |
| T37 | 「자동 권한 완화, root ACL 수정, 환경 변수 경로 우회는 복구가 아니다」 | P6.4 | 보존 |
| T38 | 「관측 자료를 **한 묶음으로** 제시한다」 | P6.5 | 일반화 |
| T39 | 「둘 중 하나만 갱신하거나 caller가 revision을 제공하면 `BLOCKED_CONTRACT`다」 | P1.2 | 일반화 |
| T40 | 「V 전용 key/pin/worker fixture digest 전체를 B14에 강제하지 않는다」 | P0.1 | 보존 |
| T41 | 「AGS/VM과 같은 SID/uid·서비스 계정을 요구하거나 issuer credential을 worker에게 공유하지 않는다」 | P0.2 | 보존 |
| T42 | 「`FIXTURE_ONLY`나 `READY_FOR_QUALIFICATION`은 운영 `host-supported/configured/observed`가 아니다」 | P9 | 일반화 |
| T43 | 「`UNKNOWN`을 PASS로 올리지 않는다」 | P9 | 보존 |
| V01 | 「VM Core의 일반 `Popen`으로 직접 worker를 만드는 경로는 운영 모드에서 금지한다」 | V03-i | VM 전용 유지 |
| V02 | 「운영 Core의 권위 상태 루트는 Windows `C:\ProgramData\flowmarshal\core-state`, Linux `/var/lib/flowmarshal/core-state`로 고정한다」 | V03-i | VM 전용 유지 |
| V03 | 「Python VM Core의 Windows `python.exe`/Linux `python3` interpreter·module closure는 AGS V06-b가 생산할 수 없으므로 별도 VM package leaf가 필요하다」 | V03-i | VM 전용 유지 |
| V04 | 「Windows/Linux의 합성 principal과 key·pin·Core state·launcher·설치 기록별 root→parent→file `protectedChains`를 제공한다」 | V03-i | VM 전용 유지 |
| V05 | 「VM worker 격리 launcher를 V06-b에 흡수하지 않는다」 | V03-i | VM 전용 유지 |

`일반화` 행의 강도 비교: T09·T13·T16·T20·T22~T27·T32·T38·T39·T42는 V03-i에서 VM Core·VM worker·key에 걸린 조건을 AGS 보호 주체·caller·worker·모든 보호 값으로 넓혔다. 적용 대상이 넓어졌을 뿐 조건을 뺀 곳은 없다. T13은 "같은 읽기·프로세스 제어 권한"을 양방향 제어·읽기와 같은 group 쓰기까지 넓혔다(P4.1). T16은 관측 대상을 worker child에서 보호 주체와 worker 양쪽의 실제 프로세스로 넓혔다(P4.3·P4.4).
