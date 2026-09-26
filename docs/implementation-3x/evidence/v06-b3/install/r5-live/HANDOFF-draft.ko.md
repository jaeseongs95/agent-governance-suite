# TASK_V06-b3b-r5 handoff (초안)

- **TASK_ID**: V06-b3b-r5 (새 Linux 첫 설치 결과 결합 재판정)
- **결과**: 결합 대조 불일치 0건, 미관측 항목은 명시했다. 근거 정확성만 판정했고 lineage 판정은 r6에 남긴다. 최종 SHA와 자체 감사 결과는 세션 최종 보고에 적는다.
- **브랜치**: `claude/v3x-v06-b3b-r5-lineage-combine`, 시작 SHA `eb5f2e5dc3c71372ae2ec97f5775e79c6c411f87`
- **writer**: `cse_01PRna2jKCs5EdTv8Rwv3j83`(claude-opus-5-5/high). r5a·r5b를 이어서 맡았다.
- **dependency**: r5a COMPLETED(d8f20ac4), r5b COMPLETED(eb5f2e5d), r3는 Progress 233행 BLOCKED를 유지한다(모두 개발팀장 전달).

## 수행 작업

1. 시작 점검: 작업 트리가 깨끗하고 origin이 eb5f2e5d인 것을 확인한 뒤 branch를 만들었다.
2. r5 턴(boot 9ed1c2a0)에서 scratch manifest, r5b-run, r5a scratch 목록, 설치 root inventory·sha를 읽기만 해서 다시 확인했다.
3. git으로 선택 통합 범위, r3-live tree·조상 관계, installer blob을 확인했다.
4. r5a·r5b 근거를 항목별로 대조했다(combine-table.md).
5. 구 VM 전달 사본을 r3-live·r5a-live 기준값과 대조했다(old-vm-compare.md).

## 변경 파일

- `docs/implementation-3x/evidence/v06-b3/install/r5-live/` 새 파일 6개만 만들었다.
- 저장소 밖 쓰기는 없다.

## 검증 결과

| 항목 | 결과 |
|---|---|
| r5a 입력 → r5b 설치 직전 pin | 전 항목 일치 |
| r5b 설치 사건(한 boot) | 일치 |
| scratch·r5b-live 사본 hash | 일치(manifest e78cb508, strace 07597bba) |
| 구 VM 기준값 대조 | 불일치 0, 미대조 항목은 명시 |
| r1-live·r3-live 불변, 선택 통합 | 일치 |

## 남은 문제

- 미관측: host 동일성(공통 hostname·machine-id, fs UUID 미관측), manifest 기록마다의 fstat(F1), 적재 bytes(root 신뢰 가정), 구 writer 이양 충분성, 공식 감사 원문(전달만 있음)
- 구 VM 전달 사본의 새 측정값(meta·content hash 등)은 기준값이 없어 불변을 주장하지 않는다.
- CLI 첫 설치 복구 leaf는 r6 뒤에 둘 예정이다.
- r6 신뢰 가정 후보: sudo 그룹 ubuntu(1000), 로그인 셸 계정 claude·postgres
- 오케스트레이션: 대조는 이 writer가 직접 하고, 쓰기 금지 opus/high 서브에이전트는 fresh 자체 감사 1회에만 쓴다. 대조 대상이 한 세션의 근거 묶음이라 병렬로 나눌 이득이 작다.

## 다음 Task(r6) 최소 정보

- 결합 근거: `r5-live/combine-table.md`, `r5-live/old-vm-compare.md`
- 설치 root: `/usr/lib/agent-governance-suite/protected-runtime/32a825d9…8edd`(root ino 524291, node ino 524293)
- manifestFile: `/root/r5a-out/manifest.txt`(ino 1671184, sha e78cb508…2428)
- 원본 strace: r5b-live/b1-supplement/raw/strace.txt.gz(풀면 07597bba)
- 구 VM 저장본: 개발팀장 로컬, sha256 519427ce…988b
