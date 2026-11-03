# test-proof

이 모듈이 필요한 작업에서만 읽는다. 기존 AGS 권한·역할·계약을 유지한다. 규칙 원본은 [catalog.json](catalog.json)이며 모델 행동 평가는 NOT_RUN이다.

## TP-001 — 실제 실패를 확인

**담당:** test-engineering

**적용:** 회귀 테스트가 결함을 잡는다고 주장할 때

**행동:** 격리된 사본에서 결함 버전 또는 의미 있는 mutation에 같은 테스트를 실행하고 실패 후 수정 버전의 성공을 확인한다.

**근거:** 같은 caseId·test file digest·argv에 대한 red와 green 실행 receipt를 연결한다.

**피할 실패:** 고장 난 import나 실행기 부재의 exit 1은 올바른 red가 아니다.

**예외:** 실행이 허용되지 않거나 환경이 없으면 NOT_RUN을 유지한다. 사용자 원본을 되돌리지 않는다.

출처: AW-TEST, SP-VERIFY ([고정 커밋](sources.lock.json)).

## TP-002 — 일치하는 테스트와 입력

**담당:** test-engineering

**적용:** red/green 결과를 비교할 때

**행동:** 테스트 코드·관련 설정·실행 명령을 같게 유지하고 production change만 분리한다.

**근거:** snapshot file digests와 mutationPaths를 비교한다.

**피할 실패:** red에서 약한 테스트, green에서 다른 테스트를 실행한 기록을 한 쌍으로 인정하지 않는다.

**예외:** 필요한 fixture 변화는 사전 계획에 명시하고 동일 조건 비교가 불가하면 그 한계를 기록한다.

출처: AW-TEST, SP-VERIFY ([고정 커밋](sources.lock.json)).

## TP-003 — 격리와 재현성

**담당:** test-engineering

**적용:** 시간·랜덤·상태·외부 의존성을 쓰는 테스트

**행동:** 테스트 데이터는 실행별로 분리하고 seed·시계·시간대·환경을 명시한다. 대기는 조건과 deadline으로 제한한다.

**근거:** fixture 소유권, seed, clock, timezone 또는 해당 없음의 이유를 남긴다.

**피할 실패:** sleep 길이 증가나 성공할 때까지 재실행해 flaky를 감추지 않는다.

**예외:** 실제 시간·네트워크가 대상이면 통제하지 않은 경계를 명시한 별도 테스트로 둔다.

출처: AW-TEST, SP-VERIFY ([고정 커밋](sources.lock.json)).

## TP-004 — mock의 역할 제한

**담당:** test-engineering

**적용:** 외부 경계를 대체할 때

**행동:** 대체한 경계와 유지한 실제 동작을 구별하고 실제 코드가 보내는 요청과 부작용을 검증한다.

**근거:** mock boundary와 실제 실행된 entryPoint를 기록한다.

**피할 실패:** 정해준 mock 응답이 그대로 반환되는 것만으로 제품을 검증했다고 하지 않는다.

**예외:** 실제 외부 서비스 호출은 기존 승인·비용·개인정보 정책을 따른다.

출처: AW-TEST, SP-VERIFY ([고정 커밋](sources.lock.json)).

## TP-005 — 표적 mutation과 회귀 corpus

**담당:** test-engineering

**적용:** 파서·경계·인증·상태 전이 위험을 검사할 때

**행동:** 현실적인 결함을 구별하는 제한된 mutation을 사용하고 fuzz 실패 입력은 작은 회귀 corpus로 보존한다.

**근거:** mutation 설명과 잡힌 assertion, 살아남은 변이의 의미를 기록한다.

**피할 실패:** 동등한 변이를 못 잡았다는 이유만으로 실패 판정하거나 전 저장소 mutation을 무조건 실행하지 않는다.

**예외:** 수학적으로 동등한 변이는 이유와 함께 제외하며 탐색 비용 상한은 작업 계약에 둔다.

출처: AW-TEST, SP-VERIFY ([고정 커밋](sources.lock.json)).

## TP-006 — 실행 상태를 그대로 보고

**담당:** test-engineering

**적용:** 테스트 실행 결과를 요약할 때

**행동:** PASS·FAIL·NOT_RUN·TIMED_OUT·SPAWN_ERROR를 구분하고 후보·명령·stdout/stderr를 연결한다.

**근거:** 원시 receipt의 exitCode·signal·snapshot digests·시간과 검증 범위를 보고한다.

**피할 실패:** 일부 통과나 실행 0개를 전체 성공으로 바꾸지 않는다.

**예외:** 검증 도구의 무결성 일치는 독립 감사 또는 전체 정확성 보장이 아니다.

출처: AW-TEST, SP-VERIFY ([고정 커밋](sources.lock.json)).
