# 관리자 서명 기록과 설정 읽기

관리자 페이지의 사용법은 [관리자 페이지와 컨텍스트](../user/admin-page.md)에 있다. 이 문서는 페이지가 저장하는 서명 기록의 형식, 검증, 읽는 쪽의 동작, JEV 구성과 오류 코드를 정리한다.

## 페이지 서버

- 주소는 `http://localhost:<port>/`이고 기본 포트는 `47615`(`DEFAULT_ADMIN_PORT`, `runtime-config.ts`)다. `AGENT_GOVERNANCE_ADMIN_PORT`가 0~65535 밖의 값이면 서버는 진단 `admin-page` `port-invalid`를 남긴다. `0`이면 페이지를 열지 않는다.
- 3.9.0 서버는 포트가 쓰이고 있으면(`EADDRINUSE`) 페이지를 건너뛰고 진단 한 줄만 남겼다. 4.0.0(AGS3-D-0078)부터는 다음과 같다.
  - 설정 포트에서 `/api/state`를 물어 AGS 페이지가 답하면 그 페이지를 그대로 두고, 이 서버는 15초마다(`TAKEOVER_RETRY_MS`) 설정 포트를 다시 시도해 그 서버가 끝나면 이어받는다.
  - AGS가 아닌 프로그램이 포트를 쓰고 있으면 시스템이 고른 포트(`0`)에 페이지를 연다. 그마저 실패하면 진단 `admin-page` `listen-failed`를 남긴다.
  - 페이지를 연 프로세스는 포트와 pid를 공유 상태 폴더의 `admin-page.json`에 적는다. hook과 도구 응답의 주소는 살아 있는 기록을 따르고, 없으면 설정 포트를 쓴다.
- 서버는 `127.0.0.1`에만 묶인다. API는 localhost로 온 요청만 받는다.

## 정본: 패스키 서명 기록

- 사람이 바꾸는 항목의 정본은 공유 상태 파일(`context-layers.sqlite3`)의 `admin_log` 하나다. 기록은 추가만 한다.
- 기록 하나는 패스키가 서명한 canonical JSON 문자열(intent) 하나다. 내용은 `{v, domain:"ags.admin", rpId:"localhost", target, prevTargetHash, change, issuedAt}`이고 challenge는 SHA-256(intent)이다. 읽을 때 `canonicalJson(JSON.parse(s)) === s`를 강제한다.
- 대상(target)은 `keys`, `global`, `roles`, `binding:<host>:<sessionId>`, 그리고 설정의 `jev`(켜고 끄기·예산·프리셋), `jevKeys`, `locale`, `editExempt`다. `locale`(`locale.set`)은 4.0.0부터 적용하지 않는다. 기존 기록은 사슬 검증에만 쓰고, 새 `locale.set`은 `ADMIN_CHANGE_INVALID`로 거절한다(모든 문구가 `MODEL_LOCALE`로 고정됐다, [i18n.md](i18n.md) 4.1). 대상마다 이전 기록의 hash를 이어 거는 사슬이라 서로 무관한 대상끼리는 경합하지 않는다.
- 검증 항목: client data type(`webauthn.get`), challenge, origin(`http://localhost[:port]`), rpIdHash(`localhost`), 사용자 존재·사용자 확인(UP·UV) 플래그, 서명(ES256·RS256·EdDSA, `node:crypto`만 씀). signCount는 기록만 하고 판정에 쓰지 않는다. 페이지 서버는 저장할 때 origin이 자기 주소(`http://localhost:<설정 포트>`)와 같아야 받는다. 다른 localhost 포트에 띄운 비슷한 페이지가 받아 낸 서명으로는 저장할 수 없다. 이미 저장된 기록을 읽을 때는 포트 설정이 바뀔 수 있으므로 localhost의 어느 포트든 받는다.
- 첫 키는 자기 서명으로 등록한다(TOFU). 그 뒤 키 추가·폐기는 유효한 키의 서명이 있어야 한다. 마지막 키는 폐기할 수 없다. 폐기된 키가 그 뒤에 서명한 기록은 무효다.
- 저장은 검사와 추가를 한 트랜잭션(`BEGIN IMMEDIATE`)으로 한다. 같은 요청 ID로 다시 보내면 이미 저장된 기록을 돌려준다. 응답을 받지 못한 페이지는 다시 보내지 않고 `GET /api/request/:id`로 결과만 확인한다.

## 읽는 쪽(hook·MCP·페이지)

