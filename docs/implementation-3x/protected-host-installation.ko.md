# 보호 subtree·실행 주체 공통 계약 (V03-i)

계약 ID: `ags-vm-protected-host-installation/v1`. 권위 원본은 이 AGS 문서와 `tests/coordinate-subagents/v3x/fixtures/protected-host-installation/`의 manifest·사례다. V03-i는 설계 동결과 합성 fixture 판정이며 운영 설치, 제품 권한 적용 또는 Windows/Linux host 자격을 입증하지 않는다. V03-d/e/g의 기존 검사는 이 계약의 구현 완료 근거가 아니다.

## 현재 경계와 선택 경로

VM Engine은 현재 `GovernanceSettings.from_environment → _load_installed_producer`에서 private key를 읽고 `AGSObservationProducer.issue`에서 현재 Core prepared operation·terminal을 다시 읽은 뒤 서명한다. AGS MCP는 VM의 stdio child다. 반면 VM `claude_runtime.py::_spawn`은 일반 `subprocess.Popen`으로 worker를 시작하며 다른 OS principal을 지정하지 않는다. 따라서 현 제품의 worker는 key·Core 상태·AGS pipe로부터 격리됐다고 판정할 수 없다.

**선택 경로:** VM Core 프로세스가 signer와 보호 파일 reader를 유지하고, OS 서비스 관리자가 별도 저권한 principal로 시작한 **worker service**가 작업 코드를 실행한다. Windows는 SCM이 별도 worker 서비스 SID/계정으로, Linux는 systemd가 별도 worker uid/gid로 시작한다. VM Core의 일반 `Popen`으로 직접 worker를 만드는 경로는 운영 모드에서 금지한다. 관리자가 서비스 둘과 ACL/mode를 provision하고, Core→worker service의 한정된 요청/결과 IPC는 신규 OS별 생산자 leaf가 구현한다. worker service와 작업 자손은 private key·Core state·AGS control pipe에 접근하지 못한다. Core는 worker 반환값을 신뢰된 terminal로 승격하기 전에 자체 ledger와 provider 관측을 재검증한다. worker가 Core와 같은 실효 SID/uid 또는 같은 읽기·프로세스 제어 권한을 가지면 실패다. signer 서비스는 추가하지 않지만 worker 서비스·IPC 생산자가 없으므로 현재 운영 자격은 `BLOCKED_CONTRACT`다.

## 고정 경로와 신뢰 경계

