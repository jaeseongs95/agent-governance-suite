# 실행 관측과 호스트 연결

실행 관측은 서버가 검증한 호출자(`VerifiedCaller`, [세션 결속 설계](ags30-session-binding-design.md) 2.1)의 `execution`에서 온다. 호스트별 caller ingress가 그 값을 호스트가 쓴 사실에서 채우고, 공통 `HostAttestationProvider`가 신뢰된 adapter로 자격을 판정하며, `WorkflowService`가 task/run/stage/revision 결속, 유효기간, 한 번 소비와 실행 하한을 집행한다. 도구 인자의 `executionContext` JSON이나 설정 희망값은 관측을 대신하지 않는다. 서명 token(`_hostAttestation`, `aghs1`·`aghs2`)은 없다.

## 관측과 실행 자격

- `caller.execution`은 `{model, effort, turnId, provenance}` 또는 `{unavailable: 사유}`다. 실행 하한이 있는 도구(`plan_workflow`, `record_stage_result`, `classify_skills`, `record_skill_selection`)만 소비한다.
- `observe()`는 호출의 host가 설치 adapter의 host와 같은지(`HOST_ADAPTER_MISMATCH`), effort가 공통 enum인지(`REASONING_EFFORT_INVALID`) 확인한 뒤 `resolveAdapterModelCapability`로 현재 trusted descriptor를 찾는다. descriptor가 없으면 judgment 사유(예: `MODEL_NOT_IN_CATALOG`, `MISSING_MODEL_CAPABILITY`)로, 지원 effort·최소 effort를 어기면 `CURRENT_POLICY_EFFORT_UNSUPPORTED`·`CURRENT_POLICY_EFFORT_BELOW_MINIMUM`으로 `BINDING_INVALID`를 반환한다.
- `observationId`는 (host, sessionId, actor, callId)의 hash다. 같은 호스트 호출을 다시 보내도 두 번째 소비는 workflow 원장에서 거부된다. 호출 ID가 없는 호스트(agy)는 관측을 만들지 않고 `HOST_CALL_ID_UNAVAILABLE`로 진단한다.
- `modelClassForModel`만 가진 legacy adapter의 class 응답은 capability가 아니므로 지원 effort나 revision을 합성하지 않는다(D0089). 실행 자격이 필요한 adapter는 `resolveModel`이나 `judgeModel`로 trusted descriptor를 제공해야 한다.

## 배포물의 연결

| 호스트 | 관측 출처 | 한계 |
| --- | --- | --- |
| Codex | `.mcp.json`의 `AGENT_GOVERNANCE_HOST_ATTESTATION=codex`. 서버가 `tools/call` `_meta`의 `x-codex-turn-metadata`(`model`, `reasoning_effort`, `turn_id`)와 `callId`를 읽는다. hook이 없다 | model이나 effort가 없으면 `CODEX_EXECUTION_META_MISSING`. child도 자기 thread의 값을 쓴다 |
| Claude Code | manifest의 `AGENT_GOVERNANCE_HOST_ATTESTATION=claude-code`. PreToolUse governance hook이 effort(`effort.level`)와 model(발신 transcript 항목, 없으면 `SessionStart`·`PostModelSwitch`가 기록한 세션 model)을 admission 행에 기록하고, 서버가 `claudecode/toolUseId`로 그 행을 한 번 회수한다 | 둘 중 하나라도 관측하지 못하면 `CLAUDE_MODEL_UNOBSERVED`·`CLAUDE_EFFORT_UNOBSERVED` 등. transcript-latest 추정은 하지 않는다 |
| Antigravity | `mcp_config.json`의 `AGENT_GOVERNANCE_HOST_ATTESTATION=antigravity`. `_meta`가 대화 ID만 준다 | model·effort·호출 ID가 없어 `ANTIGRAVITY_EXECUTION_UNOBSERVED`. 실행 하한 도구는 관측 없이 진행할 수 없다 |

`AGENT_GOVERNANCE_HOST_ATTESTATION`이 없거나 위 세 값 밖이면 caller ingress가 없어 모든 도구가 `HOST_INGRESS_UNAVAILABLE`로 거부된다.