- 읽을 때마다 기록 전체를 순서대로 검증한다. 검증에 실패한 기록은 적용하지 않고, 그 대상은 서명이 유효한 마지막 판(rN)으로 동작한다. 유효한 판이 없으면 기본값(전역 컨텍스트 없음, 역할 없음, 결속 없음)을 쓴다. 권한이 줄어드는 쪽이다.
- hook은 실패한 대상마다 한 줄을 넣는다: 「검증 실패 · rN 적용 중 · 사용자에게 알릴 것 · 에이전트가 고칠 수 없음」.
- 전역 컨텍스트와 담당 컨텍스트는 따로 읽는다. 하나가 실패해도 다른 하나는 주입한다(D-0069).
- 페이지는 실패한 대상마다 빨간 띠와 [서명해서 채택]·[버리기]를 보여 준다. [서명해서 채택]은 실패한 기록이 요청하던 변경에 다시 서명하는 것이고, [버리기]는 현재 유효한 상태를 그대로 두겠다는 확인(`ack`)에 서명하는 것이다.
- 상주하는 MCP 서버는 대상마다 본 적 있는 가장 큰 seq를 메모리에 둔다. 기록이 그보다 줄면 `ADMIN_LOG_REGRESSED`로 알린다.

## 설정을 읽는 곳

설정 항목도 다른 서명 항목과 같은 검증 경로(`foldAdminLog`, `admin-settings.ts`)로 읽는다. 읽을 때마다 기록 전체를 검증하고, 검증에 실패한 기록은 적용하지 않는다. 그 항목은 마지막 유효 판, 그것도 없으면 기본값으로 동작한다.

| 항목 | 읽는 곳 | 바뀐 값이 적용되는 때 |
| --- | --- | --- |
| 편집 관문 예외 경로 | 편집 관문 hook(`continuity-hook.ts` `exemptEditRoots`) | 다음 편집부터 |
| JEV 켜고 끄기·모델·정보 전송 허용·대체 평가자·프리셋 | MCP 서버의 분류 런타임 읽기(`classify_skills`·선택 기록 때마다) | 다음 호출부터 |
| JEV 예산 | MCP 서버의 예산 예약(예약할 때마다) | 다음 예약부터 |
| JEV key | JEV 호출과 모델 목록 갱신 때 key 읽기(이름 `JEV_API_KEY`) | 다음 호출부터 |
| 벤더 경로 key | 설치 설정의 벤더 경로 자격 증명 읽기(`credentialEnvName`) | 다음 호출부터 |

- 예외 경로 기록을 읽지 못하면 예외를 하나도 더하지 않는다. 읽기 실패가 관문을 열지 않는다. 예외 경로는 최대 50개다(`EDIT_EXEMPT_MAX_PATHS`).
- JEV 설정을 읽지 못하면 JEV는 꺼진다. 예산을 읽지 못하면 JEV 예약을 하지 않는다.
- 비용: hook 한 번에 서명 기록을 한두 번 검증한다(파일 열기 + 기록 수만큼 서명 검증). 기록은 사람이 저장한 것만 쌓이므로 작다. 수천 개로 늘면 검증된 앞부분을 저장해 두는 방식으로 바꾼다(`context-layer-store.ts`의 `ceiling:` 주석).

### 환경 변수와 서명 기록이 둘 다 있을 때

기존 사용자가 환경 변수로 정한 값은 조용히 무시되지 않는다.

