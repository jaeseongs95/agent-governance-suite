# 실행 관측과 호스트 연결

공통 `HostAttestationProvider`가 서명과 입력 digest를 검증하고, `WorkflowService`가 task/run/stage/revision, 유효기간, 한 번 소비와 실행 하한을 집행한다. 벤더별 adapter는 모델 정책과 실제 호스트 관측만 담당한다. `executionContext` caller JSON이나 설정 희망값은 관측을 대신하지 않는다.

## 관측 서명과 실행 자격

새로 발급하는 `_hostAttestation`은 `aghs2`의 v2 관측 token이다. 호스트가 확인한 raw model·effort·actor·session·turn·call과 정확한 도구 입력을 서명한다. 모델 이름의 catalog 등록 여부나 모델별 effort 하한은 관측 서명 발급 조건이 아니다. Codex decoder도 현재 session·turn·model·effort를 확인한 뒤 관측을 반환하며, capability가 없다는 이유만으로 관측을 폐기하지 않는다. 이 분리는 native actor 관측의 지원 범위나 권한을 확대하지 않는다.

v2는 raw 관측과 별도로 `eligibility` snapshot 또는 `null`을 서명한다. 기존 trusted descriptor가 있고 관측한 effort가 기존 지원 목록·minimum을 충족할 때만 class·provider·resolved model·policy revision snapshot을 담는다. 조건이 충족되지 않아도 raw 관측 서명은 발급된다. 서버는 snapshot이 있어야 하며, 그 값들을 현재 trusted descriptor와 모두 대조한 뒤에만 실행 context를 만든다. 같은 revision 아래 class·provider·resolved model이 바뀌어도 기존 signed snapshot과 불일치하면 거부한다. workflow의 task/run/stage/revision 결속, freshness, 한 번 소비와 단계별 class·effort 하한 검사는 기존 경로에서 계속 집행한다. 유효한 관측 서명만으로 실행 자격을 얻지는 않는다.

`policyRevision` 필드는 v2 서명 본문에 항상 있으며 실제 revision 문자열 또는 `null`이다. issuer는 설치된 adapter가 선언한 revision을 우선 사용하고, 선언이 없으면 기존 `resolveAdapterModelCapability`가 반환한 effective revision을 사용한다. 여기에는 기존 trusted `modelClassForModel` mapping이 승인한 legacy capability의 `1.0.0`도 포함된다. 선언 revision과 capability가 모두 없으면 `null`을 서명하므로 관측 token은 발급되지만 실행 자격은 거부된다. unknown 모델에 새 기본 revision을 만들거나 서버의 현재 revision으로 보충하지 않는다. 선언 revision과 현재 descriptor revision이 서로 달라도 실행을 거부한다.

`aghs1` v1 token은 유효한 서명이어도 거부한다. 현재 `aghs2` v2는 기존 서명 키와 host/session/agent/turn/call 범위의 observation ID 및 한 번 소비 원장을 그대로 사용한다. 새 키·DB·issuer·capability registry는 추가하지 않는다.

기본 hook의 named adapter와 서버의 기본 adapter map은 같은 설치물의 기존 `defaultSuite` 정책을 사용한다. 이 변경은 새 capability 공급자를 등록하지 않는다. 기존 승인 family/alias 정책으로 새 raw identifier를 해석하거나 이미 신뢰된 resolver가 동등 descriptor를 제공하면 별도 이름 등록 조건 없이 소비할 수 있다. 현재 기본 catalog에서 해석되지 않고 별도 권위 descriptor도 없는 모델은 관측 token이 있어도 실행을 거부한다. 그 경우를 지원 완료로 표시하지 않는다.

## 배포물의 연결

| 경로 | 관측과 선택 | 한계 |
| --- | --- | --- |
| Codex Hook | `.mcp.json`의 `AGENT_GOVERNANCE_HOST_ATTESTATION=codex`, `PreToolUse`의 `--host=codex` | 정확한 session/turn/model/call과 같은 턴의 effort가 필요 |
| Claude Code Hook | Claude manifest의 `AGENT_GOVERNANCE_HOST_ATTESTATION=claude-code`, launcher의 `PreToolUse`와 session model을 기록하는 `SessionStart`·`PostModelSwitch` | 기존 main/subagent 모델·effort 경로 유지 |
| Gemini Adapter | `mcp_config.json`의 `AGENT_GOVERNANCE_HOST_ATTESTATION=gemini`, wrapper 또는 `openHostAttestation` | Flash-Lite/Flash/Pro/Ultra 패밀리 매핑 적용 |
| Hook 없는 host wrapper | 공개 `mcp-server/dist/host-attestation-api.mjs`의 `openHostAttestation` | host-owned 관측 callback과 같은 workflow DB를 연결해야 함 |

