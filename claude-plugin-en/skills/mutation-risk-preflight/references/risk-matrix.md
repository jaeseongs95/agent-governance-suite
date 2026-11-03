# 위험 분류

| 행동 | 필수 확인 |
| --- | --- |
| 영구 삭제·덮어쓰기·되돌리기 어려운 이동 | canonical target, 범위, data loss, trash·backup·복원 절차 |
| 배포·게시 | environment, project, ref, 공개 범위, rollback revision, 승인 |
| migration | schema·data 영향, 호환 구간, backup, forward·rollback 절차, restore 검증 |
| 권한 변경 | 주체, 대상, 이전·이후 권한, lockout 가능성, 승인 |
| 결제 | 계정, 금액 또는 상한, 반복 여부, 취소 가능성, 승인 |
| 전역 설정 | 영향받는 project·사용자, 이전 설정, 복구 절차, 승인 |

이 표는 SKILL.md의 적용 조건에 해당해 이 스킬을 실행한 변경에만 쓴다. 같은 디스크 안 이동·이름 변경과 되돌릴 수 있는 로컬 편집은 이 표의 대상이 아니다. `external`, `production`, `shared` 환경은 외부 영향이 있는 것으로 분류한다. `delete`, `deploy`, `publish`, `migrate`, `permission-change`, `billing`, `global-config`는 별도 승인 근거를 요구한다.
