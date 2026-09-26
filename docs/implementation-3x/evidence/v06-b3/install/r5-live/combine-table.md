# V06-b3b-r5 결합 대조표

r5a(신뢰 입력 준비)와 r5b(새 host 첫 설치)의 근거를 항목별로 대조한다. 원시 근거는 다시 복사하지 않고, 경로(통합 eb5f2e5d 기준)와 값으로만 인용한다.

판정 표기:
- **일치**: 두 근거의 원시값이 같다.
- **불일치**: 원시값이 다르다.
- **미관측**: 원시 근거가 없거나 추론에 의존한다.

이 표는 근거가 정확한지만 판정한다. 설치 lineage를 수용할지는 판정하지 않는다(r6 몫).

## A. 커밋·통합 범위

| 항목 | r5a | r5b | 판정 |
|---|---|---|---|
| 최종 commit | 7a13c518 (merge d8f20ac4의 두 번째 부모) | 51295a25 → b209874c → eb5f2e5d (통합 HEAD eb5f2e5d) | 일치(git-scope.txt) |
| 근거 tree | r5a-live `f12bfb2f`(7a13c518과 eb5f2e5d에서 같음) | r5b-live `1061d5ba`(22개 파일) | 일치 |
| 선택 통합 범위 | `d8f20ac4^1..d8f20ac4`: r5a-live 아래 A 16개, 밖 0 | `4017ca95..eb5f2e5d`: r5b-live 아래 A 22개, 밖 0 | 일치 |
| r3-live 비의존 | eb5f2e5d tree에 r1-live·r3-live 경로 0개, ca0aae01은 조상 아님 | 같음 | 일치 |
| fresh 감사 | 830e4628 자체 감사 PASS. cloud 사전 감사 BLOCKED(B1) → 7a13c518 보완. 통합·COMPLETED는 개발팀장 전달 | 51295a25 자체 감사 PASS. df73d3b5 FAIL(B1) → b209874c, BLOCKED(원본 부재) → eb5f2e5d. COMPLETED는 개발팀장 전달 | 전달 기록(이 세션은 공식 감사 원문을 보지 않았다) |

## B. writer·session·host

| 항목 | r5a 기록 | r5b 기록 | 판정 |
|---|---|---|---|
| writer | cse_01PRna2j, AREA f9f49211 (r5a-live/handover.txt) | 같은 session, AREA 1910c26e (r5b-live/README.ko.md) | 일치(같은 session) |
| 구 writer 이양 | 012TH run log 원문 09:58:58Z 동의, get_session은 BLOCKED/need_input (handover.txt) | 해당 없음 | 미관측: 이양 충분성은 r5a 감사에서 판정했다 |
| model/effort | claude-opus-5-5 / high (session-host.txt) | HANDOFF-draft에 claude-opus-5-5/high로 적혀 있다. get_session 원문은 r5b-live에 없다(개발팀장이 따로 기록) | 일치(r5b는 원문 미포함) |
| boot | 턴마다 바뀜: 33345bc8 → a6a1e00b → 1dd8bb46 → 25a57085 → bce6e43b (persistence.txt) | 설치 전체가 한 boot 701c96a7 안에서 이뤄짐(pre-install·install·post-install·reject-tests) | r5b 설치 사건 안에서는 일치. r5a와 r5b의 boot는 서로 다름(예상된 차이) |
| host 연속성 | hostname vm, machine-id 0d0af05e…(구 VM과 같은 공통값), fs UUID 미관측 | 같음 | 미관측: 공통값이라 host 동일성의 증거가 아니다 |
| 디스크 연속성 | scratch-sha256.txt 1631개, 목록 sha 8c0c1f60 (r5a 여러 턴에서 `-c` 통과) | pre-install.txt에서 같은 목록 `-c` 통과(11:32Z, boot 701c96a7) | 일치: r5a scratch가 r5b 설치 직전까지 bytes 단위로 유지됐다 |

## C. 입력 pin (r5a 준비 → r5b 설치 직전 재계산)

| 입력 | r5a 값 (pins.txt, k1-node.txt, source.txt) | r5b 직전 값 (pre-install.txt, install.txt) | 판정 |
|---|---|---|---|
| K1 keyring | 140f2ad5…5932, 21011 B | 140f2ad5…5932 (/root/r5a와 r5b-in 사본) | 일치 |
| 서명 | gpgv VALIDSIG 5BE8A3F6…D356 | 같음 | 일치 |
| archive | fd8e59d5…2d6 = SHASUMS 행 = PINNED.releaseSha256 | 같음 | 일치 |
| bin/node | 7fde7b8a…df4c | 같음(설치 후 inode 524293도 같은 sha) | 일치 |
| AGS source | 0724bb2b, 1620개 파일, root 700 조상, g/o 쓰기·symlink·비root·nlink>1 0, host-integration 648dddda | 같은 값, blob 단위 SOURCE_EQUALS_0724bb2b | 일치 |
| installer blob | c7b3414e (8bb6e689=4866e455=0f530615) | c7b3414e (작업 트리=8bb6e689=4866e455=4017ca95), release 5fc2427e, stage 755c6f0b | 일치 |
| 모듈 적재 경로 | 해당 없음 | repo scripts/qualification. 경로 사슬 root 755, 모듈 ctime 09-25 09:59 < 11:32:15Z, pid 2219의 코드 open은 driver와 세 모듈뿐(b1-supplement) | 일치. 단 적재 bytes는 root 신뢰 가정 아래의 추론(raw/RAW-NOTE 한계 1) |
| umask | 022 | 0022 | 일치 |
| release ID | 32a825d9…8edd (preimage 계산) | 설치 출력과 verifier 32a825d9…8edd | 일치 |

