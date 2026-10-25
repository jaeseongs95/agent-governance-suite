# 스킬 import 실패 후 복구 상태

`import-skill.mjs`는 실패 원인과 `recovery` 정보를 함께 반환한다. 최초 실패는 `cause`와 `errors` 연결을 따라 확인할 수 있다.

- `state: completed`, `transactionState: removed`: rollback과 transaction 정리가 끝났다. transactionDirectory·previousSkill.path·metadataOriginals는 null이며, 남아 있는 백업 경로가 아니다.
- `state: incomplete`, `preserveTransaction: true`: transaction을 보존한다. metadataOriginals는 변경 전 registry/source-lock의 원본 바이트이며, previousSkill.state로 이전 스킬의 복원·보존 여부를 구분한다. previousSkill.path는 state가 retained일 때 보존된 백업을 가리킨다.
- cleanup 자체가 실패하면 복구가 완료된 경우에도 남은 디렉터리의 실제 상태를 별도로 확인해야 한다. 이전 경로가 모두 남았다고 가정하지 않는다.

저장소 루트의 `.agent-governance-import-*` transaction은 복구 자료가 조용히 사라지지 않도록 현재 의도적으로 숨기거나 자동 삭제하지 않는다. 실패 후에는 error.recovery에 표시된 해당 transaction만 확인하고, 다른 실행의 transaction을 정리 대상으로 삼지 않는다. 정상 성공과 완전한 rollback은 기존처럼 자동 정리한다.

이 동작은 프로세스 종료·전원 손실에 대한 내구성 보장이 아니다. CLI catch→cleanup 전체 경로의 fault 회귀는 아직 별도 검증이 필요하며, helper 회귀가 이를 대신하지 않는다.
