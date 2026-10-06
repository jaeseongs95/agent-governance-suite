# claude-b28a-c2-git-1: Cloud 로그 이송 packet

- 수집 cutoff(private 원본 복사): 2026-10-06T13:01:30Z.
  - 이 packet에는 그 뒤의 preflight·commit·push 로그가 없다.
  - 그 로그는 사후 private 로그로 따로 보존한다.
- source pin: `b28a442ad424b255283fe32fe3c0e661b195fa4e`, tree `e1ffc736bc999781e7ea0670e43d7eca3bd80a82`, dirty 0.
  - 근거: `c2-log-1-pre-commands.jsonl` seq 1~2.
- 이송 전 fetch로 관측한 evidence base:
  - commit `b2a28fda32a987098951863ae9ae08829ceb2bc7`, tree `2b488963557a0223de4d844e58701527a8342e0b`.
  - prefix가 없음을 확인했다(seq 3~5).
  - 전체 baseline은 `baseline-files.tsv`와 `baseline-lstree.txt`에 있다(각 11993행).
- 아래 "지시"는 위임받아 전달된 지시문이다. 인간 승인 원문이 아니다. 다만 이 packet의 게시는 사용자가 세션 안에서 직접 승인했다.
  - 지시 원문과 실제 결과는 `transcripts/cloud-main-session.jsonl`(정제본)에 있다.

| 지시(시각 순) | 실제 결과 |
|---|---|
| 원 검증 run(S·C1·E·C2) | `run1/status.json`, `run1/commands.jsonl`(96행), `run1/raw/` |
| 상태 확인 질문 1(읽기 전용) | 답변함(transcript) |
| push 창 지시 1(11:35~12:00Z) | 첫 commit은 자동 분류기에 거부돼 STOP했다. 사용자가 세션 안에서 승인한 뒤 commit했다. preflight READY, push 1회 exit 0, remote `dd2b6770…`. 기록은 `transfer-dd2/` |
| 기록 읽기 질문 2(읽기 전용, 12:14Z) | 답변함(transcript). receipt를 새로 만들지 않았다 |
| C2 Git marketplace 지시(12:28Z) | add·install 각 1회, 모두 exit 0. `<I>` 506/506, lock 42/42, MCP는 `<I>`에서 Connected. child는 STOP(NOT_RUN): `--max-turns`가 지원되지 않고 기존 run에도 한도가 없었다. 기록은 `c2-git-v2/` |
| 이송 창 지시 2(13:05~13:30Z) | 이 packet. 첫 시도(13:03Z 무렵)의 메타 문서 작성이 자동 분류기에 거부돼 STOP했다. 사용자가 세션 안에서 승인한 뒤 진행했다. 게시 결과는 사후 private 로그에 있다 |

- dd2 원 private 218개 파일을 다시 읽어 dd2 MANIFEST의 pre sha와 대조했다. 218개 일치, 불일치 0이다(`dd2-private-recompare.tsv`).
  - 이 결과는 원 bytes와 manifest가 일치한다는 근거일 뿐이다.
  - dd2 공개본의 결함(13행)은 해소되지 않는다.
