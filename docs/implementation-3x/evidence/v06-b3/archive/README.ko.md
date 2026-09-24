# V06-b3a Linux Node 24 서명 배포본 검증 증거

이 디렉터리는 `ags-protected-node-closure/v2`(V06-b1, `docs/implementation-3x/protected-node-closure-v2.ko.md`)의 `linux-x64` 대상에 대해, **서명된 nodejs.org 배포 archive 검증만**을 다룬 V06-b3a leaf의 실제 실행 증거다. 보호 설치, ELF loader closure 측정, 운영 host 적격성은 이 leaf의 범위가 아니며 여기 기록된 어떤 결과도 그런 자격을 주장하지 않는다. 최대 상태는 `CANDIDATE_VERIFIED_LIVE_PENDING`이다.

## 실행 환경

- 2026-09-24, Ubuntu 24.04.4 x86_64, root 컨테이너 host(네이티브 Linux, 에뮬레이션 아님).
- 기본 `/opt/node22`는 Node v22.22.2이며 이는 이 leaf의 Node 24 근거가 아니다. 아래에서 검증한 archive에서 추출한 `bin/node`로 별도 관측했다.

## 입력 출처와 검증 (실제 배포본, 2026-09-24 실행)

- Node 버전: 정확한 `24.21.0` (2026-09-24 시점 `https://nodejs.org/dist/index.json`의 최신 v24 release). `latest`/`latest-v24.x` 별칭 URL은 사용하지 않았다.
- Archive URL: `https://nodejs.org/dist/v24.21.0/node-v24.21.0-linux-x64.tar.xz` — `scripts/qualification/v06-b3-linux-release.mjs`의 `assertVersionedArchiveUrl`로 정확한 버전·arch·OS·`https://nodejs.org/dist/v<version>/` 경로 형태를 강제했다.
  - Archive SHA-256(다운로드 bytes, 서명된 `SHASUMS256.txt` 항목과 일치): `fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6`.
