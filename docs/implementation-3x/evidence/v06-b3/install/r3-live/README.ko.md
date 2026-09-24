# V06-b3b-r3 Linux 원시 근거 (r4 최종 코드 결속)

이 디렉터리는 r4 최종 커밋 `8bb6e6891bf25a5ddf9593def7468779616d3866`(tree `e6db3967…`)의 clean 작업 트리로, 후보 host 한 대에서 다시 실행한 원시 출력이다. 대상은 보존된 v2 root `32a825d9…`와 legacy root `fd8e59d5…`다. 통합 기준은 `4866e45501227624d1e625470453ef8ce018bb9b`이며, installer blob `c7b3414e…`가 두 SHA에서 같다(`provenance.txt`). 사전 점검은 "기록한 값"으로만 적는다(`preflight.txt`). 이 README와 보고는 사전 점검 PASS나 Task 완료를 주장하지 않는다.

## 실행 기록

- boot_id `2c428abc-c358-4e63-b650-c7bb78cadfbe`(전 구간 같음), model `claude-opus-5-5`, effort `high`(get_session 기록은 `preflight.txt` 참고)
- 사전 점검 20:52:38Z → 근거 생성 20:54Z(`/root/b3bf/r3/ev.sh`) → 비밀 검사와 공백 정리 20:55Z
- **멈춤 구간**: 20:56:15Z부터 20:59:34Z까지(팀장 일시 중지 지시). 이 구간에는 읽기 전용 재조회만 했다. 재개 때 같은 재조회를 다시 했다(`preflight.txt` §3~4).
- 재개 뒤 추가·변경:
  - `preflight.txt`, `README.ko.md`, `SHA256SUMS`를 새로 만들었다.
  - `install-manifest-r1.txt`와 `parent-manifest-b3b.txt`의 파일 mode를 0600에서 0644로 바꿨다(복사 때 원본 0600이 따라옴). 내용은 바꾸지 않았다.
  - 다른 근거 파일은 다시 만들지 않았다.

## 파일별 생성 명령 (모두 `/root/b3bf/r3/ev.sh`에서 실행. 각 명령의 exit는 파일 안 `exit=N`)

| 파일 | 생성 방법 | 가공 |
| --- | --- | --- |
| provenance.txt | date, boot_id, uname, os-release, id, CapEff, findmnt(PROPAGATION), protected_hardlinks, node, git rev-parse·ls-remote·fetch·merge-base·blob·sha256·diff --stat | 줄 끝 공백 |
| release-id.txt | preimage `printf`를 `od -c`와 `sha256sum`에 넘김, `ls protected-runtime` | 줄 끝 공백 |
| checksums.txt | sha256sum(archive, SHASUMS, sig, keyring, 추출 node, R/bin/node, R/package/host-integration.json), git blob 0724bb2b, gpgv GOODSIG·VALIDSIG, SHASUMS archive 줄 | 줄 끝 공백 |
| inventory.tsv | 조상 5개는 `stat`, R 아래는 `find . \| sort` 한 줄마다 `stat` + 파일이면 `sha256sum`, 끝에 TOTAL(find 수) | 없음 |
| package-set.txt | artifacts+host-integration 목록과 `find R/package -type f`의 정렬 diff, `sha256sum -c --quiet`, 불일치 수. 마지막 `grep -vc`는 0건일 때 exit 1이다(불일치 0). | 줄 끝 공백 |
| lineage.txt | 두 manifest sha·크기·줄 수·내용, c584e0a4, 0724bb2b tree, `diff -rq r1/src r3/src0724`, source 조상 mode, group/other 쓰기·비root·symlink 수, 최종 코드의 `readPackageSource`·`readTrustedParentManifest`(`lineage-check.mjs`, 쓰기 없음) | 없음 |
| install-manifest-r1.txt, parent-manifest-b3b.txt | `/root/b3bf/r1/manifest.txt`, `/root/b3bf/manifest.txt` 원문 복사(잘라내지 않음) | mode만 0644 |
| verify-final.txt | `verify-final.mjs`: 8bb6 코드로 v2·legacy root 읽기 전용 verify와 verified use `--version` | 줄 끝 공백 |
| mount-boundary.txt | A(`mountA.mjs`, fixture `/root/b3bf/r3/fx`), B(`mountB.mjs`, 실제 R/bin에 decoy bind), C(r4 테스트, fixture+live). 모든 mount는 `unshare --mount --propagation private` 안에서만 했다. 전후 host mountinfo와 두 root ino·ctime을 적었다. | 줄 끝 공백 |
| nobody-probe.txt | `setpriv --reuid=65534 --regid=65534 --clear-groups`로 create 6, 쓰기 open 3, rename 4, hardlink 1, `unshare --mount`, `mount --bind`, CLI 실행 | 줄 끝 공백 |
| live-test.txt | live 읽기 전용 env로 r4, r2, r1, b3b vitest(재설치 없음) | 줄 끝 공백 |
| invariance.txt | baseline과 작업 뒤 값 비교(diff) | 없음 |
| r1-live-recheck.txt | r1-live 초안 8개의 sha256과 r3 대응 파일 diff 요약(초안은 커밋하지 않음) | 요약 문구 편집, 줄 끝 공백 |
| preflight.txt | baseline 원문·sha·명령, get_session 선택 필드, 20:56:15Z와 20:59:34Z 재조회, gate 문장 | 없음 |

