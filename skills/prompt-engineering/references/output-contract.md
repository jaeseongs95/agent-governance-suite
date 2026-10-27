# 입출력 계약

직접 호출에서는 사용자에게 필요한 프롬프트와 설명만 반환하라. 아래 형식은 정식 AGS provider 결과나 재현 가능한 파일 검사가 필요할 때만 사용한다.

## 입력

`prompt-engineering-request`는 [request schema](../contracts/prompt-engineering-request.v1.schema.json)를 따른다.

- `mode`: create / review / improve / compare.
- `snapshotRef`, `targets`: 현재 검토할 프롬프트·설계 revision과 대상. create/improve에서 targets는 각각 후보를 만들어야 하는 산출물 대상이며, 참고 자료는 evidenceRefs에 둔다.
- `requirements`: 원문 또는 기존 계약에서 가져온 ID·조건·출처. 새 요구를 몰래 추가하지 않는다.
- `instructionRefs`, `evidenceRefs`: 실제 읽은 지침·근거 참조. 원문·비밀을 공용 원장에 복사하지 않는다.
- `environment`: 확인된 환경과 근거, 아직 확인되지 않은 부분.
- `baseline`: 기준판 참조와 실제 digest. 새 설계는 null을 허용한다. compare 모드에는 기준판이 필요하다.

이 request는 설계 입력의 snapshot이며 권한을 부여하는 TaskEnvelope가 아니다. 새 실행 증거를 포함해 snapshot을 갱신하면 request digest를 다시 계산한다. 기존 동결 task contract나 수용 기준을 변경하는 허가로 사용하지 않는다.

## 출력

`prompt-engineering-report`는 [report schema](../contracts/prompt-engineering-report.v1.schema.json)를 따른다.

| 필드 | 의미 |
| --- | --- |
| status | ANALYZED: 요청 범위 설계·검토 완료 / NOT_APPLICABLE: 대상 아님 / NEEDS_INPUT: 핵심 입력·조건 미해결 |
| requestDigest | 입력 파일의 실제 바이트 SHA-256. UTF-8 직렬화·개행이 바뀌면 다시 계산 |
| scope | 검토함·미검토 대상의 겹치지 않는 전체 목록 |
| findings | 관찰·추론·가설 구분, 실제 근거 참조, 영향과 권고 |
| candidates | 바로 사용할 본문, 해당 UTF-8 문자열 digest, 변경 이유 |
| requirementTrace | 모든 입력 요구 ID의 보존·충돌·미검토와 후보 연결 |
| evaluation | NOT_RUN 또는 OBSERVED, 사례·실행 증거·비교 결론의 선언 |
| limitations / handoffs | 남은 제약과 기존 담당에 전달할 근거 |

create/improve의 ANALYZED에는 대상마다 실제 후보와 모든 핵심 요구의 보존·후보 연결이 있어야 한다. 검토만 끝난 review는 후보가 없어도 된다. review/compare에서 기존 대상의 요구 충돌을 확인했다면 그 문제를 기록한 ANALYZED가 가능하다. 이는 대상 프롬프트가 요구를 만족한다는 뜻이 아니다. 작성·개선의 핵심 조건이 미해결이거나 요청된 판단에 필요한 입력이 없으면 NEEDS_INPUT으로 부분 결과를 보존한다. NOT_APPLICABLE에는 후보·finding을 만들지 않는다.

OBSERVED는 실제 출력 기록이 있을 때만 사용한다. run은 후보 digest, 기준판 digest, 표본·설정·결과 참조를 연결한다. 기준판이 없으면 새 후보의 결과를 관찰할 수 있지만 비교 개선 결론은 NOT_ESTABLISHED다. 비실행에는 NOT_RUN, 빈 runs, NOT_ESTABLISHED와 이유를 남긴다. 기준판과 조건이 실제로 동등한지, 성능이 개선됐는지는 독립적인 내용 검토가 필요하다.

## 검사

```bash
node skills/prompt-engineering/scripts/check-report.mjs --request REQUEST.json --report REPORT.json
```

검사는 `valid`, `errors`, `validationScope: structure-and-binding-only`를 반환한다. 구조·요구 ID·출처의 선언된 참조·후보 텍스트 digest·요청 결속을 검사한다. 참조 파일을 자동 열거나 외부 모델을 호출하지 않는다. 실제 자료의 존재·진위·의미 보존·평가 공정성·주장의 강도는 이 CLI의 검증 범위가 아니다.

MCP는 정식 workflow의 descriptor outputSchema와 stateMapping을 사용한다. 이 CLI가 MCP provider semantic validator로 자동 등록되지는 않는다. CLI 결과가 필요한 작업에서는 명시적으로 실행하고 결과를 기존 검증 증거로 연결하라.

정식 workflow는 외부 artifact `task:prompt-engineering-request`를 제공하고 required capability에 `prompt-engineering`을 포함한다. 기존 task 계약·권한·위험/수용/감사 단계는 유지한다. provider의 passed는 이 전문 단계 완료만 나타내며 실제 모델 평가·배포 승인이 아니다.