- 서명된 checksum: [`SHASUMS256.txt`](https://nodejs.org/dist/v24.21.0/SHASUMS256.txt) SHA-256 `f410428039e2c922a14058df067a4482691c9304a5c01a75847f9f3f2d3307f6`, [detached 서명](https://nodejs.org/dist/v24.21.0/SHASUMS256.txt.sig) SHA-256 `865f22b026e4080554e10d247553fd770573893dac8fc7affc7d58b72de35a89`.
- [Node release keyring](https://github.com/nodejs/release-keys) `git clone --depth 1`(HTTPS, git 프로토콜) 후 commit `481637f813e912c4aa3622d7964ab426c97b8e8d`의 `gpg-only-active-keys/pubring.kbx`, SHA-256 `140f2ad5260fd62773b6243ce8e1d3009645d558f121b8262c55e383dc285932`(같은 디렉터리의 `trustdb.gpg`도 함께 받았으나 `gpgv` 자체는 사용하지 않음).
  - `gpgv --status-fd 1 --keyring ./nodejs-release-keyring.kbx ./SHASUMS256.txt.sig -` (stdin = 읽은 `SHASUMS256.txt` bytes) 실행 결과 `[GNUPG:] VALIDSIG 5BE8A3F6C8A5C01D106C0AD820B1A390B168D356 2026-09-08 ...`와 `gpgv: Good signature from "Antoine du Hamel <antoine.duhamel@platformatic.dev>"`를 반환했다. 이 fingerprint는 `keys.list`의 활성 release key 목록에 있다.
- 검증 도구: 컨테이너 Debian 패키지 `gpgv`(GnuPG) 2.4.4, `/usr/bin/gpgv` SHA-256 `097b577cdf8b51dcc1fb42417d5ef3ca2e22b36a8ad16c9df4bd083a38fe476c`; `/usr/bin/tar` SHA-256 `6453fce2cf2dde32b86557bb44f533afb3b5171b59b8d21cc797b9b20d9c7b06`. 이 pin은 이 host의 gpgv/tar 패키지 bytes에 한정되며 OS 업데이트 시 재측정이 필요하다(계약 §"측정·검증 순서" 4).
- Archive에서 추출한 `bin/node`(entry `node-v24.21.0-linux-x64/bin/node`) SHA-256: `7fde7b8afa198da66257f42ee2001d874c7355631e6d1579a5fb5ef1f246df4c`. 이 파일을 `--no-addons --no-global-search-paths --version`으로 직접 실행하면 `v24.21.0`을 출력해 Node >=24를 관측했다. 이 추출·실행은 사용자 쓰기 가능 임시 디렉터리에서 한 관측일 뿐이며 보호 설치가 아니다.

## 재현

정확한 네 입력 파일(`node-v24.21.0-linux-x64.tar.xz`, `SHASUMS256.txt`, `SHASUMS256.txt.sig`, `nodejs-release-keyring.kbx`)을 별도 입력 디렉터리에 두고 다음을 실행한다.

```text
node scripts/qualification/v06-b3-linux-release.mjs \
  --input-dir <input-dir> --version 24.21.0 --gpgv /usr/bin/gpgv \
  --keyring-sha256 140f2ad5260fd62773b6243ce8e1d3009645d558f121b8262c55e383dc285932
```

CLI는 URL 검증과 서명·digest 검증을 통과하면 `CANDIDATE_VERIFIED_LIVE_PENDING` 상태의 JSON 요약을 표준출력에 쓴다. 위 명령을 이번 실행에서 실제로 실행했고 출력은 다음과 같다.

```json
{"contractId":"ags-protected-node-closure/v2","target":"linux-x64","status":"CANDIDATE_VERIFIED_LIVE_PENDING","nodeVersion":"24.21.0","archiveUrl":"https://nodejs.org/dist/v24.21.0/node-v24.21.0-linux-x64.tar.xz","archiveName":"node-v24.21.0-linux-x64.tar.xz","archiveSha256":"fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6","signerFingerprint":"5BE8A3F6C8A5C01D106C0AD820B1A390B168D356","limitations":["signed-release-verification-only","no-protected-installation","no-elf-closure-measurement"]}
```

원본 archive, 서명, checksum, keyring 파일은 용량과 재배포 관례 때문에 Git에 커밋하지 않는다. 재현하려면 위 공식 입력을 새로 받아 동일한 검증을 수행한다.

## 집중 검사 (네트워크 없이 재현 가능한 거절 사례)

`tests/coordinate-subagents/v3x/V06-b3a.test.mjs`는 아래를 합성 fixture로 검증한다(실제 배포본 증거로 승격하지 않음).

- `latest`/`latest-v24.x` 별칭 URL, 버전 불일치, arch(`linux-arm64`) 혼동, OS(`win-x64`, `darwin-x64`) 혼동, `http://`, 다른 host, 확장자 조작 URL을 모두 거부.
- 서명된 checksum 항목의 누락·중복을 거부.
- archive bytes가 서명된 digest와 다르면 거부.
- keyring bytes가 pin과 다르면 거부.
- keyring, `SHASUMS256.txt`, `SHASUMS256.txt.sig`가 없으면 gpgv 실행 전에 `required release input missing: <파일명>`으로 거부.

`AGS_V06_B3A_INPUT_DIR`, `AGS_V06_B3A_GPGV`, `AGS_V06_B3A_VERSION`, `AGS_V06_B3A_KEYRING_SHA256`(및 `bin/node` 관측용 `AGS_V06_B3A_TAR`) 환경변수가 설정되면, 같은 파일 집합에 대해 위 "재현" 절의 실제 서명된 입력을 사용해 각 파일(서명, checksum, archive, keyring)을 한 byte씩 변조하거나 잘못된 버전을 지정했을 때 모두 거부하는지, 그리고 검증된 archive에서 추출한 `bin/node`가 정확히 pinned version을 보고하는지 추가로 확인한다. 같은 게이트에서 네 입력 파일을 하나씩 지우면 각각 부재로 거부하는지, 그리고 서명 키가 없는 keyring(임시 GNUPGHOME에서 새로 만든 무관한 키만 담은 keyring, 빈 keyring)에서 `gpgv`가 `NO_PUBKEY 20B1A390B168D356`을 내고 스크립트가 `signature invalid or signer untrusted`로 거부하는지도 확인한다. 이번 실행에서는 이 네 환경변수를 모두 설정해 실제 서명된 배포본으로 이 테스트를 실행했고 통과했다(아래 검증 로그 참고).

## NOT_OBSERVED / 범위 밖

- Docker, ARM(linux-arm64/musl), Windows는 이 leaf에서 관측하지 않았다(Windows는 V06-b2a에서 별도로 다룸).
- ELF loader/공유 라이브러리 전이적 closure 측정, `patchelf`, 보호 root 설치, 운영 host 적격성은 이후 leaf(b/c/d)의 범위이며 이 leaf는 주장하지 않는다.
- `host-integration.json` 작성이나 AGS package 파일 집합 검사는 이 leaf의 대상 파일에 없으므로 수행하지 않았다(V06-b2a의 `inspectPackage`에 해당하는 단계는 범위 밖).
