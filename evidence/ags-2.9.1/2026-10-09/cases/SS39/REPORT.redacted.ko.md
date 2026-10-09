SS39 결과는 FAIL이며, 원래 12개 variant의 개별 정의 검증은 BLOCKED다.

후보는 `codex/skill-classification-2.9.1`의 commit `c6a8019be30e4bf5ee9a36147ca45ae28b0f75b6`, tree `28f2f2ed8a864405320f6d20e7bc5004e8466ad3`다. `git archive`로 별도 사본을 만들었다. Fixture SHA256 `17ade7e27cc11ffee8cc0b7b2070785617861d4c3384448cf24fce75f40d87e9`와 계산한 frozen oracle `5db1d67cef8719c40b17b0ab07003f01f765746d34ced0b326e59fadb2efe055`가 요청값과 일치한다. 원본 1,567개 파일의 바이트가 시험 후에도 동일하다.

원문 `sourceSpec.fields` 8개, `originalPrompt=null`, `oracle=null`, `counterexample-01..12`를 모두 읽었다. `TEST-SPEC.seq7.ko.md`는 사본에 없으며, fixture에는 12개 이름 외에 각각의 입력과 기대 결과가 없다. 이 12개는 입력·기대·관측을 각각 `null`, 상태를 `NOTRUN`으로 유지한다. 별도 보강 시나리오는 이 이름에 대응시키지 않았다. Embedded 요구가 명시한 SS03 prompt·golden을 읽어 prompt를 재사용하고, golden은 문맥 근거로만 보관했다. SS03 자체 테스트나 모델 의미 채점은 실행하지 않았다.

| 실행 종류 | 통과 | 실패 | 비고 |
|---|---:|---:|---|
| 기존 SS39 profile 회귀 | 8 | 0 | 해당 이름 필터의 제한된 검사 |
| 기존 SS19/39 OFF 공유 회귀 | 1 | 0 | SS39의 OFF 경로만 실행 |
| 새 SS39 경계 테스트 | 19 | 3 | 22개 별도 시나리오, 원래 variant 정답 아님 |
| 실제 모델 qualification·호스트 | 0 | 0 | NOTRUN |

보강 시험은 실제 service, profile 검증, route adapter, 비용 원장을 호출하고 HTTPS fetch와 native runner만 mock으로 대체한다. Vendor-A→model-a/low, Vendor-B→model-b/null과 전체 24개 inventory·SS03 원문의 모의 wire 전달을 확인했다. profile 부재·중복, 미검증·만료·미지원 옵션, 이전 fingerprint, 미승인 route·모델 미가용, egress·예산 부족은 다른 모델로 대체하지 않고 보류했다. 명시적 profile 갱신은 새 revision과 synthetic qualification으로 다음 요청에 적용됐다. 실제 품질·최저 비용 qualification 완료라는 뜻은 아니다.

심각한 실패 3개는 다음과 같다. 알려진 원인과 연결한 2개 그룹으로 기록해 중복 집계하지 않았다.

- `SS39-DEV-expiry-race`: availability 대기 중 qualification이 만료됐는데도 mock fetch 1회, 결과 SUCCESS. 최초 qualification 검증 뒤 비동기 경계에서 만료를 다시 검사하지 않는다.
- `SS39-DEV-stale-credential`: provider의 두 번째 credential 조회 중 profile revision이 변경됐다. mock fetch 1회 후 STALE_CLASSIFICATION으로 거부됐다. 전송 직전 재검사 공백의 추가 재현이다. 최종 response는 `dispatchState=not-started`지만 attempt는 `started`이므로 최종 response만 보고 무전송을 주장할 수도 없다.
- `SS39-DEV-invalid-response-cost`: 유효 actualCostUsd=0.6을 포함한 binding 불일치 응답에서 비용이 null로 유실됐다. spentUsd=0, invalidCostCeilings=[], unknown reservation=0.4다. 알려진 invalid RESP 비용 유실 원인을 재현했으며 새로운 원인으로 집계하지 않았다.

모든 JEV·외부 vendor·Claude·실제 native 호출, runtime catalog·가격 탐색, 과거 21-run 재실행은 0회다. 실제 AGENT의 selected/read/applied/verified는 전부 NOTRUN, agentSelectedSkillIds와 hostReceipt는 null이다. 테스트가 selection receipt를 만들지 않았다. oracle=null인 SS39의 정확도는 null이다. 제품 수정·push·PR·릴리스·전체 suite 실행은 하지 않았다.

재현 명령은 다음과 같다. 세 번째 명령은 현재 후보에서 assertion 실패 3건으로 exit 1이 정상 관측이다.

```sh
cd <pinned-repository>
node node_modules/vitest/vitest.mjs run tests/mcp/skill-classification-profiles.test.ts -t SS39
node node_modules/vitest/vitest.mjs run tests/mcp/skill-classification-service.test.ts -t 'SS19/39 OFF'
node node_modules/vitest/vitest.mjs run tests/ss39-independent/SS39.test.ts
```

`SS39.result.json`에는 provenance, variant별 NOTRUN와 누락 입력, 모든 command/exit, 22개 새 시나리오 결과, known finding 연결, API0, host 요구사항을 기록했다. `evidence/SS39-DEV-*.json`은 시나리오별 입력·기대·관측·비밀 제거 wire·원장을 포함한다. `evidence/*.vitest.json`과 stdout/stderr는 runner의 원시 근거다. `check-plan`은 READY/exit0, `check-proof`는 INCOMPLETE/exit1이다. 제품 수정 금지로 수정 후보의 green과 red/green sensitivity pair는 NOTRUN이다. 이것은 서명 없는 로컬 기록이며 독립 감사·실제 호스트 관측이 아니다.

현재 환경에는 `<codex-executable>`가 있지만 Claude executable과 `AGENT_GOVERNANCE_CLASSIFICATION_CONFIG` 설정이 없다. 실제 지원 연결 경로는 `mcp-server/src/index.ts` → runtime config → 중앙 profile registry와 provider runtime/native adapter definitions → `createNativeClassificationAdapters` → `classify_skills` → AGENT 결정 → 실제 hook 관측으로 검증하는 `record_skill_selection`이다. 코드상 native Codex 호출은 고정 model·effort, 구조화 output schema, read-only/ephemeral/ignore-user-config 인자를 사용한다. executable 존재만으로 이 기능·격리·no-retry가 실증되지는 않았다. 내장 native adapter는 non-null effort를 요구하므로 Vendor-B/null을 native에서 몰래 다른 값으로 바꾸지 않아야 한다. generic remote vendor adapter도 별도 등록이 필요하다.

실호스트 시험을 위해서는 원래 12개 counterexample의 입력·기대 결과, 승인된 설치 runtime config, 실제 현 호스트의 model/effort/지원 옵션과 workload qualification·고정가격 최소비용 근거, 승인 route·structured capability·no-retry·isolation 증거, 확인된 native allowance·예산·과거 소비·unknown 예약, 최종 AGENT 선택의 실제 hook 관측이 필요하다. 현재 배정의 외부 호출 0 제약은 유지하며 이 입력들을 임의로 만들지 않았다. 후속 수정 후보가 공급되면 같은 SS39 테스트로 이어서 재검증할 수 있다.
