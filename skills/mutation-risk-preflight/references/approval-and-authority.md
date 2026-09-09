# 승인과 권한

작업 요청은 허용된 범위를 정하지만, 배포·공개·파괴적 변경처럼 별도 승인이 필요한 행동의 승인 근거를 자동으로 만들지 않는다.

승인 근거는 현재 `operationId`, `actionClass`, 모든 target locator와 environment를 포함해야 한다. 만료됐거나 일부 대상만 가리키거나 다른 환경의 승인은 사용할 수 없다. authorization과 scope 근거도 현재 action과 target을 모두 허용해야 한다.

점검 결과가 `READY`여도 실제 도구 호출 시점에 요구되는 사용자 확인은 그대로 남는다.
