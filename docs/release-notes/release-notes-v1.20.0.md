# v1.20.0 — 코드 작성에 ponytail 연결

## 핵심 변경

- MIT 공개 스킬 `ponytail`을 가져와 새 capability `minimal-implementation`의 provider로 등록했습니다(phase `implementation`, phaseOrder 44). 이 스킬은 코드를 쓰기 전에 기능이 꼭 필요한지 따지고, 저장소에 이미 있는 것, 표준 라이브러리, 플랫폼 기능, 이미 설치된 의존성 순으로 찾아 가장 단순한 올바른 구현을 고르도록 지시합니다.
  - 원본: `DietrichGebert/ponytail` v4.10.0. 가져온 곳: 포크 `jaeseongs95/ponytail`의 커밋 `83b2cbc3bc50df3030c49d1dfe598ccefe850a85`. 이 커밋은 원본 커밋 `e3ba2aa`(chore: release v4.10.0)에 스킬 버전 파일(`skills/ponytail/VERSION`)만 더했습니다. 원본 태그 `v4.10.0`(`1d95ff7`)과는 plugin manifest·`package.json`만 다르고 `skills/ponytail/SKILL.md`는 같습니다.
  - `skills/source-lock.json`에는 커밋으로 고정하고 `notify-only`로 둡니다. 원본에 새 버전이 나와도 자동 PR을 만들지 않습니다.
  - 공용 사본의 수정 다섯 가지를 lock의 `downstreamModifications`에 기록했습니다. Codex 공식 스킬 검사기가 허용하지 않는 frontmatter 키 `argument-hint`를 뺐고, 다른 스킬과 같은 `agents/openai.yaml`을 더했으며, 원본 저장소 루트의 MIT `LICENSE`를 스킬 폴더에 복사했습니다. 설명문에서는 코딩 작업 목록의 `reviewing`을 빼고 코드 검토·감사·검증·완료 판정에는 쓰지 않는다는 문장을 더했습니다. 본문에서는 "매 응답마다 켜짐"을 코드를 쓰거나 고치는 응답으로 좁히고, 경계 문단을 바꿔 검토·감사·검증·완료 보고·코딩이 아닌 답변에는 적용하지 않으며, 사용자·프로젝트·저장소 지침(보고 형식, 언어, 테스트 위치와 도구)이 출력·테스트 규칙보다 우선하고, 요청한 동작과 수용 기준은 줄이지 않고 제안만 한다고 적었습니다. 이 배포물에 없는 Caveman 스킬 언급도 뺐습니다.
- 사용자 결정에 따라 거버넌스 흐름 밖의 평소 코드 작업에도 이 스킬을 적용합니다.
  - Claude Code: MCP 서버의 세션 접수 규칙에 실패 영향이 낮은 요청이라도 코드를 작성·수정·리팩터링·설계하거나 의존성을 고르는 작업이면 코드를 쓰거나 파일을 고치기 전에 ponytail을 호출한다는 문장을 넣었습니다. 범위나 완료 조건이 불명확하면 먼저 확정하고, 코드 검토·감사·검증·완료 판정, 설명·조사만 하는 요청, 코딩이 아닌 요청, 검토·감사를 맡은 서브에이전트에서는 호출하지 않습니다. 기존 문장 "사용자가 특정 스킬을 지정한 경우에만 orchestrator 없이 그 스킬을 바로 호출한다"는 실패 영향이 큰 작업에 한정하도록 고쳤습니다.
  - Codex: 세션 접수 규칙이 없으므로 스킬 설명("Use on ANY coding task…")과 `allow_implicit_invocation: true`로 호스트가 스스로 선택합니다.
