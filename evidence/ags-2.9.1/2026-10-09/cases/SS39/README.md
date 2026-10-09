SS39 기존 오프라인 증거 게시본

기존 검증 결과는 FAIL이다. 기존 회귀 9 PASS, 새 경계 시험 19 PASS / 3 FAIL을 그대로 보존했다. 원래 counterexample-01..12는 개별 입력·기대값이 없어 모두 NOTRUN이며 전체 variant 판정은 BLOCKED다. selected/read/applied/verified는 모두 NOTRUN, agentSelectedSkillIds와 hostReceipt는 null이다. JEV/vendor/Claude/실제 Codex API 호출 0, 이 게시 작업의 새 시험·기존 시험 재실행 0이다.

기준 후보 commit c6a8019be30e4bf5ee9a36147ca45ae28b0f75b6 / tree 28f2f2ed8a864405320f6d20e7bc5004e8466ad3, branch codex/skill-classification-2.9.1이다. fixture 원본 bytes 142450 / SHA256 17ade7e27cc11ffee8cc0b7b2070785617861d4c3384448cf24fce75f40d87e9, 동결 oracle SHA256 5db1d67cef8719c40b17b0ab07003f01f765746d34ced0b326e59fadb2efe055이다. pinned/fixtures.json은 기존 공개 fixture와 동일 bytes다. SHA는 재채점 결과가 아닌 기존 근거 결속이다.

실패는 qualification 대기 중 만료 후 전송, credential 대기 중 profile revision 변경 후 전송, invalid RESP의 유효 비용 $0.6→null 유실이다. 알려진 전송 직전 재검사 공백·invalid RESP 비용 유실과 연결한 2개 원인 그룹이며 새 결함 중복 집계가 아니다. 원래 oracle=null이므로 정확도 점수를 만들지 않았다. 테스트 판단용 응답은 synthetic이며 AGENT 선택이 아니다. 기존 command/exit와 원시 runner report는 evidence/에, 시나리오 입력·기대·관측·wire·원장은 evidence/SS39-DEV-*.json에 있다.

이 게시본은 정제본이다. 원본은 변경하지 않았으며 manifest.json의 origin.bytes/origin.sha256와 공개 bytes/sha256를 구분한다. private 절대 경로를 역할 placeholder로 치환했다. 재현 파일에서는 증거 출력만 .ss39-evidence로, 호출하지 않는 native mock executable만 /host/codex로 바꿨다. 기존 proof에 남은 candidate/test digest는 원본의 digest이며 공개 정제본이 원본 bytes와 같다고 주장하지 않는다. stdout/stderr의 빈 파일도 보존했다. 개인 대화·자격정보·환경 변수 값·개인 로컬 경로·원본 tar·불필요한 전체 archive-before 목록은 게시하지 않는다.

제품 수정 patch: NONE (원래 제품 소스를 수정하지 않았고 생성된 patch가 없다).
원본 회수 누락: TEST-SPEC.seq7.ko.md = MISSING_ORIGINAL. 원래 12개 counterexample의 개별 입력·기대 정의도 미제공/MISSING_ORIGINAL이다. 결과 JSON·22개 시나리오·test·기존 stdout/stderr·exit 원본은 PRESENT이다. 실호스트 영수증은 NOTRUN이며 없는 로그를 만들지 않았다. check-plan은 READY/exit0, check-proof는 INCOMPLETE/exit1이라는 기존 관측을 보존했다.

다음 명령은 재현 안내이며 게시 작업에서 실행하지 않았다. 외부 API가 필요 없는 mock 시험이다. repo의 기존 Node 24.19 / Vitest 의존성을 사용한다. 설치가 필요하면 별도 환경 권한을 따른다.

```sh
git clone https://github.com/jaeseongs95/agent-governance-suite.git ags-ss39-reproduction
cd ags-ss39-reproduction
git checkout --detach c6a8019be30e4bf5ee9a36147ca45ae28b0f75b6
# 이 게시 경로의 reproduction/SS39.test.ts를 아래 repo 상대 위치로 복사한다.
mkdir -p tests/ss39-independent
# cp <downloaded-case-directory>/reproduction/SS39.test.ts tests/ss39-independent/SS39.test.ts
node node_modules/vitest/vitest.mjs run tests/mcp/skill-classification-profiles.test.ts -t SS39
node node_modules/vitest/vitest.mjs run tests/mcp/skill-classification-service.test.ts -t 'SS19/39 OFF'
node node_modules/vitest/vitest.mjs run tests/ss39-independent/SS39.test.ts
```

세 번째 명령은 기존 후보에서 19 PASS / 3 FAIL과 exit1이 관측됐던 명령이다. 수정 후보의 green, 실제 workload quality·최소 비용 qualification, 실제 host selection/read/applied/verified는 아직 NOTRUN이다. 원래 반례 정의와 승인된 runtime profile·route·예산·host hook 증거가 다음 입력이다.

파일 무결성: manifest.json은 자신과 SHA256SUMS를 files 목록에서 제외한다. SHA256SUMS는 모든 payload와 manifest.json을 포함하고 자신의 hash를 포함하지 않는다. 이 구조에는 순환 hash가 없다. publish commit 및 실제 원격 검증 결과는 게시 후 보고하며 이 README는 push 성공이나 원격 검증 완료를 미리 주장하지 않는다.
