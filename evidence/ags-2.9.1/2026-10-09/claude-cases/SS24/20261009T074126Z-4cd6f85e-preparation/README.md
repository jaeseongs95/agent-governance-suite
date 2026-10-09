# SS24 — 요청 중 ON OFF 및 provider 설정 변경

준비 완료 / 실제 Claude Code 시험 **NOTRUN** / 부모 입력 대기. 이 보고서는 실제 시험 PASS, 독립 SOURCE 승인, 릴리스 승인 또는 현재 후보 정상 동작을 주장하지 않는다. 새로운 제품 시험과 유료 호출은 모두 0회다.

고정 공개 근거는 `af579e2caa8c09b380bdf88b5e9c675b0b0b9c68`의 `evidence/ags-2.9.1/2026-10-09/cases/SS24/`다. 40개 파일의 실제 바이트를 읽었고 manifest 38개와 SHA256SUMS 39개가 모두 일치했다. 입력 `inputs/SS24.fixture.json`의 SHA256은 `e8b47493a0defabdda67b0b9aedcdd147b3efb6e99dd29a674ea011618508b41`다. 파일별 bytes/SHA256/Git blob은 `source-verification.json`에 있다.

역사적 전체 fixture SHA256 `17ade7e27cc11ffee8cc0b7b2070785617861d4c3384448cf24fce75f40d87e9` 및 corpus oracle `sha256:5db1d67cef8719c40b17b0ab07003f01f765746d34ced0b326e59fadb2efe055`도 재계산하여 일치했다. `c6a8019...`는 역사적 자료 검증에만 사용했고 시험 후보로 사용하지 않았다. 공개 SS24 입력은 역사적 corpus의 SS24 항목과 동일하다. SS24 `originalPrompt=null`, `oracle=null`, accuracy=null을 유지한다. 전체 corpus oracle digest는 SS24 의미 정답이 있다는 뜻이 아니다. `TEST-SPEC.seq7.ko.md` 원문과 원 provider wire는 없다. sourceSpec bodyDigest는 원문 부재로 재계산하지 못했고 기록된 값을 보존했다. E0·E1·E2의 세부 정의도 누락 원문에서 복구했다고 주장하지 않는다.

## 원래 입력과 판정 기준

아래 내용은 고정 fixture의 embedded sourceSpec.fields다. 기존 실패나 미실행을 기대값으로 바꾸지 않는다.

**입력**

revision 1의 ON·JEV 요청을 지연시킨 뒤 revision 2를 JEV OFF로 바꾸는 변형, providerProfileRegistryRef·profile revision을 바꾸는 변형을 실행하고 이전 응답을 도착시킨다. select 모드에서 OFF 변경 뒤 선택 반영 직전 경쟁도 포함한다.

**필수추천**

구 revision 응답은 해당 요청의 관측 기록으로만 남기며 최신 선택을 덮지 않는다. 새로운 설정은 다음 요청부터 사용하며, 실제 선택 반영 전 현행 revision을 재검사한다.

**금지추천 또는 행동**

같은 JEV 시도를 중복 전송; 늦은 JEV 응답으로 새 vendor 선택 덮어쓰기; OFF 뒤 새 JEV 호출 시작; 변경된 revision에 옛 모델·비용 snapshot을 사용.

**허용선택**

취소 요청 또는 응답 폐기·stale 표시. 이미 전송된 호출의 발생 비용은 지우지 않는다.

**보류조건**

취소 성공이나 비용이 확인되지 않으면 unknown으로 남긴다.

**통과기준**

request/configRevision 연결이 유지되고, revision이 다른 결과가 현재 후보·agentSelectedSkillIds를 교체하지 않는다. 다음 OFF 요청의 jevCallCount=0이고 허용된 vendor 분류는 가능하다. 현행 작업이 유효하면 현재 유효 profile로 분류 경로를 다시 결정하고, 취소·목적 변경이면 옛 선택을 중단한다.

**증거**

E0·E1·E2, 설정 변경 전후 순서와 호출수.

**실행종류**

mock.

## 기존 결과와 기대값

역사적 후보 `c6a8019be30e4bf5ee9a36147ca45ae28b0f75b6`에서 네 변형의 offline mock assertion은 통과했고 추가 경계 둘은 실패했다. 마지막 isolated 실행은 4 PASS / 2 FAIL, exit 1이다. 기존 targeted regression 8 PASS는 전체 성공이 아니다. 취소된 작업 선택 수락과 invalid late response 비용 유실은 유지해야 할 정답이 아니라 원래 요구 위반의 역사적 관측이다. initial helper counter 오류와 intermediate 로그는 최종 결과와 구별한다. 새 unique root cause나 R17에서의 결함 존속을 주장하지 않는다.

| 확인 대상 | 재개 후 유지할 기대 결과 |
| --- | --- |
| on-to-off | config-1 ON의 이미 시작된 응답은 원 요청 기록에 남는다. config-2 OFF 다음 요청 JEV 전송은 0회이며 승인된 vendor 분류는 가능하다. 옛 선택이 최신 선택을 덮지 않는다. |
| profile-ref-change | ref가 바뀌면 문자열 revision이 같아도 새 유효 profile/model/cost snapshot으로 다음 경로를 결정한다. 옛 응답을 새 선택에 적용하지 않는다. |
| profile-revision-change | 다음 요청은 갱신된 유효 profile revision 및 model/cost snapshot을 사용한다. 옛 응답의 request/config/profile 결속을 유지한다. |
| before-selection-race | select acceptance의 async 읽기 중 OFF 변경을 발생시킨다. 실제 반영 직전 현행 revision을 재검사하고 옛 선택을 거부한다. |
| cancellation boundary | acceptance await 중 authoritative current task가 취소되거나 목적이 바뀌면 선택을 저장하지 않는다. 유효한 작업은 현행 profile로 경로를 다시 결정한다. |
| known-cost invalid late response | 이미 발생하여 확인된 비용을 malformed/stale RESP 때문에 null/0으로 지우지 않는다. 비용·취소가 확인되지 않은 부분은 unknown 예약으로 남긴다. |

