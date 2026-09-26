# r5-live 정오표 (r5 감사 df73d3b5·c19eb792에서 넘어온 항목)

r5-live는 고치지 않는다. 아래 정정은 이 파일에만 적는다. 경로는 `docs/implementation-3x/evidence/v06-b3/install/r5-live/` 기준이다.

## I-1 문서 오류 3건

| 위치 | 원문 | 정정 |
|---|---|---|
| `old-vm-compare.md:42` | r3 invariance.txt "7-14행"의 8개 값 | 6–13행 |
| `HANDOFF-draft.ko.md:19` | "새 파일 6개" | 7개(SHA256SUMS 포함) |
| `combine-table.md:54` | `O_WRONLY\|O_CREAT\|O_APPEND, 0600` | `O_WRONLY\|O_CREAT\|O_APPEND\|O_CLOEXEC, 0600`(r5b-live/post-install.txt의 openat 집계 원문) |

## I-3 구 VM content hash

- 32a825d9 content 4e652467…c1de와 fd8e59d5 content be53efdc…7432는 구 VM 사본(519427ce) 기준으로 **일치**다.
- 감사자가 재계산한 값이며 비교 입력이다. 새 실측이 아니다. 구 VM 사본 519427ce도 비교 입력일 뿐이다.
- 따라서 `old-vm-compare.md` 34·37행의 "미대조"는 감사 재계산 기준으로 "사본 기준 일치"로 읽는다.

## I-4 결합표 B의 host 연속성 행

- `combine-table.md:30`은 r5a·r5b 모두 "hostname vm, machine-id 0d0af05e…"처럼 적었다.
- 실제로 r5b 원시 자료(pre-install.txt 등)에는 hostname `vm`만 있다. machine-id는 r5 턴(boot 9ed1c2a0)에서 사후에 얻은 값이다.

## I-5 `/root/r5a-out`의 mtime·ctime

- 설치 직전 ctime 1790329927(pre-install.txt:104)은 약한 신호다. host 동일성 근거가 아니다.
