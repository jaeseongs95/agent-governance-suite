# V06-b3b Linux 보호 runtime root와 byte identity 증거

이 디렉터리는 `ags-protected-node-closure/v2`의 `linux-x64` 대상에서, V06-b3a가 검증한 Node 24.21.0 archive의 `bin/node`를 **이 후보 host 한 대**의 `/usr/lib/agent-governance-suite/protected-runtime/<releaseSha256>/node`에 배치하고 그 identity를 확인한 V06-b3b leaf의 실행 증거다. 최대 상태는 `CANDIDATE_HOST_INSTALLED`이며, 운영 host 설치 자격, 완전히 새 디스크·물리 분리·secure erase, VM 재할당 rollback은 주장하지 않는다. ELF loader closure 측정도 범위 밖이다.

## 보수 이력: Windows에서 `/usr` gate를 건너뛴 결함

- 최초 커밋의 `protectedPaths`는 호스트 `path.resolve`를 썼다. Windows 통합 검증에서 `/usr/lib`가 `D:\usr\lib`로 바뀌어 `/usr` gate를 건너뛰었고, 테스트 `a /usr install is refused without the explicit gate env`가 기대한 `requires AGS_V06_B3B_PROTECTED_INSTALL=1` 대신 `ENOENT <drive>:\proc\self\mountinfo`로 실패했다(FAIL_RELEVANT).
- 보수: 보호 경로 계산은 호스트 OS와 무관하게 `path.posix`만 쓴다. `installProtectedNode`는 `/usr` gate → 플랫폼 → bytes 순으로 판정한 뒤에만 host에 접근한다. `platform`(기본 `process.platform`)을 주입할 수 있고, `linux`가 아니면 gate를 통과해도 `/proc`·조상 검사·설치 전에 `linux-only` 오류로 거절한다. `inspectAncestors`, `verifyInstalledNode`, `runVerifiedNode`도 같은 플랫폼 검사를 먼저 한다.
- 회귀 테스트는 설치 모듈에만 `path.win32`를 `node:path`로 주고(Windows처럼 `.posix`는 POSIX 그대로) fs 함수 7개(`readFileSync`, `lstatSync`, `statSync`, `openSync`, `mkdirSync`, `chmodSync`, `appendFileSync`)를 예외로 바꾼 자식 프로세스에서 판정한다. 설치 모듈의 첫 host 접근은 이 중 하나로 시작한다. 대체 모듈은 자신이 win32 의미로 계산한 `path.win32.join('/usr', 'lib')` 값(`\usr\lib`)을 표지로 남기고, 테스트가 이를 단언하므로 대체가 빠지면 실패한다.
- 수정 전 코드(`af65a82e`) 재현, 최종 테스트 기준: 경로가 `\usr\lib…`, gate 없음(win32)과 gate 있음(win32)은 `HOST_ACCESS readFileSync /proc/self/mountinfo`, darwin(기대 sha를 `b`×64로 준 경우)은 플랫폼 검사 없이 `node bytes do not match the expected archive-extracted sha256`, host 접근 2건이다.
- 처음 테스트 버전(15:03:40 실행)은 darwin 경우에 맞는 sha를 주었기 때문에 세 경우 모두 `/proc/self/mountinfo` 접근(3건)으로 실패했다. 이후 플랫폼 검사가 bytes 검사보다 먼저인지 고정하려고 darwin 경우의 기대 sha를 불일치로 바꿨다. 수정 후에는 POSIX 경로, gate 오류, `platform=win32`·`platform=darwin` 거절, host 접근 0건이다.

## 실행 환경 (2026-09-24, 보수 후 새 후보 host)

- Ubuntu 24.04 x86_64 root 컨테이너 VM(firecracker), boot_id `85e6dab7-95a0-4675-8e2f-6e9a8d49a280`. 최초 커밋의 관측 host(boot_id `f8c2e0e3-a3d9-4a93-a2f8-bfa15a11b9c0`)와 다른 VM이며, 이 host에서 수정 후 코드로 새로 설치했다. 주장 범위는 동시 세션의 가시 파일시스템 격리까지다.
- `/`는 `/dev/vda` ext4 단일 mount(dev 65024)이고 `/usr`, `/usr/lib`와 설치 트리는 모두 같은 mount 안에 있다(`/proc/self/mountinfo`에서 `/`만 mount point).
- `/proc/sys/fs/protected_hardlinks` = `1`, `setpriv`(util-linux 2.39.3), 비root 검사 principal은 기존 `nobody`(65534).
- 검사용 Node는 V06-b3a 절차(`gpgv` 서명, keyring pin, archive sha256)로 검증한 archive에서 추출한 v24.21.0이다. `/opt/node22`는 근거로 쓰지 않았다.
- 작업 입력·추출물·fixture는 root 전용 `/root/b3bf`(mode 700), `TMPDIR=/root/b3bf/t`에 두었다.

## 입력 (V06-b3a 고정값과 일치)

- archive `node-v24.21.0-linux-x64.tar.xz` sha256 `fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6` = `<releaseSha256>`
- keyring `nodejs/release-keys@481637f8…/gpg-only-active-keys/pubring.kbx` sha256 `140f2ad5260fd62773b6243ce8e1d3009645d558f121b8262c55e383dc285932`, 서명자 `5BE8A3F6C8A5C01D106C0AD820B1A390B168D356`
- archive에서 추출한 `bin/node` sha256 `7fde7b8afa198da66257f42ee2001d874c7355631e6d1579a5fb5ef1f246df4c`

## 설치 규칙 (`scripts/qualification/v06-b3-linux-install.mjs`)

