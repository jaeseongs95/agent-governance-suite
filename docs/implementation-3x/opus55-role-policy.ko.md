# Opus 5.5 역할 preset v1

`opus55-balanced.v1.json`은 Anthropic 후보가 이미 승인된 역할 slot 또는 기존 정책의 Anthropic 분기에 한해 쓸 수 있는 **비활성 기본 선호**다. 일반 구현 역할의 effort 후보는 `medium`, 복잡 추론·독립 감사는 `high`다. 기본 모델 선호는 exact ID `claude-opus-5-5`의 `preferred`이며, `claude-fable-5-1`은 명시 요구 또는 어려운 추론·장기·특화 작업의 선택 후보로 남는다. Fable을 자동으로 Opus로 대체하지 않는다.

`readOpus55RolePresetV1`은 versioned JSON을 검증해 복사본을 반환한다. `projectOpus55RolePresetV1({request, currentEligibleCandidates})`은 기존 `ModelSelectionRequest.v2.user` 선호 계약에 모델만 투영한다. 후보 배열은 **현재 서버가 기존 catalog·policy·host capability로 수집한 적격 후보**여야 한다. 모든 후보의 `modelOrigin`이 Anthropic이고 Opus 5.5가 실제 적격 후보에 있을 때만 투영한다. 빈 후보는 defer, 다른 벤더가 섞인 후보군은 미적용이다. 요청에 사용자 `required` 또는 `preferred`가 있거나 profile이 balanced가 아니면 원본을 유지한다. 이 reader만으로 승인 slot, 후보 출처 또는 실행 권한을 인증할 수 없으며, M08 caller가 서버 소유의 slot/정책 분기와 후보 집합을 결속해야 한다.

결과의 `request`는 v2 schema의 기존 필드만 사용한다. `effortCandidate`는 안내값이며 `nativeReasoning`을 쓰거나 기존 정책의 더 높은 하한을 낮추지 않는다. 실제 모델·effort·accessPath는 기존 적격성 검사와 최신 host binding으로 결정한다. Opus 5.5가 적격 후보에 없으면 `DEFAULT_MODEL_UNAVAILABLE`로 defer하며, 임의 유료 API나 다른 벤더로 우회하지 않는다. 사용자 required Fable이 미지원이면 기존 라우터의 required 차단을 유지하고, preferred Fable은 기존 허용 fallback 규칙을 따른다.

max effort, fast speed, 자동 유료 API fallback 기본값은 모두 꺼져 있다. 기존 `policy.json` snapshot, 벤더간 순서, allowed accessPath, high-risk native floor는 변경하지 않는다. 공식 문서의 모델 지원은 설치 host의 지원 또는 실제 관측을 뜻하지 않는다. 이 단계는 일반 caller에 자동 연결하지 않으며 M08이 연결과 재검증을 맡는다.
