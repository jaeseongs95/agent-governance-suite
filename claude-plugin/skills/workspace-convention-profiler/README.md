# workspace-convention-profiler

낯선 저장소의 구조, 사용 도구, 정의된 검증 명령과 변경 후보 지점을 읽기 전용으로 조사하는 Codex 스킬입니다. 관측한 사실에는 근거 경로와 체크섬을 붙이고, 근거가 부족한 내용은 열린 질문으로 남깁니다.

이 스킬은 적용할 `AGENTS.md`를 결정하거나 작업 범위를 승인하지 않습니다. `changeHotspots`도 조사 후보일 뿐, 사용자가 요청한 범위를 넓히지 않습니다. build, test, lint, format이나 의존성 설치 명령은 실행하지 않습니다.

## 요구 사항

- Node.js 22 이상
- pnpm 10

Agent Governance Suite나 MCP는 직접 실행에 필요하지 않습니다.

## 직접 실행

```powershell
pnpm install --frozen-lockfile
node scripts/profile-workspace.mjs --input request.json > profile.json
node scripts/validate-profile.mjs --input profile.json
```

stdin으로도 같은 JSON을 전달할 수 있습니다. 입력과 출력 형식은 `contracts/`의 JSON Schema에 정의돼 있습니다. CLI는 stdout에 JSON만 쓰며 `PASS`는 종료 코드 0, `BLOCKED`는 종료 코드 2를 반환합니다.

## 검증

```powershell
pnpm lint
pnpm test
```

`integration/skill-descriptor.json`은 플러그인 편입용 선언입니다. 독립 CLI는 이 파일이나 suite 코드를 읽지 않습니다.

## 안전 범위

수집기는 매니페스트, CI 설정, 빌드 파일과 최상위 안내 문서만 읽습니다. `.git`, dependency cache, 생성물, 비밀 파일, 크기 제한을 넘는 파일은 열지 않으며 symlink와 junction을 따라 workspace 밖으로 나가지 않습니다.

## 라이선스

MIT
