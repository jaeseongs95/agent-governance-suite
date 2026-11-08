# 수렴 가드 계약

이 계약서는 같은 실행자가 실패 뒤 작업 목표나 판정 의미를 스스로 바꾸면서 전체 실행을 반복하지 못하게 하는 로컬 MCP 계약이다. 전체 실행은 최종 수용 판정을 만들 수 있는 workflow run을 뜻하며 읽기 전용 진단 조회와 구분한다.

## 최초 결속

`plan_workflow`가 만든 ready plan과 같은 `TaskEnvelope.v1`에서 `open_convergence_root`를 한 번 호출한다. frame은 다음을 분리한다.

- `controlArtifacts`: validator, rubric, oracle, aggregation, pass-condition, evaluation-input
- `targetArtifacts`: target, candidate
- `operationalSettings`: `maxAttemptsPerEpoch: 3`, `maxEpochs: 2`와 `leaseTtlSeconds`. `leaseTtlSeconds`와 lease의 `expiresAt`은 저장된 root와의 호환을 위해 남은 필드이며 검사하지 않는다. lease는 시간으로 만료되지 않고, 같은 root의 새 claim이 아직 시작되지 않은 lease를 대체한다

MCP가 반환한 `rootId`는 요약, 재개, 서브에이전트 handoff와 fresh-context 검토에도 보존한다. 같은 workspace와 겹치는 scope에 새 root를 열어 예산을 초기화하지 않는다. 사용자 재계약으로 root를 바꿀 때만 이전 root를 `parentRootId`로 지정하고 사용자 승인 근거를 전달한다.

## 전체 시도 시작

매번 다음 순서를 지킨다.

1. 현재 task와 frame에서 `plan_workflow`를 호출한다.
2. `claim_workflow_attempt`에 root revision, task, frame, signed plan, 실행자, 출력 대상과 이전 실패 근거를 전달한다.
3. 발급된 lease와 같은 plan을 이 시도에서 쓸 `skills`와 함께 즉시 `start_guarded_workflow`에 전달한다.
4. run 결과는 기존 stage 기록과 finalize/abort 경로로 닫는다.

첫 시도의 `priorFailure`는 `null`이다. 그 뒤에는 가장 최근 `AttemptOutcome.v1.failureFingerprint`, 검증 가능한 원인 가설, 변경 요약, 가설을 가르는 관측과 새 evidence reference를 사용한다. target 변화도 새 evidence도 없으면 전체 실행을 시작하지 않고 `blocker-diagnostician`으로 전환한다.

시도 예산은 무의미한 반복을 막는 한도이며 오래된 target을 유지하는 최적화 목표가 아니다. 실제 통합 대상이 바뀌면 기존 run과 시도 기록을 삭제하거나 성공으로 바꾸지 말고 새 target을 evidence로 기록한다. 지금 재배치하고 다시 검증하는 비용이 나중의 충돌 해결과 전체 재검증 비용보다 작으면 새 target에 맞춰 작업을 재배치한다. 현재 epoch의 예산이 부족하면 오래된 target에서 계속 작업하지 말고 아래 독립 검토 절차로 진행하며, 재사용 가능한 조사·명세·증거는 다음 시도에 연결한다.

## 중단과 독립 검토

- `NEW_EVIDENCE_REQUIRED`: 같은 실행을 반복하지 말고 실패 원인을 가르는 진단을 수행한다.
- `FRAME_REVIEW_REQUIRED`: target을 제외한 task, control, workspace, operational 의미가 바뀌었거나 artifact 역할이 바뀌었다. 새 전체 실행 전에 fresh-context `iteration-frame-auditor`를 호출한다.
- `ATTEMPT_BUDGET_EXHAUSTED`: 현재 epoch에서 세 번의 전체 실행이 시작됐다. 독립 검토 전에는 네 번째 실행을 만들지 않는다.
- `ROOT_CONFLICT`: 응답의 겹친 경로(`requestedEntry`, `existingPath`)와 `ownedBySession`, `nextActions`를 확인한다. 한 세션은 겹치지 않는 경로로 workflow를 여러 개 함께 진행할 수 있으므로, 겹치지 않는 writeTargets로 새 workflow를 시작하고 막힌 부분만 보류한다. 이 세션의 open root와 겹치면 그 workflow 안에서 계속하거나, 시도가 끝났으면 `start_workflow`에 `rootId`를 넣어 이어 간다. 판정을 기다리는 root와 겹치면 `resolve_convergence_gate`로 먼저 판정한다. 실제 사용자의 새 계약이 있을 때만 parent 관계를 보존한 replacement root를 연다.
- `LEASE_CONFLICT`: 기존 lease/run 상태를 먼저 조회하며 다른 진입점으로 우회하지 않는다. 시작 전 lease가 사라졌거나 대체됐으면 현재 revision으로 다시 claim한다. 시작된 run이 끝나지 않았으면 그 run을 마치거나 `abort_workflow`로 닫는다.

독립 검토가 원래 사용자 계약을 보존하고 결과 비교 가능성이 있다고 판정한 경우에만 `resolve_convergence_gate`로 두 번째 epoch를 연다. 모호하면 `independent-deliberation-panel`, 사용자 가치·범위·수용 기준·권한이 달라지면 사용자에게 돌린다. 두 번째 epoch 뒤에는 독립 검토만으로 다시 초기화하지 않는다.

필요한 MCP 도구가 없으면 직접 실행 결과를 guarded 완료 근거로 표현하지 않는다. 별도의 서버를 수동 기동하라고 요구하지 말고, 설치된 Agent Governance Suite의 로컬 stdio MCP를 사용할 수 없는 상태로 보고한다.
