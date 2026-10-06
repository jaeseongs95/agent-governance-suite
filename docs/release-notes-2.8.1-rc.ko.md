# AGS 2.8.1 릴리스 노트 초안

AGS 2.8.1 후보는 테스트 설계·근거 검토와 고정 변경분 코드 리뷰를 기존 전문 스킬 흐름에 연결한다. 새 `test-engineering` 0.1.0과 `code-review` 0.1.0은 소스 패키지 `ags-engineering-practices` 0.1.0에서 편입한다. 패키지 0.1.0과 AGS 2.8.1은 서로 다른 버전 축이다.

공통 지식은 8개 모듈·48개 규칙이며 담당 스킬이 필요한 참조만 읽는다. 닫힌 `engineering-*.v1` 계약 9개는 테스트 계획·proof, 고정 리뷰 입력·보고서, snapshot과 실행 receipt를 표현한다. 디버깅은 `blocker-diagnostician`, 최소 구현은 `ponytail`, 의존성 보안은 `software-security-auditor`, 수용 근거는 `acceptance-evidence-validator`, 흐름 연결은 `orchestrator`의 기존 책임을 유지한다.

이 후보는 새 권한 source, hook, MCP handler, DB·세션 제어 또는 signed binding을 추가하지 않는다. raw proof와 로컬 `CONSISTENT` 결과는 수용·독립 감사·릴리스 승인 근거로 자동 승격되지 않는다. `code-review`의 `NO_BLOCKING_FINDINGS`도 고정된 입력 범위의 리뷰 결과이며 전체 제품의 정확성이나 출시 가능성을 뜻하지 않는다.

`cs-engineering` 0.2.0의 CS 조건 도출, 선택된 stage artifact binding, draft 규칙의 상태와 2.8.0 릴리스 노트의 한계는 그대로 유지한다. Node.js 24 이상, `pnpm@11.19.0`, Registry 2.0, SourceLock 3.0과 TaskEnvelope 1.0 호환 기준도 바꾸지 않으며 새 npm 의존성을 추가하지 않는다.

후보 작업 트리에는 source, registry·source lock, orchestrator bridge와 기존 테스트 wrapper 연결이 반영되어 있다. 입력 payload 47개 중 42개는 byte를 유지하고 5개는 lint와 content lock 정합성을 위한 통합 delta다. 새 package script와 npm 의존성은 추가하지 않았다. 직접 스킬 선택, registry provider 실행, 통합된 validator, 전체 repository·bundle·runtime·official 검사, Codex·Claude 생성물, 실제 호스트 로딩과 독립 감사를 실행하지 않았다. 입력 패키지의 자체 검증 보고는 통합 후보의 PASS로 재사용하지 않는다.

후보 tree의 package·plugin·marketplace metadata는 2.8.1로 맞추되, `publicVersion`과 README 설치 예시는 선행 출시 대상인 2.8.0을 가리킨다. 현재 원격 공개 `main`과 tag에는 2.8.0이 아직 게시되지 않았다. 사용자 지시로 승인된 출시 순서에 따라 2.8.0의 공개·현재 PC 설치 검증을 먼저 완료하고, 2.8.1의 source pin·생성물·실제 검사와 독립 감사를 고정한 뒤 2.8.1 공개 tag·Release·Cloud 검증·사용자 설치를 진행한다.