- **표시 언어(4.0.0에서 없앰):** `AGENT_GOVERNANCE_LOCALE`, 서명한 값, `settings.json`, 패키지 기본값 모두 효과가 없다. 언어를 고르는 설정 자체가 없어졌으므로 사용자 문서([admin-page.md](../user/admin-page.md#언어))에 그 사실을 적는다.
- **편집 관문 예외 경로:** `AGENT_GOVERNANCE_PHASE_EXEMPT_PATHS`가 비어 있지 않으면 그 목록이 이기고 서명한 목록은 쓰지 않는다(합치지 않는다). 페이지는 편집을 잠그고 환경 변수 목록을 보여 주며, 서명한 목록이 몇 개인지 적는다.
- **JEV(4.0.0부터):** MCP 서버가 전부 관리한다. 설치 설정 파일과 환경 변수는 JEV에 쓰지 않는다. 아래 「JEV 구성」을 본다.
- **벤더 경로 key:** 경로가 요구하는 이름(`credentialEnvName`)의 환경 변수가 있으면 그 값을 쓴다. 없을 때만 페이지에서 등록한 key를 쓴다. 페이지는 환경 변수가 있다는 사실만 보여 주고 값은 보여 주지 않는다.
- 잠금 표시는 페이지를 연 MCP 서버의 환경 기준이다. 호스트마다 환경 변수가 다르면, 그 호스트의 hook·서버에서는 그 호스트의 환경 변수가 이긴다.

## JEV 구성

JEV의 역할(조언 계층이며 관문이 아님), 쓰는 조건, 전송 항목과 4.0.0 이전 절차는 [사용자 문서의 JEV 절](../user/admin-page.md#jev-스킬-선택-조언)에 있다. 구현 쪽 사실은 다음과 같다.

- **공급자는 AGS 소스에 내장한다**(`mcp-server/src/skill-classification/jev-provider.ts`). 이 판의 공급자는 TypeSafe 하나다. 호출 주소 `https://api.typesafe.ai/v1/systemone`, 모델 목록 주소 `https://api.typesafe.ai/v1/models`, wire 형식 `jev-skill-selection-choice-r01`, key 이름 `JEV_API_KEY`. 공급자를 더할 때는 이 파일의 목록에 정의 하나를 더한다.
- **쓰는 조건의 모델 검사:** AGS가 아는 공급자·모델 이름 형식이어야 한다.
- **모델 목록:** 서버 메모리에 두고 24시간마다(실패하면 1시간 뒤) 다시 받으며, 동시에 들어온 갱신 요청은 하나로 합친다(`jev-model-catalog.ts`).
- **qualification 없음:** JEV에는 사전 qualification 관문을 두지 않는다. AGS가 만드는 JEV 프로필은 qualification을 `NOT_RUN`으로 적고, `classify_skills` 응답의 `adviceQualification`도 JEV 조언이면 `NOT_RUN`이다. 벤더 경로의 qualification 규칙(PASS·inventory 결속·만료)은 그대로다.
- **정보 전송 허용:** 서명한 허용이 JEV에서 설치 설정의 `externalClassificationAllowed`·`allowRemotePrivateContent`를 대신한다(벤더 경로에는 설치 설정을 그대로 쓴다). 페이지의 「전송 정보 자세히 보기」는 wire 형식이 실제로 만드는 항목을 보여 준다.
- **예산:** 서명한 한도만 쓴다. 호출마다 최대 비용(입력 상한 256 KiB를 1바이트=1토큰, 입력 USD 0.042/M로 계산한 약 0.0110 USD)을 미리 잡아 두고, 응답의 실제 사용량으로 정산한다.
- **대체 평가자:** 서명한 `vendorId`가 없으면 JEV 1회만 시도한다. 있으면 JEV가 조언하지 못할 때 그 벤더에 한 번 더 묻는다.
- **설치 설정에 남은 JEV 항목:** 설치 설정의 `jevEnabled`, JEV 경로(`providerKind: "jev"` route), JEV 프로필, `budget.jev`는 읽지 않는다. 남아 있으면 서버가 시작할 때 진단 한 줄(`jev-installation-settings-ignored`, 무시한 경로·프로필 수와 페이지 주소)을 남기고, 페이지도 같은 사실을 적는다. 3.9.0의 진단 `jev-off-until-signed`는 이 진단으로 바뀌었다.
- **D-0075:** 페이지와 workflow 변경 안내는 JEV를 실제로 부를 수 있을 때만 「쓰는 중」으로 말하고, 아니면 빠진 것을 적는다.

### JEV key 저장

- JEV key(`JEV_API_KEY`)는 이 페이지에 등록한 값만 쓴다. 같은 이름의 환경 변수는 JEV에 쓰지 않는다.
- 페이지는 key 값을 SHA-256으로 지문(`sha256:<hex>`)을 만든 뒤, 그 지문을 담은 변경(`jevKey.set {name, fingerprint}`)에 패스키로 서명한다. 서명 기록에는 지문만 남는다.
- 값은 서명한 commit 요청에만 함께 보낸다(`secret`). 서버는 값의 지문이 서명한 지문과 같은지 확인한 뒤, AES-256-GCM(`node:crypto`, 값마다 무작위 96-bit IV, 128-bit 인증 태그)으로 암호화해 서명 기록을 추가하는 트랜잭션 안에서 `jev_keys`에 저장한다. 인증 데이터는 이름과 지문이므로, 저장된 값을 다른 이름으로 옮기거나 다른 값으로 바꾸면 풀리지 않는다.
- 데이터 키(256-bit)는 공유 상태 파일 옆의 `jev-key-vault.bin`에 둔다(소유자만 읽기 권한, 플랫폼이 지원할 때). 처음 등록할 때 만든다.
- 읽는 쪽은 마지막 유효한 서명 기록의 지문과 저장된 값이 맞을 때만 값을 쓴다. 나중 기록이 검증에 실패하면 저장된 값이 그 기록의 것이므로 지문이 맞지 않고, key를 쓰지 않는다(key 없음으로 동작).
- 응답·페이지 상태·진단에는 값을 넣지 않는다. 재설정(`admin-reset`)은 저장된 key도 지운다.
- 지문은 소금 없는 SHA-256이다. 무작위로 만든 API key라면 지문에서 값을 되찾을 수 없지만, 짧거나 추측하기 쉬운 값은 지문으로 맞혀 볼 수 있다.
- 운영체제 키 저장소(Windows DPAPI 등)는 `node:crypto`만으로 쓸 수 없어 이 판에서는 쓰지 않는다. 암호화가 막는 것은 상태 파일만 따로 복사되거나 읽힌 경우(백업, 지원용 묶음, SQLite 파일 열람)다.

### 사용액

JEV 사용액은 이미 집계된 값만 보여 준다. 예산 객체(`InMemoryClassificationBudget`)가 이 MCP 서버 프로세스에서 쓴 금액(0에서 시작)과 예약 중인 금액이다. 서버마다 따로 세고, 서버를 다시 시작하면 0부터 다시 센다. 페이지는 그 값을 보여 주기만 한다.

## 에이전트 요청

- `checkpoint_global_context`와 `bind_session_role`은 서명 없는 요청(proposal)만 저장하고 `pending`·`proposalId`·`adminUrl`을 돌려준다. 페이지가 꺼져 있으면(`AGENT_GOVERNANCE_ADMIN_PORT=0`) 주소 대신 그 사실을 돌려준다. 같은 세션이 같은 대상에 새 요청을 내면 이전 요청을 대신한다.
- 결속은 역할 등록표에 있는 역할에만 요청할 수 있다. 없으면 `ROLE_NOT_REGISTERED`다.
- 결속은 root 세션 단위다. 서브에이전트는 root 세션의 결속을 이어받는다. 결속은 마지막 사용 뒤 30일이 지나면 없어진다(D-0070).
- root 세션 승인 창(`root-approval.ts`)은 관리자 서명 기록과 별개다.

## 무인증 보기

`GET /` 와 `GET /api/state`는 패스키 없이 열린다. 다른 웹 페이지가 읽거나 쓰지 못하도록 Host 헤더(`localhost:<port>`·`127.0.0.1:<port>`만)와 POST의 Origin·`Sec-Fetch-Site`·`Content-Type: application/json`·본문 64KiB 상한을 검사한다(DNS rebinding·cross-site 요청 차단). 페이지는 nonce CSP로 외부 스크립트·스타일을 막는다.

## 재설정

`admin-reset`은 기록 전체를 `admin_log_archive`로 옮기고 `admin_resets`에 `resetOf`(이전 마지막 기록 hash)를 남긴다. 대기 중인 요청은 거절 처리한다. 첫 등록 증명에는 MCP 확인 창(elicitation)을 쓰지 않는다. 같은 OS 사용자가 가짜 MCP 클라이언트로 자동 수락할 수 있기 때문이다. 막지 못하는 공격 목록은 [사용자 문서](../user/admin-page.md#막지-못하는-것)에 있다.

## 오류 코드

`ADMIN_KEY_NOT_REGISTERED`, `ADMIN_ALREADY_BOOTSTRAPPED`, `ADMIN_KEY_UNKNOWN`, `ADMIN_KEY_REVOKED`, `ADMIN_LAST_KEY_REVOKE_REFUSED`, `ADMIN_ALGORITHM_UNSUPPORTED`, `WEBAUTHN_PUBLIC_KEY_UNAVAILABLE`, `ADMIN_SIGNATURE_INVALID`, `ADMIN_CHALLENGE_MISMATCH`, `ADMIN_ORIGIN_REJECTED`, `ADMIN_RPID_MISMATCH`, `ADMIN_USER_VERIFICATION_MISSING`, `ADMIN_INTENT_NONCANONICAL`, `ADMIN_INTENT_EXPIRED`(intent 발급 뒤 10분), `ADMIN_TARGET_STALE`, `ADMIN_LOG_REGRESSED`, `ADMIN_PROPOSAL_NOT_FOUND`, `ADMIN_CHANGE_INVALID`(details.reason: `ROLE_NAME_TAKEN` 등, 설정은 `JEV_PRESET_UNKNOWN`·`JEV_KEY_NOT_FOUND`·`JEV_KEY_FINGERPRINT_MISMATCH`·`SECRET_UNEXPECTED`·`JEV_KEY_VAULT_UNAVAILABLE`), `ADMIN_RECORD_ALTERED`(파일에서 고쳐진 기록). HTTP 경계: `HOST_REJECTED`, `CONTENT_TYPE_REJECTED`, `REQUEST_TOO_LARGE`, `REQUEST_INVALID`, `STORE_UNAVAILABLE`.
