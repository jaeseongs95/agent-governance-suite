# V06-b3b-r5a 원시 근거: 새 Linux 후보 host의 신뢰 입력 준비

이 디렉터리는 V06-b3b-r5a(명세 r41, spec sha `ba9aef5e…502c`)를 새 격리 Claude cloud writer `session_01PRna2jKCs5EdTv8Rwv3j83`에서 실행한 원시 근거다. 목적은 네 가지다.

- keyring 403의 원인을 판별한다.
- 서명 검증된 Node archive, AGS release `0724bb2b` source, V03-i/v2/V06-c pin을 root 전용 scratch에 준비한다.
- 첫 설치 전 상태를 읽기 전용으로 고정한다.
- r5b가 다시 확인할 입력과 중단 조건을 남긴다.

- base: `0f5306154dfb987f35c215322354f6e10cc8c4b3` (tree `a38ff77d…`)
- branch: `claude/v3x-v06-b3b-r5a-trusted-input`
- writer 근거: 총괄 GO `claude-main-go-v06b3b-r5a-to-devlead-20260925-01`, AREA `f9f49211` V06_B3B_R5A_CLAUDE_CLOUD
- 착수: 2026-09-25T09:50:24Z

## 파일

| 파일 | 내용 |
|---|---|
| `session-host.txt` | 모든 턴(09:20, 09:25, 09:43, 09:50, 09:58Z)의 date·boot·btime·uptime, hostname·machine-id·uname·CapEff·mount, get_session 필드. fs UUID는 미관측이다. |
| `keyring-403.txt` | A1~A6 요청의 원시 헤더·본문·시각과 가설 판정표 |
| `k1-node.txt` | K1 keyring 헤더·크기·sha, SHASUMS·sig·archive 다운로드, gpgv 출력 전문, archive sha와 SHASUMS 행, 추출 bin/node sha와 pin |
| `source.txt` | `0724bb2b` source 생성 명령, umask, 조상·src stat, 개수 검사, host-integration sha, 파일 집합 비교, releaseIdV2 preimage와 결과 |
| `pins.txt` | V03-i·v2·V06-c pin 표(경로·hash·owner·mode·nlink·symlink), 코드 상수 줄 번호, 계약 필드 대조, Node·keyring pin |
| `installer-blob.txt` | 8bb6e689·4866e455·0f530615의 installer blob과 조상 관계 |
| `preinstall-state.txt` | 빈 보호 subtree, /usr 쓰기 가능 범위와 mount 경계, parent manifest 부재, manifestFile 경로 사전 점검 |
| `persistence.txt` | 턴별 boot 변화와 2단계a·2단계b 재확인(sha256sum -c, 목록 sha) |
| `old-vm.txt` | 구 VM(012TH) 관측 원문(개발팀장 전달)과 신 host 대조 |
| `handover.txt` | writer 이양 근거. 012TH 원문, 09:58Z 이양 동의, 신 writer 확인 |
| `scratch-sha256.txt` | `/root/r5a/scratch-sha256.txt` 사본(1631줄, sha256 `8c0c1f60…6b41`) |
| `r5b-inputs.txt` | r5b가 다시 확인할 고정 입력·identity·명령과 중단 조건 |
| `checks.txt` | 저장소 검사(validate-repository, check-source-lock, check-bundle) 명령과 결과 |
| `HANDOFF-draft.ko.md` | handoff 초안. 개발팀장이 공식 경로로 옮긴다. |
| `SHA256SUMS` | 이 디렉터리의 다른 파일 전체의 sha256 |

binary, archive, src tree(`pubring.kbx`, `node-v24.21.0-linux-x64.tar.xz`, `SHASUMS256.txt.sig`, `/root/r5a/src`, `/root/r5a/node`)는 넣지 않고 sha만 기록했다.

## 요약

