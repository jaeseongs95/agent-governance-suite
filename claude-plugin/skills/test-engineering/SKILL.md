---
name: test-engineering
description: 테스트를 작성·보강하거나 회귀 테스트의 결함 탐지 능력을 확인할 때 쓴다. 요구·실제 코드 경계에서 사례를 설계하고 red/green 또는 표적 mutation 근거를 정리한다. 원인 진단, 제품 구현 총괄, 최종 수용·독립 감사·릴리스 승인에는 쓰지 않는다.
license: MIT
metadata:
  version: "0.1.0"
---

# Test Engineering

## 적용과 입력
테스트 설계·구현·회귀 보호가 요청되면 사용한다. 단순 개념 설명·문구 수정·제품 코드 구현만 요청된 작업에는 절차를 추가하지 않는다. 적용 지침, 작업 계약, 테스트 대상 코드, 기존 runner와 허용된 실행 범위를 먼저 읽는다.

## 실행
1. 현재 코드와 테스트 설정에서 실제 공개 경계와 검증 가능한 요구를 식별한다. 기존 `cs-engineering` 보고서가 있으면 rule/obligation ID를 참조하고 재정의하지 않는다.
2. [test-design](../orchestrator/references/engineering-practices/test-design.md)을 읽고 `engineering-test-plan`을 만든다. 요구·case·oracle·테스트 수준·제외 범위를 연결한다. 기존 승인이 있는 요구에 대해 형식적인 추가 승인을 반복하지 않는다.
3. 허용된 범위에서 해당 runner로 테스트를 작성한다. runner 추가·외부 서비스 호출·비용 발생은 기존 권한 경계를 따른다. 제품 구현은 `ponytail` 책임을 유지한다.
4. 결함 탐지 능력을 검증할 때 [test-proof](../orchestrator/references/engineering-practices/test-proof.md)를 읽는다. 원본 작업 트리가 아닌 격리 사본에서 같은 테스트로 red/green 또는 mutation을 실행한다. 사용자의 코드를 TDD 형식에 맞추기 위해 삭제하거나 reset하지 않는다.
5. 아래 CLI로 계획과 receipt 참조·후보·테스트 동일성을 검사한다. 미실행·실행기 오류·시간초과·범위 공백은 통과로 바꾸지 않는다.
6. 계획·코드·원시 근거·미확인 범위를 `acceptance-evidence-validator`에 전달한다. 로컬 consistency 검사를 독립 감사나 전체 정확성 보장으로 표현하지 않는다.

## 출력과 실패
`engineering-test-plan`, `engineering-test-proof`, 계산된 `engineering-test-result`를 출력한다. 실행 불가 항목은 NOT_RUN, 불필요한 기계적 red/green은 사전 계획의 근거 있는 예외로 기록한다. invalid input이나 digest 불일치면 중단하고 수정할 참조를 알린다. 새로운 workflow·PEER·세션·승인 규칙을 만들지 않는다.

## CLI
```sh
node skills/test-engineering/scripts/run.mjs check-plan --root /absolute/artifacts --plan plan.json
node skills/test-engineering/scripts/run.mjs check-proof --root /absolute/artifacts --plan plan.json --proof proof.json
```
명령 캡처·snapshot·예제는 [공통 CLI](../orchestrator/references/engineering-practices/cli.md)를 읽는다.
