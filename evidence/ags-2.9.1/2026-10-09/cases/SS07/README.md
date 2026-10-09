# SS07 기존 증거 게시

고정 후보 `c6a8019be30e4bf5ee9a36147ca45ae28b0f75b6`, tree `28f2f2ed8a864405320f6d20e7bc5004e8466ad3`.
fixture SHA256 `17ade7e27cc11ffee8cc0b7b2070785617861d4c3384448cf24fce75f40d87e9`, oracle `5db1d67cef8719c40b17b0ab07003f01f765746d34ced0b326e59fadb2efe055`.

동결 variant는 `base` 1개. SEC 필수, P·CR·독립 완료 감사 자동 추가 금지, 대상 소스 없으면 감사 실행 보류. embedded originalPrompt/sourceSpec.fields/oracle/variants 전체를 기준으로 검증했다.

기존 격리 검사 **16개: 13 PASS, 3 FAIL, exit 1**. 전체 사례 PASS가 아니다. 세 FAIL은 기존 발견 metadata 조건 중복, invalid RESP에서 유효 비용 유실, timeout overflow 재현이며 새 원인 중복 집계 0이다. 기존 별도 SS07 회귀 실행 0, 실제 provider/host 시험 NOTRUN. selected/read/applied/verified 각각 NOTRUN, 실제 AGENT 선택 집합과 hostReceipt는 null이며 []로 바꾸지 않았다. 합성 exact-SEC 응답은 evaluator/support control일 뿐 실제 AGENT 선택이 아니다.

JEV·외부 vendor API·Claude·native model 호출 0. 이 게시 단계의 새 시험 0, 새 모델 API 호출 0, 과거 run 재실행 0. 제품 수정·패치·PR·릴리스 없음. **패치는 처음부터 없었으므로 NO_PATCH_EXISTED**이며 새 패치를 생성하지 않았다.

`result.public.json`은 기존 결과의 정제본이다. `observations.public.json`은 모든 기존 입력/기대/관측을 유지하되 반복된 요청·payload 객체를 `inputs/` 참조로 정리했다. `inputs/request.json`, `fixture.json`, `inventory.json`은 원본 bytes 그대로이며 별도 prompt 파일은 원본 요청에서 UTF8 문자열을 그대로 추출했다(추가 newline 없음). 로그의 절대 개인 로컬 경로와 dependency stack 경로는 명명된 placeholder로 바꿨고 원래 assertion/종료값을 보존했다. 정제 전·후 bytes/hash와 변환은 `manifest.json`에 있다. private conversation·자격정보·환경 변수 값은 게시하지 않는다.

원본 회수 누락: `TEST-SPEC.seq7.ko.md` — **MISSING_ORIGINAL** (최초 저장소부터 부재, embedded 원문만 사용). 결과 JSON·stdout/stderr·명령·테스트·입력/기대/관측 원본은 회수했다. 임시 합성 대상 파일은 원 실행 후 삭제되었고 게시 시 복원하지 않았다; 합성 원문은 기존 테스트에 포함되어 있다. 원본 공개에서 제외한 help/version·empty diff 로그 등의 bytes/hash도 manifest 원본 inventory에 기록했다.

실제 호스트 검증에 필요한 입력: 실제 감사 root/CLI·MCP·설정 목록과 고정 bytes/범위/권한 모델, 승인 설치 classification config와 검증된 중앙 profile, native 경로·격리·no-retry·allowance/cost 근거, 실제 설치/활성/host지원 inventory, host-signed 선택 관측과 task binding, 같은 후보의 read/apply/verify 증거. 당시 AGS MCP 선택 도구가 없고 classification config 미설정이어서 실제 선택을 검증하지 못했다. 비용·metadata·overflow 결과는 `observations.public.json`과 보존된 runner 로그에서 대조할 수 있다.

## 재현 안내 — 게시 과정에서 실행하지 않음

별도 시험 승인을 받은 검토자가 고정 제품 후보와 Node 24.19.0/Vitest 5.0.0/기존 잠금 dependencies를 준비한 후, `reproduce/SS07.test.ts`를 후보의 `tests/ss07-isolated/SS07.test.ts`에 복사해 기존 runner로 실행한다. 공개 테스트는 출력 위치와 temp directory만 이식 가능한 형태로 바꾼 정제본이며 게시 중 실행하지 않았다.

```sh
node node_modules/vitest/vitest.mjs run tests/ss07-isolated/SS07.test.ts --reporter=verbose --reporter=json --outputFile.json=SS07-reproduction-output/SS07.vitest.json
```

고정 후보의 기존 결과는 exit 1이다. 이 안내는 과거 실행 로그를 대체하지 않는다. 로컬 경로가 포함된 원래 명령은 `commands.public.json`의 placeholder와 원본 digest로 구분했다.

`manifest.json`은 payload 파일만 hash하여 자기 hash를 포함하지 않는다. `SHA256SUMS`는 payload와 manifest를 포함하고 자기 자신을 제외한다. 파일 bytes/hash 원격 대조는 게시자 최종 응답에서 별도로 보고한다.
