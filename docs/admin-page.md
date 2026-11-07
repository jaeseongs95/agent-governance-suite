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
| 페이지에서 바꿈(패스키 서명) | 전역 컨텍스트, 역할 등록표(추가·이름 변경·삭제), 세션↔역할 결속, 패스키 목록 |
| 보기만 | 담당 컨텍스트 본문(결속된 세션의 에이전트가 씀), 세션 현황, 변경 이력, 표시 언어, JEV 설정, 편집 관문 예외 경로 |
| 페이지에 두지 않음 | 도구 스키마 프로필, 호스트 증명, DB·상태 경로, JEV 런타임·digest, 깨우기 방식 |

- 표시 언어는 `AGENT_GOVERNANCE_LOCALE` 또는 AGS 사용자 설정 파일(`settings.json`)에서 읽는다. JEV 설정은 `AGENT_GOVERNANCE_CLASSIFICATION_CONFIG`가 가리키는 파일에서 읽고 서버 시작 때 승인된 런타임으로 고정한다. 이 판에서는 두 항목 모두 페이지에서 보기만 하고, 어디서 정해지는지를 글로 보여 준다.
- 편집 관문 예외 경로는 hook이 `AGENT_GOVERNANCE_PHASE_EXEMPT_PATHS`(플랫폼 경로 구분자, 절대 경로만)에서 읽는다. 페이지는 그 목록을 같은 규칙으로 읽어 보여 주고, 환경 변수로 고정됐다고 적는다.
- 이 세 항목을 서명 기록으로 옮기려면 hook·서버가 그 값을 읽는 곳마다 서명 검증을 거쳐야 한다. 3.9.0에서는 옮기지 않았다.

## 정본: 패스키 서명 기록

- 사람이 바꾸는 항목의 정본은 공유 상태 파일(`context-layers.sqlite3`)의 `admin_log` 하나다. 기록은 추가만 한다.
- 기록 하나는 패스키가 서명한 canonical JSON 문자열(intent) 하나다. 내용은 `{v, domain:"ags.admin", rpId:"localhost", target, prevTargetHash, change, issuedAt}`이고 challenge는 SHA-256(intent)이다. 읽을 때 `canonicalJson(JSON.parse(s)) === s`를 강제한다.
- 대상(target)은 `keys`, `global`, `roles`, `binding:<host>:<sessionId>`다. 대상마다 이전 기록의 hash를 이어 거는 사슬이라 서로 무관한 대상끼리는 경합하지 않는다.
- 검증 항목: client data type(`webauthn.get`), challenge, origin(`http://localhost[:port]`), rpIdHash(`localhost`), 사용자 존재·사용자 확인(UP·UV) 플래그, 서명(ES256·RS256·EdDSA, `node:crypto`만 씀). signCount는 기록만 하고 판정에 쓰지 않는다.
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

## 오류 코드

`ADMIN_KEY_NOT_REGISTERED`, `ADMIN_ALREADY_BOOTSTRAPPED`, `ADMIN_KEY_UNKNOWN`, `ADMIN_KEY_REVOKED`, `ADMIN_LAST_KEY_REVOKE_REFUSED`, `ADMIN_ALGORITHM_UNSUPPORTED`, `WEBAUTHN_PUBLIC_KEY_UNAVAILABLE`, `ADMIN_SIGNATURE_INVALID`, `ADMIN_CHALLENGE_MISMATCH`, `ADMIN_ORIGIN_REJECTED`, `ADMIN_RPID_MISMATCH`, `ADMIN_USER_VERIFICATION_MISSING`, `ADMIN_INTENT_NONCANONICAL`, `ADMIN_INTENT_EXPIRED`(intent 발급 뒤 10분), `ADMIN_TARGET_STALE`, `ADMIN_LOG_REGRESSED`, `ADMIN_PROPOSAL_NOT_FOUND`, `ADMIN_CHANGE_INVALID`(details.reason: `ROLE_NAME_TAKEN` 등), `ADMIN_RECORD_ALTERED`(파일에서 고쳐진 기록). HTTP 경계: `HOST_REJECTED`, `CONTENT_TYPE_REJECTED`, `REQUEST_TOO_LARGE`, `REQUEST_INVALID`, `STORE_UNAVAILABLE`.
