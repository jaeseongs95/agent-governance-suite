# 로컬 관리자 페이지 (3.9.0)

사람이 정하는 AGS 설정을 사람이 직접 바꾸는 곳이다. 에이전트는 이 값들을 바꾸지 못하고 요청만 남긴다. 사용자는 페이지에서 요청을 확인하고 패스키로 서명해 승인한다.

## 여는 법

- 주소: `http://localhost:47615/` (`AGENT_GOVERNANCE_ADMIN_PORT`로 바꾼다. `0`이면 페이지를 열지 않는다).
- AGS MCP 서버가 시작할 때 페이지를 연다. 한 컴퓨터에서 여러 MCP 서버가 돌면 먼저 연 서버 하나가 페이지를 맡는다. 나머지는 포트가 쓰이고 있으면(`EADDRINUSE`) 건너뛰고 진단 한 줄만 남긴다. 모두 같은 공유 상태 파일을 쓰므로 어느 서버가 맡아도 같은 페이지다.
- 서버는 `127.0.0.1`에만 묶인다. 다른 컴퓨터에서는 열 수 없다.
- **localhost 필수.** 패스키(WebAuthn)의 relying party ID에는 IP 주소를 쓸 수 없다. 그래서 `http://127.0.0.1:<port>/`로 들어오면 이유를 적은 안내를 보여 주고 `http://localhost:<port>/`로 넘긴다. API는 localhost로 온 요청만 받는다.

## 무엇을 바꾸고 무엇을 보기만 하나

| 구분 | 항목 |
| --- | --- |
| 페이지에서 바꿈(패스키 서명) | 전역 컨텍스트, 역할 등록표(추가·이름 변경·삭제), 세션↔역할 결속, 패스키 목록, JEV 켜고 끄기(기본 꺼짐)·예산·프리셋, JEV key(지문만 보임, 값은 암호화), 표시 언어, 편집 관문 예외 경로(절대 경로만) |
| 보기만 | 담당 컨텍스트 본문(결속된 세션의 에이전트가 씀), JEV 사용액, 세션 현황, 변경 이력 |
| 페이지에 두지 않음 | 도구 스키마 프로필, 호스트 증명, DB·상태 경로, JEV 런타임·digest, 깨우기 방식 |

### 설정을 읽는 곳

설정 항목도 다른 서명 항목과 같은 검증 경로(`foldAdminLog`, `admin-settings.ts`)로 읽는다. 읽을 때마다 기록 전체를 검증하고, 검증에 실패한 기록은 적용하지 않는다. 그 항목은 마지막 유효 판, 그것도 없으면 기본값으로 동작한다.

| 항목 | 읽는 곳 | 바뀐 값이 적용되는 때 |
| --- | --- | --- |
| 표시 언어 | 모든 hook·CLI의 locale 결정(`resolveHostLocale`), MCP 서버의 기본 locale | hook은 다음 호출부터, MCP 서버는 다시 시작할 때 |
| 편집 관문 예외 경로 | 편집 관문 hook(`continuity-hook.ts` `exemptEditRoots`) | 다음 편집부터 |
| JEV 켜고 끄기·프리셋 | MCP 서버의 분류 런타임 읽기(`classify_skills`·선택 기록 때마다) | 다음 호출부터 |
| JEV 예산 | MCP 서버의 예산 예약(예약할 때마다) | 다음 예약부터 |
| JEV key | 승인된 원격 경로의 자격 증명 읽기(`credentialEnvName`) | 다음 호출부터 |

- 표시 언어 기록을 읽지 못하면 그 단계만 건너뛰고(`LOCALE_SIGNED_UNREADABLE`) 설정 파일·패키지 기본값으로 간다.
- 예외 경로 기록을 읽지 못하면 예외를 하나도 더하지 않는다. 읽기 실패가 관문을 열지 않는다.
- JEV 설정을 읽지 못하면 JEV는 꺼진다. 예산을 읽지 못하면 JEV 예약을 하지 않는다.
- 비용: hook 한 번에 서명 기록을 한두 번 검증한다(파일 열기 + 기록 수만큼 서명 검증). 기록은 사람이 저장한 것만 쌓이므로 작다. 수천 개로 늘면 검증된 앞부분을 저장해 두는 방식으로 바꾼다(`context-layer-store.ts`의 ponytail 주석).

