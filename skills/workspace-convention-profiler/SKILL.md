---
name: workspace-convention-profiler
description: 낯선 저장소의 구조, 도구, 관례, 정의된 검증 명령과 변경 후보 지점을 읽기 전용으로 조사한다. AGENTS.md 우선순위 판정, 작업 범위 확정, diff 감사에는 사용하지 않는다.
license: MIT
metadata:
  version: "0.1.1"
---

# Workspace Convention Profiler

현재 작업과 관련된 저장소 구조와 관례를 근거와 함께 정리한다. 관측된 사실, 반복 사례에서 얻은 추론, 확인하지 못한 항목을 구분하고 저장소에 새 관례를 만들지 않는다.

## 적용 조건

- 사용자가 저장소 구조, 관례, 명령 또는 변경 후보 지점을 조사해 달라고 요청했다.
- 낯선 저장소의 여러 파일이나 모듈을 수정하기 전에 기존 방식을 확인해야 한다.
- 작업 분해나 검증 계획에 필요한 코드, 테스트, 설정 위치가 아직 확인되지 않았다.

단일 파일의 명백한 수정, 이미 유효한 profile이 있는 작업, 적용 `AGENTS.md`만 묻는 요청, 현재 diff의 범위 판정에는 사용하지 않는다.

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

## 출력

출력은 [profile 계약](references/profile-contract.md)을 따른다. `profileFingerprint`는 결과에 영향을 주는 요청 필드, Git ref와 revision, 관측한 구조·근거로 계산하며 `observedAt`은 포함하지 않는다. 요청, 관련 매니페스트, CI, 지침, Git 상태나 구조가 바뀌면 이전 profile을 다시 사용하지 않는다.
