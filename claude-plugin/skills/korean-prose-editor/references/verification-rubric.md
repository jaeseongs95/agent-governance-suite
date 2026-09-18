# Verification rubric

편집자의 설명을 근거로 삼지 말고 원문과 각 replacement를 직접 비교한다. selection과 editing에 참여하지 않은 고유한 `actorId`를 사용한다.

selection과 editing이 사용한 것과 완전히 같은 glossary binding만 사용한다. `protect` 표기는 유지하고, `prefer`·`avoid`는 실제 문맥과 의미 보존을 확인한 경우에만 용어 판단의 보조 근거로 삼는다. `allow` 표기를 사전 항목이라는 이유만으로 결함으로 판정하지 않는다.

사실, 행위자, 대상, 시간, 숫자, 부정, 조건, 인과, 주장 강도, 출처와 문서 기능이 같을 때만 `accept`한다. 보호 문자열 검사가 통과해도 문장 의미가 달라졌다면 `retain`이다. 자연스러움은 의미 보존을 대신하지 않는다. 원문이 이미 자연스럽거나 후보의 변화가 취향성 동의어·어순 교체에 그쳐 개선 이득이 분명하지 않아도 `retain`한다.

각 edit에 `sourceDefect`와 `invariantDelta`를 먼저 판정한다. `sourceDefect`는 원문에 실제로 있던 문법 불일치·명사 적층·중복·번역투·불필요한 안내 문구·근거 없는 강조·사용자에게 노출된 내부 구현 표현 중 하나이거나 `NONE`이다. `invariantDelta`는 수량 범위, 조건과 시제, 가능성·확정성·예상·요구 같은 양태, 행위 허용과 권리 부여, 주장 유형·강도, 술어의 논항 구조, 비유와 분석 같은 수사적 기능, 행위자·대상, 시점, 부정, 인과, 용어 중 달라진 항목이며 변화가 없을 때만 `NONE`이다. 문맥만으로 같다고 확정할 수 없으면 `UNCERTAIN`이다. 사용자에게 노출된 내부 구현 표현을 독자가 확인할 수 있는 행동이나 결과로 바꾼 edit에서 낱말이 달라진 것 자체는 「용어」 변화로 세지 않는다. 다만 바뀐 낱말이 고정 명칭, 계약 값 또는 실제 대상을 가리킬 가능성을 문장과 제공된 문맥으로 배제할 수 없으면 「용어」 항목은 `UNCERTAIN`이고, 이 판정은 그 표현이 직역 은유로 보인다는 이유로 완화되지 않는다.

판정 순서는 다음처럼 고정한다.

1. 해당 edit만 적용한 후보를 재구성한다.
2. 원문에서 후보로 읽으며 원문의 사실·조건·양태·논항·주장·수사 기능이 모두 남았는지 확인한다.
3. 후보에서 원문으로 거꾸로 읽으며 후보가 새 행위자·결과 확정·의무·권리·심각도·분석적 주장을 만들지 않았는지 확인한다.
4. 두 방향의 대조와 별개로 원문의 구체적 결함이 실제로 제거됐는지 확인한다.

2와 3의 잠정 판정이 다르면 순서 편향 또는 의미 불확실성으로 보고 `invariantDelta: "UNCERTAIN"`, `retain`으로 처리한다. 두 방향 모두 동치이고 결함이 제거됐다면 피동/능동, 어순이나 표면 단어가 달라졌다는 이유만으로 `retain`하지 않는다.

`accept`는 구체적인 `sourceDefect`가 제거되고 `invariantDelta`가 `NONE`일 때만 허용한다. 다음처럼 대체로 비슷해 보여도 의미 연산자가 달라질 수 있는 경우에는 원래 의도를 추정하지 말고 `retain`한다.

- 가능하거나 가능하게 한다는 표현을 결과가 확정된 서술로 바꾼 경우
- 기대·권고·요구·의무의 강도를 바꾼 경우
- 어떤 행위를 허용한다는 표현을 권한이나 권리를 부여한다는 표현으로 바꾼 경우
- 도전·제약·위험·실패처럼 주장 유형이나 심각도를 바꾼 경우
- `모든`, `일부`, 상한·하한과 조건의 적용 범위를 바꾼 경우
- 현재 상태를 나타내는 조건을 미래 사건 조건으로 바꾸거나 그 반대로 바꾼 경우
- 어떤 대상이 제약을 가한다는 술어 구조를 그 대상 자체에 한계가 있다는 구조로 바꾼 경우
- 비유적으로 논의를 조명한다는 서술을 필자가 통찰을 제공한다는 분석적 주장으로 바꾼 경우

원문에 번역투가 있더라도 후보가 그 결함만 제거했는지 따로 확인한다. 반복을 새로 만들거나, 논항 구조·수사적 기능을 함께 바꾸거나, 원문과 후보가 모두 자연스럽지 않거나 비슷하게 자연스러우면 `sourceDefect`를 제거한 명확한 개선으로 인정하지 않고 `retain`한다.

각 edit의 결정은 `accept` 또는 `retain`으로 제한하며 모든 edit를 독립적으로 판정한다. `accept`의 reason code는 `MEANING_PRESERVED`로 기록한다. 의미 변화나 불확실성을 나타내는 reason code를 붙인 edit는 `accept`하지 않는다. 애매하거나 필요한 문맥이 없으면 해당 edit를 `retain`한다. 하나라도 `accept`했다면 전체 `pairPreference`도 `candidate`여야 하며, 그 밖의 안전성 평가는 모두 `pass`여야 한다. work product의 `editingDigest`는 editing work product 전체를 `stableJson`으로 직렬화한 SHA-256이어야 한다. 입력 artifact, digest나 actor 계약을 신뢰할 수 없을 때만 `globalDecision: "fallback"`을 사용한다.

같은 사례에 edit가 여러 개면 하나씩 나머지 edit를 원문으로 되돌린 상태에서 판정한다. 한 edit의 의미 변화나 개선 부족만으로 독립적으로 안전한 다른 edit를 `retain`하지 않는다. edit별 결정을 마친 뒤에는 `accept`된 edit만 적용한 유효 후보를 다시 구성하고, 전체 `assessment`는 편집자가 제안한 미필터 후보가 아니라 이 유효 후보를 요약한다. 따라서 의미가 바뀐 edit를 `retain`해 유효 후보에서 제거했다면 그 edit의 `invariantDelta`를 이유로 전체 `majorMeaningChange`를 `true`로 만들지 않는다.

`rubricDigest`는 호출자가 전달한 동결 rubric의 SHA-256과 같아야 한다. finalizer는 이 기대 digest와 verification work product의 값을 다시 비교한다.

`assessment`에는 전체 후보 쌍에 대한 `meaningPreservation`, `majorMeaningChange`, `registerCompliance`, `protectedStrings`, `terminologyJudgment`, `pairPreference`를 기록한다. 이 요약은 edit별 결정을 대신하지 않는다. `globalDecision: "continue"`일 때도 누락된 결정은 finalizer가 해당 edit만 유지한다.
