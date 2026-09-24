# V06-b3b Linux 보호 runtime root와 byte identity 증거

## V06-b3b-r2: 입력 신뢰 경계 복구 (2026-09-24)

총괄 감사가 r1(`c584e0a4`)을 FAIL로 판정했다. 두 결함은 이렇다. (F1) `readPackageSource`가 source의 조상만 검사하고 자식 파일·디렉터리의 owner·mode는 보지 않았다. 그래서 root 소유 0755 source 아래에 사용자 쓰기 가능한 manifest나 artifact가 있어도, 서로 맞는 digest로 통과했다. (F2) 부모 재사용이 caller가 준 JSON 항목과만 대조돼, 위조 manifest로도 성립했다.

- 원 결함 재현(`c584e0a4` 코드): r2 테스트에서 0666 manifest가 `Missing expected exception`로 받아들여졌다. pin 없는 host-integration digest와 caller JSON 부모 재사용도 받아들여져 4건이 실패했다. 진단 fixture(`/root/b3bf/r1/diag`)에서도 0666 manifest·0666 artifact·0777 하위 디렉터리·nobody 소유 artifact가 `readPackageSource`와 설치에서 `ACCEPTED`됐고, 위조 부모 manifest로 부모 재사용이 `ACCEPTED`됐다.
- 보완(`scripts/qualification/v06-b3-linux-install.mjs`):
  - 코드 상수 `TRUST_PINS`: `0724bb2b`의 host-integration.json `648dddda…ce70c`, V06-b3b 부모 manifest `857bad43…ce9f`, V03-i v1 manifest(`ags-vm-protected-host-installation/v1`, revision 1, `0c5bfc70…cb19`), v2 계약 ID·revision(`ags-protected-node-closure/v2`, 2). 테스트용 pin은 라이브러리 옵션으로만 받고 CLI에는 두지 않는다.
  - source 입력(host-integration.json, artifacts 전부, V03-i manifest, v2 문서)은 source root부터 그 파일까지 경로의 모든 디렉터리와 파일을 lstat한다. symlink, 비root owner, group/other 쓰기가 있으면 거절한다. 파일은 정규 파일이고 `nlink == 1`이어야 한다. 이어 `O_NOFOLLOW` fd로 읽고 dev/ino가 lstat과 같은지 확인한다. 모든 입력을 이렇게 읽은 뒤에 `inspectPackage`를 적용한다.
  - 계약 1번: source의 V03-i v1 manifest digest·ID·revision, v2 계약 블록의 ID·revision·`extends`·`releaseIdInputs` 순서·`nodeEngine`·linux-x64 배치(installRoot, `bin/node`, `package`)를 pin과 대조한다. host-integration digest는 source에서 계산하지만 pin에 없으면 거절한다. 설치 후 검증(`verifyProtectedRuntime`)도 같은 pin을 요구한다.
  - 부모 재사용: `parentManifestFile`만 받는다. 조건은 root 소유 정규 파일, group/other 쓰기 없음, `nlink == 1`, 신뢰 조상 체인에 group/other가 닫힌(0700) 디렉터리가 하나 이상 있을 것, sha256이 pin과 같을 것이다. caller JSON(`parentManifestEntries`)은 명시적으로 거절한다. pin이 없으면 기존 부모를 재사용하지 않는다.
  - 순서: `/usr` gate → linux-only → nodeVersion·archive hex·node bytes 검사 → source·부모 manifest 읽기 → 설치 쓰기. nodeVersion 검사를 host 접근 앞으로 옮겼다(r1 감사 비차단 1).

### provenance와 기존 root 재검증 (새 설치 아님)

