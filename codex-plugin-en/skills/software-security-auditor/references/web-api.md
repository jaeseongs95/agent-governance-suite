# 웹·API 감사

각 항목을 실제 엔드포인트와 권한 경계에 연결한다. 적용 불가에는 이유를, 미확인에는 필요한 증거를 적는다. OWASP ASVS의 적용 버전과 요구사항 ID를 기록할 수 있지만 체크리스트 충족만으로 전체 안전을 주장하지 않는다.

- 인증·인가: 로그인 여부와 객체 소유권·역할·tenant 제한을 분리한다. 공통 middleware, router 장착, DB row policy까지 추적한다. 다른 사용자의 ID, bulk API, export, background job이 같은 정책을 쓰는지 확인한다.
- 입력: SQL·템플릿·명령·파일·역직렬화 sink까지 데이터 흐름을 확인한다. escaping이 해당 문맥에 맞는지와 decode·normalize 순서, allowlist의 적용 위치를 본다.
- 세션: 토큰 검증·수명·폐기·audience, cookie 속성, 상태 변경의 CSRF 방어를 실제 배포 전제와 함께 판단한다. 설정이 없으면 환경을 추측하지 않는다.
- 외부 요청: 공격자 통제 URL, redirect·DNS 재해석, 사설망과 메타데이터 접근, 응답 노출을 함께 살핀다. 사용자 URL이라는 사실만으로 SSRF를 확정하지 않는다.
- 업무 규칙: 결제·환불·쿠폰·승인 단계의 권한, 중복 처리, 병렬 요청과 idempotency를 추적한다. 로컬 합성 상태만 사용한다.
- 민감정보: 응답·로그·오류·캐시·백업의 데이터 노출을 확인하고 보고서에는 비밀 원문을 복사하지 않는다.
- 의존성·CI: lockfile 버전, advisory 적용 조건, 실제 배포 포함 여부와 도달 가능성을 구분한다. 워크플로 token 권한, 비신뢰 PR 입력의 실행, artifact·release 신뢰 경계도 확인한다.

예: handler에 소유권 검사가 없어도 실제 router의 tenant middleware가 대상 객체를 제한하면 그 증거로 가설을 반증한다. middleware 파일만 있고 장착 경로가 없으면 보호된다고 추정하지 않는다.
