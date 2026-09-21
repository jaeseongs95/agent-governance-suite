---
name: instruction-scope-resolver
description: 특정 경로에서 어떤 CLAUDE.md·.claude/rules·AGENTS.md·AGENTS.override.md가 적용되는지 확인해야 할 때, 지침끼리 충돌하는 것 같을 때, 하위 디렉터리 규칙이 상위를 덮는지 판단할 때 쓴다. 적용 chain·우선순위·충돌 근거를 계산한다. 지침 파일 작성이나 일반 정책 검토는 하지 않는다.
license: MIT
metadata:
  version: "1.0.0"
---

# Instruction Scope Resolver

대상 경로마다 실제로 적용되는 저장소 지침을 찾고 근거를 남긴다. 파일을 만들거나 수정하지 않으며, 저장소 지침을 근거로 사용자 권한을 넓히지 않는다.

## 입력 확인

workspace root, 대상 경로와 caller가 읽도록 허용한 instruction root를 `InstructionScopeRequest.v1`으로 준비한다. 시스템·개발자·사용자 지침은 파일 시스템에서 추측하지 않고 이미 제공된 참조만 `externalPolicyRefs`에 넣는다.

대상이 아직 없다면 `mayNotExist: true`를 명시한다. 허용된 root 밖의 경로, 외부를 가리키는 symlink·junction, 읽을 수 없는 지침 파일은 임의로 우회하지 않는다.

<!-- optimization-navigation:start condition="the skill is activated for the request" reference="references/entry-details.md" do-not-load-otherwise="true" -->
- If the skill is activated for the request, read [entry details](references/entry-details.md) before producing any result or taking any action; otherwise do not read it.
<!-- optimization-navigation:end -->
## Claude Code 지침 파일

스크립트는 `AGENTS.md`·`AGENTS.override.md` chain만 계산한다. Claude Code는 `AGENTS.md`를 직접 읽지 않고 `CLAUDE.md` 계층을 읽으므로, [claude-code-instructions.md](references/claude-code-instructions.md)에 따라 Claude Code 지침 파일을 따로 확인하고 `findings`에 원본 경로와 함께 기록한다. 이 확인을 하지 않았으면 `PASS`로 판정하지 않고 `ANALYSIS_REQUIRED`를 유지한다.

## 출력과 실패 처리

출력은 `InstructionScopeResolution.v1`을 따른다. 파일 chain, SHA-256, 활성 규칙의 원본 위치와 미해결 충돌을 보존한다.

- 파일 탐색만 끝났고 의미 판정 전이면 `ANALYSIS_REQUIRED`다.
- 적용 chain의 의미를 확인했고 중요한 충돌이 없으면 `PASS`다.
- 사용자 판단이 필요한 충돌은 `NEEDS_INPUT`이다.
- 입력이 잘못됐거나 허용된 root 안에서 증거를 읽을 수 없으면 `BLOCKED`다.

다른 전문 스킬을 직접 호출하지 않는다. 통합 실행 정보는 `integration/skill-descriptor.json`에서 제공한다.