| OS | 시스템 부모(기본 ACL 변경 금지) | 최초 보호 subtree | 보호 파일 |
| --- | --- | --- | --- |
| Windows | `C:\`, `C:\ProgramData` | `C:\ProgramData\flowmarshal`; `C:\ProgramData\agent-governance-suite` | 각각 `ags-producer-key.json`, `vm-operator-policy.json` |
| Linux | `/`, `/etc` | `/etc/flowmarshal`; `/etc/agent-governance-suite` | 각각 `ags-producer-key.json`, `vm-operator-policy.json` |

기존 설치 경로는 유지한다. `C:\`·`ProgramData`의 owner/ACE를 시스템 전체에서 변경하지 않는다. 시스템 부모에 일반 사용자의 새 디렉터리 생성 권한이 있을 수 있어도, **이미 provision된 보호 subtree와 그 부모 자체**에 대해 worker·일반 사용자·패키지 작성자가 rename/delete/replace, reparse/junction 전환, ACL/owner 변경을 할 수 없어야 한다. Windows에서는 subtree 자체의 `DELETE`와 부모의 `FILE_DELETE_CHILD`, `WRITE_DAC`, `WRITE_OWNER` 등 실효 권한을 SID·group·deny/allow·상속·privilege와 함께 평가한다. 단순 ACL 비트 목록 또는 subtree 파일 ACL만으로 판정하지 않는다. Windows 파일·디렉터리의 표준 권한과 child 삭제 권한은 [Microsoft File Security](https://learn.microsoft.com/en-us/windows/win32/fileio/file-security-and-access-rights)와 [File and Directory Access Rights](https://learn.microsoft.com/en-us/windows/win32/fileio/file-access-rights-constants)에 정의돼 있다.

Linux에서는 root부터 보호 subtree와 파일까지 owner, mode, ACL, mount/bind-mount, symlink를 확인하고 worker·일반 계정의 부모 교체·쓰기·소유권 변경 가능성을 거부한다. 보호 경계는 디렉터리 핸들 기반 경로 해석과 열린 파일의 identity 재확인으로 TOCTOU를 닫아야 한다. Linux 구현은 `openat2`의 `RESOLVE_NO_SYMLINKS` 같은 경로 제약을 이용하거나 동등한 증거를 제시한다([openat2(2)](https://man7.org/linux/man-pages/man2/openat2.2.html)). Windows도 reparse 검출뿐 아니라 열린 핸들의 volume/file identity와 각 부모의 교체 불가를 검사한다. 검사 중 parent/subtree 교체·삭제·권한 완화·metadata 조회 실패는 거부한다.

## 운영 설치 기록과 보호 상태

installer가 작성하는 운영 기록은 Windows `C:\ProgramData\flowmarshal\protected-installation.json`, Linux `/etc/flowmarshal/protected-installation.json`에 둔다. 이 파일은 caller 입력이 아니라 설치 관리자의 보호 파일이며 VM Core와 AGS preflight가 읽는다. 필수 필드는 `contractId`, `revision`, AGS fixture `sha256`, OS, installer/Core/AGS/worker의 실제 principal ID와 group·privilege 정책, key/pin/VM Core state/AGS state/worker endpoint/실행물의 고정 절대 경로, OS 서비스 ID, 허용된 build digest 및 launcher/interpreter closure digest다. 파일 자체의 신뢰는 worker·일반 사용자에게 쓰기·삭제·교체가 거부된 보호 subtree와 설치 측정에 의존한다. self-reported JSON만으로 실효 ACL·token·hash 확인을 대체하지 않는다. 임의 `--db`·`--artifacts`·환경 변수로 운영 기록을 고르지 않는다.

운영 Core의 권위 상태 루트는 Windows `C:\ProgramData\flowmarshal\core-state`, Linux `/var/lib/flowmarshal/core-state`로 고정한다. `/var/lib/flowmarshal`도 installer 소유 보호 subtree다. VM ledger SQLite 본체와 `-wal`/`-shm`, prepared/terminal 기록, 인증·nonce·session 상태, 권위 artifact 저장소, AGS workflow/continuity/trust DB와 그 sidecar·로그는 이 루트 또는 동등하게 보호된 자식 경로에 둔다. VM Core와 AGS의 자기 DB 쓰기 범위는 애플리케이션 계약이며, 동일 실효 principal인 동안 OS ACL로 둘을 분리했다고 주장하지 않는다. worker는 이 전체 루트의 읽기·쓰기·삭제·교체가 거부돼야 한다. worker가 작성하는 workspace/staging 결과는 불신 입력이고 Core가 검증해 보호 저장소로 가져오기 전에는 서명 근거가 아니다. 현재 VM CLI의 cwd 기반 `.flowmarshal-engine` 기본값과 `--db`/`--artifacts` 입력은 이 운영 모드에 맞지 않는다. V03-k 또는 선행 VM protected-state producer가 고정 경로·sidecar·parent ACL과 override 차단을 구현·검증해야 한다.

## 주체와 접근 행렬

역할은 동일 SID/uid/서비스 이름을 강제하는 식별자가 아니다. Windows의 VM Core는 설치 관리자가 만든 보호 SYSTEM 서비스, Linux의 VM Core는 root 소유 보호 서비스로 시작하고, 작업 agent는 반드시 별도 비특권 worker 서비스에 둔다. 설치 manifest는 각 OS의 실제 SID 또는 uid/gid, 보조 group, 권한과 실행 형식을 기록하며 제품이 읽어 확인한다. 서비스 계정·identity가 실제 설치 환경에서 마련되지 않으면 운영 검사는 `BLOCKED_CONTRACT`다.

| 역할 | key | pin | Core DB·prepared/terminal | AGS stdio/control pipe | worker 실행 |
| --- | --- | --- | --- | --- | --- |
| 설치 관리자 | provision·회전·복구 시만 접근 | provision·회전·복구 | 운영 중 접근 불필요 | 운영 중 접근 불필요 | 실행 주체와 패키지 권한 설정 |
| VM Core signer/reader | 읽기·서명, 쓰기 금지 | 읽기 | 읽기·쓰기 권위 | 독점 소유·호출 | OS 관리 worker service에 단회 작업 요청 |
| AGS MCP reader | key를 전달받지 않음. 현 동일 principal에서는 OS 읽기 거부 미증명 | 검증 읽기 | 직접 호출하지 않음. 현 동일 principal에서는 OS 차단 미증명 | VM Core와의 해당 연결만 | 시작 권한 없음 |
| worker service 및 작업 자손 | 읽기·쓰기·복제 거부 | 운영 pin 읽기·변경 거부 | 읽기·쓰기 거부 | AGS/Core control pipe 연결·상속·duplication 거부 | 자기 작업 경계만 |

VM Core와 AGS reader가 같은 실효 주체로 실행되는 현 stdio 방식은 허용하되 key bytes는 AGS argv/env/stdio로 전달하지 않는다. AGS가 key를 읽을 수 있는 같은 주체라면 key 파일 ACL만으로 AGS 자체에 대한 key 접근 차단을 주장하지 않는다. 이 계약의 격리 대상은 불신 worker와 그 자손이다. AGS 분리가 운영 요구가 되면 별도 주체·signer 서비스 계약이 선행돼야 한다.

Windows worker service는 SCM이 installer-provisioned 별도 비특권 서비스 계정으로 시작한다. Core와 구분되는 **실효 접근 권한**의 primary token을 관측한다. SID 이름만 다른지 또는 restricted token 명칭만 있는지로 통과시키지 않는다. 작업 child token의 user/group·enabled privileges·integrity와 보호 파일·pipe에 대한 실제 접근 거부를 측정한다. 서비스가 작업 자손을 만들 때 명시적 환경 블록과 최소 handle 상속을 사용한다. `CreateProcessAsUserW`는 지정 primary token과 별도 환경 블록을 받으며, 상속 handle 설정은 child 접근에 직접 영향을 준다([Microsoft CreateProcessAsUserW](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-createprocessasuserw)).

Linux worker service는 systemd의 별도 비특권 `User`/`Group`으로 시작한다. 작업 자손의 보조 group, capability, 상속 FD와 환경을 제거한다. 실행 뒤 uid/euid/gid/egid/groups/capability를 실제 child에서 관측하고 key·pin·Core DB·AGS pipe 접근을 거부한다. `no_new_privs` 등 재상승 방어를 적용하되 그 설정 이름만으로 접근 거부를 대체하지 않는다([PR_SET_NO_NEW_PRIVS](https://man7.org/linux/man-pages/man2/PR_SET_NO_NEW_PRIVS.2const.html)). 일반 `Popen`으로 다른 uid로 바꾸는 경로는 권한 없이 성립하지 않는다([setuid(2)](https://man7.org/linux/man-pages/man2/setuid.2.html)).

## 설치·회전·복구 절차의 불변 조건

1. 관리자는 고정 vendor subtree와 Core state subtree가 없음을 확인한 뒤 보호된 owner/ACL 또는 mode로 생성한다. 이미 존재하면 owner·identity·reparse·권한을 검사해 허용된 동일 설치임을 증명하기 전에는 덮어쓰지 않는다. 사용자 선점 디렉터리는 실패다. 설치 기록과 서비스 정의의 revision·경로·principal을 동시에 고정한다.
2. 관리자만 key/pin을 임시 보호 파일로 작성하고 완전한 검증 후 원자적 교체·동기화한다. key 원문은 로그·fixture·메시지·worker 환경에 넣지 않는다. active pin, installation/key/host ID와 정책 버전, 공개키 대응을 함께 읽어 검증한다.
3. VM Core·AGS 설치 실행물과 interpreter/launcher closure는 별도 보호 subtree 또는 동등한 불변 설치 경로에서 측정한다. 사용자 쓰기 가능 DLL/module/search path, cwd, argv·env override, `.cmd` wrapper를 보호 실행물로 인정하지 않는다. **선택 경로는 측정된 interpreter closure**다. AGS V06-b는 Windows의 보호된 `node.exe`, Linux의 보호된 `node`와 `mcp-server/dist/server.mjs`, 실행 인수, OS loader가 실제 읽는 dependency·module bytes를 후보별 manifest에 결속한다. 빌드 도구는 현재 AGS의 Node 22.13+·pnpm 11·esbuild를 기준으로 하며 별도 native launcher를 기본값으로 가정하지 않는다. 실제 OS별 Node 설치 위치와 동적 dependency 집합은 후보 설치 후 측정한다. Python VM Core의 Windows `python.exe`/Linux `python3` interpreter·module closure는 AGS V06-b가 생산할 수 없으므로 별도 VM package leaf가 필요하다. 어느 OS에서든 interpreter 의존 집합을 닫을 수 없으면 V06-b/VM package leaf는 `NEEDS_SPLIT`으로 보고하고 지원 OS를 추정하지 않는다.
4. 시작 전·key/pin 및 Core state 읽기 전후·worker service 요청 전후에 경로 identity와 실제 실행 주체를 관측한다. 불일치·조회 불가·서비스 재시작·회전 중간 상태는 fail-closed다. 복구는 관리자에 의한 재설치·회전·pin 동시 확인과 재qualification으로만 한다. 자동 권한 완화, root ACL 수정, 환경 변수 경로 우회는 복구가 아니다.
5. 사용자 결정이 필요한 실제 운영 단계에서는 대상 Windows/Linux host, installer/VM Core/AGS/worker 실효 주체, 실행 형식과 build 도구, key/pin 회전·철회 방법, 보호 subtree 설치/되돌리기 권한 및 관측 자료를 **한 묶음으로** 제시한다. 아직 이 입력이나 권한을 받지 않았으며 설치하지 않았다.

## 현재 Core 호출과 IPC 결속

VM Core가 sign 전에 현재 DB transaction의 prepared operation, stage/attempt/task/run, terminal provider event, model·effort provenance를 다시 읽는다. registration·receipt는 그 호출의 installation/key/instance/session/turn/invocation, 예약된 MCP call ID와 nonce에 결속한다. AGS는 `vm/hello → vm/reserve_dispatch → tools/call`의 동일 stdio 연결과 epoch, signed registration/receipt, pending ledger를 대조한다. caller JSON, argv 또는 환경 변수로 key/pin 경로, signer 신원, Core row나 승인된 call을 고르게 해서는 안 된다.

선택 경로에서는 별도 signer IPC가 없다. worker service의 요청/결과 IPC는 Core만 유효한 요청을 시작할 수 있게 OS peer identity와 service identity를 확인하고 현재 Core operation·task/attempt·단회 request ID에 묶는다. 응답은 worker가 조작 가능한 자료로 취급한다. worker 작업 자손은 AGS pipe·VM Core control handle을 상속·duplication·재연결할 수 없어야 하며 Core state도 접근하지 못한다. 같은 SID/uid의 공개 pipe ACL, caller가 고르는 IPC 주소나 token은 인증 근거가 아니다. worker service 설치·IPC 프로토콜·수명은 OS별 신규 생산자 leaf의 필수 책임이다.

<a id="protected-host-provisioning-v1"></a>

## 공통 provisioning 사용 범위

AGS V03-j와 VM V03-k는 이 계약 ID·revision과 아래 fixture digest를 같은 값으로 pin하고 각자의 reader/preflight가 동일한 경로·주체·거부 행렬을 소비한다. 둘 중 하나만 갱신하거나 caller가 revision을 제공하면 `BLOCKED_CONTRACT`다. VM worker service·보호 state 생산자가 없어도 V03-j의 AGS 합성/제품 측 검사는 독립 진행할 수 있다. V03-k의 운영 수용과 V03-f/h의 양제품 qualification은 선행 생산자가 없으면 `BLOCKED_CONTRACT`다. V03-g 합성 preflight의 `FIXTURE_ONLY`나 `READY_FOR_QUALIFICATION`은 운영 `host-supported/configured/observed`가 아니다.

B14-k issuer와 B14-m storage는 **이 절의 공통 provisioning revision `protected-host-provisioning/v1`**에 있는 installer 신뢰 경계, 역할 분리, 설치 기록 보호, 회전·복구 불변 조건을 권위로 참조한다. V 전용 key/pin/worker fixture digest 전체를 B14에 강제하지 않는다. 각자의 credential audience·storage path·서비스 주체·접근 행렬은 해당 Task가 별도로 정한다. AGS/VM과 같은 SID/uid·서비스 계정을 요구하거나 issuer credential을 worker에게 공유하지 않는다.

## 필수 후속 생산자

| 최소 leaf | 책임과 완료 근거 |
| --- | --- |
| VM Windows worker service producer | SCM이 별도 비특권 서비스 계정으로 시작하는 worker service, Core→service 전용 IPC와 작업 자손 launcher를 생산한다. child token·group·privilege, key/pin/Core DB/AGS pipe 접근 거부, handle·env 차단을 설치 후보에서 관측하고 필요한 native API/build tool·서비스 권한을 확정한다. |
| VM Linux worker service producer | systemd가 별도 uid/gid로 시작하는 worker service, Core→service 전용 IPC와 작업 자손 launcher를 생산한다. 보조 group/capability/FD 정리, child identity와 같은 접근 거부를 설치 후보에서 관측하고 필요한 OS 권한·빌드 도구를 확정한다. |
| VM protected-state producer | 고정 Core state 경로, SQLite sidecar·artifact·AGS DB와 parent/subtree 보호, CLI/env override 차단, worker의 실제 읽기·쓰기·삭제 거부를 구현한다. V03-k에 담을 수 없는 storage 이동·migration 책임은 별도 leaf로 분할한다. |
| VM interpreter package producer | Windows/Linux VM Core가 사용하는 Python 실행 파일·module·native dependency closure의 설치 경로, args, build identity와 hash를 설치 후보에서 산출한다. AGS V06-b의 Node closure로 대신하지 않는다. |

이 leaf는 V06-b의 **AGS/VM 제품 진입 실행물 closure** 책임과 다르다. VM worker 격리 launcher를 V06-b에 흡수하지 않는다. 별도 생산자와 OS별 실제 빌드 수단이 마련되지 않으면 V03-j/k/f/h의 운영 판정은 `BLOCKED_CONTRACT` 또는 `LIVE_PENDING`이다.

## fixture와 판정

`tests/coordinate-subagents/v3x/fixtures/protected-host-installation/profiles.json`은 Windows/Linux의 합성 principal과 key·pin·Core state·launcher·설치 기록별 root→parent→file `protectedChains`를 제공한다. 각 조상과 대상의 identity·owner·reparse/symlink·실효 권한을 별도로 기록한다. `cases.json`의 `baselineAssertions`는 이 profile을 요약하고 `override`는 의미적 실패 조건, `observationPatch`는 해당 OS profile의 metadata 변경 경로다. 제품 Task는 boolean 자체를 신뢰하지 않고 profile에 patch를 적용해 권한·identity 판정을 재구성해야 한다. positive도 protected subtree 조건의 **계약 가능성**만 뜻한다. 각 negative의 판정은 `REJECT` 또는 관측 부족 시 `UNKNOWN`이며 `UNKNOWN`을 PASS로 올리지 않는다. `manifest.json`이 이 문서와 두 fixture의 SHA-256에 결속된다. 제품 Task는 manifest의 ID·revision·digest를 고정해 사용하고, 문서나 fixture bytes가 달라지면 관련 제품 검증을 다시 수행한다. 실제 OS 호스트 판정에는 설치된 build, root/parent/subtree ACL·mode, 실제 child principal 및 key/IPC 거절, V06-b closure, Core↔AGS 제품 호출 결과가 별도로 필요하다.
