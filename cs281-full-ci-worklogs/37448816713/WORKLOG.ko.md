# AGS 2.8.1 full CI 및 official 실제 성공 원로그

run `37448816713`, attempt 1, source `1b36ec771d641137e821f27c2066e05205c1e8f8`는 `completed/success`다. 양OS Test 각각은 Test Files 69 passed / 1 skipped (70), Tests 925 passed / 5 skipped (930)을 기록한다. skipped 5개를 통과 수로 합치지 않는다. 이 성공은 이전 `1209` 실행의 Windows broker 실패 원인을 입증하지 않으며 그 원인은 UNKNOWN으로 유지한다.

양OS artifact의 실제 `official-command.txt`는 `pnpm run validate:official`이고 `official-status.txt`는 EXECUTED다. `official-exit-code`, `official-step-exit-code`, `step-exit-code`, `preparation-exit-code`, `metadata-exit-code`는 모두 원 receipt의 숫자 0이다. 이 숫자는 GitHub step conclusion에서 추정한 값이 아니다. official.stdout는 plugin validation passed와 Skill is valid! 24개를 기록한다. official.stderr 37 bytes는 `$ node scripts/validate-official.mjs` 명령 출력으로 별도 보존한다. step.stdout/stderr 및 모든 실패·경고 원출력도 동봉했다.

각 artifact의 실제 supplier 5개 파일 SHA는 고정 supplier commit `10382da79a2a2d6e8ae221fa63077215389c1ad2`의 선언 SHA와 일치한다. 예전 supplier 파일을 대신 넣지 않았다. API의 artifact digest와 다운로드 ZIP의 SHA가 양OS 모두 정확히 일치한다. before/after 실제 source HEAD는 `1b36ec771d641137e821f27c2066e05205c1e8f8`, tree는 `bc71f67523fd5dee6ed339e5e83f557e744dad10`로 같고 Git status 출력은 비어 있다.

실제 Node는 양OS v24.21.0, pnpm v11.19.0, PyYAML 6.0.3이다. Python은 Linux 3.12.14, Windows 3.12.10이다. 요청값과 관측을 구별하며 개별 검사 fresh/reuse는 unknown이다. command/env/source identity 원파일과 전체 run 로그를 유지한다.

원 JSON 3개·전체 ZIP 로그 50개·양OS artifact 각24개를 private에 보존하고 안전 추출했다. 공개 사본은 artifact text/source 46개를 포함하며 Python bytecode .pyc 2개는 private에만 보존한다. ARTIFACT-CONTENTS는 제외 항목을 포함한 원 archive index/hash/API digest를, MANIFEST는 원/공개 파일 SHA·size와 치환 기준/위치를 기록한다. runner 절대경로·hostname·임시 UUID·계정/opaque metadata와 credential 후보를 제거하면서 commands/stdout/stderr·CRLF/BOM을 보존했다. 이번 Windows drive fallback은 URL의 s:/를 잘못 경로로 잡지 않도록 앞 boundary를 추가했으며 supplier URL을 유지했다.

evidence base `e56f5e5799d5a46940870a081df4a83cce6b5003`에서 새 prefix만 추가했다. 원자료·기존 payload·제품 source 변경, 로컬 제품 실행과 원격 mutation은 0이다. CI 실행 및 official 결과와 제품 출시·설치 승인을 구별한다.