- 줄 끝 공백과 EOF 빈 줄만 지웠다(`git diff --check` 통과용). 원본과 저장본 sha256:
  - checksums.txt original=5a07e084371b9933aaa079de39073fe192f3b29ea55ac802b2db9a0e752fee33 saved=147d1c84668856cd5bae908a78fc691ed897e1b1bfcddfe25fcda5c184c7455a
  - live-test.txt original=7de0aba73de20766c8371791342c16556e3d373b7efd59692f536fc8e203aa6a saved=4bc9acb5e12b02da82e0f68175f050da0dd626e395a86fab6d6190727a09d36a
  - mount-boundary.txt original=85a38dd17f8f15a7ca734b7519cf77f5c46bc222deb2d4baf48e815c875d9163 saved=189996a606d662f20557e64ae695302946d412976c00da0e235dfb1562cf25d7
  - nobody-probe.txt original=ead4dca650f4b8366bd0a1fafb7537410e80db17f69291d3e18053357b50ba66 saved=7d781d2928cf9519afa27c7650bcdc654e87b611d4d7d4ad3f6b659c4409faa7
  - package-set.txt original=35df2e1e5cfae50e7509290089ffa10b33c0c73e8616d64af7bacd08d3989f9d saved=a78901c5a75ac09dc29fba5cadd89cf227d93b61127bb36ab5365e602af1e0b5
  - provenance.txt original=05f2b6dcb03d8c0b963e98d0bf466a2acc1d7436beb9d1590ec45f0a4c115c34 saved=9de33220d9606b29ad17ebd5e053a3eaeefddab52cbfbc195569280f83f48dbf
  - r1-live-recheck.txt original=d5333947c3c2967e49b9d4f2c49fc21603d5289ab9c9d52935024f604a5b78c6 saved=830aec9f3b98b396a4dab48553ae0a7547123b728350fe37250297a1885c578f
  - release-id.txt original=3c7cb7fad2dd22f9f60eb8335bb03644ea7eb1a95c186952d0c28b719846df78 saved=9894b2d08728cce9a9f7c81f06903ba6c637974a094267237aba41f2b54a9da6
  - verify-final.txt original=faa24465a3eec9549cfda6c914a2b9eba7e1ac82d832c1362b35d06c0a37ddd9 saved=1b6edb0175a65e39cb390c778c6c3f50012eeb275318d4ca0d3df64ceeefee6f
- 가공 없는 원 출력은 `/root/b3bf/r3/`의 스크립트로 다시 만들 수 있다.

## 비밀 검사

- 패턴 `ghp_|github_pat_|gho_|sk-|xox[bp]-|AKIA|BEGIN .*PRIVATE|Authorization|Bearer|password|secret|token|api[_-]?key`(대소문자 무시)로 검사했다. 결과는 56줄이고, `inventory.tsv`와 `install-manifest-r1.txt`에만 있다.
- 모두 오탐이다. `task-envelope`·`task-contract`·`mutation-risk-preflight`의 `sk-`와, 스킬 이름 `codex-token-usage-analyzer`·`token-usage-*`의 `token`이다. 이 경로명 패턴을 빼면, 재개 뒤 만든 파일에서 오탐 3줄이 더 나온다. 이 README의 패턴 줄 자체와, `preflight.txt` 재개 재조회의 `ls` 출력에 나온 작업 파일명 `secret-class.txt`·`secret-grep.txt` 2줄이다. 비밀 값은 0건이다.
- `env`, `git remote -v`, 원격 자격 증명, 세션 토큰은 넣지 않았다. 경로는 컨테이너 작업 경로 `/home/user/agent-governance-suite`와 `/root/b3bf` 아래만 나온다.

## 증거의 한계

- 후보 host 한 대(firecracker VM)의 관측이다. 운영 host 적격성, V06-b3c loader closure, r2 소급 완료, 원 V06-b3b 완료를 주장하지 않는다.
- `32a825d9…` root는 c584e0a4 코드(r1)로 16:51Z에 설치했다. 최종 코드(8bb6e689)로 재설치하지 않았고, 최종 코드로는 읽기 전용 검증과 사용만 했다.
- 설치 당시 source `/root/b3bf/r1/src` 안에는 group 쓰기 비트 항목이 1991개 있었다. 조상 4곳은 700이었다. 최종 코드의 source 검사는 이 source를 거절하고(`lineage.txt`), 같은 bytes를 umask 022로 다시 푼 `/root/b3bf/r3/src0724`는 받아들인다. 이 lineage가 계약 수용에 충분한지는 감사자와 총괄이 판단한다.
- manifest는 path, ino, type, uid, mode만 기록한다. installer·source·parent 필드는 없다.
- B 사례의 decoy bind는 private namespace 안의 R/bin에만 적용됐다. namespace 밖 host mountinfo와 root ino·ctime은 전후가 같다.
