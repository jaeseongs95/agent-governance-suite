이 문서는 구현자의 기존 검토 근거를 정리한 것이며 독립 감사가 아닙니다. 새 테스트를 실행하지 않았습니다.

- 기존 InventoryOptions 경계에 installed/hostSupported를 전달하며 enabled는 registry 정책과 호스트 enabled의 교집합입니다. Disabled 후보는 필요한 후보로 남고 runnable에서 제외됩니다. HD1/HD2 회귀가 이 구분을 검사합니다.
- 후보 이름을 고정하지 않고 관측된 외부 root/중립 ID를 읽습니다. 메타데이터가 없으면 INCOMPLETE/INSTALLED_SKILL_UNEXPOSED로 보고하고 불완전한 인벤토리로 분류를 진행하지 않습니다. 이는 loader 자체가 원래 full-host discovery를 제공한다는 주장이 아닙니다.
- 관측의 revision/content/freshness가 operation digest에 결합됩니다. 동일한 효과적 인벤토리에서는 qualification digest를 유지하며 관측 identity만 갱신해도 이전 operation을 재사용하지 못합니다.
- accept는 readRuntime과 host discovery의 await를 마친 뒤 현재 작업을 동기적으로 재관측하고 저장합니다. 최종 검사와 저장 사이에 await가 없습니다. 취소/제거/revision/requestDigest/sourceRef의 runtime-await 변경 5건은 원본에서 수용되어 red, 후보에서 거부되어 green이었습니다. Discovery-await 변경도 후보에서 5 PASS였습니다.
- MCP transport, gateway/service, 파일 읽기는 실제 경계입니다. 공급자·호스트 관측 및 선택 결정을 테스트가 합성했습니다. 실제 AGENT의 선택·SKILL 읽기·적용을 검증했다고 주장하지 않습니다.
- 최종 scope report는 허용 5파일/제외 0/미계획 0이며 원본 tracked 1567파일과 보호 경로를 보존했습니다.
- 초기 ZodError/timeout fixture 실패와 JSON reporter의 witness 공백은 유효한 red 증거에서 제외됐습니다. 게시된 최종 verbose red/green receipt는 동일 테스트·argv의 제품 assertion 실패/성공입니다.
- 호스트 producer, 실제 호스트 연결, 통합 bundle/cache, 실제 품질 qualification, 실제 스킬 적용, timeout 상한은 미완료입니다. 자세한 한계는 integration-limitations.json에 있습니다.
