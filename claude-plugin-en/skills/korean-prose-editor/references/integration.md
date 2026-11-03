# MCP 통합

MCP adapter는 모델이나 외부 API를 호출하지 않고 네 provider의 입력과 출력을 운반한다. 언어 판단 provider의 실행 가능 여부를 먼저 확인하고, 셋 중 하나라도 별도 행위자로 실행할 수 없으면 `SUBAGENTS_UNAVAILABLE`로 실패한다. finalization provider에는 selection receipt인 `edit-decision-set`도 candidate와 verification receipt와 함께 전달한다.

직접 스킬 실행은 사전을 사용하지 않는다. MCP 경로는 보호 구간을 추출한 다음 읽기 전용 `lookup_korean_prose_terms`를 selection 전에 정확히 한 번 호출한다. 응답을 비공개 `glossary-match-set.v1`으로 고정하고 같은 `GlossaryBinding.v1`을 selection, editing, verification에 전달한다. 세 역할은 사전을 다시 조회하지 않는다. `protect` 일치만 보호 manifest에 병합하며 사용자 `protectedStrings`와 겹치면 사용자의 보호 구간과 원문이 우선한다. `prefer`와 `avoid`는 후보 판단의 근거일 뿐 자동 치환하지 않고, `allow`는 해당 표기를 결함으로 선택하지 않게 하는 근거로만 쓴다.

조회 상태가 `unavailable`, `limit-exceeded`, `unsupported-normalization`이면 match를 비우고 해당 고정 경고를 결속한 뒤 사전 없이 기본 편집을 계속한다. 원문, 일치 표면형, 권장 표현과 전체 match set은 workflow SQLite나 공개 receipt에 저장하지 않는다. 공개 채널에는 사전 ID·version·digest, match-set digest, match count, 상태와 고정 경고만 허용한다.

저장소의 기존 동결 평가에서는 provider 호출 직전에 `pnpm eval:preflight -- <selection|editing|verification> <run> <evaluation-root>`를 실행하고 receipt 기록 전에는 `record` 단계로 다시 검사한다. 이 검사는 승인된 실행 횟수, 기존 출력, 입력·후보·루브릭 digest, ID 순서, 빈 후보, 역할 결속과 블라인드 검증 입력을 확인한다. 실패하면 모델을 호출하지 않는다.

통합 저장소의 `pnpm eval:receipt -- <run> <evaluation-root> [cycle-path | --cycle-dir <cycle-path>]`는 기존 `evals/runs`와 구조화된 `evals/cycles/<cycle-id>` 형식을 구분한다. cycle 형식에서는 JSON·JSONL work product를 canonical digest로 결속하고, finalization 입력과 evidence에 `edit-decision-set`이 포함됐는지 검증한다. 기존 DB나 receipt가 있으면 덮어쓰지 않는다.

결과문과 receipt를 같은 객체에 합치지 않는다. 원문과 replacement가 들어갈 수 있는 work product는 호스트가 제공한 비공개 artifact 채널에서만 운반하고, MCP 응답에는 `receipt.schema.json`을 만족하는 receipt만 포함한다. 로그에도 원문, replacement, 보호 문자열이나 발췌를 남기지 않는다.

직접 함수 호출이나 비-MCP CLI 출력은 artifact 격리를 보장하지 못하므로 결과를 `unverified`로 표시한다. 이 표시는 보호 검사 통과 여부와 별개다.