`AGENT_GOVERNANCE_HOST_ATTESTATION`이 없거나 `claude-code`·`codex`·`gemini` 밖의 값이면 서버는 실행 관측 provider 없이 시작하며, strict orchestration은 `provider-not-configured` 진단과 함께 `BINDING_REQUIRED`로 거절된다.

Codex 공식 [Hooks 문서](https://learn.chatgpt.com/docs/hooks)는 현재 `model`, `session_id`, `transcript_path`와 `PreToolUse`의 `turn_id`, `tool_use_id`, `tool_input`, `updatedInput`을 정의한다. effort는 같은 턴의 host-recorded `turn_context`에서 읽는다. 이 transcript 형식은 안정된 host API가 아니므로 모양이 바뀌거나 관측이 없으면 추정하지 않는다.

같은 문서의 `PreToolUse` 계약은 `updatedInput`을 `permissionDecision: "allow"`와 함께 반환하도록 요구한다. Codex adapter는 정확한 AGS 두 도구에서 관측 token을 주입하거나 caller token을 제거할 때 이 입력 치환 형식을 사용한다. 승인 요청을 결정하는 `PermissionRequest`의 `decision.behavior: "allow"`는 별도 이벤트이며 이 adapter는 해당 이벤트에 등록하지 않는다. 이 구분만으로 모든 host 승인 정책의 실제 동작을 검증했다고 주장하지 않는다. 관측이 없거나 잘못되면 서버의 binding gate가 실행을 거절하는지 native 검사에서 별도로 확인한다.

Codex adapter는 첫 256 KiB에서 `session_meta.id`를, 마지막 8 MiB에서 가장 최근 `turn_context`를 읽는다. 전체 history scan, polling과 daemon은 없다. 최근 turn이 Hook의 turn과 다르거나 그 metadata가 읽기 범위 밖이면 구체적인 진단과 함께 token을 제거한다. 새 native turn의 관측이나 host-owned wrapper 연결이 필요하다. 같은 OS 사용자 범위의 협력적 보증이며 로그와 키를 읽을 수 있는 악의적 사용자의 위조를 막는 OS 격리는 아니다.

Codex subagent Hook의 session ID는 parent일 수 있다. `agent_id`, subagent metadata 또는 session/turn 불일치를 발견하면 parent의 모델·effort를 빌려 쓰지 않는다. 현재 adapter는 독립된 child 신원을 증명하지 못하는 subagent 경로를 지원 완료로 표시하지 않는다.

모델 class는 추론이 아닌 명시적 제품 정책이다. Codex adapter는 기존 preset의 `gpt-6-astra=frontier`, `gpt-5.6-sol=deep`, `gpt-5.6-terra=general`, `gpt-5.6-luna=lightweight`를 사용한다. 이번 지원 정책은 host tool metadata의 workhorse/easier-task 역할 설명을 근거로 `gpt-6-sol=general`, `gpt-6-luna=lightweight`를 보수적으로 추가한다. 이는 품질 실측이나 5.6 후계 등급의 자동 복제가 아니다. 이미 서명·저장된 계획이 `deep` 이상을 명시하면 그 요구를 실제 관측과 비교한다. 새 계획에서 모델 등급이나 단계 이름만으로 `deep` 요구를 만들어 내지는 않는다. 정확한 ID 정책에서 해석되지 않는 모델은 기본 실행 자격을 얻지 못하지만, 확인된 raw 관측의 서명 자체를 막지는 않는다. Claude의 Haiku/Sonnet/Opus/Fable mapping은 그대로 유지한다. Gemini adapter는 `flash-lite`=lightweight, `flash`=general, `pro`=deep, `ultra`=frontier 매핑을 적용한다. `reasoningEffort`가 없거나 공통 enum 밖이면 필수 관측 누락이며 다른 모델·턴의 값으로 보충하지 않는다. 관측한 effort가 모델의 지원 목록이나 minimum을 충족하지 않으면 서버가 실행 자격을 거부한다.

## Hook 없는 호스트

host 실행 wrapper는 동일 schema의 실제 실행 관측을 얻는 callback을 소유한다. 다음은 연결 형식을 보여 주며 실행 관측을 생성하는 코드가 아니다.

```javascript
import {
  openHostAttestation,
} from "/absolute/plugin/mcp-server/dist/host-attestation-api.mjs";

const attestation = openHostAttestation(workflowDatabasePath, executionAdapter);
try {
  const response = await attestation.runObserved(
    toolName, argumentsForThisCall,
    () => observeCurrentHostCall(),
    (signedArguments) => hostMcpClient.callTool({ name: toolName, arguments: signedArguments }),
  );
} finally {
  attestation.close();
}
```

`executionAdapter`는 선언된 host와 명시적인 `modelClassForModel` 정책을 제공한다. callback은 host가 관측한 `model`, `reasoningEffort`, `sessionId`, `turnId`, `toolUseId`, `actorId`를 반환한다. actor는 공통 `hostActorId(host, sessionId, agentId)`로 해당 신원에 결속한다. 관측이 없으면 `null`을 반환한다. 서명된 인자는 host 내부 transport로만 전달하며 모델에 재사용 token을 제공하지 않는다. 일반 LLM 입력을 callback 결과로 전달하는 연결은 이 계약을 충족하지 않는다.

동일 process의 `WorkflowService`를 연결하는 host는 같은 callback을 `HostAttestationProvider.runObserved`에 전달할 수 있다. 두 경로는 같은 공통 signing 함수를 사용한다. 새 MCP 도구로 JSON을 등록하거나 환경변수에 모델·effort를 입력하는 경로는 없다.

## 실패와 검증

관측이 없으면 `BINDING_REQUIRED`와 provider 연결 진단이 반환된다. 서명·입력·신원 결속 변조, 만료, 이미 소비한 관측은 `BINDING_INVALID`다. 초기 접수는 검증된 현재 관측을 요구하고 작업 무관 성능 하한은 두지 않는다. 검증된 정상 관측이 실제 단계 하한에 못 미치면 `GATE_FAILED`로 구분한다. 같은 host/session/agent/turn/call은 다시 서명해도 같은 관측 ID를 사용한다. workflow 상태와 기존 SQLite claim 원장을 유지하며 운영 DB·키를 삭제하지 않는다.

source adapter 검사, bundled hook·STDIO fixture, `node_modules` 없는 wrapper import, 실제 설치 Hook의 정상 실행은 서로 다른 검증이다. fixture의 synthetic metadata나 token으로 native host 완주를 입증하지 않는다. 릴리즈·설치 담당자는 최종 통합 tree에서 실제 host 관측과 guarded workflow 완료를 별도로 확인해야 한다.

## 단계 하한의 근거와 보존 범위

D0094 후속은 `AGENTS.md`의 프리셋 제품 정책 중 고위험 작업의 `general/high` 하한을 보존한다. 이는 수치 성능 평가 결과가 아니라 명시 정책이다. 사용자 지정 모델·추론 설정은 실제 호스트 지원과 이 유효한 요구 안에서 우선하며, caller가 입력한 희망값을 실제 관측으로 바꾸거나 단계 하한을 덮어쓰지는 않는다. 모델 선택기의 프리셋·사용자 지정 처리와 호스트 capability 자격은 이번 변경으로 수정하지 않는다.

기본 `general/medium`과 capability·provider 별칭·mandatory gate에서의 `deep/high` 강제에는 별도 명시 요구나 수치 평가 근거를 확인하지 못했다. v1.13 릴리스 기록은 도입 당시의 구현 설명이며 현재 강제 하한의 독립 근거로 승격하지 않는다. 이 분기들을 제거하고 고위험이 아닌 의미 단계는 관측 전용으로 계획한다. 감사 의무·독립성·산출물 검사는 그대로 집행한다.

현재 TaskEnvelope의 `constraints`는 문자열 배열이고 provider의 `gate`는 감사 조건이다. 별도의 명시 모델 하한 입력 계약은 없다. 새 입력이나 근거 등록 도구를 추가하지 않는다. 개별 사용자 요구나 provider 필수 하한이 실제로 들어오면 현재 구조가 지원하지 않는 경계를 알리고, 이를 조용히 버리거나 문자열만으로 강제값을 추정하지 않는다. 그때 실제 소비자·권위·적용 범위를 확인해 계약 확장 또는 해당 작업 보류를 결정한다. 생성된 단계 요구는 `taskDigest`와 전체 계획 서명에 결속되고 claim 시 작업에서 다시 계산해 대조된다. 이미 claim되어 유효한 issued lease는 저장 proposal과 계획의 일치·유효기간·revision·단회 소비 검사를 그대로 거쳐 시작하고, 새 생성 규칙으로 저장 계획을 덮어쓰지 않는다. 이미 시작된 실행은 저장 계획의 nonnull 하한 비교를 계속 사용하며, caller가 서명된 하한을 null로 바꾸면 무결성 검사에서 거부한다. 과거 하한의 무결성 보존은 그 선정 근거의 타당성을 새로 인증한다는 뜻이 아니다. 정책 변경 전 미시작 계획은 기존 claim 재계산에서 충돌할 수 있으므로 원 기록을 보존하고 새 관측으로 재계획한다.