- 설치 root는 인자(`--base-dir`)로 받고 POSIX 경로로만 해석한다. `/usr` 아래 설치는 `AGS_V06_B3B_PROTECTED_INSTALL=1`이 없으면 어떤 host 접근보다 먼저 거절한다. Linux가 아닌 플랫폼은 그다음, host 접근 전에 거절한다.
- 조상 `/`부터 `<releaseSha256>`까지 각 요소를 `lstat`해 symlink, 디렉터리가 아닌 것, root가 아닌 owner, group/other 쓰기 비트를 거절한다. 각 요소의 mount point 여부를 기록한다.
- 대상 `<releaseSha256>` 디렉터리가 이미 있으면 거절한다. node는 `O_CREAT|O_EXCL|O_NOFOLLOW`로 만들고 쓰기 전에 `0555`로 고정한다.
- 모드 근거: 디렉터리는 root `0755`(group/other 쓰기 없음), node는 root `0555`. node는 비밀이 아니고 모든 사용자가 실행해야 하므로 읽기·실행은 열고, 소유자 root까지 쓰기 비트를 두지 않아 실수로 열어 쓰는 경로를 없앴다.
- 사용 가능 조건: 정규 파일, root 소유, 쓰기·special 비트 없음, `nlink == 1`, sha256이 archive 추출 bytes와 같음.
- 검증 시 dev/ino/size/mode/uid/gid/nlink/mtimeNs/ctimeNs와 sha256을 기록한다. 사용 직전 조상을 다시 검사하고, `O_NOFOLLOW`로 연 fd의 `fstat`을 기록과 대조한 뒤 같은 fd로 다시 hash하고, 그 fd의 `/proc/<pid>/fd/<n>` 링크로 실행한다. 경로가 중간에 바뀌어도 검증한 inode만 실행된다.
- 새로 만든 경로마다 path, ino, 형식, owner, mode를 manifest에 즉시 남긴다. 설치 중 실패하면 현재 상태가 manifest와 모두 같을 때만 만든 경로를 역순으로 지우고, 하나라도 다르면 지우지 않고 보고한다.

## 실제 host 관측값

| 경로 | owner | mode | ino | mount point |
| --- | --- | --- | --- | --- |
| `/` | root:root | 755 | 2 | 예 |
| `/usr` | root:root | 755 | 193 | 아니오 |
| `/usr/lib` | root:root | 755 | 308 | 아니오 |
| `agent-governance-suite` | root:root | 755 | 516801 | 아니오 |
| `protected-runtime` | root:root | 755 | 516802 | 아니오 |
| `<releaseSha256>` | root:root | 755 | 516803 | 아니오 |

- 설치 node: `/usr/lib/agent-governance-suite/protected-runtime/fd8e59d5…2cb2d6/node`, root:root `0555`, 정규 파일, dev 65024, ino 516804, nlink 1, size 126595440.
- sha256: archive 추출 bytes, 설치 파일, 사용 직전 fd 모두 `7fde7b8a…1f246df4c`로 같다.
- 사용 직전 fd 경유 실행 `--version` → `v24.21.0`.
- `nobody`(`setpriv --reuid=65534 --regid=65534 --clear-groups`)로 설치된 node를 실행해 시도한 결과:
  - 보호 디렉터리에 새 파일 create → `EACCES`
  - 설치 node 쓰기 open(`r+`) → `EACCES`
  - 설치 node rename → `EACCES`
  - `/tmp/ags-b3b-hl-<pid>`로 hardlink → `EPERM` (`protected_hardlinks=1`). 링크는 생기지 않았다.
- manifest `/root/b3bf/manifest.txt` sha256 `857bad43df354eb2022fcc3355257cd37adaa0a4acca506f2a2a9add0721ce9f`(설치 4개 경로).

## 재현

```text
AGS_V06_B3B_PROTECTED_INSTALL=1 node scripts/qualification/v06-b3-linux-install.mjs \
  --base-dir /usr/lib --input-dir <b3a-input-dir> --gpgv /usr/bin/gpgv --tar /usr/bin/tar --manifest <root-only-file>

AGS_V06_B3B_FIXTURE_PARENT=<root 소유·group/other 쓰기 없는 디렉터리> \
AGS_V06_B3B_PROTECTED_INSTALL=1 AGS_V06_B3A_INPUT_DIR=<b3a-input-dir> AGS_V06_B3A_GPGV=/usr/bin/gpgv \
AGS_V06_B3A_TAR=/usr/bin/tar AGS_V06_B3B_MANIFEST=<root-only-file> \
pnpm exec vitest run tests/coordinate-subagents/v3x/V06-b3b.test.mjs
```

- env가 없으면 fixture·live 검사 5건은 `skipIf`로 skip으로 표시되고, 순수 판정 검사 3건(플랫폼·경로 회귀 포함)만 실행된다. 회귀 검사는 OS와 권한에 관계없이 실행된다.
- fixture 검사는 Linux root와 안전한 조상 체인이 필요하다. sticky `/tmp`는 group/other 쓰기로 거절되므로 fixture parent로 쓸 수 없다.

## 주장하지 않는 것

- 운영 host 설치 자격, 운영 subtree 변경
- 완전히 새 디스크, 물리 분리, secure erase, 재할당 rollback
- root 자신의 교체 방지(root는 모든 모드를 우회한다. 이 leaf는 비root 교체와 검증-사용 사이 교체를 다룬다)
- Windows에서의 설치·실행(이 leaf는 Linux 전용이며 Windows에서는 거절만 한다), ELF loader closure
- Windows에서 수정 후 테스트를 직접 실행한 결과(이 VM에서는 실행할 수 없었다)