- r1 설치 당시 source `/root/b3bf/r1/src`: `git archive 0724bb2b`(기본 umask 002). 조상 `/root`, `/root/b3bf`, `/root/b3bf/r1`, `src`가 모두 root 700이었다. 내부 디렉터리 371개와 파일 1620개에 group 쓰기 비트가 있어, 보완된 source 검사라면 거절된다. 다만 700 체인 때문에 비root 주체는 접근할 수 없었다.
- r2 source `/root/b3bf/r2/src`: `git -c tar.umask=022 archive 0724bb2b`. 조상은 모두 700이고 내부 group/other 쓰기 0, 비root owner 0, symlink 0이다. `diff -rq` 결과 r1 source와 bytes가 같다.
- r1 설치에 쓴 부모 manifest `/root/b3bf/manifest.txt`: root 600, sha256 `857bad43…`(pin과 같음).
- live 읽기 전용 재검증(boot_id `18e156cd-7585-4c5f-a57c-c7a254354141`):
  - 보완 코드의 `readPackageSource(/root/b3bf/r2/src)`가 V03-i·v2 pin과 host `648dddda…`를 통과했고 입력은 179개였다. 결합 ID는 기존 root 이름 `32a825d9…8edd`와 같았다.
  - `readTrustedParentManifest(/root/b3bf/manifest.txt)`를 통과했고, suite·runtime ino(516801, 516802)가 manifest와 같았다.
  - `verifyProtectedRuntime`: package 179개가 정확 집합이다. `bin/node`는 root 555, ino 516919, nlink 1, sha256 `7fde7b8a…`이고, fd 경유 `--version`은 v24.21.0이다.
  - nobody 18건 모두 거절: create 6·쓰기 open 3·rename 5·교체 2는 `EACCES`, hardlink 2는 `EPERM`.
  - 재검증 전후로 `bin/node`의 ino·ctime(516919, 1790268678)이 같고, 두 manifest sha도 그대로다. 최종 코드가 기존 root를 새로 설치했다고 주장하지 않는다.
- 기존 `fd8e59d5…` root는 바꾸지 않았다.

## V06-b3b-r1: v2 release ID·배치 복구 (2026-09-24)

V06-b3b 최초 설치는 `ags-protected-node-closure/v2`와 세 가지가 달라 BLOCKED였다. (1) root 이름에 archive sha256(`fd8e59d5…`)을 그대로 썼고, (2) node를 `<root>/node`에 두었으며, (3) `<root>/package`가 없었다. 이 절이 v2 배치를 기준으로 하며, 아래 V06-b3b 절의 `fd8e59d5…` root는 이전 증거로만 보존한다(v2 후보 아님).

- 원래 결함 재현: 독립 계약 검사기(`V06-b3b-r1.test.mjs`의 `contractViolations`)를 기존 `fd8e59d5…` root에 적용하면 `root-id`, `node-path`, `package`, `root-entries` 위반이 나온다. 수정 전 코드에서 v2 테스트 5건은 `releaseIdV2`·`installProtectedRuntime` 부재로 실패했다.
- 수정(`scripts/qualification/v06-b3-linux-install.mjs`):
  - `releaseIdV2`: `releaseIdInputs` 순서(contractId, targetId `linux-x64`, nodeVersion, archiveSha256Hex, hostIntegrationSha256Hex)를 LF로 잇고 끝에 LF를 붙인 UTF-8 bytes의 SHA-256.
  - `installProtectedRuntime`: `/usr` gate → linux-only → 입력(archive hex, node bytes) 검사 → package source 읽기 순서. source는 root 전용 조상 아래여야 하고, `host-integration.json` digest를 그 bytes에서 직접 계산한다(caller digest를 받지 않는다). `<root>/bin/node`(root `0555`)와 `<root>/package`(host-integration.json과 `artifacts[].path`만, 파일 root `0444`, 디렉터리 root `0755`)를 `O_CREAT|O_EXCL|O_NOFOLLOW`로 만들고 만든 경로마다 manifest에 기록한다. 이미 있는 `agent-governance-suite`, `protected-runtime`는 이전 설치 manifest의 ino·형식·owner·mode와 일치할 때만 재사용한다.
  - `verifyProtectedRuntime`: root 항목이 정확히 `bin`, `package`, `bin`은 `node` 하나, root 이름이 설치된 host-integration bytes로 다시 계산한 결합 ID와 같은지, package 정확 집합(Windows leaf의 `inspectPackage(…, exact=true)` 재사용: 추가·누락·대소문자 중복·symlink·특수 파일 거절)과 각 파일의 digest·root 소유·쓰기 비트 없음·`nlink == 1`을 확인한다.
  - `runVerifiedRuntime`: 사용 직전 조상, package 파일 전부와 `bin/node`의 identity·hash를 기록과 다시 대조하고, 검증한 fd를 `--no-addons --no-global-search-paths`와 빈 환경으로 실행한다.
  - CLI는 v2 설치로 바꿨다(`--package-source`, `--parent-manifest` 추가).