- orchestrator 초기 라우팅에 7번 항목을 넣었습니다. 코드를 작성·수정하는 구현 단계가 있는 요청은 `minimal-implementation`을 요청하고, 이 단계는 변경 전 기준선 뒤, 위험한 상태 변경의 사전 점검과 범위·수용 근거 확인 전에 실행됩니다. 사전 점검은 push·배포처럼 구현 뒤에 오는 변경의 정확한 대상을 고정하므로 구현보다 뒤에 둡니다. 같은 항목에 세 가지 경계를 적었습니다. 구현 단계에서는 Git이 추적하는 파일의 편집·삭제, 새 파일 생성, 확인용 테스트·빌드 실행만 하고, 추적되지 않는 파일 삭제·마이그레이션 실행·배포·push 같은 작업은 사전 점검 뒤로 미룹니다. 동결된 작업 계약의 범위와 수용 기준은 명시적 요청으로 보고 줄이지 않고 줄일 후보는 제안으로만 남깁니다. 검사용 테스트를 포함한 새 파일은 계약 범위(계약이 없으면 요청 범위) 안에서 저장소의 테스트 관례를 따라 만듭니다. MCP 없이 직접 진행할 때도 구현 단계에서 이 스킬을 호출합니다.
- Claude 배포물: orchestrator의 "Claude Code에서의 선택 결정" 후보 목록에 `ponytail`을 넣었고, 스킬 설명을 한국어로 바꿨으며, 본문의 `/ponytail lite|full|ultra`를 `/agent-governance-suite:ponytail …`로, `argument-hint`를 되살렸습니다. 독립 감사자(`independent-auditor`)와 숙의 reviewer(`deliberation-reviewer`) 서브에이전트는 `Skill` 도구도 쓰지 못하게 했습니다. 세션 접수 규칙이 서브에이전트에도 전달되므로, 감사·검토 중에 ponytail이나 orchestrator가 끼어들지 않게 하려는 것입니다.
- `scripts/lib.mjs`의 `readFrontmatter`가 YAML 블록 값(`description: >`, `|`)을 읽습니다. 원본 ponytail이 이 형식이라 저장소 검사가 description을 읽지 못했습니다.

## 넣지 않은 것

- 사용자 결정에 따라 원본의 항상 켜짐 훅(`SessionStart`·`UserPromptSubmit`), 보조 스킬 5개, MCP 서버는 넣지 않았습니다. 이 저장소의 Claude 전용 안내 훅(`skill-trigger-hook.mjs`)에도 ponytail 규칙을 넣지 않았습니다.

## 호환성

- Codex 배포물에도 스킬, orchestrator 라우팅 문구, 본문 수정이 들어갑니다. Codex에 보이는 MCP 도구, 계약, 훅, SQLite schema는 바뀌지 않았습니다. 세션 접수 규칙은 Claude(`anthropic` 프로필)에만 나갑니다.
- 새 capability는 선택 사항입니다. 작업 계약의 `requiredCapabilities`에 `minimal-implementation`이 없으면 계획은 v1.19.1과 같습니다. orchestrator 7번은 코드를 작성·수정하는 요청의 새 작업 계약에 이 capability를 넣도록 안내합니다(schema가 강제하지는 않습니다). 이를 넣은 계획에는 구현 stage가 하나 늘어납니다.

## 알려진 제한

- 평소 코드 작업에서 이 스킬이 실제로 호출되는지는 적은 횟수의 관측이 근거입니다(아래 검증). Claude는 접수 규칙 문장, Codex는 설명문에 기대며, 어느 쪽도 호출을 강제하지 않습니다.
- Codex에서 이 스킬이 선택되는지, direct 모드에서 7번 경계를 지키는지는 관측하지 않았습니다. 설명문과 라우팅 문구만 확인했습니다. Codex 사본에는 원본의 `/ponytail lite|full|ultra` 표기가 남아 있습니다(Codex의 호출 표기는 `$ponytail`).
- 한 번 호출된 본문은 대화 문맥에 남습니다. 본문은 코드를 쓰거나 고치는 응답에만 적용된다고 적었지만, 뒤 답변에 영향을 주지 않는다는 보장은 아닙니다.
- 사전 점검(phaseOrder 45)의 위치는 그대로이고, 그 앞에 구현 단계(44)가 새로 들어갔습니다. 구현 단계는 추적 파일 편집·새 파일·테스트·빌드만 하고 마이그레이션 실행·추적되지 않는 파일 삭제·배포 같은 작업은 사전 점검 뒤로 미루도록 orchestrator에 적었지만, 이 경계는 지침이며 MCP나 훅이 강제하지 않습니다.
- 사전 점검은 여전히 범위 확인·독립 감사보다 앞입니다. 감사 뒤 수정이 생기면 영수증을 실행 직전에 다시 검증해야 합니다. 이 순서는 이번 릴리스 이전부터 같습니다.
- 주간 upstream 동기화는 lock 커밋(`83b2cbc`)과 `v4.10.0` 태그 커밋(`1d95ff7`)이 달라 ponytail을 매번 'needs attention'에 표시합니다. 두 커밋의 `skills/ponytail/SKILL.md`는 같고, lock 커밋에는 `VERSION`이 더해져 있습니다.
- 범위나 완료 조건이 불명확한 코드 요청에서 접수 규칙은 ponytail보다 먼저 범위를 확정하라고 하지만, 확정 방식은 모델에 맡겨집니다. 관측에서는 만들 대상 자체가 없는 요청("검증 도구 하나 추가해 줘")에는 되물었고, 완료 조건만 흐린 요청("더 좋게 개선해 줘")이나 판단을 맡긴 요청("알아서")에는 저장소를 조사해 범위를 스스로 정하고 결과에서 그 선택을 보고했습니다. 스스로 정한 범위가 요청하지 않은 작은 정리까지 넓어진 경우가 있었고, 편집 전에 범위를 먼저 밝히게 하는 문구를 시험했으나 지켜지지 않고 되묻는 동작도 사라져 적용하지 않았습니다.
- 사용자가 추적되지 않는 폴더 삭제만 명시적으로 요청하면, Claude Code 세션이 실패 영향을 낮게 분류해 orchestrator와 사전 점검 없이 삭제할 수 있습니다(아래 검증). 이 판단 부분의 접수 규칙은 v1.16.1부터 같습니다.

