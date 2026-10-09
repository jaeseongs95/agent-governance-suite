# SS32 — 429와 중복 요청

상태: **PREPARED_WAITING_FOR_PARENT**. 실제 Claude Code 시험, 제품 판정, API 인증 검증은 **NOTRUN**이다. 이번 준비에서 제품 시험·JEV·유료 API 호출은 0회, API 비용은 US$0이다. Sol은 공개 입력·환경·근거만 준비했고 Claude의 호스트 작업을 대신 실행하지 않았다.

원래 근거는 공개 evidence commit `af579e2caa8c09b380bdf88b5e9c675b0b0b9c68`의 `evidence/ags-2.9.1/2026-10-09/cases/SS32/`이다. 이 커밋의 공개 payload 35개에 대해 SHA256SUMS 및 manifest의 raw bytes·크기·해시를 대조했고 모두 일치했다. 관측에서 파생한 입력 JSON 14개도 각각 bytes/SHA256을 검증했다. 전체 파일 해시는 `source-verification.json`, 입력별 해시와 원래 기대값은 `expected-observation-matrix.json`에 있다.

공개 fixture raw bytes SHA256은 `4ebfbc312fe2bd35334ecbe3f949676212c5261393f522ccd5642bb8901fcc6a`, 공개 원본 SHA256SUMS 자체 해시는 `b47079ed0dcc96428e9486ed991856c6d8540c57fd19548604c42723a256851e`이다. 기존 보고서의 frozen fixture 참조 `17ade7e27cc11ffee8cc0b7b2070785617861d4c3384448cf24fce75f40d87e9`와 frozen oracle 참조 `5db1d67cef8719c40b17b0ab07003f01f765746d34ced0b326e59fadb2efe055`는 그대로 기록했다. 이 둘은 공개 fixture raw bytes 해시와 구별하며, 이번 준비에서 원래 frozen source bytes/정확한 projection 알고리즘을 독립 복원했다고 주장하지 않는다.

원래 originalPrompt와 semantic oracle은 null이다. TEST-SPEC.seq7.ko.md의 SS32 embedded fields를 읽었으며 원본 문서 자체가 이번 고정 case 자료에 있는 것으로 주장하지 않는다. 입력 JSON은 기존 관측의 파생 인코딩이며 원래 직렬화 transport wire bytes는 MISSING_ORIGINAL이다. 재구성한 프롬프트·의미 정답·baseline B를 만들지 않는다.

원래 입력: 429 또는 529와 Retry-After를 반환하는 provider, 동일 operationId·requestId·digest의 동시 제출 두 개, 동일 requestId지만 다른 digest를 각각 주입한다. 실행 종류는 mock이며 rate limit을 만들기 위해 실제 API를 대량 호출하지 않는다.

원래 기대 결과:

- 429·529는 UNAVAILABLE/unavailable로 드러내고 기존 B 및 목적 적합성 판정을 보존한다.
- Retry-After 관측을 보존한다. 같은 JEV 시도는 최대 1회이며 재시도하지 않는다. 정책상 허용된 vendor fallback만 별도 attempt로 최대 1회 허용한다.
- 진행 중 동일 논리 요청은 고정 정책에 따라 공유 결과 또는 중복 거부한다. 이중 전송·과금·결과 합성·SDK 은닉 재시도·중복 완료는 0이어야 한다.
- 다른 digest는 INVALID이며 기존 요청의 결과를 오염시키지 않는다. 이전 처리 상태를 알 수 없으면 새 요청으로 재발급하지 않는다.
- E0·E1·E2, requestId·digest·전송 계수를 같은 입력 및 후보에 결속해 남긴다.

기존 결과는 c6a8019be30e4bf5ee9a36147ca45ae28b0f75b6/tree 28f2f2ed8a864405320f6d20e7bc5004e8466ad3의 과거 mock 결과다. 선택된 기존 회귀 6 PASS, 격리 사례 11 PASS/3 FAIL(exit1), acceptance report FAIL이다. Retry-After 숫자/HTTP-date 관측 유실 2개 assertion은 한 원인이며, 취소 후 1회 mock wire가 나간 추가 경계 assertion은 알려진 pre-dispatch 재검사 공백이다. 실제 외부 SDK, baseline B/목적 판단, selected/read/applied/verified는 NOTRUN이었다. 이 과거 FAIL/NOTRUN을 정답으로 삼거나 새 후보 결과로 옮기지 않는다.

재개 후 실제 Claude Code에서 확인할 순서:

