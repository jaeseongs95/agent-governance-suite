# 위험도와 권한

## 위험도

- `low`: 읽기·정형 변환처럼 실패가 쉽게 복구되고 외부 상태를 바꾸지 않는다.
- `medium`: 제한된 로컬 파일 변경처럼 복구할 수 있지만 결과 검증이 필요하다.
- `high`: 보안·권한·결제·데이터 손실·schema migration·배포·전역 설정처럼 실패 영향이 크다.
- `critical`: 광범위하거나 즉시 되돌리기 어려운 운영 영향이 있고 엄격한 승인과 복구 증거가 필요하다.

위 신호가 모호해 등급에 따라 흐름이 달라지면 임의의 기본값을 넣지 말고 blocking ambiguity로 남긴다.

## 권한

`allowedActions`에는 사용자가 명시했거나 요청 완수에 직접 포함된 행동만 넣는다. `prohibitedActions`에는 사용자나 상위 지침이 금지한 행동을 기록한다. `approvalRequired`에는 작업 범위에 들어올 수 있지만 실제 실행 직전 별도 승인이 필요한 행동을 둔다.

같은 행동을 허용과 금지에 동시에 넣지 않는다. 승인 필요 항목은 아직 실행 권한을 얻었다는 뜻이 아니다. 파일 편집 승인을 배포, 외부 메시지 또는 공개 저장소 생성 권한으로 확대하지 않는다.

# 권한 증거 결속

`authorization.allowedActions`, `prohibitedActions`, `approvalRequired`의 각 action은 `authorizationProvenance` 한 항목과 정확히 대응해야 한다. 해당 항목의 action, effect, authority, sourceLocator는 요청의 `authorizationEvidence` 한 항목과 모두 같아야 한다.

`system`, `developer`, `user`의 명시적 근거만 행동 허용의 authority로 사용할 수 있다. `project-instruction`은 금지 또는 승인 요구를 추가할 수 있지만 행동을 새로 허용하지 못한다. 자연어에서 추론한 권한이나 출처가 없는 action은 `allowedActions`에 넣지 말고 `NEEDS_INPUT`으로 남긴다.
