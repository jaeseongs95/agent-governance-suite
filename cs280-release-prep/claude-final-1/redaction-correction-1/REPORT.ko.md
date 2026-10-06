# Claude final evidence 구조화 내부 추론 제거 보정

기준 공개 evidence는 `28846ad0ff51e514f5e569e68f13563f3b170923`이다. 실제 transcript 구조를 검사해 `thinking` content block이 남아 있던 6개 공개 경로를 정정했다. 6개 경로는 4개 고유 Git blob이며, 경로 기준 100건을 제거했다. `analysis`, `reasoning`, `redacted_thinking` block은 확인되지 않았다.

변환은 JSON 전체를 재직렬화하지 않았다. 각 target object와 배열 문법에 필요한 인접 쉼표만 제거하고 나머지 byte를 그대로 연결했다. 유효 JSON record는 원래 값에서 target block만 재귀적으로 뺀 값과 deep equality를 확인했다. 일반 `text`, `tool_use`, `tool_result`, 사용자 명령, 실패 결과와 record 순서는 보존했다. session transcript의 기존 parse-error 1행은 target label이 없어 원 byte 그대로 유지했다.

현재 tree의 Cloud packet JSON·JSONL·stdout 후보 685경로를 내용 SHA-256 기준 626개로 묶어 다시 검사했다. 실제 transcript의 structured internal block 잔여는 0건이었다. root `MANIFEST.tsv` 133개와 `SHA256SUMS` 135개의 현재 hash도 모두 일치했다. 전후 SHA, 제거 수와 parse-error 보존 근거는 `PROVENANCE.json`에 있다.

이 정정은 현재 branch 끝에 새 commit을 추가하는 방식이다. 이전 공개 commit, 이전 Git blob, fork와 이미 fetch된 사본은 계속 접근 가능할 수 있다. 그 접근을 줄이려면 별도 사용자 승인 뒤 모든 remote ref와 tag를 점검하고, history rewrite·force push 및 호스팅 제공자의 민감자료 제거 절차를 수행해야 한다. 이미 복제된 사본의 회수는 보장할 수 없다.
