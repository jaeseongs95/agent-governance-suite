# 보호 Node interpreter closure 확장 계약 (V06-b1)

이 문서의 계약 ID는 `ags-protected-node-closure/v2`, revision은 `2`다. [V03-i의 `ags-vm-protected-host-installation/v1`](protected-host-installation.ko.md) 중 interpreter closure 절을 확장한다. V03-i 문서·fixture·manifest bytes와 V03-j의 ID·revision·digest pin은 변경하지 않는다. 이 문서는 Windows/Linux 생산자가 사용할 **후보 생산 계약**이다. 실제 Node 바이너리, OS loader 의존성, 보호 설치 또는 운영 host의 적격성을 증명하지 않는다.

## 고정 입력과 지원 범위

다음 JSON은 이 revision의 기계 판독 가능한 규범이다. 경로의 `<releaseSha256>`은 아래에서 정의한 결합 release ID의 64자리 소문자 SHA-256 hex로 치환한다. 후보 manifest에서 치환을 마친 경로는 절대 경로 문자열이어야 하며, placeholder를 남기거나 caller 입력으로 바꿀 수 없다.

<!-- protected-node-closure-contract -->
```json
{
  "contractId": "ags-protected-node-closure/v2",
  "revision": "2",
  "extends": { "contractId": "ags-vm-protected-host-installation/v1", "revision": "1" },
  "nodeEngine": ">=24",
  "source": "nodejs.org signed versioned release archive",
  "releaseIdInputs": ["contractId", "targetId", "nodeVersion", "archiveSha256Hex", "hostIntegrationSha256Hex"],
  "targets": {
    "windows-x64": {
      "os": "win32",
      "arch": "x64",
      "archive": "node-v<version>-win-x64.zip",
      "installRoot": "C:\\ProgramData\\agent-governance-suite\\protected-runtime\\<releaseSha256>",
      "node": "node.exe",
      "package": "package"
    },
    "linux-x64": {
      "os": "linux",
      "arch": "x64",
      "archive": "node-v<version>-linux-x64.tar.xz",
      "installRoot": "/usr/lib/agent-governance-suite/protected-runtime/<releaseSha256>",
      "node": "bin/node",
      "package": "package"
    }
  },
  "nodeFlags": ["--no-addons", "--no-global-search-paths"],
  "entryPointIds": ["mcp-server", "scope-baseline", "scope-compare", "acceptance-cli"],
  "packagePolicy": "exact-host-integration-manifest-plus-artifacts-no-extra-files",
  "nodeInstallPolicy": "byte-identical-archive-extracted-node",
  "requiredManifestFields": [
    "contractId", "revision", "baseContract", "hostIntegrationSha256",
    "os", "arch", "osBuild", "nodeVersion", "releaseSource", "releaseSha256",
    "installRoot", "nodePath", "packageRoot", "entryPoints",
    "loadedFiles", "measurement", "result"
  ],
  "rejectOn": [
    "unsupported-target", "node-below-24", "unverified-source",
    "unprotected-or-alias-path", "mutable-search-path", "wrapper-or-override",
    "incomplete-loaded-files", "digest-or-identity-mismatch",
    "undeclared-module", "unmeasured-native-addon",
    "extra-package-file", "transformed-node-bytes"
  ],
  "environmentPolicy": "explicit-allowlist-no-node-or-loader-overrides",
  "dependencyPolicy": "measured-loaded-bytes-only",
  "candidateStatus": "CANDIDATE_VERIFIED_LIVE_PENDING"
}
```