### 환경 변수와 서명 기록이 둘 다 있을 때

기존 사용자가 환경 변수로 정한 값은 조용히 무시되지 않는다.

- **표시 언어:** `AGENT_GOVERNANCE_LOCALE`이 있으면 환경 변수가 이긴다. 순서는 환경 변수 → 서명한 값 → `settings.json` → 패키지 기본값 → `en`이다. 페이지는 환경 변수가 있으면 선택 칸을 잠그고, 잠근 환경 변수 이름과 서명해 둔 값을 함께 보여 준다. 서명할 때 「설정 파일·기본값 따름」을 고르면 `settings.json` 이후 순서를 그대로 쓴다.
- **편집 관문 예외 경로:** `AGENT_GOVERNANCE_PHASE_EXEMPT_PATHS`가 비어 있지 않으면 그 목록이 이기고 서명한 목록은 쓰지 않는다(합치지 않는다). 페이지는 편집을 잠그고 환경 변수 목록을 보여 주며, 서명한 목록이 몇 개인지 적는다.
- **JEV:** 설치 설정 파일(`AGENT_GOVERNANCE_CLASSIFICATION_CONFIG`)이 허용 범위를 정하고, 서명한 값이 그 안에서 정한다. 둘 중 좁은 쪽이 적용된다.
  - 켜고 끄기: 설정 파일의 `jevEnabled`가 `true`이고 서명한 스위치가 켜짐일 때만 켜진다. 서명한 기록이 없으면 꺼짐이다(기본값). 설정 파일이 `false`면 페이지 스위치를 잠근다.
  - 설정 파일이 `jevEnabled: true`인데 서명한 기록이 없으면, 서버는 시작할 때 진단 한 줄(`jev-off-until-signed`)을 남기고 페이지는 「꺼짐(기본값) · 이 페이지에서 켜야 동작합니다」를 보여 준다.
  - 프리셋: 서명한 기록이 끄지 않은 프리셋은 켜짐이다. 스킬 분류(`classify_skills`)는 JEV와 그 프리셋이 모두 켜져야 JEV를 쓴다.
  - 예산: 설정 파일의 `budget.jev.limitUsd`와 서명한 한도 중 작은 값을 쓰고, 어느 쪽이든 5 USD를 넘지 않는다. 설정 파일에 한도와 사용액이 모두 없으면 서명한 한도를 이 서버 프로세스에서 0부터 센다. 설정 파일에 한도만 있고 사용액이 없으면 예전처럼 예약하지 않는다.
- **JEV key:** 경로가 요구하는 이름(`credentialEnvName`)의 환경 변수가 있으면 그 값을 쓴다. 없을 때만 페이지에서 등록한 key를 쓴다. 페이지는 환경 변수가 있다는 사실만 보여 주고 값은 보여 주지 않는다.
- 잠금 표시는 페이지를 연 MCP 서버의 환경 기준이다. 호스트마다 환경 변수가 다르면, 그 호스트의 hook·서버에서는 그 호스트의 환경 변수가 이긴다.

### JEV key

- 페이지는 key 값을 SHA-256으로 지문(`sha256:<hex>`)을 만든 뒤, 그 지문을 담은 변경(`jevKey.set {name, fingerprint}`)에 패스키로 서명한다. 서명 기록에는 지문만 남는다.
- 값은 서명한 commit 요청에만 함께 보낸다(`secret`). 서버는 값의 지문이 서명한 지문과 같은지 확인한 뒤, AES-256-GCM(`node:crypto`, 값마다 무작위 96-bit IV, 128-bit 인증 태그)으로 암호화해 서명 기록을 추가하는 트랜잭션 안에서 `jev_keys`에 저장한다. 인증 데이터는 이름과 지문이므로, 저장된 값을 다른 이름으로 옮기거나 다른 값으로 바꾸면 풀리지 않는다.
- 데이터 키(256-bit)는 공유 상태 파일 옆의 `jev-key-vault.bin`에 둔다(소유자만 읽기 권한, 플랫폼이 지원할 때). 처음 등록할 때 만든다.
- 읽는 쪽은 마지막 유효한 서명 기록의 지문과 저장된 값이 맞을 때만 값을 쓴다. 나중 기록이 검증에 실패하면 저장된 값이 그 기록의 것이므로 지문이 맞지 않고, key를 쓰지 않는다(key 없음으로 동작).
- 응답·페이지 상태·진단에는 값을 넣지 않는다. 재설정(`admin-reset`)은 저장된 key도 지운다.

