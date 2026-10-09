SS05 개발 검증을 고정 commit `c6a8019be30e4bf5ee9a36147ca45ae28b0f75b6`, tree `28f2f2ed8a864405320f6d20e7bc5004e8466ad3`에서 완료했다. fixture SHA256은 `17ade7e27cc11ffee8cc0b7b2070785617861d4c3384448cf24fce75f40d87e9`, 계산한 동결 oracle SHA256은 `5db1d67cef8719c40b17b0ab07003f01f765746d34ced0b326e59fadb2efe055`로 모두 일치한다. 원문, embedded sourceSpec의 8개 fields, 전체 oracle와 유일한 동결 variant `base`를 확인했다. 없는 `TEST-SPEC.seq7.ko.md`는 생성하거나 다른 원문으로 대체하지 않았다.

SS05는 lock 해제 순서와 cancellation 경합의 읽기 전용 diff 리뷰다. 필수 추천은 code-review, cs-engineering, orchestrator이며 ponytail과 test-engineering은 금지다. diff가 없거나 잘리면 리뷰 실행만 보류하고 CR·CS·O 필요성은 유지한다. 이번 개발자에게 허용된 격리 테스트 작성은 SS05 대상 AGENT의 금지 행동과 별개의 권한이다.

오프라인 격리 검사 28개를 실행했고 24개 PASS, 4개 FAIL이며 종료 코드는 1이다. 4개는 모두 배정 시 알려진 원인의 재현이며 신규 원인 수는 0이다. 기존 회귀의 SS05 assertion은 SS04·SS06과 묶여 있어 실행하지 않았고 SS05만 검사하는 동등 assertion을 격리 테스트에 넣었다. 전체 suite, 다른 사례, 과거 완료 21-run은 실행하지 않았다. JEV·외부 vendor API·Claude 호출은 각각 0이며 fetch guard의 시도 수도 0이다.

| 기존 원인 | SS05 입력을 사용한 관측 | 근거 |
| --- | --- | --- |
| invalid RESP와 함께 유효 비용 유실 | 비용 0.1인 빈 judgments RESP → actualCostUsd=null, spentUsd=0, 예약 1개 유지. 정상 RESP의 같은 비용 대조 사례는 spentUsd=0.1, 예약 0개 | service.ts:194,204,210 |
| timeout overflow | timeoutMs=2147483648 → Node가 1ms로 축소, PROVIDER_TIMEOUT과 모의 dispatch 1회. 호출 전 INVALID_TIMEOUT으로 거부해야 함 | service.ts:127,166 |
| 호스트 활성/지원 상태 공급 공백 | 직접 loader에 CR 미지원 관측을 주면 hostSupported=false. gateway에는 그 관측을 공급할 경로가 없어 true로 기본 처리 | gateway.ts:37,49; inventory.ts:218 |
| 수락 직전 동시성 재검사 공백 | accept의 readRuntime await 중 취소 → valid=true. accept 전 취소 대조 사례는 거부 | gateway.ts:117,123,125,136 |

위 결과는 TS 제품 경계를 직접 호출한 모의 provider·모의 runtime context 검사다. gateway가 내부에서 만드는 모의 receipt를 실 AGENT 선택 근거로 사용하지 않았고 결과 artifact로 내보내지도 않았다. 호스트 지원 공백은 공급 경로 부재를 재현한 것이며 실제 호스트의 CR 비활성 상태를 관측한 결과는 아니다. 메타데이터 조건 중복은 SS05의 allowedConditions={}에 해당하지 않아 시험하지 않았다.

올바른 R 집합, 각 필수 추천 누락, P/T 각각의 금지 추천, SEC/K 제외, 미판정 extra, 미등록 alias, select-all, null과 [], 무관측 NOT_RUN, unsigned 선택 거부, 자체 stage 완료 선언의 0 coverage, 전체 inventory와 부정 원문의 보존을 검사했다. 주입한 정답 집합의 scorer PASS는 실제 분류기의 의미 정확도가 아니다. 테스트별 입력·기대·관측은 `unit-observations.json`과 `SS05.result.json`에 있다.

실제 SS05 `selected/read/applied/verified`는 전부 NOT_RUN이며 각 원래 관측은 null이다. 로컬 개발 조사에서 SKILL을 읽은 사실은 실제 SS05 AGENT의 read 증거로 전환하지 않았다. missing-diff와 truncated-diff 실행 행동 경계도 실제 호스트 시험 없이는 NOT_RUN이다. semanticAccuracy=null이며 전체 case PASS나 독립 감사 PASS를 주장하지 않는다.

현재 Codex 실행 파일은 `<OBSERVED_CODEX_EXECUTABLE>`에 있지만 `AGENT_GOVERNANCE_CLASSIFICATION_CONFIG`는 없고 Claude 실행 파일도 발견되지 않았다. 이 경로 발견은 native capability 검증이 아니다. 제품 경로는 `.mcp.json`의 `node mcp-server/dist/server.mjs`, `get_skill_inventory → classify_skills → AGENT 판단 → record_skill_selection`, Codex host-attestation hook이다. native fallback 구현은 `createNativeClassificationAdapters`에 있다.

실호스트 후속 시험에는 SS05의 고정 diff 또는 base/head·변경 파일 목록, 승인된 config/profile/providerRuntime/nativeAdapterDefinitions, 현재 inventory·taxonomy에 결속된 qualification, 정확한 vendor/model/effort, 비용·쿼터, no-retry/isolation/capability 근거와 isolationArgs, 동일 actor/task의 실제 hook 관측이 필요하다. CR/CS 리뷰와 검증 artifact도 동일 후보에 결속해야 한다. 이 배정의 호출 0 제한에 따라 native/vendor 시험도 실행하지 않았다.

재현 명령은 아래와 같다. Node 24.19.0과 pnpm 11.19.0, 동일 lockfile의 기존 의존성을 사용했다. 현재 격리 clone의 node_modules는 기존 `<EXISTING_DEPENDENCIES>`를 가리키는 도구용 symlink다. 제품 파일과 커밋 번들은 변경하지 않았다.

```sh
cd <TEST_REPO>
node_modules/.bin/vitest run tests/skill-classification/SS05-isolated.test.ts --reporter=verbose --reporter=json --outputFile.json=evidence/SS05/vitest-results.json
# 예상: 24 passed / 4 failed, exit 1
python3 evidence/SS05/generate-result.py
```

제품 수정·build·push·PR·릴리스는 수행하지 않았다. tracked/staged diff는 비어 있다. 후속 수정 후보가 주어지면 이 SS05 격리 테스트로 동일 사례를 이어서 재검증할 수 있다.