## D. 출력 경계와 설치 사건

| 항목 | r5a | r5b | 판정 |
|---|---|---|---|
| 빈 보호 subtree | `/usr/lib/agent-governance-suite` 없음 (preinstall-state.txt, 여러 턴) | 11:32:15Z와 11:33:49Z에 없음 (pre-install·install) | 일치 |
| mount | `/`, `/usr`, `/usr/lib` 단일 ext4 dev 65024, bind 없음 | 같음, mountinfo sha ca88d4a2가 설치 전후 동일 | 일치 |
| manifestFile 경로 | `/root/r5a-out` root 700 빈 디렉터리, manifest.txt 없음, symlink 아님 | 설치 직전 ABSENT. 설치가 생성: ino 1671184, 0600, nlink 1, uid 0, 248줄, sha e78cb508 | 일치 |
| 기록마다 결속 | 해당 없음 | strace openat 248회 모두 `O_WRONLY\|O_CREAT\|O_APPEND, 0600`, 단일 pid 2219, O_TRUNC·unlink·rename 0 | 미관측(부분): 기록마다 fstat을 재지 않았다(F1). root 신뢰 가정 안에서만 성립 |
| 설치 명령 | 해당 없음 | installer 모듈 API 1회 실행(진입점 driver 38905e19), exit 0, stderr 0 B, stdout sha 1b432df3, 11:33:49–57Z | 일치(CLI 실행 아님) |
| 원본 strace | 해당 없음 | 07597bba, 45331줄. raw/strace.txt.gz를 풀면 같은 값 | 일치 |
| 설치 후 inventory | 해당 없음 | 248개 경로(dir 68, file 180) = manifest, verifier OK, runVerifiedRuntime v24.21.0 | 일치 |
| 비인가 거절 | 해당 없음 | nobody 14/14 거절, mount 교체 3건 거절(1건 판정 불가) | 일치 |
| 시스템 조상 | 해당 없음 | `/`, `/usr`, `/usr/lib` owner·mode·ino 불변. `/usr/lib` ctime은 하위 추가로 바뀜 | 일치 |
| limitations | 해당 없음 | driver 출력에 빠진 4개(candidate-host-only, not-production-host-qualified, no-fresh-disk-or-secure-erase-claim, no-loader-closure-measurement)를 그대로 적용 | 명시됨 |

## E. r5 턴 사후 관측 (boot 9ed1c2a0, 설치 lineage 증거 아님; turn-check.txt)

| 항목 | r5b 기록 | r5 턴 관측 | 판정 |
|---|---|---|---|
| scratch manifest | ino 1671184, sha e78cb508 | 같음, r5b-live 사본과 cmp 동일 | 일치 |
| r5b-run 전체 | strace 07597bba, driver 38905e19, stdout 1b432df3, stderr e3b0c442 | 같음 | 일치 |
| r5a scratch 목록 | 8c0c1f60, 1631개 | `-c` 통과 | 일치 |
| 설치 root | 248개 경로, 180개 파일 sha | inventory.tsv와 diff 없음, installed-sha256 `-c` 통과, node ino 524293 | 일치 |

## F. 구 VM과의 구별

- 두 host의 release ID는 32a825d9…8edd로 같다. 그래서 root 이름으로는 구별할 수 없다.
- 구별 근거:
  - 새 host에는 fd8e59d5 root와 `/root/b3bf`가 없다.
  - root inode가 다르다: 구 516848, 새 524291.
  - bin/node inode가 다르다: 구 516919, 새 524293.
  - 설치 ctime이 다르다: 구 1790268678–79, 새 1790422435.
  - manifest가 다르다: 구 d75268ce 246줄, 새 e78cb508 248줄.
- hostname·machine-id는 두 host가 같은 공통값이라 구별 근거가 아니다.
- 주의: 두 host의 package 파일 inode 범위가 겹친다(구 VM r3-live inventory에 524398이 있고, 새 host package도 524xxx다). 같은 이미지에서 ext4 inode를 비슷하게 할당한 결과로 보인다. inode 하나만으로는 host를 구별하지 못한다. 위의 여러 항목을 합쳐서 구별한다.

## 요약

- 일치: A 전 항목(공식 감사 원문 제외), B의 writer·model·디스크 연속성, C 전 항목, D의 기록마다 결속을 뺀 전 항목, E 전 항목
- 불일치: 없음
- 미관측:
  - host 동일성: 공통 hostname·machine-id, fs UUID 미관측
  - 구 writer 이양의 충분성
  - manifest 기록마다의 fstat(F1)
  - 적재 bytes: root 신뢰 가정 아래의 추론
  - 공식 감사 원문: 개발팀장 전달만 있음
  - strace가 기록하지 않은 syscall: read·stat·access·execve
