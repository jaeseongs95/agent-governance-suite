# SS22 — shadow 준비 단계와 실제 채택 구분

상태: **준비 완료 · 부모 입력 대기 / 실제 Claude Code 시험 NOT_RUN**. 준비 중 Claude·JEV·기타 모델 API 호출은 0회, 비용 US$0, 토큰·캐시·재시도·실패 호출은 모두 0이다. 제품 시험 PASS나 독립 SOURCE PASS를 주장하지 않는다.

원자료는 고정 evidence commit `af579e2caa8c09b380bdf88b5e9c675b0b0b9c68`의 `evidence/ags-2.9.1/2026-10-09/cases/SS22/`에서 읽었다. SHA256SUMS의 24개 항목과 manifest의 23개 payload 항목이 현재 공개 바이트와 일치했다. 전체 해시·바이트 목록은 `input-integrity.json`에 있다. fixture SHA256은 `fa16eb98f996666b7fec150510b9e4e0684b78082a027836c602c989aae5c45f`, 연결 공개 합성 입력 SHA256은 `171b2e6448bfb900319cb9ceb112dc79edf208a9791fb57dba27252a394aeee9`이다. 원래 fixture와 연결 입력의 공개 바이트는 `inputs/`에 그대로 보존했다.

SS22 자체의 `originalPrompt=null`, `oracle=null`은 그대로 유지한다. `TEST-SPEC.seq7.ko.md` 원파일은 공개 근거에 없으므로 동결된 `sourceSpec.fields`를 기준으로 삼는다. SS03은 연결 합성 입력의 출처일 뿐 SS03 시험을 실행하지 않는다. 역사적 full-corpus SHA256 `17ade7e27cc11ffee8cc0b7b2070785617861d4c3384448cf24fce75f40d87e9`와 oracle digest `5db1d67cef8719c40b17b0ab07003f01f765746d34ced0b326e59fadb2efe055`는 기존 기록이며 이번 준비에서 full corpus나 의미 점수를 재계산한 것이 아니다.

기대 결과: B={P}, raw={P,CS,T,O}를 같은 의미 입력의 별도 shadow/select 요청으로 다룬다. P=`ponytail`, CS=`cs-engineering`, T=`test-engineering`, O=`orchestrator`다. shadow는 observe-only이며 `adviceApplied=false`, B의 CS·T·O 누락은 품질 FAIL로 남는다. select에서는 실제 Claude가 같은 지원 정보·기준으로 선택하고 S에 네 필수 스킬이 있어야 하며 `adviceApplied=true`의 실제 반영 경계를 기록한다. 실제 선택 반영 경계를 관측하지 못하면 select는 NOT_RUN이다. shadow 비교만으로 누락 해결이나 출시 PASS를 선언할 수 없다. `null`과 `[]`, 분류 지원과 실제 선택, 선택과 파일 읽기·적용·검증을 구분한다. `valid=true`는 목적 충족의 증거가 아니다.

기존 결과는 c6a8019 후보의 `FAIL_OFFLINE; HOST_NOTRUN`, 격리 offline 13개 중 12 PASS/1 FAIL, 정식 민감도 근거 INCOMPLETE였다. 런타임 재읽기 중 취소됐는데 acceptance가 true로 선택을 저장한 기존 공백이 실패 원인이다. 요구되는 올바른 결과는 취소 거절과 selected=null이다. 기존 실패를 정답으로 바꾸거나 R17 결과로 이전하지 않는다. 기존 native host receipt와 full mock wire 원본은 MISSING_ORIGINAL이며 새로 만들어 원본으로 주장하지 않는다.

로컬 Claude CLI는 `/workspace/cloud-tools/claude/node_modules/.bin/claude`, 버전 `2.1.286 (Claude Code)`, 실행 바이트 SHA256 `fe503f65c6289d59c23e5b21ae44f03583f997dd33a2cbfc75ab4f96fb8fc73f`다. PATH에서는 발견되지 않았지만 절대 경로의 `--version`·`--help`가 성공했다. Node v24.19.0, Git 2.52.0이다. API 인증·모델 접근성·plugin 활성화는 아직 검사하지 않았다. `--max-budget-usd` 등 로컬 지원 옵션을 확인했으며 실제 모델·effort·인증·권한 옵션은 부모 공통 절차가 정한다.

현재 R17 제안 commit `fa1e250c1cbc4f8f446f2e2ddeb516f4e439edbb`, tree `43d2b4e49cdb6993c48d7adc792a3ef17426092e`는 부모 검증 대기다. 이 준비에서 main이나 c6a8019를 제품 시험 대상으로 실행하지 않았다. 실제 시험은 검증된 후보, 독립 SOURCE 판정, 고정 원격 게시 확인, 공통 정확한 모델·effort/API 인증 절차와 선행 검사 결과 수신 후 재개한다. 후보 지침·Claude overlay·MCP 도구·qualified classification 설정·실제 host observation도 확인해야 한다. JEV는 개별 배정 전이며 승인된 mock 입력 경로 또는 별도 JEV 배정이 필요하다.

실행 단계와 재개 조건은 `resume-plan.json`, 비용 장부는 `usage-ledger.json`, 지침 읽기 근거는 `instructions-read.json`에 있다. Sol은 환경·근거를 관리하고 실제 host 작업과 스킬 선택은 Claude가 수행한다. 모드별 request/operation/receipt를 분리하고 E0·E1·E3 및 selected/read/applied/verified를 각각 기록한다. US$2는 준비 호출까지 포함하는 사례별 소프트 한도이며 소비 목표가 아니다. 한도 접근 또는 비용 불확실 시 다음 호출을 멈춘다.

게시 범위는 이 고유 run 경로의 정제된 준비 보고·공개 합성 입력·근거·해시뿐이다. 제품 코드·생성 배포물·영구 인증·권한·네트워크 정책은 변경하지 않았다. 비밀값·개인정보·원본 채팅·원시 Claude 대화는 게시하지 않는다. 독립 감사나 제품 수용 CLI 실행 결과를 만들지 않았다. 로컬 준비 지침은 사용 가능한 checkout의 것으로 후보 시험 전 재확인이 필요하다.
