# wrapper(commands.jsonl) 밖에서 실행한 단계
아래 단계는 run.sh wrapper 없이 Bash 도구로 바로 실행했다. 원 stdout/stderr는 native transcript에만 있다. transcript를 공개하지 않은 이유는 `NOT_VERIFIABLE-append-2.md`에 적었다. 관측한 값만 옮긴다.

| 시점(UTC) | 단계 | 관측 출력 요지 |
|---|---|---|
| 06:04 | 본문 cutoff, stage 복사 | 파일 133개, 6.1M |
| 06:05 | 본문 redaction, 리터럴 5개 대조 후 삭제 | 133개 중 7개 파일 변경 |
| 06:05 | 본문 residual | email 12(noreply), 그 외 0 |
| 06:06 | 본문 REDACTION·MANIFEST·SUMS | SUMS `df2f8bee…`, MANIFEST `ff4c9885…` |
| 06:24 | append-1 회수(읽기 전용 확인, proxy 상태 조회) | uptime 17.59s, HEAD/tree 같음, dirty 0 |
| 06:25 | append-1 redaction, 리터럴 5개 대조 후 삭제 | 29개 중 2개 변경(account-name) |
| 06:25 | append-1 MANIFEST·SUMS | SUMS `7cf279dc…`, MANIFEST `59845096…` |
| 06:25 | append-1 로컬 commit | `64b469d382e9547188fdbfc7660bead8ccceb047` (parent `eff886e8…`) |
| 06:26 | 원격 fetch(읽기) | 원격 `ed429f2`, 경로 충돌 0 |
| 06:28 | 백업 브랜치 `evidence-local-backup` → 64b469d | 출력 없음 |
| 06:35:56 | append-2 회수 | 이 폴더 |
- 첫 로컬 commit `eff886e8…`의 commit·show·push(403) 원 로그는 append-1 `raw-logs/41–44`에 있다.