### 신뢰 근거와 결합 ID

- package source: `origin/codex/v260-semantic-decision-layer`를 fetch해 `FETCH_HEAD` = `0724bb2bc452626aba546a57d1db5c407d32feb0`(tree `eb59f43d…`)를 확인하고, `git archive 0724bb2b`를 root 전용 `/root/b3bf/r1/src`에 풀었다. `pnpm bundle:check`는 exit 0이다.
- `hostIntegrationSha256` = `648dddda453db17832a776a6d381a747d7af851c2594762bd2f2a494628ce70c`. 풀어낸 파일과 `git cat-file blob 0724bb2b:host-integration.json` 모두에서 독립 계산했다. artifacts 178개, entryPoints 4개이며, source의 178개 artifact digest는 모두 일치했다.
- 결합 `releaseSha256` = `32a825d9da1c613e097e6246cf282b89777cc13d043fda3dd68113c1fc208edd`. preimage 입력은 `ags-protected-node-closure/v2`, `linux-x64`, `24.21.0`, `fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6`, `648dddda…ce70c`이다. 셸의 `printf … | sha256sum`, 테스트의 독립 계산, 설치 코드가 같은 값을 냈다.

### 실제 host 관측값 (boot_id `10677179-31a1-4fec-a035-c3d5f6705d1a`)

| 경로 | owner | mode | ino |
| --- | --- | --- | --- |
| `/`, `/usr`, `/usr/lib` | root:root | 755 | 2, 193, 308 |
| `agent-governance-suite`, `protected-runtime` (b3b manifest와 일치해 재사용) | root:root | 755 | 516801, 516802 |
| `32a825d9…` (root) | root:root | 755 | 516848 |
| `bin` | root:root | 755 | 516918 |
| `bin/node` | root:root | 555 | 516919, nlink 1 |
| `package` | root:root | 755 | 516920 |

- `bin/node` sha256 `7fde7b8a…df4c`: archive 추출 bytes, 설치 파일, 사용 직전 fd가 같다. fd 경유 `--version` → `v24.21.0`.
- package 파일 179개(host-integration.json + 178). symlink 0, root가 아닌 owner 0, 쓰기 비트 0, `nlink != 1` 0, 디렉터리 mode 755가 아닌 것 0, artifact digest 불일치 0. 설치된 host-integration.json sha256도 `648dddda…`이다.
- `nobody`(65534, `setpriv`) 시도 19건 모두 거절: 조상 2개·root·bin·package·package 하위 디렉터리에 create, `bin/node`·host-integration.json·`mcp-server/dist/server.mjs` 쓰기 open, root·bin·bin/node·package·하위 디렉터리·package 파일 rename, `/tmp` 파일로 bin/node·package 파일 교체 → `EACCES`, bin/node·package 파일의 `/tmp` hardlink → `EPERM`.
- 새 manifest `/root/b3bf/r1/manifest.txt` 246줄(root, bin, node, package, 하위 디렉터리 63개, 파일 179개), sha256 `d75268cecb0c8f2210c7d0f8683a4b0bd8a4e6b685e3eec5144f42aca4be0e05`.
- 기존 `fd8e59d5…` root: `node` ino 516804, mode 555, nlink 1, ctime 1790262265, sha256 `7fde7b8a…`로 변하지 않았고, b3b manifest sha256 `857bad43…`도 그대로다.