### 사용액

JEV 사용액은 이미 집계된 값만 보여 준다. 예산 객체(`InMemoryClassificationBudget`)가 이 MCP 서버 프로세스에서 쓴 금액(설정 파일의 `spentUsd`에서 시작)과 예약 중인 금액이다. 서버마다 따로 세고, 서버를 다시 시작하면 설정 파일 값부터 다시 센다. 페이지는 그 값을 보여 주기만 한다.

## 정본: 패스키 서명 기록

- 사람이 바꾸는 항목의 정본은 공유 상태 파일(`context-layers.sqlite3`)의 `admin_log` 하나다. 기록은 추가만 한다.
- 기록 하나는 패스키가 서명한 canonical JSON 문자열(intent) 하나다. 내용은 `{v, domain:"ags.admin", rpId:"localhost", target, prevTargetHash, change, issuedAt}`이고 challenge는 SHA-256(intent)이다. 읽을 때 `canonicalJson(JSON.parse(s)) === s`를 강제한다.
- 대상(target)은 `keys`, `global`, `roles`, `binding:<host>:<sessionId>`, 그리고 설정의 `jev`(켜고 끄기·예산·프리셋), `jevKeys`, `locale`, `editExempt`다. 대상마다 이전 기록의 hash를 이어 거는 사슬이라 서로 무관한 대상끼리는 경합하지 않는다.
- 검증 항목: client data type(`webauthn.get`), challenge, origin(`http://localhost[:port]`), rpIdHash(`localhost`), 사용자 존재·사용자 확인(UP·UV) 플래그, 서명(ES256·RS256·EdDSA, `node:crypto`만 씀). signCount는 기록만 하고 판정에 쓰지 않는다. 페이지 서버는 저장할 때 origin이 자기 주소(`http://localhost:<설정 포트>`)와 같아야 받는다. 다른 localhost 포트에 띄운 비슷한 페이지가 받아 낸 서명으로는 저장할 수 없다. 이미 저장된 기록을 읽을 때는 포트 설정이 바뀔 수 있으므로 localhost의 어느 포트든 받는다.
- 첫 키는 자기 서명으로 등록한다(TOFU). 그 뒤 키 추가·폐기는 유효한 키의 서명이 있어야 한다. 마지막 키는 폐기할 수 없다. 폐기된 키가 그 뒤에 서명한 기록은 무효다.
- 저장은 검사와 추가를 한 트랜잭션(`BEGIN IMMEDIATE`)으로 한다. 같은 요청 ID로 다시 보내면 이미 저장된 기록을 돌려준다. 응답을 받지 못한 페이지는 다시 보내지 않고 `GET /api/request/:id`로 결과만 확인한다.

## 읽는 쪽(hook·MCP·페이지)

