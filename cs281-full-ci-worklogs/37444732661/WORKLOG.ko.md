# AGS 2.8.1 두 번째 full CI 실패 원로그

run `37444732661` attempt 1은 source `bdaf8a223ce78d2f81b3368d845d8e1fbaa60248`에서 `completed/failure`로 끝났다. 양OS Lint의 `eslint . && node scripts/validate-repository.mjs` 뒤 `code-review: missing tests/code-review`, `test-engineering: missing tests/test-engineering`과 exit 1이 기록되었다. `&&` 뒤 repository 검사 출력에 도달한 것으로 ESLint 성공을 추론할 수 있으나 별도의 numeric ESLint receipt는 없다. 이전 run37443418396의 unused import 3개 오류와 다른 실패 episode다.

이후 공식 검사 단계는 skipped/NOT_RUN이고 supplier 5개 원파일, official stdout/stderr/exit receipt가 이번 실행에서 생성되지 않았다. always artifact upload는 미생성 디렉터리 때문에 실패했다. artifact API count 0을 다운로드 오류로 바꾸지 않는다. 앞선 설치·bundle·Claude drift 결과와 모든 후속 skipped는 동봉된 원로그 및 jobs metadata에 보존한다. full QA PASS가 아니다.

원 API JSON 3개와 전체 ZIP의 모든 로그를 private에 보존했다. 공개 사본은 명령·출력·실패·미실행·줄바꿈을 유지하며 runner 절대경로, hostname, 임시 UUID와 계정/opaque metadata만 선언 규칙에 따라 제거한다. MANIFEST는 원/공개 SHA·size와 치환 위치를, RUN-LOG-CONTENTS는 원 ZIP과 로그 digest를 기록한다. 현재 evidence base는 `3a98f2fcd4ebb105d754140babc7da7d25be1c83`이며 새 prefix만 추가한다. 제품·원자료·기존 payload 변경과 원격 변경은 0이다.
