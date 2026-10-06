# SQLite 큐의 실행 가능한 예시

`assets/examples/sqlite-queue/`에는 기준 출처, 요청, 제약, task, 정책, binding,
후보 manifest, 리뷰와 실제 로컬 참조 테스트 결과가 포함되어 있다.
예제 후보는 이 패키지가 새로 만든 Python reference queue다. AGS 제품 큐의 복사나
현재 AGS에서 발견된 결함이 아니다. 목적은 제약을 코드와 근거에 결속하는 흐름을 보여주는 것이다.

```text
node <SKILL_DIR>/scripts/validate.mjs check-bundle --root <SKILL_DIR>/assets/examples/sqlite-queue --binding binding.json --task task.json --policy policy.json --review review.json --candidate candidate.json
```

예제는 두 조건을 동결한다. 첫째, 같은 소유권 세대의 원자 claim 성공자는 최대 하나다.
둘째, 재할당되거나 만료된 token은 DB의 결과를 확정하지 못한다. 독립 프로세스의
claim 경합과 오래된 worker의 완료 쓰기로 검증한다. 근거 파일은 실행한 테스트의
요약이며 코드 검토와 원시 로그의 의미 해석을 대체하지 않는다.

후보는 `BEGIN IMMEDIATE`와 조건부 UPDATE, generation 및 lease 비교를 사용한다.
비교할 시간을 호출자가 주입한다. 실제 운영에서는 시간의 신뢰·단위·프로세스 간
비교 가능성을 별도로 설계해야 한다. 이 예제는 외부 API 부작용의 exactly-once,
멀티호스트 공유 파일시스템, 네트워크 파티션, 운영 처리량의 보장을 주장하지 않는다.

전체 ZIP에서 재실행하려면 다음을 사용한다.

```text
python tests/cs-engineering/sqlite_reference_test.py
node --test tests/cs-engineering/reference-mechanisms.test.mjs
```

기본 테스트 실행은 예제 근거를 덮어쓰지 않는다. 근거를 새로 수집하고 예제를 다시
동결하는 유지보수 작업에서는 `--write-evidence`와 `integration/build-example.mjs`를
순서대로 사용한다. 그 뒤 패키지 digest가 바뀌므로 source-lock과 배포 manifest를
다시 작성하고 검증해야 한다. 기존 운영 작업의 binding을 조용히 갱신하지 않는다.
