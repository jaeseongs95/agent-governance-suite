# NOT_VERIFIABLE / UNKNOWN

| 항목 | 상태 |
|---|---|
| 수집 cutoff(13:01:30Z) 이후의 preflight·commit·push·fetch 로그 | 이 packet에 없다. 사후 private 로그로 따로 보존한다 |
| 파싱 실패 줄 5개, 정책 파일 3개 | 원문은 공개하지 않는다. SHA·size·사유는 `EXCLUDED.tsv`에 있다. 그래서 전체 완전성·privacy PASS로 올리지 않는다 |
| C2 child(Git marketplace) | NOT_RUN(STOP). init plugin root, Skill base directory, 주입된 body 위치, child model 모두 관측하지 못했다 |
| in-process 메모리에 실제로 올라간 bytes | UNKNOWN |
| dd2 공개본 `transcripts/cloud-main-session.jsonl` 13행 파싱 실패 | 그대로 남는다(dd2 파일은 덮어쓰지 않는다). 이번 packet의 정제본은 줄 단위 leaf 방식으로 다시 만들었다 |
| dd2 홈 경로 잔여 45건(d4 보고) | dd2 파일에 그대로 남는다 |
| dd2 push 명령 자체의 UTC | UNKNOWN. wrapper 시작 11:46:12.667669Z와 종료 11:46:16.101980Z, gate `now` 값만 있다 |
| executor 재사용 근거 | container ID는 같다. 12:29Z에 재부팅(새 boot_id)을 관측했다. 그 밖의 재사용 여부는 UNKNOWN |
| 단독 writer 조건 | root가 확인할 조건이다. Cloud는 ls-remote가 정확히 일치하는지만 관측한다 |
| 이 packet의 root fetch 검증 | Cloud가 대신하지 않는다 |
