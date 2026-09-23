# M05 — Claude thinking 이력과 세션 전환 계약

## 소유권과 preflight

`conversation-binding.ts`는 애플리케이션이 직접 소유하는 Messages API history에만 적용한다. Claude Code와 Claude Agent SDK가 만든 요청·이력·서명은 native 관리 대상으로 돌려보내며 AGS가 편집하지 않는다. 현재 저장소에는 Messages API caller가 없으므로 이 모듈은 호출 권한이나 host 지원을 부여하지 않는다. M08은 실제 이력 소유 caller와 설치 host binding을 확인한 뒤 연결해야 한다. M01의 `document-supported`, `host-supported`, `configured`, `observed` 상태는 서로 별개다.

같은 세션의 `append`에서는 직전 요청의 top-level `system`, `tools`, 모든 기존 `messages` 값을 다음 요청의 같은 prefix와 비교한다. 이전 assistant 응답의 모든 content block을 순서와 빈 thinking field까지 그대로 보존하고 새 turn만 뒤에 붙인다. 같은 Claude API 안의 단순 모델 전환도 이력을 client가 제거하지 않는다. 읽을 수 없는 thinking block은 API가 해당 요청에서 제거하며, 모델 간 읽기 가능성은 방향에 따라 달라진다. preflight의 `append-only`는 이력 형태만 확인하며 dispatch나 target model의 thinking 해독을 승인하지 않는다. `model_binding_mismatch`는 prefix 편집이 아니다.

`system`·`tools`·기존 메시지 편집이나 수동 요약 뒤 과거 thinking 보존은 `prefix-edited`로 멈춘다. provider의 signed on-demand/server compaction은 금지하지 않고 `provider-validation-required`로 넘긴다. checkpoint delta는 작업 상태 갱신일 뿐 provider transcript를 재작성하지 않는다. 기존 이력을 재구성할 새 세션은 명시 승인된 checkpoint가 필요하며, 이 모듈은 승인 진위를 확인할 권한이 없으므로 `checkpoint-authorization-required`만 반환한다. 승인된 새 세션은 요약을 새 첫 메시지로 사용하고 이전 raw thinking을 상속하지 않는다.

## 관측과 독립 review

API의 `input_transformations`에서 `model_binding_mismatch`, `prefix_binding_mismatch`, `thinking_mismatch_allowed`를 구별한다. 필드 부재·빈 배열 또는 오류 없는 호출은 계정의 prefix enforcement, block 가독성, 실제 모델 지원 증거가 아니다. unknown transformation은 unknown으로 둔다. beta header와 `prefix_mismatch_behavior`를 쓰는 실제 caller의 정책·응답 처리도 M08에서 확인한다.

독립 review에는 소유자가 허용한 test result, artifact diff, checkpoint summary 식별자만 투영한다. provider transcript와 원래 이력, thinking block은 전달하지 않는다. 요약 본문에 원시 thinking을 넣지 않는 책임은 checkpoint 생성·승인 경계에 있다. 다른 벤더에게 Claude raw thinking을 보내지 않는다.

이 계약은 vendor context 크기, TTL, 자동 compact 임계값을 변경하지 않으며 active session을 삭제하지 않는다.

## 근거

- [Anthropic preserved thinking](https://platform.claude.com/docs/en/build-with-claude/preserved-thinking): prefix 구성, 모델별 block 가독성, 편집과 compaction, `input_transformations` 및 계정별 enforcement.
- [Anthropic Opus 5.5 migration guide](https://platform.claude.com/docs/en/models/opus-5-5/migration-guide): 모델 전환과 요청 호환성.
- [M01 source·host contract](opus55-source-host-contract.ko.md): 설치 host와 직접 API의 소유권 구분.
