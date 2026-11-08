# v1.14.0 — Claude Code distribution

## 핵심 변경

- Claude Code 배포물을 추가합니다. `claude-plugin/`은 `pnpm claude:build`가 생성하고, Claude 전용 파일은 `claude-overlay/`, 공용 파일의 Claude용 문구 보정은 `claude-overlay/replacements.json`에 둡니다.
- `.claude-plugin/marketplace.json`으로 Claude Code 마켓플레이스 설치 경로를 제공합니다.
- Claude Code 배포물의 상태 DB는 `${CLAUDE_PLUGIN_DATA}` 아래에만 만듭니다.
- `AGENT_GOVERNANCE_TOOL_SCHEMA_PROFILE=anthropic`일 때 `plan_workflow`의 공개 스키마를 최상위 조합자 없는 객체 스키마로 내보냅니다. Claude 플러그인 매니페스트에서만 이 값을 넘깁니다.
- CI에 `pnpm claude:check`를 추가해 생성물과 소스가 어긋난 채로 병합되지 않게 합니다.
- 저장소 전체 Vitest 기본 타임아웃을 30초로 올립니다(`vitest.config.mjs`). 이전에는 설정 파일 없이 기본 5초를 썼고, Windows CI가 이 한계에서 간헐적으로 실패했습니다.

## 배경

Windows의 Claude Code 2.1.274는 최상위 `oneOf`를 쓰는 입력 스키마의 도구를 건너뜁니다.

```
Skipping tool "plan_workflow": its input schema uses top-level oneOf, which the Anthropic API does not accept.
```

`plan_workflow`가 빠지면 orchestrated workflow를 시작할 수 없으므로, Claude 배포물에서만 공개 스키마 표현을 바꿉니다. 입력 검증은 두 프로필 모두 기존 `PlanWorkflowRequest.v1` 계약을 그대로 사용합니다.

## 호환성

- Codex 배포물은 바뀌지 않습니다. 환경 변수 없이 띄운 서버가 내보내는 도구 목록은 이전 번들과 같고, 두 프로필 모두 도구 20개를 노출합니다.
- 스킬 구성, 계약 schema와 SQLite schema는 v1.13.0과 같습니다. 기존 workflow·continuity DB는 그대로 열립니다.
- 실행 보증은 기존 경계를 유지합니다. Claude Code 훅은 모델 정보를 주지 않으므로 orchestrated 모드는 신뢰할 수 있는 attestation adapter가 없는 한 `BINDING_REQUIRED`로 차단됩니다. 이는 Codex 배포 서버와 같은 동작입니다.

## 알려진 제한

- Claude Code에서 orchestrated semantic workflow를 실제로 진행하려면 host가 trusted execution context provider를 공급해야 합니다. 이 릴리스는 그 adapter를 포함하지 않습니다.
- `claude-plugin/`은 생성물이므로 직접 수정하면 `pnpm claude:check`가 실패합니다. 공용 원본이 바뀌면 같은 변경에서 `pnpm claude:build`를 실행해 함께 커밋합니다.
