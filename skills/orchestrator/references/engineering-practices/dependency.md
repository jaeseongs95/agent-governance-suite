# dependency

이 모듈이 필요한 작업에서만 읽는다. 기존 AGS 권한·역할·계약을 유지한다. 규칙 원본은 [catalog.json](catalog.json)이며 모델 행동 평가는 NOT_RUN이다.

## DEP-001 — 이름과 출처 확인

**담당:** software-security-auditor

**적용:** 새 패키지·스킬·MCP·hook 도입

**행동:** 정확한 이름·namespace·공식 저장소·필요 기능을 확인하고 대체 가능한 기존 의존성을 비교한다.

**근거:** 확인한 출처와 고정 버전 또는 commit을 남긴다.

**피할 실패:** 모델이 제안한 이름을 확인 없이 설치하지 않는다.

**예외:** 인기도나 저장소 존재만으로 안전성이 보장되지는 않는다.

출처: AW-DEP ([고정 커밋](sources.lock.json)).

## DEP-002 — 잠금과 변경의 연결

**담당:** software-security-auditor

**적용:** manifest·lockfile 수정

**행동:** 추가·삭제·전이 의존성 변경이 작업 목적과 어떻게 연결되는지 보고 설치 방식을 재현 가능하게 유지한다.

**근거:** 변경한 graph 범위와 lockfile 검증 결과를 기록한다.

**피할 실패:** 전이 변경을 설명 없이 무조건 악성 또는 무관한 변경으로 취급하지 않는다.

**예외:** 앱 manifest의 범위 지정은 잠금 파일로 실제 버전을 고정할 수 있다.

출처: AW-DEP ([고정 커밋](sources.lock.json)).

## DEP-003 — 설치 시 실행 검토

**담당:** software-security-auditor

**적용:** build script·postinstall·CI action·agent hook 추가

**행동:** 실행 권한·파일 접근·네트워크 목적지·비밀 접근·런타임 외부 fetch를 실제 산출물에서 확인한다.

**근거:** 검토한 배포 파일과 실행 지점을 남긴다.

**피할 실패:** README의 용도 설명만 믿고 설치 후 실행 내용을 생략하지 않는다.

**예외:** 검토를 위해 임의 코드를 실행하지 말고 능동 검사 권한은 기존 작업 계약에서 확인한다.

출처: AW-DEP ([고정 커밋](sources.lock.json)).

## DEP-004 — 취약점과 악성 동작 구분

**담당:** software-security-auditor

**적용:** scanner 또는 공급망 경고가 있을 때

**행동:** 실제 resolved version·도달 경로·실행 환경·탐지 일자를 확인하고 이미 알려진 취약점과 악성 기능을 나눈다.

**근거:** advisory locator, checkedAt, reachability와 미검사 범위를 기록한다.

**피할 실패:** offline 검사 결과를 최신 CVE가 없다는 근거로 쓰지 않는다.

**예외:** 개발 전용 도구도 빌드 권한·비밀에 접근할 수 있으므로 이름만으로 저위험 처리하지 않는다.

출처: AW-DEP ([고정 커밋](sources.lock.json)).

## DEP-005 — 라이선스와 배포물 일치

**담당:** software-security-auditor

**적용:** 외부 자료를 수정·배포할 때

**행동:** 사용한 commit의 license와 notices, 실제 배포 파일을 확인하고 수정·재배포 범위를 기록한다.

**근거:** 원본 license와 수정 내역·파일별 provenance를 보존한다.

**피할 실패:** 라이선스가 없는 자료를 공개되어 있다는 이유만으로 복사하지 않는다.

**예외:** 라이선스 해석이 중요한 경우 법률 판단을 꾸며내지 않고 확인 필요 항목으로 넘긴다.

출처: AW-DEP ([고정 커밋](sources.lock.json)).

## DEP-006 — 변경 후 동일 검사 재실행

**담당:** software-security-auditor

**적용:** 의존성 업데이트나 제거 후

**행동:** 실제 변경 후보에서 기존 경고를 구별하던 검사와 관련 runtime을 다시 확인한다.

**근거:** 고정 후보·새 resolved graph·검사 결과와 되돌리기 조건을 기록한다.

**피할 실패:** 버전 숫자가 올라갔다는 이유만으로 경고 해결을 단정하지 않는다.

**예외:** 업데이트 실행은 ponytail·mutation-risk-preflight 담당이며 감사 자료가 설치 승인을 만들지 않는다.

출처: AW-DEP ([고정 커밋](sources.lock.json)).
