# TASK_V06-b3b-r5b handoff (초안)

- **TASK_ID**: V06-b3b-r5b (새 Linux 후보 host의 첫 보호 runtime 설치·감사)
- **결과**: 설치 exit 0(`CANDIDATE_HOST_INSTALLED`). 설치 직후 최종 코드로 검증했고 거절 시험도 통과했다. 최종 판정은 fresh 자체 감사 결과와 세션 최종 보고에 적는다.
- **브랜치**: `claude/v3x-v06-b3b-r5b-first-install`, 시작 SHA `4017ca9545418c45044a40e6cf67d4a74074ccd4`
- **최종 SHA/tree**: 이 handoff는 자기 커밋 SHA를 담을 수 없으므로 세션 최종 보고에 적는다.
- **writer**: `cse_01PRna2jKCs5EdTv8Rwv3j83`(claude-opus-5-5/high), AREA `1910c26e`. r5a writer가 이어서 맡았다.
- **boot**: 모든 단계가 `701c96a7-937e-47dd-9a3d-cdfdb92380fc` 한 boot 안에서 이뤄졌다(11:30:42Z~).

## 수행 작업

1. 시작 점검: 작업 트리가 깨끗하고 origin이 4017ca95인 것을 확인한 뒤 branch를 만들었다.
2. 설치 직전 재검증: 모든 입력을 다시 계산했다. 결과는 pre-install.txt에 있다. `dpkg --verify`도 실행했다.
3. CLI 형식을 확인했다. `--parent-manifest`가 필수라 첫 설치 명령은 거절된다. 그래서 installer CLI 블록을 parent manifest 없이 호출하는 driver로 1회 설치했다(strace 기록).
4. 설치 직후 검증:
   - manifestFile identity와 기록 trace
   - 최종 코드 verifier와 runVerifiedRuntime
   - inventory와 manifest 일치
   - 조상 불변
5. 거절 시험: nobody 14건, mount 교체 3건(1건은 판정 불가라 대체 시험으로 보충)
6. 설치 뒤 `dpkg --verify` 재실행: 설치 전과 같다.

## 변경 파일

- `docs/implementation-3x/evidence/v06-b3/install/r5b-live/` 새 파일만 만들었다.
- 저장소 밖 쓰기:
  - `/usr/lib/agent-governance-suite/` 아래 248개 경로(설치)
  - `/root/r5a-out/manifest.txt`(설치가 생성)
  - `/root/r5a/r5b-in`(입력 사본), `/root/r5a/r5b-run`(driver·trace·로그)
- 제품 코드, r1-live, r3-live, r5a-live는 변경하지 않았다.

## 검증 결과

| 항목 | 결과 |
|---|---|
| keyring·서명·archive·bin/node pin | 일치 (VALIDSIG 5BE8A3F6…) |
| source 0724bb2b(owner·mode·symlink·nlink·blob) | 일치 |
| installer·release·stage blob | 작업 트리 = 8bb6e689 = 4866e455 = HEAD |
| mount·bind 경계 | 단일 `/` ext4, bind 없음, 전후 mountinfo 동일 |
| 대상 subtree·manifestFile 설치 전 부재 | 관측됨 |
| 설치 | exit 0, releaseSha256 32a825d9…, 248 경로 |
| manifestFile | regular·root·0600·nlink1, 248줄, 매 기록 O_APPEND 0600, 단일 pid |
| 설치 후 verifier(4017ca95) | OK, manifest 불일치 0 |
| 거절 시험 | nobody 14/14 거절, mount 교체 3/3 거절(판정 불가 1건 별도) |
| dpkg --verify | 설치 전후 동일, 실행 파일 불일치 0 |

## 이력과 판단 근거

- r5a F2: 2026-09-25 10:06Z에 이 host에서 root로 `pnpm install --frozen-lockfile`(esbuild postinstall 포함)이 실행됐다. 그래서 설치 직전에 모든 입력을 다시 계산했고, `dpkg --verify` 결과(실행 파일 불일치 0)를 남겼다. installer는 node 내장 모듈만 쓰며, `node_modules`는 설치 경로에 들어가지 않는다.
- 오케스트레이션: 설치는 단일 writer가 한 boot 안에서 순서대로 해야 하는 작업이다. 그래서 병렬 위임 없이 직접 수행했다. 쓰기 금지 opus 서브에이전트는 fresh 자체 감사 1회에만 쓴다.

## 남은 문제

- r5a `r5b-inputs.txt`의 설치 명령은 CLI 필수 옵션(`--parent-manifest`)과 맞지 않았다. 첫 설치용 CLI 경로가 필요한지 코드 복구 leaf에서 판단해야 한다.
- 구 VM의 두 root와 manifest의 불변은 이 host에서 관측할 수 없다. r6나 총괄이 확인해야 한다.
- 임의 root 경합은 신뢰 가정이다. 운영 host 적격과 lineage 최종 판정은 r6가 한다.

## 다음 Task 최소 정보

- 설치 root: `/usr/lib/agent-governance-suite/protected-runtime/32a825d9da1c613e097e6246cf282b89777cc13d043fda3dd68113c1fc208edd`
- bin/node: ino 524293, sha 7fde7b8a…
- manifestFile: `/root/r5a-out/manifest.txt`, ino 1671184, sha256 `e78cb508ee8537d0a43f3e09d9fd3d5ad5a63c116af623375efc0a2b95982428`. 다음 설치에서 parent manifest pin 후보가 된다(현재 코드 pin에는 없다).
- 이 host의 boot는 턴마다 바뀔 수 있다. 다음 검증은 매 턴 boot와 scratch 해시를 다시 확인한다.
