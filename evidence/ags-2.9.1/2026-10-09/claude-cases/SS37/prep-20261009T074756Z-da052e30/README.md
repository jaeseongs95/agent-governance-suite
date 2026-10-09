# SS37 — 분류 metadata 확장과 전체 노출

상태: **PREPARED_WAITING_PARENT**. 실제 Claude 제품 시험: **NOT_RUN**. 준비 완료는 제품 PASS가 아니다.

원래 입력: “큐의 중복·유실 불변조건만 읽기 전용 분석”. 공개·합성 고정 입력 58바이트, SHA-256 `f24bf139711e4d311ddcf82528b97be91e9fd6349a4319c915a8cb036bc2075e`. 동결 evidence commit `af579e2caa8c09b380bdf88b5e9c675b0b0b9c68`의 SS37을 사용했다. SHA256SUMS 29개와 manifest payload 28개 모두 바이트·해시가 일치한다. 당시 fixture 전체 해시 및 SS37 case·metadataRoleCases·oracle binding도 읽기 전용 Git 객체 대조로 일치했다. `TEST-SPEC.seq7.ko.md`는 당시 없으며 embedded source fields를 보존했다. oracle은 null이다.

기대 결과는 최신 적용·제외 metadata와 활성 상태에 맞는 선택이다. neutral ID는 skill-z17, 역할 교환은 skill-z18, ID 변경은 neutral-q83을 요구한다. 숨은 필수 의존성·설치됐으나 미노출 infrastructure·없는 metadata는 공백을 기록하고 NEEDS_INPUT으로 진단한다. 같은 capability의 구현체를 전부 선택하지 않는다. 새 SKILL.md/registry 합성 입력은 단일 loader가 선택기 코드 수정 없이 노출해야 한다. 실제 registry는 바꾸지 않는다. 8개 변형과 음성대조, 네 목록 차이, metadata digest, 실제 host 관측을 모두 유지한다. `expected-results.json`은 판정자용이며 정답 labels를 대상 모델 입력에 넣지 않는다.

기존 결과는 이전 후보 c6a8019의 FAIL이다: targeted 4 PASS/0 FAIL/17 skipped, isolated 10 PASS/5 FAIL, supplement 2 PASS/0 FAIL/15 skipped. sensitivity proof는 INCOMPLETE이며 semantic selection·host-live 및 selected/read/applied/verified는 NOTRUN이다. 그 실패와 미실행을 기대값이나 이번 후보 결과로 쓰지 않는다.

로컬 Claude CLI는 `/workspace/cloud-tools/claude/node_modules/.bin/claude`, 버전 2.1.286으로 실제 확인했다. PATH에서는 발견되지 않았으나 절대 경로 실행이 가능하다. Node는 v24.19.0이다. API 키의 값은 읽거나 복사하지 않았으며 존재 여부만 확인했다. CLI version/help만 실행했고 인증 확인·모델 호출·제품 테스트·build·생성물 수정은 하지 않았다. Claude/JEV/기타 vendor 호출 0, 토큰·cache·retry·실패 호출 0, API 비용 US$0. SS37 총 소프트 예산 US$2에는 향후 준비·실패·재시도·캐시 호출도 포함하며 접근 시 다음 호출을 중단한다. JEV는 미배정이다.

현재 R17 후보 `fa1e250c1cbc4f8f446f2e2ddeb516f4e439edbb` / tree `43d2b4e49cdb6993c48d7adc792a3ef17426092e`는 부모의 독립 SOURCE 판정·원격 게시 확인을 기다린다. 공통 Claude model/effort, 성공한 session-local API 인증 절차, 분류 config/profile/route와 선행 검사 결과도 미수신이다. 이전 main·로컬 HEAD·c6a8019를 최종 후보 대신 실행하지 않았다.

재개 후 실제 Claude가 네 inventory 목록과 revision을 관측하고 연결된 AGS 도구를 사용해 분류, 최종 선택, skill 본문 읽기, 읽기 전용 분석과 검증을 수행해야 한다. Sol은 환경·근거를 관리한다. client hostReceipt는 null이며 실제 훅에서만 신뢰 근거를 얻는다. CLI 존재와 MCP 소스 검사만으로 host-live PASS를 주장하지 않는다. 원래 전체 통과 조건의 승인된 두 실제 host inventory는 이 단일 Claude 준비와 별도로 모두 필요하다. 구체적 재개 순서와 막힘은 `resume-plan.json`, 호출 원장은 `call-ledger.json`에 기록했다.

게시 범위는 기존 evidence 브랜치의 이 고유 run 디렉터리에 새 정제 보고서·공개 합성 입력 근거·해시 목록을 추가하는 것뿐이다. 제품 코드·배포물·기존 evidence·다른 작업자의 경로는 변경하지 않는다. 비밀·개인정보·원본 채팅·원시 인증 로그를 게시하지 않는다. 공개 입력 복사는 기존 공개 합성 fixture이며 모델 wire가 아니다. 실제 원격 게시 성공과 고정 commit 파일 재읽기는 별도 게시 검증 근거로 보고한다.