### 재현 (r1)

```text
AGS_V06_B3B_FIXTURE_PARENT=<root 소유·group/other 쓰기 없는 디렉터리> AGS_V06_B3B_PROTECTED_INSTALL=1 \
AGS_V06_B3A_INPUT_DIR=<b3a-input-dir> AGS_V06_B3A_GPGV=/usr/bin/gpgv AGS_V06_B3A_TAR=/usr/bin/tar \
AGS_V06_B3B_MANIFEST=<b3b manifest> AGS_V06_B3B_R1_PACKAGE_SOURCE=<git archive 0724bb2b를 푼 root 전용 디렉터리> \
AGS_V06_B3B_R1_MANIFEST=<root-only-file> AGS_V06_B3B_R1_PARENT_MANIFEST=<b3b manifest> \
pnpm exec vitest run tests/coordinate-subagents/v3x/V06-b3b-r1.test.mjs tests/coordinate-subagents/v3x/V06-b3b.test.mjs
```

- env 없음: r1 3건(결합 ID, gate 순서, 기존 root 위반 확인. 마지막은 Linux root이고 기존 root가 있을 때만) 실행, 나머지 skip.
- 주장하지 않는 것은 아래 V06-b3b 절과 같다. 이 절도 loader closure(V06-b3c)와 Windows 보호 설치를 다루지 않으며, fixture 성공을 후보 근거로 쓰지 않는다.

## V06-b3b (이전 배치, v2 비적합)

이 디렉터리는 `ags-protected-node-closure/v2`의 `linux-x64` 대상에서, V06-b3a가 검증한 Node 24.21.0 archive의 `bin/node`를 **이 후보 host 한 대**의 `/usr/lib/agent-governance-suite/protected-runtime/<releaseSha256>/node`에 배치하고 그 identity를 확인한 V06-b3b leaf의 실행 증거다. 최대 상태는 `CANDIDATE_HOST_INSTALLED`이며, 운영 host 설치 자격, 완전히 새 디스크·물리 분리·secure erase, VM 재할당 rollback은 주장하지 않는다. ELF loader closure 측정도 범위 밖이다.

### 보수 이력: Windows에서 `/usr` gate를 건너뛴 결함

