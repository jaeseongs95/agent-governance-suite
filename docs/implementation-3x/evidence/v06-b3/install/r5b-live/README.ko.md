# V06-b3b-r5b 원시 근거: 새 Linux 후보 host의 첫 보호 runtime 설치

이 디렉터리는 V06-b3b-r5b(spec r37 `4423cde7aa60…`)를 실행한 원시 근거다. 실행 세션은 `cse_01PRna2jKCs5EdTv8Rwv3j83`이고, AREA `1910c26e`(V06_B3B_R5B_CLAUDE_CLOUD) 기준 단일 writer다. r5a 입력을 설치 직전에 다시 검증했다. installer blob `c7b3414e`(8bb6e689 = 4866e455 = base 4017ca95)로 빈 `/usr/lib/agent-governance-suite/protected-runtime/<releaseSha256>`에 처음 한 번 설치했다. 이어서 같은 boot에서 검증과 거절 시험을 했다.

- base: `4017ca9545418c45044a40e6cf67d4a74074ccd4`. ca0aae01(r3-live)은 base의 조상이 아니며 포함하지 않았다.
- branch: `claude/v3x-v06-b3b-r5b-first-install`
- 착수: 2026-09-26T11:30:42Z. 모든 단계가 한 boot `701c96a7-937e-47dd-9a3d-cdfdb92380fc`(btime 1790422227) 안에서 이뤄졌다.

## 파일

| 파일 | 내용 |
|---|---|
| `pre-install.txt` | 설치 직전 재검증: boot, root 프로세스, keyring·SHASUMS·sig·archive sha, gpgv 전문, bin/node, source 소유·mode·symlink·nlink와 0724bb2b blob 일치, scratch-sha256 재검사, installer·의존 모듈 blob, 조상 stat, mountinfo, 대상 부재, manifestFile 부재·no-symlink, uid0 계정 |
| `dpkg-verify.txt` | 설치 전후 `dpkg --verify` 비교 요약(전후 동일). 설치 전 전체 출력(6917줄)은 scratch `/root/r5a/r5b-run/dpkg-pre-full.txt`에 둔다. |
| `install.txt` | CLI 형식 확인(거절), 설치 명령, exit, stdout/stderr, 시각·boot, 출력 sha |
| `driver.mjs.txt` | 설치 driver 원문(sha256 `38905e19…bff8`). installer CLI 블록을 parent manifest 없이 호출한다. |
| `manifest-trace.txt` | strace에서 manifestFile 관련 openat·write만 뽑은 것(496줄 = open 248 + write 248) |
| `manifest.txt` | scratch manifestFile `/root/r5a-out/manifest.txt`의 사본(비밀 검사 후). 원본과 sha256 `e78cb508…2428`이 같다. |
| `post-install.txt` | 설치 직후 검증: manifestFile identity, 최종 코드 verifier·runVerifiedRuntime, inventory, 조상 불변, marker 이후 변경 목록, scratch 유지 |
| `verify.mjs.txt` | 설치 뒤 검증 스크립트 원문(verifyProtectedRuntime + runVerifiedRuntime + manifest 대조) |
| `inventory.tsv` | 설치된 248개 경로의 type·owner·mode·nlink·ino·size·path |
| `installed-sha256.txt` | 설치된 180개 파일의 sha256(bin/node + package 179개) |
| `reject-tests.txt` | nobody(65534)의 create·open·rename·chmod·rm 시도 거절과 mount 교체 거절(private namespace) |
| `HANDOFF-draft.ko.md` | handoff 초안 |
| `SHA256SUMS` | 이 디렉터리 파일 전체 |

## 요약

- 재검증 결과는 모두 pin과 같다. 항목: keyring `140f2ad5…`, gpgv VALIDSIG `5BE8A3F6…`, archive `fd8e59d5…`, bin/node `7fde7b8a…`, source 0724bb2b(1620개 파일 blob 일치, g/o 쓰기·symlink·비root·nlink>1·special 0개), host-integration `648dddda…`, installer·release·stage 모듈 blob, umask 0022, `/`·`/usr`·`/usr/lib` root 755 단일 ext4 mount(bind 없음), 대상 부재, manifestFile 부재, scratch 1631개.
- 설치 exit 0, 출력 `CANDIDATE_HOST_INSTALLED`. releaseSha256은 `32a825d9…8edd`이고 bin/node ino 524293, 0555, nlink 1이다. package 파일은 179개이고, runVerifiedRuntime `--version` 결과는 v24.21.0이다.
- manifestFile `/root/r5a-out/manifest.txt`: regular, root, 0600, nlink 1, dev 65024, ino 1671184, 248줄(dir 68, file 180).
  - strace에서 248회 기록마다 같은 경로를 `O_WRONLY|O_CREAT|O_APPEND, 0600`으로 새로 열었고 O_TRUNC는 없었다.
  - 쓴 주체는 설치 pid 하나뿐이다. 설치 중 unlink·rmdir·rename syscall은 0이다.
- 생성 경로는 `/usr/lib/agent-governance-suite` 아래 248개이며 manifest 목록과 정확히 같다(INVENTORY_EQUALS_MANIFEST).
  - 디렉터리 68개는 root 755다.
  - 파일은 bin/node가 root 555 nlink 1이고, package 179개가 root 444 nlink 1이다.
