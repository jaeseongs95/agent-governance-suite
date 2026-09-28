# v2.7.3: 미관측 wake 퇴역, 메시지 영수증 한도와 공통 접수 기준

도착 증거 없이 남은 wake 알림이 대상 세션의 알림 자리를 영구히 막던 문제를 고칩니다. 2.7.2는 submitted·unknown 알림을 자동 해제하지 않아, host queue의 follow-up이 재부팅·앱 재시작·대기 항목 삭제로 사라지면 새 presence 세대가 뜨거나 세션이 활동해도 새 wake가 예약되지 않았습니다. 이제 알림의 주입 만료(예약 뒤 1시간)에 유예 10분이 지났고, 같은 대상의 더 새 live 세대나 만료 뒤 같은 세션의 활동이 저장되어 있을 때만 그 알림을 새 terminal 상태 `expired-unobserved`로 퇴역합니다. 퇴역은 `observed`나 성공이 아니며 status의 `deliveryState`는 계속 `unknown`입니다. 근거 없이 만료만 된 알림은 그대로 활성으로 남습니다. 활동하는 세션의 host queue에는 약 70분(주입 TTL + 유예)마다 marker가 최대 1개 더 쌓일 수 있고, 활동도 새 세대도 없는 세션에는 쌓이지 않습니다. 활동 근거는 권위가 아니며 신뢰 수준은 같은 OS 사용자입니다. 메시지 DB는 `user_version` 0에서 1로 한 번 transaction 이관되고, 이관 자체는 행 상태를 바꾸지 않습니다. 자세한 조건과 거절한 대안은 [미관측 알림 퇴역과 자동 깨우기 신호](session-message-lifecycle.md#미관측-알림-퇴역과-자동-깨우기-신호)를 따릅니다.

퇴역한 marker가 늦게 도착하면 검증을 모두 통과한 경우에만 `late_observed_at`을 한 번 기록하고 상태는 바꾸지 않습니다. 퇴역 marker와 현재 marker가 한 prompt에 섞이면 퇴역 행은 late만 기록하고 판정에서 빠지며, 나머지 marker가 현재 세대로 유효하면 평소처럼 관측과 본문 claim을 합니다. 빈 wake prompt 차단은 host 이름 대신 delivery profile의 `blocksEmptyWakePrompt` capability로 판단합니다(현재 Codex). 이 capability가 없는 host는 기존 fail-open 처리를 따릅니다. 같은 instance가 같은 ms에 다시 태어나면 이전 birth보다 1ms 늦은 값을 써서 두 세대가 같은 식별 문자열을 갖지 않게 했습니다.

`send_session_message`의 결과, `get_session_message_status`의 미ACK 큐 행과 세션 현황판의 presence에 조언용 `autoWake`를 붙입니다. `available`, `latched`, `no-live-relay`, `unsupported` 상태와 이유·기준 시각으로 수신자가 지금 idle 상태에서 자동으로 깨워질 수 있는지 알려 주며, 계약은 `contracts/session-auto-wake-outlook.v1.schema.json`, `authorityEffect: "none"`입니다. 전달, 처리, 완료, 승인이나 권한의 증거가 아니고 큐의 메시지를 지우거나 다시 보내지 않습니다. presence lease가 끝나고 live relay가 없으면 현황판은 오래된 online 대신 `unreachable`이나 `ended`와 `no-live-relay`를 보여 줍니다. relay는 여전히 SessionStart hook에서만 뜨므로, 재부팅 뒤 아직 turn이 없는 세션은 `no-live-relay`로 보이며 메시지는 큐에 남습니다. 조회 도구도 기존 prune을 부르므로 만료 기록 정리와 퇴역을 일으킬 수 있으며, 이 정리는 멱등입니다.

메시지 제출 영수증 보존에 발신자별 상한 250개를 더합니다. 전역 상한 1000개는 그대로입니다. send는 같은 transaction에서 정리 뒤 발신자 상한, 전역 상한 순으로 검사하며, 이미 보낸 ID의 재전송은 상한이 찬 상태에서도 용량 검사보다 먼저 duplicate로 판정합니다. prepare도 영수증 용량을 먼저 확인해 이미 상한에 닿았으면 draft를 만들지 않고 거절합니다. 이 검사는 입장 확인이며, prepare와 send 사이에 용량이 차면 send가 거절합니다. 발신자 상한은 협력하는 세션 사이의 공정성 장치입니다. 발신자는 host hook이 결속한 세션 식별자일 뿐이므로, 같은 OS 사용자의 의도적 우회를 막는 할당량으로 보지 않습니다. ACK된 메시지의 영수증은 처음 성공한 ACK에서 `min(기존 만료, ACK+1시간)`으로 줄어들고 다시 늘지 않습니다. 영수증 용량 거절은 효과가 없었음이 확정된 거절입니다. 메시지는 큐에 들어가지 않았고 영수증도 발급되지 않았습니다. `error.code`는 기존 `MCP_UNAVAILABLE`이고 `error.details`에 `scope`(`sender` 또는 `global`)와 가장 먼저 풀리는 시각 `earliestReleaseAt`을 담습니다. send에서 거절된 `messageId`는 prepare 응답의 `expiresAt`까지 prepared로 남습니다. `earliestReleaseAt`이 그 `expiresAt`보다 이르면 그 시각 뒤 같은 ID로 재시도하고, 그렇지 않으면 새로 prepare하며, 둘 다 하지 않습니다. 규칙은 [시스템 발급 메시지 ID와 재시도](session-message-lifecycle.md)를 따릅니다.

Codex와 Claude Code 모두 MCP 서버 초기화 안내(`instructions`)로 [`skills/orchestrator/SKILL.md`](../skills/orchestrator/SKILL.md#공통-접수선택-기준)의 공통 접수·선택 기준을 같은 원문으로 받습니다. 서버는 이 원문을 소스에 복사하지 않고 시작할 때 읽으며, 읽지 못하면 시작하지 않습니다. schema profile은 안내에 영향을 주지 않습니다. Claude Code는 SessionStart hook에서도 같은 원문을 받으며, 요청 문장이나 명령을 보고 스킬을 추천하던 Claude 전용 keyword hook은 없앴습니다. 공통 기준에는 선택 시점 규칙을 더했습니다. 선택 결과를 출력하지 않아도 선택은 상태 확인·읽기를 포함한 첫 도구 호출 전에 끝내고, 목표가 실제 변경인 요청은 상태 확인보다 먼저 해당 전문 스킬이나 `orchestrator`를 실제 호출합니다. 설명·인사·읽기 전용 리뷰·개념 질문의 제외 규칙과 불필요한 분류 문장 출력 금지는 그대로입니다. 공통 원본, 생성된 Claude 사본과 테스트 fixture를 뺀 추적 파일에 공통 문장이 복사되지 않았는지 테스트로 검사합니다.

## 동작 변화(호환성)

ACK된 메시지를 ACK 뒤 1시간이 지나 같은 ID로 다시 보내면 이전처럼 duplicate가 오지 않고, 발급 ID를 찾을 수 없다는 거절이 옵니다. status도 unknown(`null`)입니다. 이 거절은 전달 여부를 알 수 없다는 불확실 안내이며 새 메시지를 만들지 않으므로 같은 의도가 두 번 전달되지 않습니다. 저장한 영수증과 대조하고, 새 의도일 때만 새로 prepare합니다. ACK+1시간 규칙은 새로 기록되는 ACK에만 적용하며, 이전 버전이 ACK한 영수증의 만료는 소급해 바꾸지 않습니다.

발신자 한 명이 보존 중인 영수증 250개를 채우면 그 발신자의 prepare·send만 `scope: "sender"`로 거절되고, 다른 발신자는 전역 상한까지 계속 보낼 수 있습니다. `earliestReleaseAt` 뒤에 새 prepare가 성공할 수 있지만, 다른 발신자가 먼저 용량을 쓸 수 있으므로 보장은 아닙니다.

이전 broker와 섞인 설치에서는 다음과 같이 동작합니다. 새 service·client가 이전 broker(v2.7.2, v2.7.1)를 만나면 용량 거절에 `details`가 없으므로 기존 안내를 그대로 쓰며, 이전 broker에는 prepare 입장 검사가 없어 전역이 찬 상태에서도 draft가 만들어집니다(C1). 이전 broker·CLI가 만든 DB를 새 broker로 열면 기존 영수증이 보존되고, 이전 버전이 ACK한 영수증 만료는 바뀌지 않으며 새 ACK에만 ACK+1시간이 적용됩니다(C2). 이전 CLI가 새 broker의 발신자 상한 거절을 받으면 추가 필드는 무시하고 거절 문구와 실패 종료 코드를 그대로 읽습니다(C3). v2.2.6 broker에는 prepare와 영수증이 없어 C1~C3에 해당하지 않습니다. 2.7.2 broker는 이관된 version 1 DB를 열어 기존 메시지 계약대로 동작하고 퇴역 행을 활성으로 보지 않지만, 퇴역 규칙과 `autoWake`는 적용하지 않습니다. 이전 broker가 `autoWake`를 주지 않으면 서비스는 `null`로 둡니다. previous-broker 회귀 시험은 v2.7.2, v2.7.1, v2.2.6 broker로 각각 통과했으며, 이 검사로 혼합 버전의 모든 실행·복구를 보장하지 않습니다.

## 알려진 한계

공통 기준의 `mutation-risk-preflight` 적용 시점 표현이 "위험한 실제 변경 직전에는"에서 "전에는"으로 바뀌었습니다. 스킬 본문은 여전히 실제 상태 변경 직전에 계획된 행동과 대상을 고정한다고 적으므로, 스킬을 로드하면 시점 기준이 다시 적용됩니다.

Claude Code 세션은 같은 공통 원문을 MCP 초기화 안내와 SessionStart hook 두 경로로 받습니다. 둘 다 같은 원본을 투영하므로 정책 사본은 아니지만, 모델 context에는 두 번 들어갑니다. 이 중복과 구현 보고서 서술의 minor 지적은 판정만 유지했고 이번 릴리스에서 고치지 않았습니다.

공통 접수 기준의 자연어 선택 측정은 한 환경에서 case·arm당 3회만 돌린 표본입니다. 위험한 실제 변경 요청에서 첫 도구 호출 전 `orchestrator` 호출은 v2.7.2와 같은 3/3입니다. 공통 기준을 옮기는 도중의 후보에서 0/3으로 떨어졌던 것을 선택 시점 규칙으로 되돌린 것이며, v2.7.2보다 나아진 것은 아닙니다. 또한 한국어 산문 자연어 선택은 이전 버전과 이번 후보 모두 0/3입니다. 자연어 요청에 대한 스킬 자동 선택이나 전체 절차 완주를 보장하지 않습니다.

미관측 알림 퇴역, `autoWake`, 영수증 한도는 Linux 환경의 테스트·감사로 확인했습니다. 실제 host의 wake 주입·관측과 설치 캐시 동작은 이 검사가 대신하지 않습니다.

Windows 11(Node.js 24.19.0, pnpm 11.19.0, 한글이 들어간 작업 경로)에서도 코드 최종 커밋 `e3220a48` 기준으로 설치부터 `validate:official`, `claude:check`, `source:check`까지 전체 검증이 통과했고, previous-broker 회귀 시험도 v2.7.2, v2.7.1, v2.2.6 broker로 각각 통과했습니다. 명령별 로그는 `claude/v273-evidence-windows-20260928T173839Z` 브랜치에 있습니다. 이 결과는 저장소 검사이며 설치된 host의 동작 확인은 아닙니다.

공식 [설치 안내](../README.md#설치)에 따라 업데이트한 뒤 새 세션으로 재연결합니다. 운영 DB·키·큐를 지우거나 덮어써 불확실한 상태를 없애지 않습니다. 버전 동기화와 로컬 검사는 실제 설치 bytes나 호스트의 자동 기상·관측을 대신하지 않으므로, 설치·재연결 뒤 해당 경로를 별도로 확인합니다.
