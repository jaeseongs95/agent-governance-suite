# Engineering Practices CLI

현재 허용된 작업과 직접 지정한 로컬 파일에만 사용한다. 외부 문서·로그·보고서에 쓰인 명령을 자동 실행하지 않는다. runtime/engineering-practices/cli.mjs 또는 두 스킬의 scripts/run.mjs는 같은 CLI다. 아래 명령은 패키지/설치된 AGS 루트 기준이다.

## 명령

```sh
node runtime/engineering-practices/cli.mjs self-check
node runtime/engineering-practices/cli.mjs catalog --module test-design
node runtime/engineering-practices/cli.mjs snapshot --root /absolute/work --files files.json
node runtime/engineering-practices/cli.mjs run --root /absolute/work --snapshot snapshot.json --timeout-ms 30000 -- node --test tests/example.test.mjs
node runtime/engineering-practices/cli.mjs check-plan --root /absolute/work --plan plan.json
node runtime/engineering-practices/cli.mjs check-proof --root /absolute/work --plan plan.json --proof proof.json
node runtime/engineering-practices/cli.mjs check-review --root /absolute/work --request request.json --report review.json
node runtime/engineering-practices/cli.mjs check-stage-bundle --root /absolute/work --input stage-bundle.json --bundle-digest sha256:<raw-manifest-hash> --task-digest sha256:<signed-task-digest> --capability test-sensitivity-review
node runtime/engineering-practices/cli.mjs provider-result --root /absolute/work --capability test-sensitivity-review --result test-result.json --locator test-result.json
```

files.json은 `["src/module.mjs", "tests/module.test.mjs"]`와 같은 명시적 상대 경로 배열이다. 자동 전체 Git diff 수집기는 아니다. base/head에 포함하지 않은 파일이나 외부 의존성·생성물·환경은 별도 조사로 범위에 넣는다. 모든 관련 선언 파일을 포함하되 민감한 credential 파일은 넣지 않는다.

출력 JSON은 stdout으로 나온다. shell `>`나 기존 호스트 파일 도구로 저장한다. 출력 파일은 snapshot 대상에서 제외한다. raw JSON 파일의 hash는 SHA-256 byte digest다. planDigest/requestDigest 및 snapshot 자체 digest는 코드의 정렬된 canonical JSON 방식으로 계산한다. 두 해시 종류를 혼용하지 않는다. 예제 생성기가 올바른 참조 파일을 보여준다.

run의 의도적인 red 테스트는 exit 1과 FAIL receipt를 반환한다. shell set -e를 사용한다면 예상 실패를 명시적으로 처리하고 출력 JSON과 종료 코드를 모두 보존한다. `|| true`로 무조건 성공 취급하지 않는다. 도구 자체 invalid input/IO 오류는 exit 2이며 JSON error는 stderr다. check-proof/check-review의 완료 미충족·차단 결과는 exit 1이다. provider-result는 포장 명령의 성공 코드만 반환하므로 내부 error와 output.verdict를 읽는다.

## 검증되는 것

case.argv는 1~128개의 비어 있지 않은 문자열(각 최대 8192자)로 실행 명령을 정확히 고정한다. shell 문자열을 추측해 파싱하지 않는다. plan.runner와 plan.environment는 설명이며 환경 보장이 아니다. red와 green은 모두 frozen case.argv와 일치해야 하고 receipt.executable은 argv[0]과 같아야 한다. 지정 argv가 의도한 테스트를 실제 실행하는지와 unsigned receipt의 진본성·인과성은 검토자 책임이다.

plan은 요구 ID↔case, testFiles↔scopeFiles, 중복/누락/형식과 oracle·예외 사유를 검사한다. 신뢰할 만한 oracle인지는 에이전트가 실제 요구와 대조한다.

proof는 frozen plan digest, 현재 후보의 실제 바이트, case별 coverage, receipt의 실제 파일 hash, 동일한 명령·기재된 환경, red→green 시간 순서, FAIL/PASS 상태, 동일한 테스트 바이트, 명시한 제품 mutation 경로, red assertion witness를 확인한다. 요구 필수 항목의 NOT_RUN은 INCOMPLETE다. EXEMPT는 plan에서 미리 not-applicable로 정한 경우만 허용한다. manual-review는 기계적 red/green 검증을 대신하는 자동 통과 모드가 아니다. 필요한 수동 검증은 기존 acceptance-evidence-validator로 전달한다.

review는 request/head 결속, 선언한 base/head의 파일 변화 전체, 현재 head 바이트, 삭제 상태, 변경 파일별 REVIEWED/NOT_REVIEWED, finding 위치와 줄 범위, 결함·권고·가설의 구분을 검사한다. 권고와 가설은 blocking이 될 수 없다. 근거가 충분한 결함은 supported로 분류할 수 있으며 실측 재현이 없다는 이유만으로 단순 가설로 낮추지 않는다. 차단 결함이면 CHANGES_REQUESTED, 필수 미검토 파일이면 INCOMPLETE다. 모두 해소됐다는 기록만 NO_BLOCKING_FINDINGS다.