- 최초 커밋의 `protectedPaths`는 호스트 `path.resolve`를 썼다. Windows 통합 검증에서 `/usr/lib`가 `D:\usr\lib`로 바뀌어 `/usr` gate를 건너뛰었고, 테스트 `a /usr install is refused without the explicit gate env`가 기대한 `requires AGS_V06_B3B_PROTECTED_INSTALL=1` 대신 `ENOENT <drive>:\proc\self\mountinfo`로 실패했다(FAIL_RELEVANT).
- 보수: 보호 경로 계산은 호스트 OS와 무관하게 `path.posix`만 쓴다. `installProtectedNode`는 `/usr` gate → 플랫폼 → bytes 순으로 판정한 뒤에만 host에 접근한다. `platform`(기본 `process.platform`)을 주입할 수 있고, `linux`가 아니면 gate를 통과해도 `/proc`·조상 검사·설치 전에 `linux-only` 오류로 거절한다. `inspectAncestors`, `verifyInstalledNode`, `runVerifiedNode`도 같은 플랫폼 검사를 먼저 한다.
- 회귀 테스트는 설치 모듈에만 `path.win32`를 `node:path`로 주고(Windows처럼 `.posix`는 POSIX 그대로) fs 함수 7개(`readFileSync`, `lstatSync`, `statSync`, `openSync`, `mkdirSync`, `chmodSync`, `appendFileSync`)를 예외로 바꾼 자식 프로세스에서 판정한다. 설치 모듈의 첫 host 접근은 이 중 하나로 시작한다. 대체 모듈은 자신이 win32 의미로 계산한 `path.win32.join('/usr', 'lib')` 값(`\usr\lib`)을 표지로 남기고, 테스트가 이를 단언하므로 대체가 빠지면 실패한다.
- 수정 전 코드(`af65a82e`) 재현, 최종 테스트 기준: 경로가 `\usr\lib…`, gate 없음(win32)과 gate 있음(win32)은 `HOST_ACCESS readFileSync /proc/self/mountinfo`, darwin(기대 sha를 `b`×64로 준 경우)은 플랫폼 검사 없이 `node bytes do not match the expected archive-extracted sha256`, host 접근 2건이다.
- 처음 테스트 버전(15:03:40 실행)은 darwin 경우에 맞는 sha를 주었기 때문에 세 경우 모두 `/proc/self/mountinfo` 접근(3건)으로 실패했다. 이후 플랫폼 검사가 bytes 검사보다 먼저인지 고정하려고 darwin 경우의 기대 sha를 불일치로 바꿨다. 수정 후에는 POSIX 경로, gate 오류, `platform=win32`·`platform=darwin` 거절, host 접근 0건이다.

### 실행 환경 (2026-09-24, 보수 후 새 후보 host)

- Ubuntu 24.04 x86_64 root 컨테이너 VM(firecracker), boot_id `85e6dab7-95a0-4675-8e2f-6e9a8d49a280`. 최초 커밋의 관측 host(boot_id `f8c2e0e3-a3d9-4a93-a2f8-bfa15a11b9c0`)와 다른 VM이며, 이 host에서 수정 후 코드로 새로 설치했다. 주장 범위는 동시 세션의 가시 파일시스템 격리까지다.
- `/`는 `/dev/vda` ext4 단일 mount(dev 65024)이고 `/usr`, `/usr/lib`와 설치 트리는 모두 같은 mount 안에 있다(`/proc/self/mountinfo`에서 `/`만 mount point).
- `/proc/sys/fs/protected_hardlinks` = `1`, `setpriv`(util-linux 2.39.3), 비root 검사 principal은 기존 `nobody`(65534).
- 검사용 Node는 V06-b3a 절차(`gpgv` 서명, keyring pin, archive sha256)로 검증한 archive에서 추출한 v24.21.0이다. `/opt/node22`는 근거로 쓰지 않았다.
- 작업 입력·추출물·fixture는 root 전용 `/root/b3bf`(mode 700), `TMPDIR=/root/b3bf/t`에 두었다.

### 입력 (V06-b3a 고정값과 일치)

- archive `node-v24.21.0-linux-x64.tar.xz` sha256 `fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6` = `<releaseSha256>`
- keyring `nodejs/release-keys@481637f8…/gpg-only-active-keys/pubring.kbx` sha256 `140f2ad5260fd62773b6243ce8e1d3009645d558f121b8262c55e383dc285932`, 서명자 `5BE8A3F6C8A5C01D106C0AD820B1A390B168D356`
- archive에서 추출한 `bin/node` sha256 `7fde7b8afa198da66257f42ee2001d874c7355631e6d1579a5fb5ef1f246df4c`

### 설치 규칙 (`scripts/qualification/v06-b3-linux-install.mjs`)

