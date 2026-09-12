# MCP 통합

MCP adapter는 모델이나 외부 API를 호출하지 않고 네 provider의 입력과 출력을 운반한다. 언어 판단 provider의 실행 가능 여부를 먼저 확인하고, 셋 중 하나라도 별도 행위자로 실행할 수 없으면 `SUBAGENTS_UNAVAILABLE`로 실패한다.

결과문과 receipt를 같은 객체에 합치지 않는다. 결과문은 호스트가 제공한 비공개 artifact 채널에 저장하고, MCP 응답에는 `receipt.schema.json`을 만족하는 receipt만 포함한다. 로그에도 원문, replacement, 보호 문자열이나 발췌를 남기지 않는다.

직접 함수 호출이나 비-MCP CLI 출력은 artifact 격리를 보장하지 못하므로 결과를 `unverified`로 표시한다. 이 표시는 보호 검사 통과 여부와 별개다.
