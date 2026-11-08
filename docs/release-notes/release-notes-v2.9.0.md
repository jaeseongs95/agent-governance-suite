# AGS 2.9.0 릴리스 후보

이 후보는 v2.8.1 이후 검증된 R1~R3 소스 변경과 버전·생성 배포물 정리를 포함한다. tag와 GitHub Release 게시 전에는 공개 완료 상태가 아니다.

- 엔지니어링 단계의 원 증거를 workflow/test 경계에 연결하고 모델 지원 검사의 입력 처리를 보강한다.
- 공용 상태 authority·connection과 비활성 legacy adapter를 준비한다. 기본 운영 경로를 새 DB로 전환하거나 기존 사용자 DB를 이전하지 않는다.
- wake 검증에서 문자열 DB 경로를 기존 정적 읽기 전용 verifier로 처리해 조회 중 키 생성과 일부 예외 전파를 막는다. 서명·issuer·권한·유효기간 의미를 유지한다.
- Ponytail 원격 검증 주소를 `DietrichGebert/ponytail`로 바꾸고, clone에 없는 고정 커밋은 같은 SHA를 한 번 가져와 검증한다. 원본 커밋·버전·체크섬과 이전 가져오기 주소를 보존한다. 앞으로 안정 태그 알림은 새 원격을 기준으로 하며, `notify-only`와 `automaticInstall: false`를 유지한다.

기존 호스트 전용 설정과 공개 API를 유지한다. 공유 DB backup·legacy 상태 hydration, 운영 DB/MCP 전환, 실제 host 관측 연결과 현재 후보의 양 Cloud 검증은 남아 있다. 과거 fixture·로컬 회귀를 실제 운영 검증으로 해석하지 않는다.

릴리스 전에는 최종 후보의 로컬 필수 검사·Claude 생성 검사·독립 감사·정상 PR 승인과 CI를 확인한다. 검사가 실패하거나 실제 host·설치 요건이 충족되지 않으면 그 단계는 미완료로 보고한다. 기존 v2.8.1 tag와 설치물은 보존하며 공개 rollback은 보호규칙을 따르는 별도 수정·복구 절차로 진행한다.
