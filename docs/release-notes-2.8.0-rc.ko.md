# AGS 2.8.0 릴리스 노트 초안

현재 후보는 CS 조건 도출과 구현 검토를 기존 전문 스킬 흐름에 연결한다. cs-engineering0.2.0은 필요한 분야만 읽는 지식팩0.1.0, 기본5분야20규칙, 명시적 도입이 필요한 draft5분야20규칙을 제공한다.

선택된 CS 리뷰를 기록할 때 MCP는 실제 bundle 파일과 signed task digest, 후보, 동결 조건, 검증 환경과 원시 파일 digest를 대조한다. 최종 완료 시 같은 파일을 다시 읽어 기록 뒤 변경된 후보나 근거가 통과하지 않게 한다. 인계 CLI는 구현 전에 동결 입력과 의무 ID를 재검사한다. 기존 수용 근거·보안·독립 감사 책임과 실행 assurance는 유지한다.

TaskEnvelope1.0과 기존 plan wrapper를 변경하지 않는다. CS binding의 signed plan·lease·start·resume 전체 전파, 전역 적용성 및 acceptance 강제 정책은 이번 후보에 포함되지 않는다. 실호스트 자동 선택과 Windows, 품질 개선 평가 및 독립 SOURCE 감사는 별도 검증이다.

Node24 이상, pnpm11.19.0을 지원 기준으로 유지한다. 후보 ZIP/patch는 검토용이며, 공개 main·태그·Release·사용자 설치 캐시는 변경하지 않았다. 공개 릴리스는 v2.7.7이다. 최종 명령과 실제 결과는 함께 제공하는 검토 ZIP의 verification-report.ko.md를 따른다.