- 403 원인: Claude cloud proxy의 세션별 GitHub repo allowlist다. `github.com/<repo>/raw`와 `codeload.github.com`은 nodejs/release-keys에 403 JSON("GitHub access to this repository is not enabled for this session")을 돌려준다. 같은 commit·경로를 `raw.githubusercontent.com`으로 요청하면 200이다. URL 오류와 네트워크 가설은 배제됐다.
- K1: 21011 bytes, sha256 `140f2ad5…5932`로 pin과 같다.
- Node v24.21.0: gpgv GOODSIG, VALIDSIG `5BE8A3F6C8A5C01D106C0AD820B1A390B168D356`. archive `fd8e59d5…` == 서명된 SHASUMS 행 == 코드 pin이다. 추출 bin/node `7fde7b8a…`도 pin과 같다.
- AGS source: `/root/r5a/src`, root 700 조상 체인, 파일 1620개·디렉터리 372개. g/o 쓰기·symlink·비root·nlink>1은 모두 0개다. host-integration `648dddda…`가 pin과 같고, artifact 178개 digest가 모두 일치한다.
- pin: V03-i `0c5bfc70…`와 V06-c `648dddda…`가 일치한다. v2는 코드에 bytes hash pin이 없어, 계약 블록 필드가 코드와 일치하는지로 대조했다.
- installer blob: 세 ref 모두 `c7b3414e…`로 같다.
- 설치 전: `/usr/lib/agent-governance-suite`는 없다. `/usr`는 `/`와 같은 fs(/dev/vda ext4)이고 root가 쓸 수 있다. parent manifest는 없다.
- manifestFile: `/root/r5a-out/manifest.txt`는 없다. 조상 `/`(755) → `/root`(700) → `/root/r5a-out`(700)이며 모두 root이고 symlink가 아니다.
- 지속성: boot가 턴마다 바뀌었지만(09:43, 09:50, 09:58Z) 디스크는 유지됐다. 2단계a에서 scratch 1631개 파일이 bytes 단위로 같았다.

## 검사

- `git diff --check` 대응: 미추적 파일마다 `git diff --no-index --check /dev/null <file>`을 실행했고 모두 통과했다.
  - 원시 HTTP 헤더 줄(`HTTP/2 200 `, `Access-Control-Allow-Origin: ` 등)의 줄 끝 공백과 파일 끝 빈 줄은 지웠다. 값은 바뀌지 않았다.
- 비밀 grep `grep -rniE 'token|authorization|set-cookie|password|secret|sk-' r5a-live/` 결과는 모두 오탐이다.
  - `scratch-sha256.txt`: `task-`, `risk-`, `codex-token-usage-analyzer` 같은 source 파일 경로가 걸렸다.
  - `keyring-403.txt`, `k1-node.txt`: `Set-Cookie: <redacted>`(값은 가림), 응답 헤더 `Vary: Authorization,Accept-Encoding`(헤더 이름뿐), 설명 문장의 "Set-Cookie"가 걸렸다.
  - proxy 값은 `<redacted>`로 가렸다. 이 디렉터리에 인증 비밀은 없다.
- 저장소 검사(`checks.txt`, Node v24.21.0):
  - 2단계a: `check-source-lock`은 PASS였다. `validate-repository`와 `check-bundle`은 `node_modules`가 없어 FAIL_UNRELATED였다(`ajv`와 `esbuild` import 실패).
  - 2단계b: 개발팀장 허용에 따라 `PATH=/root/r5a/node/bin:$PATH pnpm install --frozen-lockfile`을 실행했다. lockfile과 추적 파일은 바뀌지 않았다. 이어서 `validate-repository`("repository: valid"), `check-source-lock`, `check-bundle`이 모두 exit 0으로 PASS다.

## 주장 범위와 한계

- 보호 subtree 설치, 재설치, rollback을 하지 않았다. `/usr` 아래에 새 경로를 만들지 않았고 manifestFile도 만들지 않았다.
- 운영 host 자격이 아니다. hostname(`vm`)과 machine-id는 구 VM과 같은 공통값이고, fs UUID는 관측되지 않았다. 신·구 host 구별은 보호 subtree 유무와 동시 관측(old-vm.txt)에 근거한다.
- r5a PASS는 r5b 설치 적격이나 lineage ACCEPT를 뜻하지 않는다. r5b는 `r5b-inputs.txt`의 모든 값을 설치 직전에 다시 계산해야 한다.
- 세션 지속성의 보존 기한은 불명확하다. get_session에 persist/retention/expires 필드가 없다.
- 구 VM 관측(old-vm.txt)과 이양 원문(handover.txt)은 개발팀장이 전달한 내용이다. 이 세션이 직접 관측한 값이 아니다. 012TH는 09:58:58Z에 cse_01PRna2jKCs5EdTv8Rwv3j83로의 이양에 동의했다.
- K2(add_repo)는 조회만 했고 호출하지 않았다. K3는 실행하지 않았다.
