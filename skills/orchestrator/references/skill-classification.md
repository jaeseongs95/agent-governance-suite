# 스킬 분류 지원과 AGENT 선택

스킬 선택 지원이 설정된 환경에서는 `get_skill_inventory`로 registry provider와 실제 설치 스킬의 전체 목록·적용·제외·의존성·source digest를 확인한다. 스킬 설명은 SKILL.md, provider의 capability·gate·단계는 registry, 구조화 taxonomy와 정확한 원문 참조는 각 스킬의 classification.json에서 읽는다. 외부 설치 스킬의 metadata가 없으면 누락을 보고하며 전체 목록을 검사했다고 주장하지 않는다. description이나 이름을 서버 코드에 복사해 두지 않는다.

`classify_skills`에는 사용자 원문과 출처가 확인된 context만 전달한다. 부정문·인용문·금지 행동을 보존하고 확인되지 않은 context는 null로 둔다. 별도 의미 요약 LLM을 호출하지 않는다. 앞단 포장은 코드이며 의미 해석은 분류 provider의 책임이다. 전체 후보와 dependency를 자르지 않는다. INPUT_TOO_LONG은 실제 누락 없이 보류한다.

JEV ON이고 승인된 키·API·profile이 가용하면 JEV를 사용한다. OFF·키/API 불가·잘못된 응답·timeout이면 같은 사용 벤더의 중앙 고정 model/effort profile로 분류한다. OFF는 JEV 호출 0회이며 모든 분류 호출 금지가 아니다. 외부 전송 허용, 승인 route, profile qualification, 현재 예산은 별도로 확인한다. native 구독 경로를 API 허가나 비용 0으로 추정하지 않는다. 요청마다 모델 catalog·가격을 탐색하거나 임의 모델/effort 상향을 하지 않는다. JEV와 vendor는 각각 최대 한 시도이며 timeout 소비 불명은 별도 예약으로 남긴다.

공통 RESP는 분류 지원이다. 실제 원문, 명시 스킬, 조건부 필수, 적용·제외·dependency를 대조해 **AGENT가 최종 선택**한다. 추천을 선택으로 복사하거나 과거 baseline을 무조건 union하지 않는다. raw 모델 누락은 규칙 보정 뒤에도 평가에서 그대로 실패로 남긴다. optional uncertainty가 독립적인 확정 작업 전체를 막지 않게 한다.

`record_skill_selection`에 AGENT가 고른 정확한 ID, 이유, 적용/제외 근거를 전달한다. hostReceipt는 null로 보내며 호스트 훅이 서명한 실제 호출 관측을 서버가 검증한다. 현재 request/task/config/profile/inventory revision이 다르거나 필수·명시·의존성이 빠지면 구체적 오류를 수정한다. 서버가 선택 집합을 대신 만들지 않는다. 실제 수락 전 selected는 null이며 실제 no-skill 정답을 수락한 경우만 []다. 미설치·비활성·미지원은 needed와 runnable을 구분한다.

선택은 실행 승인·본문 읽기·적용·검증 완료가 아니다. 기존 거버넌스 순서와 권한을 유지하고 각 스킬의 실제 본문·참조를 읽어 수행한다. selected/read/applied/verified는 동일 대상과 산출물 digest의 각 관측으로 기록한다. mode=shadow는 관측용이며 최종 select 동작을 대신하지 않는다.

설정은 승인된 설치에서 AGENT_GOVERNANCE_CLASSIFICATION_CONFIG가 가리키는 파일과 중앙 profile registry로 공급한다. 미설정·미검증 profile에는 임의 기본 모델이나 API 경로가 없으며 UNAVAILABLE을 반환한다. 요청 원문·credential을 새 상태 DB나 로그에 저장하지 않는다. 독립 감사와 릴리스 승인은 기존 담당과 절차를 따른다.
