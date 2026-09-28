# v2.7.1: wake 알림 누적 억제와 continuity DB 호환

세션 메시지 wake 알림이 받는 세션에 쌓이는 문제를 고칩니다. 새 relay는 wake 알림을 본문과 따로 기존 `wake_nonces`에 저장하고, 대상마다 아직 관측되지 않은 알림을 하나만 유지합니다. 뒤따르는 본문은 기존 `messages`에 남아 다음 전달 때 함께 claim됩니다. 알림은 reserved→started→submitted/unknown→observed 순서로 기록하며, 결과가 불확실한 알림은 unknown으로 보존하고 relay·broker 재시작이나 만료를 이유로 다시 보내지 않습니다. 관측은 실제 `UserPromptSubmit` hook의 marker와 hook receipt로만 인정합니다. 자세한 수명과 한계는 [시스템 발급 메시지 ID와 재시도](session-message-lifecycle.md#wake-알림-수명과-누적-억제)를 따릅니다.

공통 relay는 outcome·capability·dispatch port만 사용하고 transport별 처리는 adapter 모듈에 둡니다. 기존 DB에는 컬럼과 활성 대상 UNIQUE index를 transaction으로 추가하며, 기존 nonce는 `legacy`로 남기고 새 누적 억제 보장을 소급하지 않습니다.

context continuity 저장소가 schema 버전이 다른 DB를 만나도 MCP 전체가 멈추지 않게 합니다. 새 DB와 기존 schema 2 DB는 schema 2로 유지합니다. 알려진 schema 3 DB는 구조와 `quick_check`를 확인한 뒤에만 사용하고, schema 3 전용 수신 상태가 있는 작업은 읽기·복원·쓰기·정리를 사유와 함께 거절하며 상태를 보존합니다. 관련 없는 작업은 정상 동작합니다. 미래 버전·비호환·손상 DB는 시작할 때 안전한 사유로 거절하고 일반 MCP 도구는 계속 동작합니다. 진단에는 본문·키·SQL 원문을 넣지 않습니다.

이 업데이트는 손상된 DB를 복구하지 않습니다. 손상된 continuity DB는 원본을 보존한 채 새로 만들어야 하며, 운영 DB 삭제·`user_version` 하향·강제 교체는 자동으로 하지 않습니다.

업데이트 전에는 기존 AGS MCP·relay·broker를 종료한 뒤 설치하고 새 세션으로 재연결합니다. 버전 동기화와 로컬 검사는 실제 설치 bytes나 host의 자동 기상·관측을 대신하지 않으므로 설치·재연결 뒤 해당 경로를 별도로 확인합니다.
