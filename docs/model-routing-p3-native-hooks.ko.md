# P3 — 네이티브 호스트 관측 연결

## 구현 범위

기준 브랜치 `codex/v250-model-routing-integration`, 기준 HEAD `0fd9220ed603e73b35f9127041d0d7b3bd21ab15`에서 P3의 **Codex/Claude 네이티브 훅 → 관측 수신함 → 기존 v2 기록 서비스**를 연결했다. 기존 native-subagent 인자 변환기, v1 resolve/record 및 Claude v1 attestation은 유지한다. 버전은 2.4.0이며 전체 v2.5.0 릴리스 완료가 아니다.

새 번들은 `mcp-server/dist/model-routing-host-hook.mjs`다. Codex는 `hooks/hooks.json`에서 `--host codex`로 직접 실행한다. Claude는 overlay launcher가 `CLAUDE_PLUGIN_DATA/workflows.sqlite3`를 명시하고 `--host claude-code`로 실행한다. 생성된 Claude 플러그인도 같은 공용 번들을 사용한다. CLI는 설치물에 node_modules가 없어도 동작한다.

훅은 AGS의 `resolve_model_assignment`와 `record_model_application`만 관찰한다. 새로운 실행 허가 도구, 일반 shell 실행기, 모델 전환기, MCP capability 자기신고 도구를 추가하지 않는다. `PreToolUse`에서 `updatedInput`이나 `permissionDecision: allow`를 내보내지 않으므로 기존 승인 흐름을 바꾸지 않는다.

## 관측 의미와 필드별 지원

| 항목 | Codex | Claude Code |
|---|---|---|
| 모델 | 네이티브 tool hook의 `model` | 해당 `tool_use_id`를 실제로 발행한 assistant transcript의 `message.model` |
| 추론 | 공식 공통 훅 입력에 유효 effort 필드가 확인되지 않아 미확인 | 정확한 메시지의 effort와 현재 hook의 `effort.level`; 둘 다 있으면 낮은 관측값 |
| 실행 모드 | 미확인 | 미확인. `xhigh`를 standard 또는 Ultracode로 치환하지 않음 |
| 완료/성공 | unknown | unknown. 도구 호출·Stop·worker PASS는 assignment 성공 증거가 아님 |
| alias/미등록 ID | 실제 문자열 보존, origin unknown | 실제 문자열 보존, origin unknown |

**이 관측의 대상은 `record_model_application`을 발행한 actor의 그 시점 설정이다. assignment 전체가 한 모델로 실행됐다는 증명이나 최종 완료 판정이 아니다.** 관측 reference는 `native-tool-issuer:`로 구분한다. 전체 실행의 terminal outcome이나 모드를 다른 호스트 API가 증명하지 않았다면 보충하지 않는다. 이 경로만으로는 고위험 결과 채택의 모든 요건을 만족하지 않는다. 기존 v1 gate를 통과하던 정상 경로는 그대로 사용한다.

Claude에서는 정확한 tool-use 메시지가 아직 쓰이지 않았으면 최신 assistant 메시지나 세션 시작 모델을 대신 사용하지 않는다. 도구가 반환된 뒤 `PostToolUse`에서 정확한 메시지를 찾으면, 실제 MCP 반환값과 저장된 진단 record를 대조한 뒤 관측이 붙은 **새 record**를 만든다. 기존 미관측 record의 내용·digest는 고치지 않고 추가 context에 새 artifact URI와 이전 진단 record digest만 전달한다. 이미 admitted인 결과를 중복 재기록하지 않는다.

Haiku처럼 카탈로그가 native enum을 선언하지 않은 모델의 hook effort는 native enum으로 승격하지 않는다. 토큰 예산·출력 길이·요청값에서 high를 추론하지 않는다. 모델이 작성한 `tool_input.observation`, 임의 token, `last_assistant_message`, PASS 문자열은 관측 근거가 아니다.

## 수신·기록·신원 계약

기존 loopback TLS broker에 **읽기 전용 presence 조회**를 보내 현재 host/session/instance와 lease를 확인한다. broker가 없으면 새 broker를 띄우지 않고 관측을 생략한다. presence의 online을 모델 실행 능력으로 취급하지 않는다.

실제 record 관측은 다음이 있어야 저장한다.

- 저장된 v2 decision과 동일한 binding 및 target.
- 네이티브 host, session, instance에 일치하는 actor. actor ID는 기존 Claude v1과 같은 session/agent 해시 규칙을 사용하며 Codex는 `codex:` prefix를 쓴다. tool_input이 주장한 actor를 신뢰하지 않는다.
- 기존 실행 계층이 이미 등록한 dispatch 및 동일 `dispatchedAt`. 훅은 dispatch를 만들거나 작업을 수락·실행·완료로 전이하지 않는다.

기존 HMAC receipt와 추가 테이블 `ags_model_native_hook_receipts_v1`으로 application 전체 digest와 일회용 observation nonce를 연결한다. 서버는 동일 application의 native 관측을 우선 사용하며, caller가 더 유리한 과거 token을 골라 우회하지 못한다. 실제 설정 불일치는 보존하고 mismatch로 기록한다. 재사용·만료·다른 task/actor/digest·잘못된 서명은 거부한다. 실제 인자 검증, receipt 저장과 연결은 하나의 SQLite transaction으로 처리한다. 기존 workflow/root/receipt 내용과 user_version은 변경하지 않는다.