- 조상 `/`, `/usr`, `/usr/lib`는 owner·mode·ino와 mount가 같다. `/usr/lib`의 ctime은 하위 항목이 추가돼 바뀌었다. host mountinfo sha는 전후 `ca88d4a2…`로 같다.
- 거절 시험:
  - nobody의 쓰기·rename·chmod·rm 14건이 모두 거절됐다.
  - mount 교체는 private namespace 안에서 세 방식을 시험해 verifier가 모두 거절했다: package에 bind, bin에 tmpfs, `/usr/lib`을 자기 자신에 bind(ancestor bind). `/usr/share`를 `/usr/lib`에 덮은 시험은 loader가 실패해 판정 불가로 기록했다.
  - 시험 뒤 정상 검증은 다시 OK였다.
- `dpkg --verify` 설치 전후 출력이 같다. `/usr/share` 문서 누락과 `/etc/sudoers` conffile 변경뿐이고, 실행 파일 불일치는 0건이다.

## 명세·r5a 입력과의 차이

- r5a `r5b-inputs.txt` 4절의 명령은 `--parent-manifest`를 생략했다. 그러나 installer CLI는 이 옵션을 필수로 요구하므로, 인수 검사 단계에서 host 접근 전에 exit 1로 거절된다(install.txt 1절).
- 첫 설치에는 신뢰 pin(857bad43)이 붙은 parent manifest가 없다. 그래서 명세의 "parent manifest 미사용"을 따랐다. installer 모듈의 CLI 블록(631-645행)을 `parentManifestFile: undefined`로 그대로 호출하는 driver로 설치했다. 설치·검증 로직은 모두 installer 모듈(blob c7b3414e)의 것이고, driver에 새 설치 로직은 없다.
- 설치 입력 디렉터리 `/root/r5a/r5b-in`(root 0700)은 r5a scratch 아래에 새로 만들었다. `pubring.kbx`를 CLI가 요구하는 이름 `nodejs-release-keyring.kbx`로 복사했고, 네 파일의 sha가 pin과 같다(pre-install.txt 뒤 install 단계).

## 신뢰 가정과 한계

- 임의 root 경합은 신뢰 가정으로 둔다. 설치 시점의 root 사용자 프로세스는 다음과 같다. 추가 root writer는 관측되지 않았다.
  - 플랫폼 `process_api`, `environment-manager`
  - 이 세션의 `claude`와 그 자식 셸
  - 이 세션이 띄운 AGS MCP 서버 `node mcp-server/dist/server.mjs`
- r5a 이력: 2026-09-25 10:06Z에 이 host에서 root로 `pnpm install --frozen-lockfile`(esbuild postinstall 포함)이 실행됐다. 그래서 이번에 모든 입력을 다시 계산했고, `dpkg --verify`로 시스템 패키지 파일을 대조했다. 작업 트리의 `node_modules`는 설치와 검증에 쓰지 않았다. installer는 node 내장 모듈만 import한다.
- 구 VM의 두 root와 manifest, `/root/b3bf/r3`는 이 host에 없다(`/root/b3bf` 부재). 불변 여부는 이 host에서 관측할 수 없다. r1-live·r3-live·r5a-live는 이 commit에서 바꾸지 않았다.
- 한 후보 host의 설치 PASS는 운영 host 적격이 아니다. 최신 verifier(4017ca95)가 수용했다고 해서 최신 installer가 생산했다고 주장하지 않는다(이번에는 두 blob이 같다). lineage 최종 판정은 r6가, 공식 감사는 df73d3b5가 한다.
- disk 새로 만들기·보안 삭제, loader closure 측정(V06-b3c)은 범위 밖이다.
- scratch 원본(`/root/r5a-out/manifest.txt`, `/root/r5a/r5b-run/`의 strace.txt·install.stdout·dpkg-pre-full.txt)은 그대로 보존한다.

## 검사

- `git diff --check`: 미추적 파일마다 `git diff --no-index --check /dev/null <file>`로 실행했고 모두 통과했다. 줄 끝 공백과 파일 끝 빈 줄은 지웠다.
- 비밀 grep `grep -rniE 'token|authorization|set-cookie|password|secret|sk-' r5b-live/`: 걸린 줄은 모두 오탐이다.
  - `manifest.txt`, `manifest-trace.txt`, `inventory.tsv`, `installed-sha256.txt`(각 28·28·28·17줄): 설치 package의 경로 이름(`task-envelope`, `task-contract`, `codex-token-usage-analyzer`, `mutation-risk-preflight` 등)이 걸렸다.
  - `pre-install.txt` 1줄: ps의 `environment-manager task-run` 인수가 걸렸다. ps 출력은 160자로 잘랐다.
  - README와 HANDOFF: 이 설명 문장이 걸렸다.
  - 인증 비밀과 proxy 값은 없다.
- `sha256sum -c SHA256SUMS`: 전부 OK
- manifest 사본과 scratch 원본의 sha256이 `e78cb508…2428`로 같다.