## 검증

- 전체 검증: `pnpm install --frozen-lockfile`, `bundle:check`, `claude:drift`, `lint`, `build`, `test`(39개 파일, 344건 통과), `runtime:check`, `validate:all`, `validate:official`(스킬 19개 통과), `release:check`, `source:check`, `source:verify`, `claude:check`, `git diff --check`가 모두 종료 코드 0입니다. ponytail 폴더의 checksum을 다시 계산한 값은 lock의 `integratedChecksum`과 같습니다.
- 새 Claude Code 세션 E2E(`claude-fable-5-1`, 후보 빌드를 `--plugin-dir`로 적재, 저장소 복제본과 로컬 bare `origin` 사용, 요청당 1회, 비통계 관측). 최종 후보의 `claude-plugin/`은 2차 실행에 쓴 스냅샷과 파일 단위로 같습니다.
  - 2차(최종 후보):
    1. 평소 코드 작업 2건(`parseArguments` 확장과 테스트 추가, 작은 스크립트 작성): 두 세션 모두 실패 영향을 낮음으로 분류하고 첫 행동으로 ponytail을 호출한 뒤 편집했습니다. 테스트는 저장소의 기존 위치(`tests/tooling/tooling.test.mjs`)와 형식으로 추가됐고, 최종 보고는 바꾼 것과 검증한 것을 빠짐없이 적었습니다.
    2. 호출하지 않아야 하는 요청 4건(커밋 코드 리뷰, `pnpm lint` 결과 확인, 함수 설명, 번역): 4건 모두 ponytail을 호출하지 않았습니다.
    3. 검사 스크립트와 테스트를 추가하고 `main`에 병합해 push하는 고위험 요청: orchestrator를 먼저 호출했고, MCP 계획은 변경 전 기준선 → `minimal-implementation`(ponytail) → 사전 점검 → 범위 확인 → 수용 근거 → 독립 감사 순이었습니다. 독립 감사 뒤 push했고 `finalize_workflow`가 성공했습니다. 감사 서브에이전트는 Bash·Grep·Read·Glob만 썼고 `Skill` 호출은 없었습니다. stage 기록 한 번은 `INVALID_INPUT`, 한 번은 증거 부족(`MISSING_EVIDENCE`)으로 거절됐다가 고친 기록으로 통과했습니다.
    4. 범위가 불명확한 요청 3건: 위 "알려진 제한"에 적은 대로 대상이 없는 요청에는 되물었고, 나머지 2건은 범위를 스스로 정해 진행한 뒤 보고했습니다.
  - 1차(평소 코드 작업 적용과 서브에이전트 `Skill` 차단 전 후보): 추적되지 않는 폴더 삭제와 CI 변경, push를 함께 요청하자 구현 단계에서는 파일 편집만 하고 삭제는 사전 점검으로 넘겼으며, 사전 점검이 `NEEDS_APPROVAL`을 내자 삭제·커밋·push 없이 멈췄습니다(비대화형 세션이라 승인을 받을 수 없어 생긴 설계상 정지). 폴더 삭제만 요청했을 때는 실패 영향을 낮게 분류해 orchestrator와 사전 점검 없이 폴더 내용을 확인한 뒤 삭제했습니다.
  - 3차(시험 후 되돌린 문구): 편집 전에 고른 범위를 한 줄로 밝히게 하는 문구로 범위가 불명확한 요청 3건을 다시 실행했으나 세 세션 모두 선언 없이 편집했고, 대상이 없는 요청에도 되묻지 않았습니다. 이 문구는 넣지 않았습니다.