- 읽을 때마다 기록 전체를 순서대로 검증한다. 검증에 실패한 기록은 적용하지 않고, 그 대상은 서명이 유효한 마지막 판(rN)으로 동작한다. 유효한 판이 없으면 기본값(전역 컨텍스트 없음, 역할 없음, 결속 없음)을 쓴다. 권한이 줄어드는 쪽이다.
- hook은 실패한 대상마다 한 줄을 넣는다: 「검증 실패 · rN 적용 중 · 사용자에게 알릴 것 · 에이전트가 고칠 수 없음」.
- 전역 컨텍스트와 담당 컨텍스트는 따로 읽는다. 하나가 실패해도 다른 하나는 주입한다(D-0069).
- 페이지는 실패한 대상마다 빨간 띠와 [서명해서 채택]·[버리기]를 보여 준다. [서명해서 채택]은 실패한 기록이 요청하던 변경에 다시 서명하는 것이고, [버리기]는 현재 유효한 상태를 그대로 두겠다는 확인(`ack`)에 서명하는 것이다.
- 상주하는 MCP 서버는 대상마다 본 적 있는 가장 큰 seq를 메모리에 둔다. 기록이 그보다 줄면 `ADMIN_LOG_REGRESSED`로 알린다.

## 에이전트 요청

- `checkpoint_global_context`와 `bind_session_role`은 서명 없는 요청(proposal)만 저장하고 `pending`·`proposalId`·`adminUrl`을 돌려준다. 같은 세션이 같은 대상에 새 요청을 내면 이전 요청을 대신한다.
- 결속은 역할 등록표에 있는 역할에만 요청할 수 있다. 없으면 `ROLE_NOT_REGISTERED`다.
- 결속은 root 세션 단위다. 서브에이전트는 root 세션의 결속을 이어받는다. 결속은 마지막 사용 뒤 30일이 지나면 없어진다(D-0070).
- root 세션 승인 창(`root-approval.ts`)은 이번 변경과 무관하게 그대로다.

## 무인증 보기

`GET /` 와 `GET /api/state`는 패스키 없이 열린다. 같은 컴퓨터의 사용자·에이전트는 어차피 공유 상태 파일을 직접 읽을 수 있으므로 보기를 막아도 얻는 것이 없다. 다른 웹 페이지가 읽거나 쓰지 못하도록 Host 헤더(`localhost:<port>`·`127.0.0.1:<port>`만)와 POST의 Origin·`Sec-Fetch-Site`·`Content-Type: application/json`·본문 64KiB 상한을 검사한다(DNS rebinding·cross-site 요청 차단). 페이지는 nonce CSP로 외부 스크립트·스타일을 막는다.

## 키를 모두 잃었을 때: 재설정

API로는 열지 않는다. 같은 컴퓨터에서 명령으로만 한다.

```bash
node <AGS 설치 경로>/mcp-server/dist/server.mjs admin-reset        # 무엇이 보관되는지만 출력
node <AGS 설치 경로>/mcp-server/dist/server.mjs admin-reset --yes  # 실제 재설정
```

- 기록 전체를 `admin_log_archive`로 옮기고 `admin_resets`에 `resetOf`(이전 마지막 기록 hash)를 남긴다. 대기 중인 요청은 거절 처리한다.
- 사람이 정한 항목은 모두 기본값으로 돌아간다. 그래서 재설정으로 권한을 얻지는 못한다. 다시 첫 패스키를 등록해야 저장할 수 있다.
- 재설정 사실은 페이지 상단에 계속 보인다.

## 막지 못하는 것

다음은 같은 OS 사용자로 도는 프로그램(에이전트 포함)의 의도적 공격이며, 이 설계로 막지 못한다. 대신 드러나게 한다.

