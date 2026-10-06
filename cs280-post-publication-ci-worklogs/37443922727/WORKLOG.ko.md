# AGS 2.8.0 게시 후 CI 원로그

run `37443922727` attempt 1은 push event의 source `b7341d3e6636b79217b1f3d37d7a5014fcbf47be`에서 `completed/success`로 끝났다. 양OS Test 원로그 각각은 Test Files 67 passed / 1 skipped (68), Tests 916 passed / 5 skipped (921)을 기록한다. 이 실행은 이전 release QA 및 2.8.1 후보 실패 실행과 별도 episode다.

GitHub jobs API의 해당 단계 conclusion은 success다. 별도의 숫자 command-exit receipt는 제공되지 않았으므로 success를 numeric exit 0으로 바꾸지 않는다. 양OS setup 로그의 실제 Node는 v24.21.0이다. CPython은 Ubuntu 3.12.14, Windows 3.12.10이고 설치 출력의 pnpm은 양OS v11.19.0이다. npm 11.19.0 출력과 pnpm 관측을 구별했다. 설치의 Done 출력과 cache 경로를 보존하며 모든 검사의 fresh/reuse는 unknown이다.

이 게시된 2.8.0 workflow에는 official supplier validator 단계가 없다. validate:all success를 official 검사 실행으로 해석하거나 이전 supplier 5개 파일을 이번 실행의 관측으로 재사용하지 않는다. artifact API count는 0이다.

원 API JSON 3개와 전체 ZIP의 모든 로그를 private에 보존했다. 공개 사본은 명령·출력·실패·미실행·줄바꿈을 유지하며 runner 절대경로, hostname, 임시 UUID와 계정/opaque metadata만 선언 규칙에 따라 제거한다. MANIFEST는 원/공개 SHA·size와 치환 위치를, RUN-LOG-CONTENTS는 원 ZIP과 로그 digest를 기록한다. 현재 evidence base는 `3a98f2fcd4ebb105d754140babc7da7d25be1c83`이며 새 prefix만 추가한다. 제품·원자료·기존 payload 변경과 원격 변경은 0이다.