`windows-x64`와 glibc 계열 `linux-x64`만 이 revision의 생산 대상이다. Linux musl, ARM, 그 밖의 OS/arch는 지원으로 추정하지 않는다. 배포 archive는 `latest` 별칭이 아닌 정확한 Node release version URL에서 가져오고, 신뢰된 Node release signing key로 검증한 `SHASUMS256.txt`의 archive digest와 실제 다운로드 bytes를 대조한다. 후보 manifest는 정확한 Node semver(major >= 24), URL, archive 파일명·SHA-256, checksum 서명·검증 key fingerprint, 취득 시각, 원본 archive에서 추출한 `node`의 SHA-256, 설치 복사 기록, 설치된 실행 파일 SHA-256, AGS build digest를 기록한다. 설치된 `node` bytes는 archive에서 추출한 `node` bytes와 **완전히 같아야** 하며 변환은 거부한다. 독자 빌드·대체 공급자·musl 전환은 별도 계약 revision이 필요하다. [Node 공식 배포 archive](https://nodejs.org/download/release/latest-v24.x/)에는 OS별 archive와 서명된 checksum이 함께 제공된다. `package.json`의 Node 하한은 `>=24`다.

`releaseSha256`은 `SHA-256(UTF-8(preimage))`의 소문자 hex다. `preimage`는 JSON의 `releaseIdInputs` 순서로 각 값을 ASCII LF(`\n`)로 연결하고 끝에도 LF 하나를 붙인 bytes다. `contractId`는 이 문서의 고정 문자열, `targetId`는 `windows-x64` 또는 `linux-x64`, `nodeVersion`은 선행 `v`가 없는 정확한 semver, 두 `*Sha256Hex`는 `sha256:` 접두사 없는 64자리 소문자 hex다. `archiveSha256Hex`는 서명 검증한 `SHASUMS256.txt`의 해당 OS archive digest, `hostIntegrationSha256Hex`는 신뢰된 AGS release package 안의 **정확한 `host-integration.json` bytes**에 대해 생산자가 독립 계산한 digest다. 각 입력과 계산 결과를 후보 manifest에 기록하고 재계산해 일치시킨다. Node 또는 AGS package bytes가 바뀌면 새 root ID를 사용한다. 임의 JSON 직렬화·경로 문자열·caller 제공 digest를 해시 입력으로 사용하지 않는다.

## 후보 manifest와 보호 실행 경로

현재 V06-c의 공식 manifest는 위 네 진입점만 광고한다. V01-a 소비 계약이 요구하는 `host-attestation-cli`는 현재 공식 manifest에 없으므로 이 revision의 생산 성공으로 주장하지 않는다. 그 진입점이 공식 manifest에 추가되면 closure 목록과 해당 argv를 명시적으로 갱신·재검증한다.

OS별 생산자는 동일한 필수 필드를 채운다. `contractId`, `revision`, V03-i 계약 ID·revision·manifest SHA-256, AGS `host-integration.json` SHA-256, target OS/arch·OS build·libc 종류와 version, release/build/source 증거, installRoot, `nodePath`, `packageRoot`, entry point별 `scriptPath`·`argv`·`executionClosure` digest, 모든 loaded file 목록, 측정 방식·시각·증거 파일 digest, 결과를 포함한다. 각 loaded file 항목은 `kind`(interpreter, OS loader, DLL/ELF, native module, JS/resource), 정규화된 절대 경로, SHA-256, 열린 파일 identity, 소유자·권한·보호 근거, 공급 출처(`vendor-protected` 또는 `os-managed`)를 기록한다. Windows identity는 volume serial과 file ID, Linux identity는 device·inode·mount identity를 포함한다. 파일명이나 서명만으로 bytes와 identity를 대신하지 않는다. AGS package의 정규 파일 집합은 **`host-integration.json` 한 개와 그 `artifacts[].path` 전부와 정확히 같아야 한다**. 각 artifact의 실제 bytes SHA-256을 manifest와 대조하고 추가·누락 파일, 중복·alias 경로, symlink를 거부한다. 진입점·`executionClosure`도 같은 bytes를 확인하며, V06-c의 JS/schema/resource 목록을 OS interpreter·loader 목록으로 오인하지 않는다.

설치 경로는 위 root에서 `node`와 `package`를 결합한 고정 절대 경로다. 예를 들어 Windows의 `nodePath`는 `<installRoot>\\node.exe`, Linux는 `<installRoot>/bin/node`다. `scriptPath`는 `<installRoot>/package/`와 V06-c manifest의 상대 entry path를 결합한다. `C:\\`, `C:\\ProgramData`, `/`, `/usr`, `/usr/lib` 같은 시스템 조상은 기존 owner/ACE를 바꾸지 않는다. 대신 그 조상에 대해 worker·일반 사용자·패키지 작성자가 보호 subtree를 삭제·rename·교체하거나 권한을 바꿀 **실효 권한이 없는지** 검사한다. Windows `C:\\ProgramData\\agent-governance-suite`, Linux `/usr/lib/agent-governance-suite`부터 installRoot와 모든 자식·파일은 installer가 소유하고 같은 교체·쓰기 거절을 충족한다. 이는 V03-i의 최초 보호 subtree와 동등한 추가 실행물 subtree이며 시스템 부모 전체를 installer 소유로 바꾸지 않는다. OS 관리 loader/DLL/ELF를 root 밖에서 읽는 경우에도 실제 경로·bytes·identity·OS build를 후보에 pin하고 동일한 교체 불가를 증명한다. OS 업데이트로 pin이 달라지면 후보를 다시 측정한다. `node_modules`나 package 밖의 JS/module 조회가 관측되면 거부한다.

실행은 shell 또는 `.cmd` wrapper 없이 고정 `nodePath`를 직접 시작한다. 각 entry의 argv prefix는 `[nodePath, "--no-addons", "--no-global-search-paths", scriptPath]`이며, 그 뒤에 오는 요청 파일과 `--input` 같은 데이터 인수는 V01-a/V06-c의 해당 CLI 계약에서만 정한다. Node 옵션, entry path, 실행 cwd, 환경은 caller JSON·`PATH`·작업 트리에서 고르지 않는다. 옵션의 존재와 효과는 **후보의 정확한 Node 빌드에서** 확인한다. Node 문서는 [`NODE_OPTIONS`가 CLI 옵션보다 먼저 적용](https://nodejs.org/api/cli.html#node_optionsoptions)되고 [`--no-global-search-paths`가 전역 module 조회를 중단](https://nodejs.org/api/cli.html#--no-global-search-paths)한다고 명시한다. launcher는 환경을 명시적 allowlist로 구성하고 적어도 `NODE_*`, `LD_*`, `DYLD_*`, `OPENSSL_CONF`, `SSL_CERT_FILE`, `SSL_CERT_DIR`, `PATH`, `HOME`, `USERPROFILE`의 caller 값을 전달하지 않는다. 필요한 비밀·네트워크·locale 값은 별도 보호 host 설정에서만 선택·감사한다.

## 측정·검증 순서와 거절

1. 신뢰 경로에서 V03-i v1 pin과 이 v2 ID·revision, V06-c manifest digest와 정확한 package 파일 집합·artifact bytes, 정확한 OS/arch·Node >=24·archive 서명/checksum을 검증한다. 설치 입력·record가 caller JSON 또는 사용자 쓰기 가능 경로에서 왔다면 중단한다.
2. installer가 보호 root를 만들고 전체 조상·자식의 owner, 실효 ACL/mode, delete-child, reparse/junction/symlink, mount/bind-mount, hardlink 및 교체 가능성을 검사한다. 설치된 `node` bytes가 검증된 archive의 추출 `node` bytes와 같은지도 확인한다. 이미 있는 root는 동일 설치의 identity 증거가 없으면 덮어쓰지 않는다. Windows에서는 열린 handle의 volume/file ID, Linux에서는 no-symlink 디렉터리 핸들 경로 해석과 열린 file identity를 사용한다. race·metadata 조회 실패는 거부한다.
3. 설치된 `node`, entry script, V06-c closure 파일과 Node가 실제 로드한 loader/DLL/ELF/native module·추가 파일의 **전이적 집합**을 후보 실행마다 측정한다. 정적 import·binary dependency 분석만으로 완료하지 않는다. Windows DLL search order의 사용자 쓰기 가능 경로와 Linux `LD_*`/RPATH/RUNPATH/search 경로를 조사하며, 열리거나 mapping된 모든 실행 관련 bytes를 manifest에 결속한다. [`SetDefaultDllDirectories`](https://learn.microsoft.com/en-us/windows/win32/api/libloaderapi/nf-libloaderapi-setdefaultdlldirectories)는 Windows 검색 범위를 제한할 수 있고, [Linux `ld.so` 검색 순서](https://man7.org/linux/man-pages/man8/ld.so.8.html)는 `LD_LIBRARY_PATH`·RPATH·RUNPATH를 포함한다. 실제 적용·로드 관측 없이 설정 이름만으로 통과시키지 않는다.
4. 실행 직전 열린 파일의 identity·SHA-256·보호 권한을 다시 확인하고, 시작한 프로세스의 실제 image와 로드된 파일 identity를 후보 pin에 대조한다. path 문자열만 맞고 열린 객체가 다르거나, 검증과 실행 사이 교체되면 거부한다. 신규 파일 로드·OS 업데이트·실행 옵션 변경 시 후보 측정을 다시 수행한다.
5. 위 검사는 OS별 producer가 자기 target의 실제 archive·격리 package·프로세스에서 실시한다. 생산물 검증의 최대 판정은 `CANDIDATE_VERIFIED_LIVE_PENDING`이다. 운영 설치의 실제 principal, ACL, key/IPC 거절, 제품 종단 호출은 V03-h 등 별도 관측 전까지 `LIVE_PENDING`이다.

대상 밖 OS/arch, Node <24, 미검증 공급·서명, 상대·symlink·reparse 경로, 사용자 쓰기 가능 조상·search path, wrapper, 옵션/env override, 불완전한 loaded file 목록, digest/identity 불일치, `node_modules` 또는 선언 밖 module, 미측정 native addon은 `REJECT`다. 필요한 관측 자체가 불가능하면 `UNKNOWN` 또는 `BLOCKED_CONTRACT`로 남기고 성공으로 승격하지 않는다. native launcher로 바꾸려면 별도 명시적 계약 revision과 생산·검증 Task가 필요하다.
