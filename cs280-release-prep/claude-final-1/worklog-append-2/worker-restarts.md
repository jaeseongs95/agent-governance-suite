# worker 재시작 관측
- 1차: 06:12Z 무렵 seq 44 이후에 세션 안에서 "This session's worker process was restarted"라는 시스템 통지를 받았다. 06:24:34Z의 /proc/uptime은 17.59s였다(append-1 `environment-recheck.json`).
- 2차: 후속 지시 2를 시작할 때(06:35:36Z) uptime이 23.23s였다. 06:35:56Z cutoff에서는 43.06s다(`uptime-at-cutoff.txt`). 이 재시작에 대한 별도 통지는 없었다. 작업 디렉터리가 `/home/user/agent-governance-suite`로 바뀌었고 transcript 경로가 하나 더 생겼다.
- 두 번 모두 container ID와 디스크 상태(`$ST`, `/root/evidence-wt`, 로컬 브랜치)는 남아 있었다. 강제 종료한 프로세스는 없다.
- 재시작 원인: UNKNOWN.
