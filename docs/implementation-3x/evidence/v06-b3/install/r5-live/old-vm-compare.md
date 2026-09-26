# 구 VM(session_012TH) 대조: 개발팀장 전달 사본

## 인용 출처

- 이 문서의 구 VM 값은 모두 **개발팀장 전달 사본**이다. 이 세션(cse_01PRna2j)은 구 VM에 직접 접근하지 않았다.
- 저장본: `거버넌스설계/3.x 구현방향/handoffs/V06-b3b-r5_old-vm/old-vm-raw-20260926.txt`
  - sha256 `519427cea2d404875175f4c6c3cacb97e252cd076201ca4e1eac5de4ca92988b`, 13802 B
  - 개발팀장의 로컬 저장본이다. 총괄이 hash와 내용을 확인했다(claude-main-v06b3b-r5-go-release-to-devlead-20260926-01, 사용자 13:57Z "저장본으로 r5 GO").
- 원문은 복사하지 않았다. 아래 값은 GO 지시문에 옮겨 적힌 것이다.

## 한계 (전달문 그대로)

1. 모든 값은 구 VM 세션 출력을 run log로 옮긴 사본이다. 개발팀장이 직접 관측한 값이 아니고, 잘린 곳("[+N chars]")은 미관측이다.
2. fd8e59d5 root의 meta hash는 두 값이다. 13:42Z는 785cf1902018397f600057224991751d7f719bd9038412ba82115428123fea39, 13:49Z는 034f458281f9a6cc7abfb97276eddaf6fce4f527b5330eb20f0c1c364547e8f8다. 원인은 경로 끝 `/`로 추정하지만 검증되지 않았다. 785cf190은 구 VM 보고문에만 있다. content·stat·개수는 같다.
3. 32a825d9의 meta·content, r3의 meta, r1-live 8개 hash는 이번에 처음 잰 값이다. 과거 기준과 대조한 값으로 쓰지 않는다. 다만 이 문서의 대조 결과, r1-live 8개 hash는 아래 기준값에 있었다.
4. 구 VM은 질의 때마다 새 boot로 올라온다(d214944d-2758-4cea-b69e-d84e4b416213, btime 1790430133). 설치 시점 관측이 아니라 사후 관측이다. machine-id는 0d0af05ee8fd4dc29275718f2ce4dff1이다.

## 기준값 출처 (git, 읽기만)

- r3-live: `ca0aae01:docs/implementation-3x/evidence/v06-b3/install/r3-live/`(tree 2869c1d6)
  - invariance.txt: 2026-09-24 20:52·20:55 baseline
  - inventory.tsv, parent-manifest-b3b.txt
  - r3-live는 구 VM 불변 대조의 기준값으로만 인용한다. 새 설치 근거로 쓰지 않는다.
- r5a-live: `d8f20ac4:docs/implementation-3x/evidence/v06-b3/install/r5a-live/old-vm.txt`
  - 2026-09-25 09:50Z, 012TH run log 전달본

## 대조

| 항목 | 개발팀장 전달 사본 (09-26 13:42–13:49Z) | 기준값 | 판정 |
|---|---|---|---|
| 32a825d9 bin/node | ino 516919, 555, nlink 1, 126595440 B, ctime 1790268678, sha 7fde7b8a…df4c | r3 invariance: `516919 555 1 1790268678 7fde7b8a…`. r3 inventory: 516919, 555, nlink 1, 126595440. r5a old-vm: 516919, ctime 1790268678 | 일치 |
| 32a825d9 root | ino 516848, root:root 755, nlink 4, ctime 1790268679 | r3 inventory `.`: 516848, 755, nlink 4 | ino·mode·nlink 일치. ctime은 기준에 없어 미대조 |
| 32a825d9 개수 | d/f/other 66/180/0 | r3 inventory TOTAL: directories=66, files=180, symlinks=0 | 일치 |
| 32a825d9 meta·content hash | f5fa564e…, 4e652467… | 없음(처음 잰 값) | 미대조 |
| fd8e59d5 root | ino 516803, 755, nlink 2, ctime 1790262265 | r3 parent-manifest-b3b: 516803 dir 755 | ino·mode 일치. nlink·ctime 미대조 |
| fd8e59d5 node | ino 516804, 555, nlink 1, 126595440 B, ctime 1790262265, sha 7fde7b8a… | r3 invariance: `516804 555 1 1790262265 7fde7b8a…` | 일치 |
| fd8e59d5 개수·content | 1/1/0, be53efdc… | parent-manifest-b3b: root dir 1개 + node 1개 | 개수 일치. content는 미대조 |
| fd8e59d5 meta | 785cf190… / 034f4582… | 없음 | 미대조(한계 2) |
| /root/b3bf/manifest.txt | ino 1673306, 600, nlink 1, 558 B, 4줄, ctime 1790262265, sha 857bad43 | r3 invariance, r5a old-vm: sha 857bad43. parent-manifest-b3b: 4줄 | sha·줄 수 일치. ino·크기·ctime 미대조 |
| /root/b3bf/r1/manifest.txt | ino 1738911, 600, nlink 1, 58461 B, 246줄, ctime 1790268679, sha d75268ce | r3 invariance, r5a old-vm: sha d75268ce. `install/README.ko.md:98`(eb5f2e5d): 246줄 | sha·줄 수 일치. ino·크기·ctime 미대조 |
| /root/b3bf/r3 | drwx------ 5 root root, Sep 24 21:01, 항목 2011개, 최신 ctime 1790283667.58, meta 69e4d9a4… | r5a old-vm: `drwx------ 5 root root 4096 Sep 24 21:01` | mode·nlink·mtime 일치. 항목 수·meta는 미대조 |
| r1-live 8개 hash | 1f10e1bc, c769bee0, bab5ae6f, e822e6de, a9f739ee, 0a4ce5b2, bb7c818c, 9995b23a | r3 invariance.txt(20:52 baseline) 7-14행의 8개 값 | 8개 모두 일치 |
| git | claude/v3x-v06-b3b-r1 ca0aae01, `?? …/r1-live/` | r5a old-vm: 같음 | 일치 |

## 결론 (근거 정확성)

- 기준값이 있는 항목에서 불일치는 0건이다.
- 개발팀장 대조("기준값과 다른 항목 없음")와 같은 결과다. 추가로, r1-live 8개 hash는 "처음 잰 값"이 아니었다. r3 invariance baseline에 같은 값이 있어 대조할 수 있었다.
- 미대조 항목: 32a825d9의 meta·content, fd8e59d5의 meta·content, r3 meta·항목 수, manifest의 ino·크기·ctime. 모두 기준값이 없는 새 측정값이라 불변을 주장하지 않는다.
- 이 대조는 사후 관측 사본에 기대므로 구 VM 불변의 보조 근거다. lineage 판정은 r6가 한다.