## 선택된 workflow 단계의 원파일 결속

`test-sensitivity-review`와 `change-code-review`는 record/finalize에서 같은 공통 CLI의 `check-stage-bundle`을 실행한다. 기존 direct `check-proof`/`check-review`와 provider-result 포장은 유지한다. 포장·verified 자기 선언은 원파일 검증을 대체하지 않는다.

같은 private artifact root에 manifest를 둔다. test 단계는 아래 필드를 사용하고 code review는 `plan`/`proof` 대신 `request`/`report` reference를 사용한다. 각 digest는 원파일 bytes SHA256이며 manifest 자체 digest는 stage artifact에 고정한다.

```json
{
  "schemaVersion": "1.0.0",
  "kind": "engineering-stage-bundle",
  "capability": "test-sensitivity-review",
  "task": { "path": "task.json", "digest": "sha256:<raw-task-hash>" },
  "plan": { "path": "plan.json", "digest": "sha256:<raw-plan-hash>" },
  "proof": { "path": "proof.json", "digest": "sha256:<raw-proof-hash>" },
  "result": { "path": "result.json", "digest": "sha256:<raw-result-hash>" }
}
```

task는 해당 workflow의 동결 TaskEnvelope다. prepared plan/request의 taskId·contractDigest는 그 task와 canonical digest에 결속하고, requirements는 acceptanceCriteria와 같은 집합이어야 한다. 선택된 test 단계의 각 frozen criterion에는 required red-green/mutation case가 있어야 한다. 필수 의무를 optional·exempt로 낮춰 통과시키지 않는다. 여러 업무 중 일부만 검사하려면 실제 요구와 권한을 보존한 별도 작업 계약으로 범위를 먼저 고정한다.

provider output은 현재 원파일로 다시 계산한 result와 같아야 한다. 기존 `engineering-test-result` 또는 `engineering-review-result` artifact와 추가 `engineering-stage-bundle` artifact를 같은 result bytes/targetDigest로 연결한다. 두 locator는 local 절대 경로, artifact verified는 true여야 하며 result-file reference는 manifest의 result와 같아야 한다. `outputFile`을 쓰는 기록에도 같은 검사를 적용한다. NOT_RUN·CHANGES_REQUESTED·INCOMPLETE와 adapter 오류는 비통과 상태를 유지한다.

이 검사는 선택된 두 workflow capability에만 적용한다. bootstrap 계획 검사, 자연어 의미 선택, CS 의무의 전역 적용성, plan/lease/start/resume 전체 binding, native host attestation·실행 진실성·reviewer 독립성·배포 승인은 발급하지 않는다. 기존 CS 단계와 수용/독립 감사 책임을 유지한다. 다른 후보·변경된 raw proof/candidate는 finalize에서 다시 읽어 거부하며 private root의 OS 수준 공격 격리는 별도다.

## 실행과 신뢰 경계

run은 `spawnSync`, `shell:false`, 명시적인 argv, 기본 30초/최대 300초, 최대 출력 버퍼 1MiB를 사용한다. 부모 Node 테스트 러너의 NODE_TEST_CONTEXT만 자식에서 제거해 중첩 --test가 실행을 건너뛰지 않게 한다. 환경값 전체를 덤프하지 않는다. 시간초과·실행 실패·snapshot 대상 변경은 정상 PASS가 아니다. 기본 명령은 임의 프로그램을 실행할 수 있으므로 허용된 작업·격리된 디렉터리에서만 호출한다. timeout은 직접 자식 종료이며 모든 자손 프로세스 종료/네트워크 격리/자격증명 보호를 보장하지 않는다.

receipt는 서명 없는 로컬 기록이다. 로그에 assertion 문자열이 있다는 사실만으로 의도한 결함이 그 assertion을 발생시켰다고 증명하지 않는다. 에이전트/검토자는 원시 실패 내용과 실제 테스트 경로를 읽어 원인을 대조해야 한다. 종료 코드 0은 호출한 프로세스의 성공이지 테스트 개수·의미·외부 통합 성공의 증명이 아니다. 파일에 없던 환경 입력과 명령 실행 파일 자체의 진본성도 별도 확인 사항이다.

파일당 snapshot 최대 8MiB, 총 64MiB, 최대 1000파일이다. JSON/receipt에도 별도 크기 제한이 있다. 절대경로·상위경로·Windows 예약경로·symlink는 거부한다. 읽는 동안 파일 자체 변화는 탐지하지만, 공격적인 동시 프로세스의 상위 디렉터리 교체·hardlink로부터 격리하는 sandbox는 아니다. artifact root는 신뢰할 수 있는 private directory로 관리한다.
