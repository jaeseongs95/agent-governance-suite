# 경로 판정 규칙

모든 경로는 저장소 루트 기준 POSIX 상대 경로로 정규화한다. 절대 경로, `..`로 루트를 벗어나는 경로, 해석되지 않은 환경 변수와 홈 축약은 범위 규칙으로 인정하지 않는다.

`scope.excluded`가 항상 우선한다. 허용 범위는 `scope.included`와 모든 `workUnits[].writeTargets`의 합집합이다. 정확한 파일, 디렉터리 접두사, `*`, `**` glob을 지원한다. 규칙이 자연어 설명이라 경로로 해석할 수 없으면 일치한다고 추측하지 않는다.

rename은 원래 경로와 새 경로가 모두 허용되어야 한다. delete는 삭제 전 경로가 허용되어야 한다. symlink 자체의 변경은 링크 경로로 검사하지만 링크 대상은 열지 않는다. submodule은 gitlink 경로만 검사한다.

Windows 드라이브와 구분자는 canonical repository root를 찾을 때만 사용한다. Windows 저장소에서는 대소문자만 다른 규칙으로 제외 범위를 우회하지 못하도록 case-insensitive하게 비교한다. 보고서에는 소문자 변환 없이 Git이 반환한 경로 철자를 보존한다.