모델 class는 추론이 아닌 명시적 제품 정책이다. Codex adapter는 기존 preset의 `gpt-6-astra=frontier`, `gpt-5.6-sol=deep`, `gpt-5.6-terra=general`, `gpt-5.6-luna=lightweight`를 사용한다. 이번 지원 정책은 host tool metadata의 workhorse/easier-task 역할 설명을 근거로 `gpt-6-sol=general`, `gpt-6-luna=lightweight`를 보수적으로 추가한다. 이는 품질 실측이나 5.6 후계 등급의 자동 복제가 아니다. 같은 preset에는 `gpt-6.1-sol=general`도 있다(f96d2045, 2026-10-25 이후). 이 항목의 등급 근거(품질 실측 또는 정책 결정)와 결정 주체·시점은 저장소에 기록되어 있지 않으며, 이 문서는 근거를 추정해 채우지 않는다. 이 등급은 현재 설치 정책의 선언으로만 실행 하한 판정에 쓰이고, 품질 실측이나 effort 지원 검증 완료를 뜻하지 않는다. 이미 서명·저장된 계획이 `deep` 이상을 명시하면 그 요구를 실제 관측과 비교한다. 새 계획에서 모델 등급이나 단계 이름만으로 `deep` 요구를 만들어 내지는 않는다. 정확한 ID 정책에서 해석되지 않는 모델은 기본 실행 자격을 얻지 못한다. Claude의 Haiku/Sonnet/Opus/Fable mapping은 그대로 유지한다. Gemini adapter는 `flash-lite`=lightweight, `flash`=general, `pro`=deep, `ultra`=frontier 매핑을 적용한다. `reasoningEffort`가 없거나 공통 enum 밖이면 필수 관측 누락이며 다른 모델·턴의 값으로 보충하지 않는다. 관측한 effort가 모델의 지원 목록이나 minimum을 충족하지 않으면 서버가 실행 자격을 거부한다.

## 실패와 검증

호출자를 관측하지 못하면 `BINDING_REQUIRED`(`CALLER_PROVENANCE_UNAVAILABLE`), 호스트 사실이 모순되거나 자격·재사용 오류면 `BINDING_INVALID`다. 실행만 관측하지 못한 호출은 신원은 유지한 채 실행 하한 도구에서만 진단과 함께 거부된다. 검증된 정상 관측이 실제 단계 하한보다 낮으면 `GATE_FAILED`다. 같은 OS 사용자 권한으로 workflow DB에 쓰거나 서버 stdio를 직접 구동하는 프로세스와의 격리는 보장하지 않는다.

단위·STDIO fixture의 synthetic `_meta`와 실제 설치 호스트의 관측은 서로 다른 검증이다. 릴리즈·설치 담당자는 실호스트(설계 6.2)에서 관측과 guarded workflow 완료를 따로 확인해야 한다.

## 단계 하한의 근거와 보존 범위

D0094 후속은 `AGENTS.md`의 프리셋 제품 정책 중 고위험 작업의 `general/high` 하한을 보존한다. 이는 수치 성능 평가 결과가 아니라 명시 정책이다. 사용자 지정 모델·추론 설정은 실제 호스트 지원과 이 유효한 요구 안에서 우선하며, caller가 입력한 희망값을 실제 관측으로 바꾸거나 단계 하한을 덮어쓰지는 않는다. 모델 선택기의 프리셋·사용자 지정 처리와 호스트 capability 자격은 이번 변경으로 수정하지 않는다.

기본 `general/medium`과 capability·provider 별칭·mandatory gate에서의 `deep/high` 강제에는 별도 명시 요구나 수치 평가 근거를 확인하지 못했다. v1.13 릴리스 기록은 도입 당시의 구현 설명이며 현재 강제 하한의 독립 근거로 승격하지 않는다. 이 분기들을 제거하고 고위험이 아닌 의미 단계는 관측 전용으로 계획한다. 감사 의무·독립성·산출물 검사는 그대로 집행한다.

현재 TaskEnvelope의 `constraints`는 문자열 배열이고 provider의 `gate`는 감사 조건이다. 별도의 명시 모델 하한 입력 계약은 없다. 새 입력이나 근거 등록 도구를 추가하지 않는다. 개별 사용자 요구나 provider 필수 하한이 실제로 들어오면 현재 구조가 지원하지 않는 경계를 알리고, 이를 조용히 버리거나 문자열만으로 강제값을 추정하지 않는다. 그때 실제 소비자·권위·적용 범위를 확인해 계약 확장 또는 해당 작업 보류를 결정한다. 생성된 단계 요구는 `taskDigest`와 전체 계획 서명에 결속되고 claim 시 작업에서 다시 계산해 대조된다. 이미 claim되어 유효한 issued lease는 저장 proposal과 계획의 일치·유효기간·revision·단회 소비 검사를 그대로 거쳐 시작하고, 새 생성 규칙으로 저장 계획을 덮어쓰지 않는다. 이미 시작된 실행은 저장 계획의 nonnull 하한 비교를 계속 사용하며, caller가 서명된 하한을 null로 바꾸면 무결성 검사에서 거부한다. 과거 하한의 무결성 보존은 그 선정 근거의 타당성을 새로 인증한다는 뜻이 아니다. 정책 변경 전 미시작 계획은 기존 claim 재계산에서 충돌할 수 있으므로 원 기록을 보존하고 새 관측으로 재계획한다.
