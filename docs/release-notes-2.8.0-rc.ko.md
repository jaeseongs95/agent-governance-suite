# AGS 2.8.0 릴리스 노트

AGS 2.8.0은 CS 조건 도출과 구현 검토를 기존 전문 스킬 흐름에 연결한다. `cs-engineering` 0.2.0은 필요한 분야만 읽는 지식팩 0.1.0, 기본 5분야 20규칙과 명시적으로 도입하는 draft 5분야 20규칙을 제공한다. draft 규칙은 validated 규칙으로 취급하지 않는다.

선택된 CS 리뷰를 기록할 때 MCP는 실제 bundle 파일, signed task digest, 후보, 동결 조건, 검증 환경과 원시 파일 digest를 대조한다. 완료 시 같은 파일을 다시 읽어 기록 뒤 달라진 후보나 근거를 거절한다. 인계 CLI는 구현 전에 동결 입력과 의무 ID를 재검사한다. `FAIL`과 `BLOCKED`는 non-passing이며 `NOT_RUN`을 `PASS`로 승격하지 않는다.

호환 기준은 Node.js 24 이상, pnpm 11.19.0, Registry 2.0, SourceLock 3.0과 TaskEnvelope 1.0이다. 기존 plan wrapper, 수용 근거·보안·독립 감사 책임과 실행 assurance 계약은 유지한다.

CS binding의 signed plan·lease·start·resume 전체 전파, 전 작업 적용성 및 acceptance 강제, 후보 변경에 따른 epoch 재계약은 2.8.0 범위에 포함되지 않는다. 이 릴리스는 선택된 CS stage artifact를 고정하고 재검사하는 제한적 경로를 제공하며 전체 생명주기의 우회 불가 gate를 주장하지 않는다.

CS 스킬의 모델 품질·비용 A/B/C 평가는 실행하지 않았다. 이는 품질 근거의 한계이며 registry의 enabled 상태나 현재 제한적 runtime 경로를 자동으로 비활성화하는 의미는 아니다. 최종 후보의 명령 결과, 다중 OS 검증, 공식 validator, 감사와 설치 결과는 별도 릴리스 검증 보고서에서 확인한다.
