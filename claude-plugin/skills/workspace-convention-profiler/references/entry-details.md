## 경계

- 적용 지침의 우선순위는 별도 instruction scope 결과가 있으면 그대로 사용한다. 이 스킬이 재판정하지 않는다.
- `changeHotspots`는 조사 후보이며 작업 범위를 넓힐 권한이 아니다.
- 의존성을 설치하거나 build, test, lint, format 명령을 실행하지 않는다.
- 비밀 파일, `.git`, dependency cache, 생성물과 수집 한도를 넘는 파일 본문을 읽지 않는다.
- 자연어 근거가 부족하면 관례를 추측하지 말고 `unknown` 또는 열린 질문으로 남긴다.

## 절차

1. workspace root, 작업 목적, 대상 경로와 이미 해석된 지침 참조를 확인한다.
2. [발견 규칙](references/discovery-rules.md)에 따라 허용된 선언 파일과 디렉터리 구조를 읽는다.
3. 각 관례에 [근거 신뢰도](references/evidence-confidence.md)를 붙인다.
4. `scripts/profile-workspace.mjs`에 `WorkspaceProfileRequest.v1` JSON을 전달해 결정적 profile과 fingerprint를 만든다.
5. confirmed 항목의 근거, 충돌한 명령, 열린 질문과 제한사항을 직접 대조한다.
6. 구조화된 `WorkspaceConventionProfile.v1`과 짧은 사용자용 요약을 반환한다.

작업 루트가 없거나 루트 밖 경로를 요구하거나 핵심 근거에 접근할 수 없으면 `BLOCKED`로 끝낸다. 일부 관례만 불명확하면 제한사항을 보존한 `PASS`가 가능하다.
