# Finalization provider

finalization은 언어 판단을 하지 않는다. `scripts/finalize.mjs`가 verification 결정과 결정적 검사 결과만 사용한다.

`accept` edit만 반영하고 `retain` 또는 누락된 edit는 원문으로 남긴다. 보호 구간과 겹친 edit는 검증 결과와 관계없이 유지한다. 하나의 edit만 거부됐다면 다른 안전한 edit는 적용할 수 있다. 다만 원문 digest 불일치, edit 범위 오류·겹침, actor 계약 위반, `globalDecision: "fallback"`, 최종 보호 검사 실패가 있으면 원문 전체로 복귀한다.

MCP mode는 receipt만 반환 채널에 싣고 결과문은 별도의 신뢰된 transport로 전달한다. direct mode가 결과문을 함께 반환하더라도 assurance은 언제나 `unverified`다.