- **첫 패스키 선점.** 키가 하나도 없을 때의 첫 등록은 확인 없이 받는다. 같은 컴퓨터의 에이전트가 먼저 등록하면 그 키가 첫 키가 된다. 키가 있으면 새 첫 등록은 `ADMIN_ALREADY_BOOTSTRAPPED`로 거절하고, 페이지 상단·패스키 화면에 최초 등록 시각과 지문을 늘 보여 준다. 이 브라우저가 등록한 credentialId를 기억해 두고 목록에 없으면 경고한다. MCP 확인 창(elicitation)은 첫 등록 증명에 쓰지 않는다. 같은 OS 사용자가 가짜 MCP 클라이언트로 자동 수락할 수 있기 때문이다.
- **코드·dist 패치.** AGS 설치 파일을 고치면 검증 자체를 건너뛸 수 있다.
- **기록 전체 교체.** 공유 상태 파일을 통째로 바꾼 뒤 자기 키를 첫 키로 심을 수 있다(최초 등록 시각·지문이 바뀌므로 페이지에서 드러난다).
- **꼬리 자르기.** 마지막 기록 몇 개를 지우면 이전 판이 유효한 상태로 보인다. 상주 MCP 서버는 자기가 본 seq보다 줄면 알리지만, 그 서버가 다시 시작된 뒤에는 알 수 없다.
- **읽지 않고 서명.** 사람이 내용을 읽지 않고 패스키를 누르면 막을 수 없다. 페이지는 서명 전에 바뀌는 내용을 보여 준다.
- 담당 컨텍스트 본문은 에이전트가 쓰므로 서명 대상이 아니다.
- **같은 OS 사용자의 JEV key 읽기.** key 값은 암호화해 두지만 데이터 키 파일도 같은 사용자 폴더에 있다. 같은 OS 사용자로 도는 프로그램(에이전트 포함)은 두 파일을 함께 읽어 값을 풀 수 있다. 암호화가 막는 것은 상태 파일만 따로 복사되거나 읽힌 경우(백업, 지원용 묶음, SQLite 파일 열람)다. 운영체제 키 저장소(Windows DPAPI 등)는 `node:crypto`만으로 쓸 수 없어 이 판에서는 쓰지 않는다.
- **key 지문.** 지문은 소금 없는 SHA-256이다. 무작위로 만든 API key라면 지문에서 값을 되찾을 수 없지만, 짧거나 추측하기 쉬운 값은 지문으로 맞혀 볼 수 있다.
- **환경 변수.** 환경 변수가 이기므로, 호스트를 띄우는 환경을 바꿀 수 있는 프로그램은 서명 없이 표시 언어·예외 경로·JEV key를 바꿀 수 있다. 서명 기록은 에이전트가 MCP 도구나 페이지로 바꾸는 길을 막는다.
- **요청 거절.** 요청(proposal)을 거절하는 데에는 서명이 필요 없다. 같은 컴퓨터의 프로그램이 대기 중인 요청을 거절할 수 있지만, 그것으로 바뀌는 설정은 없다. 결정된 요청은 30일 뒤 지운다.
- **agy 서브에이전트 root 기록.** agy 서브에이전트의 root 세션은 MCP가 남긴 기록 파일로 잇는다. 같은 OS 사용자는 이 파일을 고칠 수 있다.

## 오류 코드

`ADMIN_KEY_NOT_REGISTERED`, `ADMIN_ALREADY_BOOTSTRAPPED`, `ADMIN_KEY_UNKNOWN`, `ADMIN_KEY_REVOKED`, `ADMIN_LAST_KEY_REVOKE_REFUSED`, `ADMIN_ALGORITHM_UNSUPPORTED`, `WEBAUTHN_PUBLIC_KEY_UNAVAILABLE`, `ADMIN_SIGNATURE_INVALID`, `ADMIN_CHALLENGE_MISMATCH`, `ADMIN_ORIGIN_REJECTED`, `ADMIN_RPID_MISMATCH`, `ADMIN_USER_VERIFICATION_MISSING`, `ADMIN_INTENT_NONCANONICAL`, `ADMIN_INTENT_EXPIRED`(intent 발급 뒤 10분), `ADMIN_TARGET_STALE`, `ADMIN_LOG_REGRESSED`, `ADMIN_PROPOSAL_NOT_FOUND`, `ADMIN_CHANGE_INVALID`(details.reason: `ROLE_NAME_TAKEN` 등, 설정은 `JEV_PRESET_UNKNOWN`·`JEV_KEY_NOT_FOUND`·`JEV_KEY_FINGERPRINT_MISMATCH`·`SECRET_UNEXPECTED`·`JEV_KEY_VAULT_UNAVAILABLE`), `ADMIN_RECORD_ALTERED`(파일에서 고쳐진 기록). HTTP 경계: `HOST_REJECTED`, `CONTENT_TYPE_REJECTED`, `REQUEST_TOO_LARGE`, `REQUEST_INVALID`, `STORE_UNAVAILABLE`.
