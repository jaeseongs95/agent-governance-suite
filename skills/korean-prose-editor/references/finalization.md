# Finalization provider

finalization은 언어 판단을 하지 않는다. `scripts/finalize.mjs`가 source-unit manifest, selection·editing·verification work product와 결정적 검사 결과만 사용한다.

`accept` edit만 반영하고 `retain` 또는 누락된 edit는 원문으로 남긴다. 선택되지 않은 unit, `retain`·`defer` unit, fenced-code unit, 보호 구간과 겹치는 edit, 최소 범위가 아닌 edit도 그 edit만 유지한다. 하나의 edit가 거부돼도 다른 안전한 edit는 적용할 수 있다.

원문·unit manifest·selection·editing·verification의 digest는 앞 단계 artifact 전체의 `stableJson` SHA-256으로 차례로 연결한다. finalization request의 `rubricDigest`도 verification work product의 값과 같아야 한다. 원문 digest 불일치, 결정적으로 다시 만든 unit manifest와의 불일치, malformed selection, editing 후보 digest 불일치, surrogate pair를 자르는 edit 범위·겹침, actor 계약 위반, verification artifact나 rubric 불일치, 승인 edit와 안전하지 않은 전체 assessment의 충돌, `globalDecision: "fallback"`, 최종 보호 검사 실패가 있으면 원문 전체로 복귀한다.

MCP mode는 receipt만 반환 채널에 싣고 결과문은 별도의 신뢰된 transport로 전달한다. direct mode가 결과문을 함께 반환하더라도 assurance은 언제나 `unverified`다.
