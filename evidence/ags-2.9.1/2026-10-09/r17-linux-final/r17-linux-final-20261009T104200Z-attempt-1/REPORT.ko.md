# R17 Linux 최종 오프라인 검증 — FAIL / 부분 통과

고정 제품 commit fa1e250c1cbc4f8f446f2e2ddeb516f4e439edbb, tree 43d2b4e49cdb6993c48d7adc792a3ef17426092e, parent 61a6f15fcb09d2082f32ab09e82a6247e3449d49.

입력 ZIP 84,403B와 원문 5개 330,857B, SHA 목록, 전체 source 1,577 path/mode/blob/bytes 및 물리 파일 바이트를 대조했다. SOURCE-GIT-TREE에서 tree43d를 독립 재구성했다. 기존 frozen install exit0/lock 동일 및 공식 공급자 5개 pin을 재사용했다.

r2 최종 명령 19개를 순서대로 한 번씩 실행했다. 16개 exit0, bootstrap 모의시험 3개 exit1이다. 전체 pnpm test: 100 files PASS, 1 file SKIP; 1,464 tests PASS, 5 tests SKIP, FAIL0. R17 freshness 9개가 이 전체 run에 포함됐고 별도 반복하지 않았다. skip은 tests/session-messaging/previous-broker.test.ts의 5개이며 PASS로 바꾸지 않았다.

실패: contract-selfcheck.mts:77의 모의 fetch 기대21/실제0; expiry-regression.mts:50 기대1/실제0; budget-regression.mts:81 기대2/실제0. 각 프로그램은 첫 assertion에서 멈췄으므로 후속 내부 분기는 미완료다. raw stdout/stderr/exit를 보존했고 수정이나 재실행하지 않았다. 읽기 전용 코드 대조에서 mock profile qualification.status=NOT_RUN인 반면 현 adapter는 dispatch 직전에 validateProviderProfile을 재검사하고 PASS가 아니면 막는 경계를 확인했다. 이는 정적 원인 분석이며 삭제된 임시 raw 결과의 error code를 새로 실측했다고 주장하지 않는다.

별도 node_modules 없는 stdio: 원 세션 initialize/tools-list/inventory는 성공(31 tools, 24 local-tree skills). glossary 요청에 실행자가 잘못 붙인 sha256: prefix 때문에 INVALID_INPUT이었다. 원 실패를 보존한 뒤 plain 64자리 hex의 다른 입력으로 glossary 요청 한 개를 별도 연결에서 검증해 matched/2 matches/sourceDigest 동일을 확인했다. 원 4응답 세션 자체는 전체 PASS가 아니다. host discovery는 UNAVAILABLE/HOST_DISCOVERY_UNAVAILABLE이며 local-tree inventory만 확인했다. 실제 host 선택/read/applied/verified, model/provider qualification 및 39/120은 NOT_RUN이다.

사전 shell Git purpose read는 실행자 환경 allowlist에서 프록시 변수를 제외해 DNS 실패 exit128이었다. 실패를 보존했고 동일 명령 재시도는 없었다. 후속 shell fetch/해당 FETCH_HEAD 관측은 NOT_RUN으로 남겼다. 연결 GitHub exact commit 읽기와 이미 byte 검증된 clean checkout에서 독립 오프라인 검사를 계속했다. 이 원격 전처리 실패를 성공으로 바꾸지 않는다.

build/test 후 양 server는 각각 1,858,039B 및 SHA256 182c498063e54c475724fc42a4af58f7bc93c125673ece45e82c804100a1acef 그대로다. 최종 전체 source 1,577파일 변화0, HEAD/tree/parent 유지, tracked/untracked clean. subreaper remainingChildren=false/runnerExitCode0/cancelled=false, reaped68이며 기록된 PID의 /proc 경로가 남지 않았다. 공식 validator exit0(plugin1+skills24).

제품 코드/main/릴리스 변경0, 외부 모델·유료/provider API 호출0. 승인된 Git 입력 수신 및 evidence 게시 네트워크 동작은 이 0회에 포함하지 않는다. 이 결과는 R17 Linux 전체 수용 PASS나 실제 호스트/모델·릴리스 완료를 발급하지 않는다. 원자료는 실행자 owned attempt에 보존하고 이 공개 사본은 상태 DB, 입력 원문/ZIP, 인증·승인 원문을 포함하지 않는다.
