공식 공급원은 rust-v0.158.0-alpha.2 / 10382da79a2a2d6e8ae221fa63077215389c1ad2로 동결했고 원격 Git·raw HTTPS의 blob 및 LF 바이트를 대조했다. 공식 세 Python 파일과 Apache-2.0 LICENSE·NOTICE를 임시 CODEX_HOME에 그대로 제공했다. Windows CRLF SHA는 원격 LF SHA로 재사용하지 않았다.

후보4ba/tree5fcc에서 pnpm validate:official은 1회 exit1. pnpm11.19 기본 verify-deps-before-run=install이 implicit install을 시도했고 기본 사용자 store 초기화 ENOENT로 실패했다. plugin 및 22개 skill 공식 validator는 NOT_RUN이며 출시 게이트는 BLOCKED다. 예상 밖 설치 시도와 FAIL을 숨기지 않았다. 동일 입력 재실행·직접 Python 대체 검사0. 1344 소스 바이트와 clean/tree 상태는 전후 동일하다.

첫 공개 스캔은 두 Git ls-files -z 로그의 NUL 때문에 exit1이었다. 두 번째 스캔은 공식 저장소의 이메일 형태 snapshot 파일명 때문에 exit1이었다. 모든 실패 로그·원본을 유지하고 공개 사본의 2688 경계 바이트를 가시적으로 escape하고 해당 형태 문자열을 제거했다. 검사 기준은 그대로다. 명령/exit, 원본→공개 SHA, cutoff, 제거 ledger 및 정확한 파일 집합을 동봉한다. 현재 전달 드라이버와 cutoff 이후 배달 로그는 범위 밖이며 원본 경로에 따로 남긴다.

새 의존성 입력을 별도로 검토해 준비하기 전 공식 PASS로 주장할 수 없다. full test/build/runtime/r1-r2통합/main/tag/release/호스트 설치/push를 수행하지 않았다. 기존 evidence는 변경하지 않은 로컬 게시 준비본이다. 비공개 원 ZIP·키·DB·내부 reasoning·다른 세션 원문은 공개하지 않는다.
