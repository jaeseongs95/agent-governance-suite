# X02 바이트 전달 경로

## 선택한 경로와 적용 범위

AGS 영역 worktree와 통합 worktree가 공유하는 **검증된 Git object**를 사용한다. 영역 세션은 전용 브랜치에 파일을 커밋하고 commit SHA를 전달한다. 메인 세션은 같은 저장소의 object database에서 해당 commit의 tree entry와 blob을 읽고, 파일 크기·SHA-256·바이트 일치를 확인한 뒤 통합한다. 이 확인은 로컬 worktree 사이의 전달 증거다. 원격 반영 여부는 메인 세션이 push와 원격 ref readback으로 별도 확인한다.

수신자는 전달받은 경로와 commit SHA를 그대로 신뢰하지 않는다. 지정된 브랜치의 commit을 확인하고, `git ls-tree <commit> <path>`의 blob ID로 `git cat-file blob <blob>`을 읽어 기대 크기와 SHA-256을 비교한다. 읽은 바이트가 일치하기 전에는 파일을 해석하거나 적용하지 않는다. 긴 Base64 또는 opaque 문자열을 모델이 전사·분할·재조립하는 경로는 사용하지 않는다.

GitHub Actions workflow의 생성·수정·실행 권한은 이 경로에 필요하지 않다. 후속 작업에 privileged workflow가 필수인데 권한이 없다면 support blocker로 기록하고 승인 우회나 workflow 자동 생성을 하지 않는다. 이 Task에서는 push, force push, workflow 실행을 하지 않았다.

## 작은 파일 readback 관측

2026-09-23, 영역 worktree `agent-governance-suite-x01`을 통합 SHA `cde1a64e3388786fb25f6cafdb3d1e3708594f19`로 fast-forward한 후, `docs/implementation-3x/evidence/environment.json`을 읽었다. 다른 통합 worktree `agent-governance-suite`에서 같은 commit의 tree entry를 조회하고 blob을 `git cat-file blob`으로 읽었다. Node `Buffer.equals`로 영역 파일과 readback bytes를 직접 비교했다.

| 항목 | 관측값 |
| --- | --- |
| commit tree | `12808d6a47f741e519e81c2d11e65edd3a865e78` |
| tree entry | `100644 blob ff5939185dfde34c408374fd50455a596fabafc7` |
| 경로 | `docs/implementation-3x/evidence/environment.json` |
| readback 크기 | 2,750 bytes |
| 양쪽 SHA-256 | `297504c50094bf0159d27b16836f630f6ebbcc0d0b82d9fbb8a9a21f985d3d9f` |
| 바이트 비교 | 일치 |

영역의 X02 문서 commit을 만든 뒤에는 메인 세션의 worktree에서 그 commit의 tree/blob으로 역방향 readback을 수행한다. 결과 SHA는 X02 handoff에 기록한다. 이 검사는 Git object의 로컬 전달 가능성과 무결성만 입증하며 GitHub 원격 수용이나 workflow 권한을 입증하지 않는다.
