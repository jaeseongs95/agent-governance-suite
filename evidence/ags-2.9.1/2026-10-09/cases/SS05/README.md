SS05 기존 개발 증거 공개본입니다. 새 시험을 실행하지 않았습니다.

기준 후보 commit `c6a8019be30e4bf5ee9a36147ca45ae28b0f75b6`, tree `28f2f2ed8a864405320f6d20e7bc5004e8466ad3`입니다. fixture SHA256 `17ade7e27cc11ffee8cc0b7b2070785617861d4c3384448cf24fce75f40d87e9`, 동결 oracle SHA256 `5db1d67cef8719c40b17b0ab07003f01f765746d34ced0b326e59fadb2efe055`를 보존했습니다. UTF-8 원래 입력은 `inputs/originalPrompt.txt`에 추가 newline 없이 있습니다. 유일한 동결 variant는 `base`입니다.

실제 기존 결과는 오프라인 모의 검사 **24 PASS / 4 FAIL / exit 1**입니다. 실패 4개는 알려진 유효 비용 유실, timeout overflow, 호스트 상태 공급 공백, 수락 직전 취소 재검사 공백을 SS05 원문으로 재현한 결과입니다. 새로운 원인으로 중복 집계하지 않았습니다. 주입한 정답과 모의 runtime context는 실제 AGENT 선택 증거가 아닙니다. selected/read/applied/verified는 모두 **NOT_RUN**, 실제 관측은 **null**입니다. `[]`를 실제 선택으로 만들어 넣지 않았습니다. JEV/vendor/Claude/Codex API 호출은 기존 검사와 이번 게시 모두 **0**, 이번 새 시험도 **0**입니다.

`SS05.result.public.json`, `observations.public.json`, `vitest-results.public.json`, `command.public.json`은 기존 원본의 공개본입니다. 필요한 최종 로그는 `logs/vitest.combined.public.log`이며 최초 캡처부터 stdout/stderr가 합쳐져 있습니다. 별도 stream 원본은 MISSING_ORIGINAL이고 분리해 새 로그를 만들지 않았습니다. `<TEST_REPO>`, `<EXISTING_DEPENDENCIES>`, `<OBSERVED_CODEX_EXECUTABLE>`은 개인 로컬 경로의 정제 표시입니다. 파일별 원본 bytes/hash와 공개 bytes/hash 및 정제 내역은 `manifest.json`에 있습니다. SKILL 원문·case fixture·기대값은 변경하지 않았습니다.

`TEST-SPEC.seq7.ko.md` 원파일은 MISSING_ORIGINAL이며 embedded sourceSpec.fields만 사용합니다. 최초 26개 실행 당시 수정 전 테스트 bytes도 MISSING_ORIGINAL이므로 최초 run 산출물을 이 최종 run 게시물에 넣지 않았습니다. 제품 수정 patch는 **NO_PATCH**입니다. 실제 diff, 승인된 profile/route/budget/isolation 및 실제 host hook/task 관측이 없어 실호스트 판정을 진행하지 않았습니다. 세부 한계는 `provenance.json`과 기존 보고서 공개본에 있습니다.

재현 안내만 제공합니다. 이번 게시 작업에서는 다음 명령을 실행하지 않았습니다. 별도 검토용 checkout에서 고정 후보와 frozen lockfile 의존성을 준비하고 `reproduce/SS05-isolated.test.ts`를 그 checkout의 `tests/skill-classification/SS05-isolated.test.ts`에 복사한 뒤 `evidence/SS05` 출력 폴더를 준비합니다. 전체 suite나 build를 실행하지 않습니다.

```sh
node_modules/.bin/vitest run tests/skill-classification/SS05-isolated.test.ts --reporter=verbose --reporter=json --outputFile.json=evidence/SS05/vitest-results.json
```

기존 예상 관측은 24 passed / 4 failed와 exit 1입니다. 이 안내는 후속 후보가 달라져도 기존 결과를 승격하거나 덮어쓰라는 지시가 아닙니다. 이 evidence 브랜치의 제품 root·main·tag·다른 사례 경로를 재현용으로 변경하지 않습니다.

`manifest.json`은 모든 payload 파일의 bytes/SHA256를 나열하며 자기 자신의 hash를 포함하지 않습니다. `SHA256SUMS`는 payload와 manifest를 포함하고 자기 자신의 hash는 제외합니다. manifest 및 SHA256SUMS 자체의 SHA256는 게시 완료 응답과 독립 원격 검증 기록에 보고됩니다.
