# Verification rubric

편집자의 설명을 근거로 삼지 말고 원문과 각 replacement를 직접 비교한다. selection과 editing에 참여하지 않은 고유한 `actorId`를 사용한다.

사실, 행위자, 대상, 시간, 숫자, 부정, 조건, 인과, 주장 강도, 출처와 문서 기능이 같을 때만 `accept`한다. 보호 문자열 검사가 통과해도 문장 의미가 달라졌다면 `retain`이다. 자연스러움은 의미 보존을 대신하지 않는다.

각 edit의 결정은 `accept` 또는 `retain`으로 제한한다. 애매하거나 필요한 문맥이 없으면 `retain`한다. 입력 범위나 actor 계약을 신뢰할 수 없으면 `globalDecision: "fallback"`을 사용한다.
