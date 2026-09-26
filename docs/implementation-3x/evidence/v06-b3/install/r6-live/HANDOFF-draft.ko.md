# TASK_V06-b3b-r6 handoff (초안)

- **TASK_ID**: V06-b3b-r6 (새 Linux 설치 lineage 원시 근거 전달·판정)
- **결과**: READY_FOR_AUDIT. 1절 생존·identity는 대조 항목 모두 일치했다. host 동일성(fs UUID)은 미관측이라 lineage는 BLOCKED가 될 수 있다. 판정은 df73d3b5가 한다.
- **start SHA**: 7e3e6fd8735fab3684743400dd4d548eb9552e0f
- **원격 branch**: `claude/v3x-v06-b3b-r6-lineage-transfer`
- **push 여부**: 세션 최종 보고에 적는다(최종 SHA·tree도 보고에 적는다).
- **CI 상태**: NOT_RUN

## 수행한 작업

1. 시작 점검: 작업 트리 청정, 7e3e6fd8이 통합 origin의 조상(anc=0), 원격 r6 branch 없음을 확인하고 branch를 만들었다.
2. 1절: 설치 root·bin/node·manifest의 identity, inventory 전체, 파일 sha 180개를 r5b 기록과 대조했다(survival.txt).
3. 2절: scratch 원본을 재계산해 git 사본과 대조하고, git에 없던 원시 기록 3개를 비밀 검사 뒤 raw/에 넣었다(transfer-table.md, git-cite.txt).
4. r5 감사 이월 항목을 정오표로 적었다(errata.md).

## 변경 파일

- `docs/implementation-3x/evidence/v06-b3/install/r6-live/` 아래 새 파일만 만들었다. 저장소 밖 쓰기는 없다.

## 검증 결과

| 항목 | 결과 |
|---|---|
| 설치 root·node·manifest identity | 일치 |
| inventory 248행(dir 68, file 180) | diff 없음 |
| installed-sha256 180개 | 통과 |
| manifest 248줄, e78cb508 | 일치, git 사본과 cmp 동일 |
| scratch 원본 ↔ git 사본 | driver·manifest-trace·strace·stdout 일치 |
| installer blob | 8bb6e689 = 4866e455 = 7e3e6fd8 = c7b3414e |
| r3-live | ca0aae01은 7e3e6fd8의 조상 아님, r1/r3-live 경로 0개 |

## 남은 문제

- host 동일성 미관측: hostname·machine-id 공통값, fs UUID는 설치 때와 지금 모두 얻지 못함.
- F1(기록마다 fstat), 적재 bytes(root 신뢰 가정), V03-i pin의 설치 직전 직접 재계산 행 없음, root·manifest의 설치 시점 ctime 기록 없음.
- CLI 첫 설치 복구 leaf는 r6 뒤에 둘 예정이다.

## 다음 Task에 필요한 최소 정보

- 설치 root `/usr/lib/agent-governance-suite/protected-runtime/32a825d9…8edd`(dev 65024, ino 524291), node ino 524293, manifest `/root/r5a-out/manifest.txt`(ino 1671184, e78cb508…2428)
- 설치 boot 701c96a7-937e-47dd-9a3d-cdfdb92380fc, r6 boot 3532114c-8a82-42f0-a1cc-c30217ed6d5b
- 대조표 `r6-live/transfer-table.md` D절