1. 부모가 검증한 최종 후보와 공통 모델·effort·API 인증 절차·선행 검사 결과를 먼저 받는다. 보고된 R17 commit fa1e250c1cbc4f8f446f2e2ddeb516f4e439edbb/tree 43d2b4e49cdb6993c48d7adc792a3ef17426092e는 아직 부모의 독립 SOURCE 및 원격 게시 확인을 기다린다. 다른 main이나 과거 c6a8019를 제품 시험 대상으로 사용하지 않는다.
2. 별도 final-candidate checkout에서 commit/tree와 AGENTS.md, 관련 원본/Claude SKILL.md·overlay·MCP·hooks·배포 바이트를 다시 읽고 해시를 고정한다. 현재 로컬 main 지침은 준비에만 사용했다. 최종 후보 lock/dependencies를 확인하고 수정·빌드·재생성 없이 실행할 수 있는 시험 사본/overlay 경로를 정한다.
3. 부모의 성공한 API 인증 절차를 비밀값 출력 없이 그대로 적용한다. 로컬 CLI --version/--help는 인증 성공 증거가 아니다. 영구 인증·권한·네트워크 정책을 바꾸지 않는다. Claude CLI에는 --model, --effort, --max-budget-usd, --output-format 및 --plugin-dir가 존재함만 확인했다. 모델이나 인증 설정은 추측하지 않는다.
4. Sol이 제공하는 wrapper에는 원래 fixture 및 원본 기대값을 참조하고, synthetic payload가 의미 정답이 아님을 명시한다. Claude가 직접 후보의 public boundary, runner, fixture를 읽고 tool call로 mock 시험을 수행해야 한다. Sol이 미리 제품 시험을 실행한 결과를 Claude 결과로 포장하지 않는다. 기존 public repro는 해시가 고정된 검토 근거이며 실행 시 호환성/isolated harness를 확인한다. 제품 코드와 생성 배포물은 변경하지 않는다.
5. 후보와 호환되는 격리 시험 사본에서 기존 6회 회귀 및 원래 14개 mock 기대값을 실행하고 명령 argv, 시작/종료, exit, assertion, requestId/operationId/digest, JEV/vendor 모의 전송 계수와 비용 settlement를 캡처한다. 명령의 후보/테스트 해시도 기록한다. 기존 runner 후보 명령은 `node scripts/run-tests.mjs tests/mcp/skill-classification-providers.test.ts tests/mcp/skill-classification-service.test.ts -t 'SS30/32 HTTP (429|529)|SS28/30/32 RATE_LIMITED|SS32 (concurrent|rejects|bounded)'` 및 `node scripts/run-tests.mjs tests/skill-classification/SS32.isolated.test.ts`이다. 이는 계획이며 지금 실행하지 않았다. 원래 repro의 취소/경계 조건이 새 후보 구조와 호환되는지도 확인한다.
6. 실제 Claude session/tool invocation과 same-candidate signed exact-call host evidence가 있는지 별도로 확인한다. mock wire counter는 실제 JEV/API 호출 수와 구분한다. 실제 SDK no-hidden-retry는 mock만으로 검증됐다고 주장하지 않는다. baseline B/목적 판단·trusted host task/session·MCP configuration·approved routes/native capability가 없으면 해당 항목을 BLOCKED/NOTRUN으로 유지한다. 빈 judgments를 AGENT no-skill 선택으로 취급하지 않는다.
7. 호출마다 input/output/cache tokens, cost, 실패·재시도·미확정 비용을 budget-ledger에 합산한다. 준비 호출 포함 US$2 soft budget에 접근하거나 다음 호출 상한을 확정할 수 없으면 멈추고 보고한다. CLI budget flag가 실패/재시도/전체 run 누적 기록을 대신하지 않는다. JEV 별도 배정 전에는 mock 외 JEV 호출을 하지 않는다.
8. 원래 기준별 현재 후보 직접 근거로 판정한다. 종료 코드 0이나 consistency valid=true만으로 제품 PASS를 선언하지 않는다. 민감값·개인정보·원본 채팅은 공개하지 않고 정제한 근거·보고서·해시 목록만 이 run 아래 별도 추가 commit으로 게시한 뒤 고정 원격 파일을 재독해 검증한다.

준비 결과: 지정 CLI `/workspace/cloud-tools/claude/node_modules/.bin/claude`는 실제 환경에서 2.1.286으로 확인했다. Node v24.19.0, pnpm 11.19.0을 확인했고 로컬 dependencies는 있으나 최종 후보 호환성은 미확인이다. 환경 및 저장소 `.agents/skills`는 없어서 repository `skills/`에서 test-engineering, acceptance-evidence-validator 및 관련 references를 읽었다. 원본 input hash verification, 14개 expected matrix, 예산 ledger, resume gate를 준비했다. 현재 제품 시험·유료 API 호출·JEV 호출은 시작하지 않았다.

막힘/재개 조건: 부모의 검증된 후보/원격 근거, 공통 Claude 모델·API 인증/실행 설정 및 선행 검사 결과를 받아야 한다. 제품 코드·생성 배포물 변경은 승인 범위에 없고 모든 시험/호스트 단계는 미실행이다. 준비 완료는 실제 시험 PASS가 아니다.