HMAC 키는 해당 호스트 workflow DB에 저장한다. 같은 OS 사용자는 DB와 키를 읽을 수 있으므로 이는 호스트 연결부의 로컬 무결성 경계이며 OS 사용자 간 격리나 직접 인간 승인의 증명이 아니다. 원문 prompt·transcript 본문·인증값을 수신함이나 로그에 복사하지 않는다.

## Capability publication

`resolve_model_assignment` 직전 현재 호스트의 관측 snapshot을 workflow routing store에 발행한다. 명시적인 실행 계약이 없으면 관측된 모델만 기록하고 dispatch/권한/도구/파일시스템/접근 경로/실행 모드는 unknown으로 유지하므로 자동 배정은 보류된다. 현재 snapshot 만료와 presence lease는 따로 검증한다.

호스트가 실제로 제공하는 지원 조합을 운영자가 확인한 경우, 선택적으로 workflow DB 디렉터리 아래 `model-routing-native/openai-codex.json` 또는 `anthropic-claude-code.json`에 다음 계약을 둘 수 있다. 훅이 그 파일을 생성하거나 수정하지는 않는다.

- `schemaVersion: "1.0.0"`, `host`, `hostVersion`, `sourceReference`
- `supportedBindings`: 기존 `HostModelCapabilities.v1` binding 배열
- `executionCapabilities`: 기존 `HostModelCapabilities.v1` 실행 경계

이 파일은 언제나 **configuration 근거**다. 파일에 명시된 조합은 실제 적용 관측과 구분하며, `observableFields`는 이 이벤트에서 확인된 모델/추론 필드로 제한한다. runtimeMode 관측이나 고위험 적격성을 설정 파일로 만들어내지 않는다. 에이전트의 MCP 인자에서 같은 이름의 파일 경로나 snapshot을 전달해도 읽지 않는다.

현재 capability 테이블은 host/session/instance 슬롯이므로 subagent가 parent의 capability를 덮어쓰지 않도록 **subagent capability publication은 생략**한다. 그러나 동일 parent session에 속한 child actor의 정확한 record 관측은 별도로 처리한다. peer 간 snapshot 전달·기능 협상과 자동 dispatch는 남은 P5 실행 연결 범위다.

## 설치와 기존 기능 유지

번들 목록, required-files, clean-room smoke에 새 훅을 등록했다. Claude launcher는 다른 AGENT_GOVERNANCE_DB_PATH가 있어도 plugin-scoped DB를 사용한다. 기존 훅 matcher와 v1 token/gate를 교체하지 않는다. P3에 필요한 읽기 전용 transcript/actor helper는 별도 모듈로 분리했다. 기존 v1 attestation 소스와 진입점은 수정하지 않으며, 새 번들이 기존 v1 hook main을 불러 실행하지 않는다.

실제 설치물 연결 테스트에서 기존 TLS broker가 클라이언트 연결 reset 뒤 처리되지 않은 `ECONNRESET`으로 종료되는 문제가 재현됐다. handshake 전후 각 socket의 error를 그 연결 안에서 처리하도록 수정했다. broker 전체의 인증·버전·권한 검사나 메시지/ACK 프로토콜은 변경하지 않는다.

## 검증과 남은 범위

Linux x86_64 / Node 22.16.0에서 기존 CI가 보관한 frozen dependency archive를 사용했고 pnpm-lock.yaml이 기준 저장소와 동일한 것을 확인했다. 신규 관측/저장 테스트 41개 및 실제 broker·설치물 테스트 4개를 실행했다. 이 45개를 포함해 라우팅·v1 attestation·P5 gate·Claude 패키징 관련 221개가 통과했다. 전체 TypeScript, ESLint, 저장소 검사, 번들 신선도, Claude 생성물 일치, SourceLock, 무의존 스킬 CLI 31개와 신규 훅 2개 실행 경로도 통과했다.

실제 TLS·SQLite·자식 프로세스를 실행한 테스트와 **벤더 계정에서 Codex/Claude를 실행한 검증(A22)**은 다르다. 후자는 수행하지 않았다. host metadata/transcript는 명시적 fixture다. 실제 계정의 제품 버전별 이벤트 확인, 전체 task의 mode/terminal 관측, 호스트 API 기반 지원 조합 자동 탐색, subagent capability 별도 슬롯, peer 자동 배정, 독립 감사 및 최종 설치 캐시 검증은 완료했다고 표시하지 않는다. 전체 CI 결과는 이번 기능 검증과 별도로 보고한다.

## 근거

구현 계획의 P3, §4.3–4.6, §9.1–9.2, A01/A04/A05/A08–A11/A19–A22를 적용했다. 호스트 계약은 아래 공식 문서에서 확인한 필드만 사용한다.

- Codex Hooks: https://developers.openai.com/codex/hooks (https://learn.chatgpt.com/docs/hooks 로 이동). Common input, PreToolUse, PostToolUse, Subagent hooks, transcript format.
- Claude Hooks: https://code.claude.com/docs/en/hooks. Common input, effort field, PreToolUse, PostToolUse, subagent metadata.
- Claude Subagents: https://code.claude.com/docs/en/sub-agents. 모델·effort 설정과 subagent 실행 경계.
