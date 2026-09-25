# TASK_V06-b3b-r5a handoff (초안)

- **TASK_ID**: V06-b3b-r5a (새 Linux 후보 host의 신뢰 입력 준비)
- **결과**: 입력 준비와 설치 전 점검을 마쳤다. 830e4628은 자체 fresh 감사 PASS였으나 cloud 사전 감사(cse_01RCednP)에서 BLOCKED(B1 이양 원문)를 받았다. 보완 commit에서 012TH run log 원문, N1 재확인, 403 미확인 문구를 추가했다. 새 cloud 사전 감사는 개발팀장이 따로 돌린다.
- **브랜치**: `claude/v3x-v06-b3b-r5a-trusted-input`, 시작 SHA `0f5306154dfb987f35c215322354f6e10cc8c4b3`(tree `a38ff77d19e4cd824b5b1916c8d8450430017dcb`)
- **최종 SHA/tree**: 2단계b commit 뒤에 채운다. 이 handoff는 자기 커밋 SHA를 담을 수 없으므로 세션 최종 보고에 적는다.
- **writer**: `session_01PRna2jKCs5EdTv8Rwv3j83`(claude-opus-5-5/high), AREA `f9f49211`. 구 writer `session_012THvfNVip1GR1zpH8MEUaV`는 2026-09-24T21:44:18Z부터 쓰기를 중지했다.

## 수행 작업

1. 403 원인 판별(A1~A6, 경로별 1회): repo allowlist와 세션 권한이 지지됐고, URL 오류와 네트워크는 배제됐다.
2. K1 keyring을 `raw.githubusercontent.com`에서 1회 받았다. sha가 pin `140f2ad5…`와 같다.
3. nodejs.org v24.21.0 SHASUMS·sig·archive를 각 1회 받았다. gpgv VALIDSIG `5BE8A3F6…`를 확인했고, archive와 bin/node가 pin과 같다.
4. `git -c tar.umask=022 archive 0724bb2b`로 root 전용 `/root/r5a/src`를 만들었다. owner, mode, symlink, digest, pin을 검사했다.
5. installer blob 세 ref가 같은지, 설치 전 상태, manifestFile 사전 점검을 읽기 전용으로 기록했다.
6. boot가 바뀐 뒤 scratch 해시를 다시 대조해 디스크 유지를 확인했다.

## 변경 파일

- `docs/implementation-3x/evidence/v06-b3/install/r5a-live/` 아래 새 파일만 만들었다. 목록은 README.ko.md에 있다.
- 제품 코드(scripts, tests, src), r1-live, r3-live는 변경하지 않았다.
- 저장소 밖 쓰기:
  - `/root/r5a`: scratch, src, node 추출, 검사 로그, pnpm-install.log
  - 작업 트리 `node_modules/`: 2단계b 검사용. gitignore 대상이다.
  - `/root/r5a-out`: 빈 0700 디렉터리
  - `/usr`와 manifestFile에는 쓰지 않았다.

## 검증 결과

| 항목 | 결과 |
|---|---|
| 403 원인 | 관측됨 (allowlist와 세션 권한) |
| K1 | PASS (sha 일치) |
| Node 서명·archive·bin/node | PASS |
| AGS source (root, umask 022, g/o 쓰기·symlink 0) | PASS |
| pin 3종 | PASS (v2는 계약 필드로 대조) |
| installer blob 동일 | PASS |
| 빈 보호 subtree, /usr 범위, manifestFile 사전 점검 | 관측됨 |
| 지속성(boot 변경 후 scratch 유지) | 관측됨 |
| `git diff --check`(미추적 파일 no-index) | PASS |
| check-source-lock | PASS |
| validate-repository, check-bundle | 2단계a FAIL_UNRELATED(node_modules 없음) → 2단계b `pnpm install --frozen-lockfile` 뒤 PASS |

## 남은 문제

- 012TH 이양 동의(09:58:58Z)는 run log 원문으로 handover.txt에 넣었다. 012TH get_session은 여전히 BLOCKED/need_input이다. 신 writer 1단계 쓰기(09:50:34Z)가 이 동의보다 먼저였다. 이양이 충분한지는 총괄과 감사가 판정한다.
- 원래 21:47Z 403의 원시 응답과 A2 본문은 없다. raw.githubusercontent 경로 통과가 의도된 정책인지는 미확인이다.
- 2단계b의 root pnpm install은 명세 쓰기 범위 밖이었다(개발팀장 허용). 뒤이은 /usr 새 항목은 플랫폼 boot symlink뿐이다.
- 세션 보존 기한은 불명확하다(persist 필드 없음). 운영 host 자격은 판정하지 않았다.
- fresh 독립 감사를 받아야 한다.

## 다음 Task(r5b) 최소 정보

- r5b는 새 AREA 갱신과 GO를 받은 뒤 시작한다. `r5a-live/r5b-inputs.txt`의 값을 설치 직전에 다시 계산한다.
- 입력: `/root/r5a` 아래 pubring.kbx, SHASUMS256.txt(+.sig), node-v24.21.0-linux-x64.tar.xz, src
- manifestFile은 `/root/r5a-out/manifest.txt`(부재 상태)이고 parent manifest는 없다(첫 설치).
- input-dir에는 keyring을 `nodejs-release-keyring.kbx` 이름으로 복사해야 한다.
- 중단 조건: r5b-inputs.txt 5절
- r5a PASS만으로 설치 적격이나 lineage ACCEPT를 주장하지 않는다.
