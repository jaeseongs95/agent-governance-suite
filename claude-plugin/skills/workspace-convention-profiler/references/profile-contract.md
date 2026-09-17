# Profile 계약

입력은 `contracts/workspace-profile-request.v1.schema.json`, 출력은 `contracts/workspace-convention-profile.v1.schema.json`을 따른다.

`evidenceRefs`는 `상대경로#sha256:<digest>` 형식이다. 디렉터리 근거도 `상대경로/#sha256:<digest>`로 기록하고 `evidenceIndex`의 `kind: directory` 항목에 결속한다. `profileFingerprint`는 결과에 영향을 주는 요청 필드, Git ref·revision·상태, 관측한 디렉터리와 산출물의 SHA-256이다.

`PASS`는 저장소 조사에 필요한 최소 근거를 얻었다는 뜻이다. 구현 범위 승인, 테스트 통과 또는 작업 완료를 뜻하지 않는다. `BLOCKED`는 workspace나 경로 입력이 잘못됐거나 안전하게 근거를 수집할 수 없는 경우에 사용한다.
