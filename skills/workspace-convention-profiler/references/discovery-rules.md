# 발견 규칙

## 수집 범위

매니페스트, 잠금 파일, workspace 설정, CI 구성, 빌드 파일과 최상위 안내 문서처럼 관례를 직접 선언하는 파일만 읽는다. `.git`, `node_modules`, `.venv`, `vendor`, `dist`, `build`, `coverage`, cache와 비밀 파일은 제외한다.

경로는 workspace root를 기준으로 정규화한다. 대상 경로가 아직 존재하지 않으면 예정 경로로 표시할 수 있지만, workspace 밖으로 해석되는 경로는 거부한다. symlink나 junction이 root 밖을 가리키는 경우에도 따라가지 않는다.

## 생태계와 명령

- `package.json`과 잠금 파일은 Node.js 생태계와 패키지 관리자를 확인하는 근거다.
- `pyproject.toml`, `requirements.txt`는 Python 생태계의 근거다.
- `Cargo.toml`과 `go.mod`는 각각 Rust와 Go 생태계의 근거다.
- build, test, lint, dev 명령은 manifest script와 CI의 명시적 실행 항목에서만 추출한다.

같은 목적의 명령이 출처마다 다르면 어느 하나를 표준으로 선언하지 않는다. 두 명령과 출처를 모두 보존하고 열린 질문을 추가한다.

## 구조와 변경 후보

`src`, `lib`, `app`, `apps`, `packages`, `tests`, `test`, `docs`, `scripts`처럼 역할이 분명한 디렉터리를 구조 항목으로 기록한다. `changeHotspots`는 대상 경로 주변의 구현·테스트·설정 후보만 제시하며 작업 범위를 자동 확대하지 않는다.
