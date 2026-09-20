# v2.1.0 — 호스트 중립 TLS 세션 메시징

## 핵심 변경

- Codex, Claude Code와 다른 로컬 AI 호스트가 TLS 1.3 loopback broker를 통해 제한된 세션 메시지를 주고받을 수 있습니다. 공용 계약은 특정 제품명을 전제로 하지 않으며, 새 호스트는 wake·claim adapter만 추가합니다.
- 공유 현황판과 메시지 상태를 사용자 홈의 `.agent-governance-suite` 아래에 둡니다. 이 경로는 Windows 패키지 가상화를 피하면서 Linux와 macOS에서도 같은 규칙을 사용합니다.
- 메시지 claim과 wake 예약을 SQLite 트랜잭션으로 직렬화합니다. 아직 소비되지 않은 wake가 있거나 메시지가 전달 중이면 새 wake를 만들지 않습니다.
- 미사용 `issue-wake` broker 연산을 제거했습니다. 전송이 확실히 시작되지 않은 경우에만 wake 예약을 해제하고 재시도하며, 제출 여부가 모호하면 중복 가능성을 피하기 위해 예약을 유지합니다.
- Codex `Stop` 훅에서는 메시지를 claim하지 않고 다음 `UserPromptSubmit`에서 전달합니다. Claude Code의 `Stop` 전달은 유지합니다.
- Codex의 새 사용자 요청을 `UserPromptSubmit` 훅으로 기록해 세션 현황판의 요청 경계를 정확히 유지합니다.

## 보안과 데이터 경계

- broker는 `127.0.0.1`에서 TLS 1.3만 허용하고, 자체 인증서 pinning과 사용자 전용 token을 사용합니다.
- 같은 OS 사용자 권한을 가진 악성 프로세스를 TLS만으로 격리하지는 못합니다. 이 기능은 전송 중 변조와 잘못된 endpoint 연결을 줄이는 로컬 협력 프로세스용 통로입니다.
- 메시지 본문은 4,096바이트, spool과 응답 frame은 고정 상한으로 제한합니다. 인증 token과 키는 메시지 본문이나 명령행에 넣지 않습니다.

## 호환성

- 기본 공유 경로는 `os.homedir()/.agent-governance-suite`입니다. `AGENT_GOVERNANCE_SHARED_STATE_DIR`로 절대 경로를 지정할 수 있습니다.
- 기존 호스트별 workflow와 continuity 데이터 위치는 바뀌지 않습니다.
- Codex와 Claude Code를 함께 사용하는 경우 두 호스트를 같은 릴리스로 갱신하고 새 세션을 시작해야 새 hook과 relay가 적용됩니다.

## 검증

- Windows 패키지·비패키지 프로세스가 같은 broker, spool과 현황판 파일을 보는지 확인했습니다.
- Claude↔Codex 양방향 메시지가 `acknowledged`까지 도달하는 것을 실세션에서 확인했습니다.
- 메시지가 156.752초 동안 claimable인 구간에 wake nonce가 하나만 유지되고, 도중 메시지가 추가돼도 새 nonce가 생기지 않는 것을 확인했습니다.
- Codex queue와 Claude inbox의 `submitted`, `definite-failure`, `accepted-or-unknown` 분류와 wake 재시도 조건을 회귀 테스트로 고정했습니다.
