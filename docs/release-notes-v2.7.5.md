# v2.7.5: 끝난 세션의 미관측 wake 퇴역

끝난 세션 앞으로 남은 활성 wake 행이 영구히 퇴역하지 않던 한계를 없앱니다. 2.7.3부터 미관측 알림은 주입 만료(예약 뒤 1시간)와 유예 10분이 지난 뒤 퇴역 근거가 있을 때만 `expired-unobserved`로 바뀌었습니다. 근거는 만료 뒤 같은 세션의 활동, 또는 알림보다 늦게 태어나 살아 있는 presence였습니다. 그래서 알림을 받은 세션이 끝났거나(프로세스 종료) lease가 끊긴 뒤(재부팅) 활동도 재등록도 없으면, 그 행은 계속 `reserved`, `started`, `submitted`, `unknown` 가운데 하나로 남았습니다. 실제 PC에서는 재부팅 뒤 다시 열지 않은 Codex 세션을 중심으로 이런 행이 13개 쌓여 있었습니다. v2.7.4 notes의 알려진 한계 첫 문단이 이 내용입니다.

두 번째 퇴역 근거를 넓힙니다. 같은 세션의 최신 presence 행(birth 기준)이 알림을 받은 birth의 살아 있는 행이 아니면 퇴역합니다. 새 birth가 최신이거나, 알림의 birth가 끝났거나 lease가 끊겼거나, presence 행이 모두 지워진 경우입니다. 주입 만료와 유예 조건, 활동 근거, 새 상태 없이 `expired-unobserved`로 끝내는 방식, schema는 그대로입니다. 판정은 instance와 birth generation으로 하고 transport는 보지 않습니다.

이 근거로 퇴역해도 wake 누적 억제의 범위는 줄지 않습니다. 끝났거나 lease가 끊긴 birth는 다시 살아나지 않습니다. heartbeat는 살아 있는 행만 갱신하고, 같은 instance가 다시 등록되면 더 늦은 새 birth를 받습니다. presence 조회, relay tick, 현재 세대 claim과 `autoWake`는 모두 최신 행을 읽습니다. 따라서 최신 행이 알림의 살아 있는 birth가 아니면 그 알림은 현재 세대로 claim될 수 없고, live relay가 없으므로 새 wake도 보내지 않습니다. 세션이 다시 열리면 새 birth가 최신이 되므로 2.7.4에서도 그때 퇴역했습니다. 새 규칙은 세션이 끝난 뒤 다시 열리기 전까지의 구간에서만 결과가 다릅니다. 살아 있지만 조용한 세션(relay heartbeat로 lease가 유지되고 활동은 없음)의 알림은 지금처럼 latch로 남고, `autoWake`는 `latched`/`wake-unobserved`입니다. 퇴역한 알림이 늦게 도착하면 기존대로 `late_observed_at`만 기록하고 본문 claim에는 참여하지 않습니다. Codex hook은 이 marker-only 입력을 모델 요청 전에 막습니다. 자세한 규칙은 [미관측 알림 퇴역과 자동 깨우기 신호](session-message-lifecycle.md#미관측-알림-퇴역과-자동-깨우기-신호)를 따릅니다.

## 동작 변화(호환성)

설치 뒤 새 broker의 첫 prune에서, 주입 만료와 유예가 지났고 받은 birth가 더 이상 최신의 살아 있는 행이 아닌 활성 wake 행이 `expired-unobserved`로 바뀝니다. 이 PC 같은 기존 DB에서는 끝난 세션 앞으로 남은 활성 행(예: 13개)이 이때 한 번에 퇴역합니다. 퇴역한 행은 기존 terminal 보관 규칙대로 퇴역 1시간 뒤 prune에서 지워집니다. 메시지 본문은 그대로 큐에 남고, 세션이 다시 열려 live relay가 뜨면 새 wake 하나를 예약할 수 있습니다. 퇴역은 되돌리지 않으며 `observed`나 성공으로 기록하지 않습니다. status의 `deliveryState`는 계속 `unknown`입니다.

퇴역은 broker의 prune에서만 일어납니다. 2.7.4 이하 broker가 같은 DB를 쓰는 동안에는 이런 알림이 활성으로 남고, 새 broker의 첫 prune에서 퇴역합니다. 새 broker가 퇴역한 행은 2.7.3 이상 broker에서 terminal로 보입니다. broker는 relay가 주기적으로 요청하는 동안 종료되지 않으므로, 기존 AGS MCP·relay·broker를 종료한 뒤 재연결합니다. previous-broker 회귀 시험은 v2.7.4, v2.7.3, v2.7.2, v2.7.1, v2.2.6 broker로 각각 통과했으며, 이 검사로 혼합 버전의 모든 실행·복구를 보장하지 않습니다.

현황판 혼합 버전 문서의 "모든 묶음이 실패해" 문구를 실제 동작에 맞췄습니다. 이전 broker의 응답이 한도를 넘으면 첫 묶음이 전송 실패로 끝나고, 남은 묶음은 요청하지 않습니다. 결과(모든 presence `unknown`, `autoWake` `null`)는 전과 같습니다.

## 알려진 한계

퇴역한 행이 보관 기간(퇴역 뒤 1시간) 뒤 지워진 다음에 같은 marker가 host에 도착하면, 미등록 nonce로 거절되어 hook이 막지 않습니다. 이 한계는 2.7.3부터 있던 것입니다. 새 규칙은 끝난 세션의 알림을 더 일찍 퇴역시키므로, 끝난 세션이 1시간보다 오래 지나 다시 열리고 host가 옛 marker를 다시 제출하는 경우에 해당할 수 있습니다. 이때 보이는 비용은 빈 모델 턴 한 번입니다.

살아 있지만 조용한 세션의 알림은 계속 latch로 남습니다. host가 marker를 끝내 처리하지 않으면, 그 세션이 활동하거나 끝나거나 새로 태어날 때까지 새 wake를 보내지 않습니다. 이것은 설계된 보호입니다.

퇴역 판정은 broker 한 process가 요청마다 읽는 벽시계를 씁니다. 시계가 되돌아가는 환경은 검증하지 않았습니다. 공통 접수 원문이 두 번 주입되는 문제(L3)는 이번 범위가 아닙니다.

퇴역 규칙은 Linux 환경의 시험(두 process 경합 포함)으로 확인했습니다. 실제 PC의 운영 DB와 설치 캐시 동작은 이 검사가 대신하지 않습니다.

공식 [설치 안내](../README.md#설치)에 따라 업데이트한 뒤 새 세션으로 재연결합니다. 운영 DB·키·큐를 지우거나 덮어써 불확실한 상태를 없애지 않습니다. 버전 동기화와 로컬 검사는 실제 설치 bytes나 호스트 동작을 대신하지 않으므로, 설치·재연결 뒤 `get_session_message_status`의 wake 상태를 별도로 확인합니다.
