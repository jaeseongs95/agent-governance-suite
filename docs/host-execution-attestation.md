# 실행 관측과 호스트 연결

공통 `HostAttestationProvider`가 서명과 입력 digest를 검증하고, `WorkflowService`가 task/run/stage/revision, 유효기간, 한 번 소비와 실행 하한을 집행한다. 벤더별 adapter는 모델 정책과 실제 호스트 관측만 담당한다. `executionContext` caller JSON이나 설정 희망값은 관측을 대신하지 않는다.

## 배포물의 연결

| 경로 | 관측과 선택 | 한계 |
| --- | --- | --- |
| Codex Hook | `.mcp.json`의 `AGENT_GOVERNANCE_HOST_ATTESTATION=codex`, `PreToolUse`의 `--host=codex` | 정확한 session/turn/model/call과 같은 턴의 effort가 필요 |
| Claude Code Hook | 기존 Claude manifest와 launcher, transcript 및 session-model 관측 | 기존 main/subagent 모델·effort 경로 유지 |
| Hook 없는 host wrapper | 공개 `mcp-server/dist/host-attestation-api.mjs`의 `openHostAttestation` | host-owned 관측 callback과 같은 workflow DB를 연결해야 함 |

Codex 공식 [Hooks 문서](https://learn.chatgpt.com/docs/hooks)는 현재 `model`, `session_id`, `transcript_path`와 `PreToolUse`의 `turn_id`, `tool_use_id`, `tool_input`, `updatedInput`을 정의한다. effort는 같은 턴의 host-recorded `turn_context`에서 읽는다. 이 transcript 형식은 안정된 host API가 아니므로 모양이 바뀌거나 관측이 없으면 추정하지 않는다.

Codex adapter는 첫 256 KiB에서 `session_meta.id`를, 마지막 8 MiB에서 가장 최근 `turn_context`를 읽는다. 전체 history scan, polling과 daemon은 없다. 최근 turn이 Hook의 turn과 다르거나 그 metadata가 읽기 범위 밖이면 구체적인 진단과 함께 token을 제거한다. 새 native turn의 관측이나 host-owned wrapper 연결이 필요하다. 같은 OS 사용자 범위의 협력적 보증이며 로그와 키를 읽을 수 있는 악의적 사용자의 위조를 막는 OS 격리는 아니다.

Codex subagent Hook의 session ID는 parent일 수 있다. `agent_id`, subagent metadata 또는 session/turn 불일치를 발견하면 parent의 모델·effort를 빌려 쓰지 않는다. 현재 adapter는 독립된 child 신원을 증명하지 못하는 subagent 경로를 지원 완료로 표시하지 않는다.

모델 class는 추론이 아닌 명시적 제품 정책이다. Codex adapter는 기존 preset의 `gpt-6-astra=frontier`, `gpt-5.6-sol=deep`, `gpt-5.6-terra=general`, `gpt-5.6-luna=lightweight`를 사용한다. 이번 지원 정책은 host tool metadata의 workhorse/easier-task 역할 설명을 근거로 `gpt-6-sol=general`, `gpt-6-luna=lightweight`를 보수적으로 추가한다. 이는 품질 실측이나 5.6 후계 등급의 자동 복제가 아니다. `deep` 이상을 요구하는 단계는 Sol에서 거절되며 이를 통과시키려고 관측값이나 정책 하한을 높이거나 낮추지 않는다. 정확한 ID 외의 알 수 없는 모델은 `host-model-policy-unsupported`다. Claude의 Haiku/Sonnet/Opus/Fable mapping은 그대로 유지한다. `reasoningEffort`가 없거나 지원 목록 밖이면 필수 관측 누락이며 다른 모델·턴의 값으로 보충하지 않는다.

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

관측이 없으면 `BINDING_REQUIRED`와 provider 연결 진단이 반환된다. 서명·입력·binding 변조, 만료, 이미 소비한 관측이나 실행 하한 위반은 `BINDING_INVALID`다. 같은 host/session/agent/turn/call은 다시 서명해도 같은 관측 ID를 사용한다. workflow 상태와 기존 SQLite claim 원장을 유지하며 운영 DB·키를 삭제하지 않는다.

source adapter 검사, bundled hook·STDIO fixture, `node_modules` 없는 wrapper import, 실제 설치 Hook의 정상 실행은 서로 다른 검증이다. fixture의 synthetic metadata나 token으로 native host 완주를 입증하지 않는다. 릴리즈·설치 담당자는 최종 통합 tree에서 실제 host 관측과 guarded workflow 완료를 별도로 확인해야 한다.
