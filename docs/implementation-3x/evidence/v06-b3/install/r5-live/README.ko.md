# V06-b3b-r5 결합 판정 근거

V06-b3b-r5(spec r50 `19373237bb06…`)의 verification 근거다. r5a(신뢰 입력 준비, 7a13c518, 통합 d8f20ac4)와 r5b(새 host 첫 설치, 51295a25·b209874c·eb5f2e5d, 통합 eb5f2e5d)를 대조해 같은 설치 사건으로 이어지는지 다시 판정한다. 설치, 재설치, rollback, 제품 코드·테스트 변경은 하지 않았다. `/usr`와 scratch는 읽기만 했다.

- writer: `cse_01PRna2jKCs5EdTv8Rwv3j83`. r5a·r5b를 이어서 맡았고 AREA는 V06_B3B_R5_CLAUDE_CLOUD다.
- branch: `claude/v3x-v06-b3b-r5-lineage-combine`, base eb5f2e5d
- r5 턴 boot: `9ed1c2a0-2b7f-4f70-b77a-b70ac5b55e2f`(btime 1790431156, 13:59:31Z~). 사후 관측이며 설치 boot는 701c96a7이다.

## 파일

| 파일 | 내용 |
|---|---|
| `combine-table.md` | 결합 대조표. 커밋·통합 범위, writer·host, 입력 pin, 출력 경계·설치 사건, r5 턴 사후 관측, 구 VM과의 구별 |
| `old-vm-compare.md` | 구 VM 값(개발팀장 전달 사본, sha256 519427ce…988b)과 기준값(r3-live·r5a-live) 대조 |
| `turn-check.txt` | r5 턴의 scratch·manifest·설치 root 원시 재확인 |
| `git-scope.txt` | 선택 통합 범위, r3-live tree·조상 관계, installer blob, 기준값 인용 원문 |
| `HANDOFF-draft.ko.md` | handoff 초안 |
| `SHA256SUMS` | 이 디렉터리 파일 |

`turn-check.txt`와 `git-scope.txt`의 `exit=1`·`exit=2` 가운데 다음은 예상된 결과다.
- `ls -ld /root/b3bf`의 부재(exit 2)
- `grep -c`의 0건(exit 1)

## 요약

- 결합 대조: 불일치 0건이다.
  - r5a가 준비한 입력(keyring, 서명, archive, bin/node, source, installer blob, umask, release ID)이 r5b 설치 직전 재계산 값과 모두 같다.
  - r5a scratch 목록(8c0c1f60)이 r5b 설치 직전까지 유지됐다.
  - r5b 설치 사건은 한 boot 701c96a7 안에서 사전 점검 → 설치 → 검증 → 거절 시험으로 이어졌다.
- r5 턴 사후 관측: scratch manifest(ino 1671184, e78cb508), r5b-run 전체, 설치 root inventory·파일 sha가 r5b 기록과 같다. 이는 설치 lineage의 증거가 아니다.
- 구 VM: 기준값이 있는 항목의 불일치 0건이다. r1-live 8개 hash는 r3 invariance baseline 값과도 같다.
- r1-live·r3-live 불변:
  - r3-live tree는 ca0aae01에서 2869c1d6(17개 파일)이다.
  - ca0aae01은 eb5f2e5d의 조상이 아니고, eb5f2e5d tree에 r1-live·r3-live 경로는 0개다.
  - `4017ca95..eb5f2e5d`는 r5b-live 아래 A 22개뿐이다.
  - r1-live는 구 VM 미추적 파일이고, 개발팀장 전달 사본의 hash 8개가 r3 baseline과 같다.

## 근거 정확성과 lineage 판정의 구분

- 이 디렉터리는 **근거가 정확한지**를 대조한다. 결과는 일치하고, 미관측 항목을 명시했다.
- **설치 lineage를 수용할지**는 판정하지 않는다. lineage ACCEPT와 최종 원시 근거 전달은 r6가 판정한다.
- 불명확한 항목은 완료로 승격하지 않는다: host 동일성, manifest 기록마다의 fstat, 적재 bytes, 구 writer 이양 충분성.

## 한계

- host 동일성: hostname·machine-id가 공통값이고 fs UUID는 관측되지 않았다. r5a→r5b 연속성의 근거는 디스크 scratch가 유지됐다는 점뿐이다.
- 두 host의 release ID와 package inode 범위가 겹친다. 그래서 여러 identity를 합쳐 구별한다(combine-table F).
- r5b의 기록마다 manifest 결속은 fstat 없이 추론했다(F1). 적재 bytes도 root 신뢰 가정 아래의 추론이다.
- r5b 결과에는 driver 출력에서 빠진 limitations 4개가 그대로 적용된다.
- 구 VM 값은 모두 개발팀장 전달 사본이다. 한계 4가지는 old-vm-compare.md에 있다.
- 공식 감사(df73d3b5)의 판정 원문은 이 세션이 보지 않았다. 개발팀장 전달로 인용한다.
