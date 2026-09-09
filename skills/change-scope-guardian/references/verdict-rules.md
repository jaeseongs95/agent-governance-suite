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
3. `preexisting-overlap` 또는 `unplanned`가 있으면 `NEEDS_APPROVAL`.
4. 나머지는 `PASS`.

`PASS`는 변경 범위만 통과했다는 뜻이다. 요구사항 충족, 코드 품질, 보안과 릴리스 가능성을 보장하지 않는다.
