# 경로와 우선순위 판정

## 탐색 범위

대상 파일은 부모 디렉터리부터 탐색한다. 대상 디렉터리는 그 디렉터리부터 탐색한다. 아직 없는 대상은 가장 가까운 기존 상위 디렉터리의 실제 경로에 남은 경로 조각을 붙여 판정한다.

caller가 `authorized: true`로 지정한 `instructionRoots`만 탐색한다. 대상은 workspace root 안에 있어야 하며, instruction root는 대상의 조상이어야 한다. symlink나 junction을 해석한 실제 대상이 workspace 밖으로 나가면 중단한다.

## 파일 선택

각 디렉터리에서는 공백을 제외한 내용이 있는 `AGENTS.override.md`를 먼저 선택한다. 이 파일이 선택되면 같은 디렉터리의 `AGENTS.md`는 적용 chain에 들어가지 않는다. override가 없거나 공백뿐이면 비어 있지 않은 `AGENTS.md`를 선택한다.

chain은 넓은 범위에서 좁은 범위 순으로 정렬한다. 더 가까운 파일은 충돌하는 규칙만 덮어쓴다. 충돌하지 않는 상위 규칙은 그대로 유지한다.

`precedence`는 선택된 chain 안의 1부터 시작하는 순서다. instruction root에 지정한 precedence는 겹치는 root의 탐색 순서를 안정적으로 정하는 데 쓰지만, 더 가까운 디렉터리라는 사실을 뒤집지 않는다.

## 예정 경로

`mayNotExist: true`인 경로는 실제로 존재한다고 표현하지 않는다. `exists: false`와 계산한 절대 경로를 함께 반환하고, 현재 존재하는 조상까지만 지침 파일을 찾는다. 예정 경로 아래에 나중에 추가될 지침은 알 수 없다는 제한을 findings에 남긴다.
