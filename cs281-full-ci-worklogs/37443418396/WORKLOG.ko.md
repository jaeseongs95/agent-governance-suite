# AGS 2.8.1 full CI 원로그 공개 사본

run `37443418396` attempt 1은 source `ce0af09851ffa3d578436f4ec5266640964d2ee0` / tree `f9dc240888f6f8019b386594664d9c474ce31d34`에서 실행되어 `completed/failure`로 끝났다. Ubuntu와 Windows 모두 lint 단계에서 실패했다. 전체 QA 통과 근거가 아니다.

두 OS의 원출력은 `tests/engineering-practices/core.node.mjs`의 `readFileSync`, `captureSnapshot`과 `tests/engineering-practices/paths-runner-cli.node.mjs`의 `writeFileSync`가 사용되지 않았다는 `@typescript-eslint/no-unused-vars` 오류 3개, 경고 0개 및 exit 1을 기록한다. 앞선 설치·기존 bundle·Claude drift 단계는 성공했다. 이후 release/source/build/test/runtime/전체 validation/official 단계는 skipped다.

official 검사와 supplier 5개 원파일, 해당 stdout/stderr/exit receipt는 이 실행에서 `NOT_RUN` / `NOT_PROVIDED`다. `always()` artifact upload는 official evidence 디렉터리가 생성되지 않아 별도로 실패했다. API artifact count는 0이며, 존재하는 artifact의 다운로드 실패로 바꾸지 않는다. 이전 실행의 supplier 파일을 이번 실행의 관측으로 재사용하지 않는다.

원 API JSON 3개와 전체 run-log ZIP의 28개 로그를 private에 보존했다. 공개 사본은 metadata의 계정·opaque context를 제외하고 runner 절대경로·hostname·임시 UUID·credential 후보를 규칙대로 제거했다. 원문 파일 SHA/size, 공개 SHA/size, 치환 위치와 기준은 MANIFEST에 기록했다. RUN-LOG-CONTENTS는 원 ZIP과 원 로그의 digest를 기록한다. 공개 사본은 원자료의 명령·출력·실패·미실행 순서와 기존 줄바꿈을 보존한다.

이 packet은 evidence 기준 `94e108912b48a5b2dc34895c43635def8feba069`에 새 prefix만 추가한다. 제품 source 실행·수정 및 원격 변경은 수행하지 않았다. 실제 환경 세부값은 동봉된 setup/install 로그에서 확인할 수 있으며, workflow 요청값을 실제 관측으로 승격하지 않는다.
