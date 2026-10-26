# 판정 규칙

각 현재 변경은 다음 중 하나로 분류한다.

- `in-scope`: baseline 이후 생겼고 허용 경로 안에 있다.
- `excluded`: 명시적 제외 경로와 일치한다.
- `unplanned`: 제외되지는 않았지만 포함 범위와 write target 밖이다.
- `preexisting-untouched`: baseline 당시 변경과 상태·checksum이 같다.
- `preexisting-overlap`: baseline 당시 변경된 경로가 이후 다시 달라졌다.
- `ownership-unknown`: baseline이 없거나 현재 저장소와 연결할 수 없다.

submodule 내부를 읽지 않으므로 baseline 당시 이미 dirty였던 gitlink가 이후에도 dirty이면 동일 상태임을 증명할 수 없다. 이 경우 안전하게 `preexisting-overlap`으로 분류한다.

전체 verdict는 우선순위대로 계산한다.

1. baseline 부재·불일치로 소유권을 판단할 수 없으면 `INCONCLUSIVE`.
2. `excluded`가 있으면 `BLOCKED`.
3. `preexisting-overlap` 또는 `unplanned`가 있으면 `NEEDS_REVIEW`. 확인된 범위 이탈이나 기존 변경과의 겹침이며 증거 부족으로 바꾸지 않는다.
4. 나머지는 `PASS`.

`NEEDS_REVIEW`는 정확한 경로와 기존 변경 소유권을 검토해야 한다는 뜻이며 사용자 승인 요청을 뜻하지 않는다. 원 요청·goal·적용 지침에서 이미 허용한 필요한 변경이면 그 근거로 범위를 조정하고 task contract와 baseline을 새로 만든다. 기존 사용자 변경은 보존하고, 소유권을 확인할 수 없으면 추측해 덮어쓰지 않는다. 사용자 승인이 실제 필요한 기본 브랜치 병합·tag/release·설치/배포·영구삭제·권한확대·운영 데이터 변경이나 원 권한 밖 작업만 별도로 승인을 받는다. provider는 검토가 해결되기 전까지 `blocked`로 소비하며 `needs-approval`로 승격하지 않는다.

`PASS`는 변경 범위만 통과했다는 뜻이다. 요구사항 충족, 코드 품질, 보안과 릴리스 가능성을 보장하지 않으며 새 작업 권한을 부여하지 않는다.
