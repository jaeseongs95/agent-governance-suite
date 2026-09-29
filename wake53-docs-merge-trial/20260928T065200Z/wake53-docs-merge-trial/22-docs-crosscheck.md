# docs.patch 주장 ↔ 53eff30a(+patch) 코드 대조 (수정하지 않음)

| 주장 (파일) | 근거 | 판정 |
| --- | --- | --- |
| AGENT_GOVERNANCE_HOST_ATTESTATION 은 claude-code 또는 codex만 선택하고, 없거나 모르는 값이면 provider 없음 (architecture.md, host-execution-attestation.md) | mcp-server/src/runtime-config.ts:187-195 | 일치 |
| provider-not-configured 진단과 함께 BINDING_REQUIRED | mcp-server/src/workflow-service.ts:1339 | 일치 |
| Codex .mcp.json 은 codex, Claude manifest 는 claude-code | .mcp.json:10, claude-overlay/.claude-plugin/plugin.json:21 | 일치 |
| **"Host attestation cannot share one server with the FlowMarshal A2 profile."** (architecture.md:25) | 53eff30a 에서 `git grep -i flowmarshal` 결과 0건. 4114da53(3.x 계열)에만 mcp-server/src/host-integration/flowmarshal-current-invocation.ts 가 있음 | **불일치: 2.7.x 후보에는 없는 기능을 서술함** |
| 공용 issueHostAttestation 이 host/세션·agent·turn·call 해시, tool, inputDigest, binding, model, modelClass, effort, actor, 5분 TTL 에 결속 | mcp-server/src/host-attestation.ts:136-170 | 일치 |
| observationId 는 해시된 scope에서 파생되므로 같은 호출을 다시 서명하면 같은 ID | host-attestation.ts:163-164 | 일치 |
| Provider가 token host == 설정 adapter 인지 검증 | host-attestation.ts:211, 220-222 | 일치 |
| 토큰 없으면 connection 진단과 함께 BINDING_REQUIRED, runObserved 안내 | host-attestation.ts:237-251 | 일치 |
| Hook 없는 host 는 runObserved 또는 host-attestation-api.mjs 사용 | mcp-server/src/host-attestation-api.ts:8 | 일치 |
| Claude overlay: PreToolUse(두 도구), SessionStart, PostModelSwitch 에서 host-attestation-hook.mjs 실행 | claude-overlay/hooks/hooks.json:34, 84, 114-119 | 일치 |
| Claude: 발행 메시지를 못 찾으면 최신 assistant 모델 또는 main thread의 더 새로운 session model로 대체하고, effort 는 hook 값만 사용 | mcp-server/src/host-attestation-hook.ts:263-277 | 일치 |
| Claude: hook effort 와 메시지 effort 중 낮은 쪽 | host-attestation-hook.ts:224-229, 281 | 일치 |
| 모델 클래스는 Haiku/Sonnet/Opus/Fable 계열을 따름 | mcp-server/src/host-execution-adapters.ts:5,8 | 일치 |
| Codex: hooks/hooks.json PreToolUse 에서 --host=codex | hooks/hooks.json:103-110 | 일치 |
| Codex: session_meta 는 첫 256 KiB, turn_context 는 마지막 8 MiB | mcp-server/src/codex-host-observation.ts:6-7, 60, 70-73 | 일치 |
| Codex: subagent(agent_id 또는 metadata)는 attestation 하지 않음 | codex-host-observation.ts:53-54, 65 | 일치 |
| Codex: 정확한 모델 ID만 클래스에 매핑 | host-execution-adapters.ts:17-23, codex-host-observation.ts:80 | 일치 |
| Codex hook: permissionDecision allow + updatedInput, 토큰이 없으면 systemMessage | host-attestation-hook.ts:316-326, 347-352 | 일치 |
| 토큰을 발급하지 않으면 두 adapter 모두 caller token 제거 | host-attestation-hook.ts:239 (withoutCallerAttestation), 312-313 (withoutHostAttestation) | 일치 |
| roadmap: Codex adapter 는 .mcp.json, hooks/hooks.json 에 연결됨. Codex subagent 신원 관측과 OS 격리는 아직 없음 | 위와 같음 | 일치 |
| architecture.md 한국어 문단: 직접 programmatic 호출은 permissive, strict MCP는 서명 token 을 검증 | 같은 문서 38행의 기존 문장, host-attestation.ts | 일치 |
