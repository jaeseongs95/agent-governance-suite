---
name: codex-token-usage-analyzer
description: Explicitly analyze local Codex thread, subagent, or project token usage from session logs. Do not use for API billing, subscription limits, or generic token-count questions.
license: MIT
metadata:
  version: "0.1.0"
---

# Codex Token Usage Analyzer

사용자가 이 스킬을 명시적으로 호출하고 로컬 Codex 작업 또는 프로젝트의 token 사용량 집계를 요청했을 때만 실행한다.

<!-- optimization-navigation:start condition="the skill is activated for the request" reference="references/entry-details.md" do-not-load-otherwise="true" -->
- If the skill is activated for the request, read [entry details](references/entry-details.md) before producing any result or taking any action; otherwise do not read it.
<!-- optimization-navigation:end -->
## 결과

provider JSON의 `output.verdict`를 확인한다.

- `PASS`: 확인 가능한 모든 집계와 대조가 일치한다.
- `PARTIAL`: 사용할 수 있는 집계와 함께 누락·불일치 사유가 있다.
- `NEEDS_INPUT`: 대상 이름 또는 경로를 사용자가 더 정확히 지정해야 한다.
- `BLOCKED`: 세션 경로·대상·요청한 Markdown artifact에 접근할 수 없다.

Cache input은 Input에, Reasoning output은 Output에 포함된다. 비용, API 청구액, 구독 한도 차감량, 품질, 효율 또는 낭비를 추정하지 않는다.