모의 profile의 `0.1`, `0.3`, `0.4`와 `code-review`는 synthetic fixture 값이다. 실제 provider 가격·예산, 실제 AGENT 정답이나 실제 선택 영수증으로 승격하지 않는다.

## 실제 Claude Code에서 확인할 단계

1. 부모가 전달한 검증 후보 commit/tree, 공통 model/effort, API 인증 방식 및 선행 검사 결과를 받는다. 실제 독립 checkout의 commit/tree와 Claude 설치물/runtime 해시를 확인하고 그 후보의 AGENTS.md/관련 SKILL.md/overlay를 읽는다. 이전 main 또는 역사적 c6a8019 후보로 대체하지 않는다.
2. 부모가 검증한 공통 API 인증 절차를 그대로 사용한다. 지정 CLI의 일회성 session/plugin 설정으로 실행하되 영구 인증·권한·네트워크 정책은 바꾸지 않는다. `--bare`는 hooks를 끄므로 실제 host attestation 시험에 임의 적용하지 않는다. 모델/effort/permission/MCP 설정과 인증 실행 명령은 지금 추측하거나 실행하지 않는다.
3. Sol은 고정 입력과 관측용 파일, 시간을 관리하고 실제 Claude가 호스트 도구와 선택·본문 읽기·적용·검증을 수행한다. Sol 작성 JSON, 합성 host 서명, Claude의 자기 선언, 단순 Vitest 실행을 실제 selected/read/applied/verified 영수증으로 대체하지 않는다.
4. trusted config/profile/qualification/route/current-task 관측을 공급한 격리 시험 환경에서 위 순서의 barrier를 제어한다. 공개 reproduce 두 파일은 assertions와 입력 근거로 읽되 원래 제품/생성물에 복사·수정하지 않는다. 기존 mock 실행과 actual Claude host 경로를 구별한다. 원래 실행종류는 mock이므로 delayed JEV/provider port는 합성임을 계속 표시하고 실제 JEV는 개별 배정 전 0회다. 원래 입력의 null 의미 oracle에 새로운 의미 선택 정답을 만들지 않는다.
5. `get_skill_inventory`, `classify_skills`, `record_skill_selection`의 후보에 맞는 실제 접점으로 요청/operation/config/profile/inventory digest를 관측한다. 늦은 응답이 도착하는 순서, 변경 전후 snapshot, request별 전송/재시도/중복 수, 선택 저장 직전 task 상태, 최신 선택 불변 및 비용 원장 상태를 보존한다. exact-call attestation과 authoritative cancellation 관측이 없으면 해당 host 단계는 BLOCKED/NOTRUN이다.
6. actual AGENT의 최종 선택을 recommendation과 구별하고 선택·읽기·적용·검증의 같은 대상 및 artifact digest를 각각 직접 증명한다. 모든 필수 경계에 직접 근거가 있을 때만 그 경계 PASS로 표시한다. 실제 host 증거 없는 offline 성공을 host PASS로 올리지 않는다. 결함이 나오면 제품을 수정하지 않고 expected/observed와 후보·파일 해시를 보고한다.
7. 모든 실제/준비/실패/자동 재시도 호출의 token/cache/cost를 기록한다. USD2는 soft allocation이며 소비 목표가 아니다. 한도에 접근하거나 unknown 예약을 해소할 수 없으면 다음 호출을 멈춘다. JEV는 별도 배정이 필요하다.
8. 원 채팅·개인정보·credential·민감 runtime 파일을 제외한 정제 보고서/근거/해시만 이 사례의 새 run 경로에 additive 게시하고 고정 원격 commit의 각 파일을 다시 읽어 검증한다.

## 현재 가능한 준비와 막힘

`/workspace/cloud-tools/claude/node_modules/.bin/claude --version`은 `2.1.286 (Claude Code)`다. resolved executable SHA256 `fe503f65c6289d59c23e5b21ae44f03583f997dd33a2cbfc75ab4f96fb8fc73f`. `--help`에서 print JSON/stream JSON, session `--plugin-dir`, `--max-budget-usd`를 확인했다. API 인증·health/provider 요청은 실행하지 않았다. Node `v24.19.0`, pnpm `11.19.0`가 존재한다. `.agents/skills`는 workspace·기존 local repo·evidence checkout 모두 없어서 저장소의 관련 skills를 읽었다. 이 지침 조회는 R17 지침 검증을 대신하지 않는다.

보고된 현재 후보는 R17 `fa1e250c1cbc4f8f446f2e2ddeb516f4e439edbb` / tree `43d2b4e49cdb6993c48d7adc792a3ef17426092e`다. 독립 SOURCE 판정과 원격 게시 확인, 공통 Claude model/effort/인증 실행 설정, 선행 검사 결과를 부모에게서 아직 받지 않았다. 실제 trusted runtime/profile·호스트 attestation 및 현재 task/취소 관측도 재개 전 확인해야 한다. 제품 시험과 유료 호출은 이 조건들을 기다린다.

`budget-ledger.json`의 이번 준비 소비는 USD0, 호출/토큰/캐시/재시도/실패 0, 사례 할당 잔여 USD2다. 다른 사례나 계정 잔액에 관한 주장이 아니다. 제품 코드와 생성 배포물, 영구 인증 설정은 수정하지 않았다.