- 설치 root는 인자(`--base-dir`)로 받고 POSIX 경로로만 해석한다. `/usr` 아래 설치는 `AGS_V06_B3B_PROTECTED_INSTALL=1`이 없으면 어떤 host 접근보다 먼저 거절한다. Linux가 아닌 플랫폼은 그다음, host 접근 전에 거절한다.
- 조상 `/`부터 `<releaseSha256>`까지 각 요소를 `lstat`해 symlink, 디렉터리가 아닌 것, root가 아닌 owner, group/other 쓰기 비트를 거절한다. 각 요소의 mount point 여부를 기록한다.
- 대상 `<releaseSha256>` 디렉터리가 이미 있으면 거절한다. node는 `O_CREAT|O_EXCL|O_NOFOLLOW`로 만들고 쓰기 전에 `0555`로 고정한다.
- 모드 근거: 디렉터리는 root `0755`(group/other 쓰기 없음), node는 root `0555`. node는 비밀이 아니고 모든 사용자가 실행해야 하므로 읽기·실행은 열고, 소유자 root까지 쓰기 비트를 두지 않아 실수로 열어 쓰는 경로를 없앴다.
- 사용 가능 조건: 정규 파일, root 소유, 쓰기·special 비트 없음, `nlink == 1`, sha256이 archive 추출 bytes와 같음.
- 검증 시 dev/ino/size/mode/uid/gid/nlink/mtimeNs/ctimeNs와 sha256을 기록한다. 사용 직전 조상을 다시 검사하고, `O_NOFOLLOW`로 연 fd의 `fstat`을 기록과 대조한 뒤 같은 fd로 다시 hash하고, 그 fd의 `/proc/<pid>/fd/<n>` 링크로 실행한다. 경로가 중간에 바뀌어도 검증한 inode만 실행된다.
- 새로 만든 경로마다 path, ino, 형식, owner, mode를 manifest에 즉시 남긴다. 설치 중 실패하면 현재 상태가 manifest와 모두 같을 때만 만든 경로를 역순으로 지우고, 하나라도 다르면 지우지 않고 보고한다.

### 실제 host 관측값

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

### 재현

```text
AGS_V06_B3B_PROTECTED_INSTALL=1 node scripts/qualification/v06-b3-linux-install.mjs \
  --base-dir /usr/lib --input-dir <b3a-input-dir> --gpgv /usr/bin/gpgv --tar /usr/bin/tar --manifest <root-only-file> \
  --package-source <git archive 0724bb2b를 푼 root 전용 디렉터리> --parent-manifest <b3b manifest>
# r1 이후 CLI는 v2 배치만 설치한다. 이전 배치는 테스트의 legacy 함수로만 검증한다.

AGS_V06_B3B_FIXTURE_PARENT=<root 소유·group/other 쓰기 없는 디렉터리> \
AGS_V06_B3B_PROTECTED_INSTALL=1 AGS_V06_B3A_INPUT_DIR=<b3a-input-dir> AGS_V06_B3A_GPGV=/usr/bin/gpgv \
AGS_V06_B3A_TAR=/usr/bin/tar AGS_V06_B3B_MANIFEST=<root-only-file> \
pnpm exec vitest run tests/coordinate-subagents/v3x/V06-b3b.test.mjs
```

- env가 없으면 fixture·live 검사 5건은 `skipIf`로 skip으로 표시되고, 순수 판정 검사 3건(플랫폼·경로 회귀 포함)만 실행된다. 회귀 검사는 OS와 권한에 관계없이 실행된다.
- fixture 검사는 Linux root와 안전한 조상 체인이 필요하다. sticky `/tmp`는 group/other 쓰기로 거절되므로 fixture parent로 쓸 수 없다.

### 주장하지 않는 것

- 운영 host 설치 자격, 운영 subtree 변경
- 완전히 새 디스크, 물리 분리, secure erase, 재할당 rollback
- root 자신의 교체 방지(root는 모든 모드를 우회한다. 이 leaf는 비root 교체와 검증-사용 사이 교체를 다룬다)
- Windows에서의 설치·실행(이 leaf는 Linux 전용이며 Windows에서는 거절만 한다), ELF loader closure
- Windows에서 수정 후 테스트를 직접 실행한 결과(이 VM에서는 실행할 수 없었다)
